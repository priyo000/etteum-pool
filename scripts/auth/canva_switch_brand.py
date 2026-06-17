"""
Switch the active Canva brand (CB cookie) for an account.

Canva accounts can belong to multiple brands (personal + 0..N teams). The
active brand is selected server-side via:

  GET https://www.canva.com/login/switch?brand=<BRAND_ID>&redirect=/

…which 302s through a chain and sets a new `CB` cookie. We follow the
chain, harvest the updated cookie jar, and merge it back into the stored
tokens — preserving Cloudflare cookies (cf_clearance, __cf_bm, …) so
follow-up API calls don't 403.

Stdin (JSON):
  {
    "tokens": { caz, cb, cau, user_id, all_cookies },
    "target_brand_id": "BAHK3S9zIOo"
  }

Stdout (one JSON):
  success → {
    ok: true,
    new_tokens: { caz, cb, cau, user_id, all_cookies },
    previous_brand_id: "...",
    brand_id: "..."
  }
  failure → {
    ok: false,
    code: "input_invalid" | "session_expired" | "switch_failed" | "timeout" | "browser_error",
    error: "..."
  }

Stderr emits `[STEP] …` log lines for live dashboard feedback.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import sys
import traceback
from typing import Any

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CANVA_ORIGIN = "https://www.canva.com"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
)
TOTAL_TIMEOUT_S = 30
PER_REQUEST_TIMEOUT_S = 15

# Canva brand ids look like "BAHK3S9zIOo" — leading BA, then base62-ish.
BRAND_ID_RE = re.compile(r"^BA[A-Za-z0-9_\-]{8,}$")


# ---------------------------------------------------------------------------
# Helpers (mirrors canva_join_team.py / canva_list_teams.py exactly)
# ---------------------------------------------------------------------------


def _log(msg: str) -> None:
    try:
        print(msg, file=sys.stderr, flush=True)
    except Exception:
        pass


def _parse_all_cookies(raw: Any) -> dict[str, str]:
    if not raw:
        return {}
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items()}
    if not isinstance(raw, str):
        return {}
    s = raw.strip()
    if s.startswith("{"):
        try:
            data = json.loads(s)
            if isinstance(data, dict):
                return {str(k): str(v) for k, v in data.items()}
        except Exception:
            pass
    out: dict[str, str] = {}
    for pair in s.split(";"):
        pair = pair.strip()
        if not pair or "=" not in pair:
            continue
        k, v = pair.split("=", 1)
        if k:
            out[k.strip()] = v.strip()
    return out


def _derive_user_id_from_cau(cau: str) -> str:
    if not cau:
        return ""
    try:
        decoded = json.loads(base64.b64decode(cau + "==").decode("utf-8", "ignore"))
        if isinstance(decoded, dict):
            return str(decoded.get("A", "") or "")
    except Exception:
        return ""
    return ""


def _build_session(cookies: dict[str, str]):
    """Construct a curl_cffi session impersonating Chrome with the user's cookies."""
    from curl_cffi import requests as cf_requests

    sess = cf_requests.Session(impersonate="chrome124")

    proxy_url = os.getenv("BATCHER_PROXY_URL", "").strip()
    if proxy_url:
        sess.proxies = {"http": proxy_url, "https": proxy_url}

    for name, value in cookies.items():
        if not name:
            continue
        try:
            sess.cookies.set(name, str(value), domain=".canva.com", path="/")
        except Exception:
            pass
    return sess


def _read_session_cookies(sess) -> dict[str, str]:
    """Read all canva.com cookies currently in the session jar."""
    out: dict[str, str] = {}
    try:
        for c in sess.cookies:
            if "canva.com" in (c.domain or ""):
                out[c.name] = c.value
    except Exception:
        pass
    return out


def _build_new_tokens(
    original_tokens: dict[str, Any],
    fresh_cookies: dict[str, str],
    new_brand_id: str,
) -> dict[str, str]:
    """
    Compose updated tokens with the new CB applied.

    MERGES three sources so we never lose cookies the Cloudflare/Canva proxy
    needs (cf_clearance, __cf_bm, __cuid, CDI, CL, CS, etc.). Identical
    contract to canva_join_team.py::_build_new_tokens.
    """
    # Layer 1: original cookies from DB.
    merged = _parse_all_cookies(original_tokens.get("all_cookies"))
    for key, src_key in (("CAZ", "caz"), ("CB", "cb"), ("CAU", "cau")):
        v = original_tokens.get(src_key)
        if v and key not in merged:
            merged[key] = str(v)

    # Layer 2: fresh cookies from the live session.
    for k, v in fresh_cookies.items():
        if k and v:
            merged[k] = str(v)

    # Layer 3: derive canonical CAZ/CAU/CB.
    caz = merged.get("CAZ", "") or str(original_tokens.get("caz", ""))
    cau = merged.get("CAU", "") or str(original_tokens.get("cau", ""))
    cb = new_brand_id or merged.get("CB", "") or str(original_tokens.get("cb", ""))

    if caz:
        merged["CAZ"] = caz
    if cau:
        merged["CAU"] = cau
    if cb:
        merged["CB"] = cb

    user_id = str(original_tokens.get("user_id", "") or _derive_user_id_from_cau(cau))
    all_cookies_str = "; ".join(f"{k}={v}" for k, v in merged.items() if k)

    return {
        "caz": caz,
        "cb": cb,
        "cau": cau,
        "user_id": user_id,
        "all_cookies": all_cookies_str,
    }


# ---------------------------------------------------------------------------
# Core flow
# ---------------------------------------------------------------------------


async def _run(payload: dict[str, Any]) -> dict[str, Any]:
    # ---- 1. Validate input ----------------------------------------------
    tokens = payload.get("tokens") or {}
    target_brand_id = str(payload.get("target_brand_id") or "").strip()

    if not isinstance(tokens, dict) or not tokens.get("caz"):
        return {"ok": False, "code": "input_invalid", "error": "tokens.caz required"}
    if not target_brand_id:
        return {
            "ok": False,
            "code": "input_invalid",
            "error": "target_brand_id required",
        }
    if not BRAND_ID_RE.match(target_brand_id):
        return {
            "ok": False,
            "code": "input_invalid",
            "error": f"target_brand_id has invalid shape: {target_brand_id!r}",
        }

    # ---- 2. Build cookie jar --------------------------------------------
    cookie_map = _parse_all_cookies(tokens.get("all_cookies"))
    if tokens.get("caz"):
        cookie_map["CAZ"] = str(tokens["caz"])
    if tokens.get("cb"):
        cookie_map["CB"] = str(tokens["cb"])
    if tokens.get("cau"):
        cookie_map["CAU"] = str(tokens["cau"])

    previous_brand_id = str(tokens.get("cb", "") or cookie_map.get("CB", ""))

    if previous_brand_id and previous_brand_id == target_brand_id:
        _log(f"[STEP] already on brand {target_brand_id}; no-op switch")
        return {
            "ok": True,
            "new_tokens": _build_new_tokens(tokens, {}, target_brand_id),
            "previous_brand_id": previous_brand_id,
            "brand_id": target_brand_id,
        }

    _log(f"[STEP] preparing http session ({len(cookie_map)} cookies)")
    sess = _build_session(cookie_map)

    # ---- 3. GET /login/switch?brand=<target>&redirect=/ -----------------
    switch_url = f"{CANVA_ORIGIN}/login/switch?brand={target_brand_id}&redirect=/"
    _log(
        f"[STEP] GET /login/switch brand={target_brand_id} (prev={previous_brand_id or '?'})"
    )
    try:
        r = sess.get(
            switch_url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": f"{CANVA_ORIGIN}/",
            },
            allow_redirects=True,
            timeout=PER_REQUEST_TIMEOUT_S,
        )
    except Exception as exc:
        return {
            "ok": False,
            "code": "browser_error",
            "error": f"switch GET failed: {exc!r}"[:200],
        }

    final_url = str(getattr(r, "url", "") or "")
    status = getattr(r, "status_code", 0)
    _log(f"[STEP] switch redirect chain settled: status={status} final_url={final_url}")

    # If we end up on /login or /signin, the session is dead.
    low = final_url.lower()
    if (
        any(seg in low for seg in ("/login", "/signin", "/signup"))
        and "switch" not in low
    ):
        return {
            "ok": False,
            "code": "session_expired",
            "error": f"redirected to login page: {final_url}",
        }

    # ---- 4. Verify CB cookie now matches target -------------------------
    fresh = _read_session_cookies(sess)
    new_cb = fresh.get("CB", "") or ""

    if not new_cb:
        return {
            "ok": False,
            "code": "switch_failed",
            "error": "no CB cookie present after switch",
        }
    if new_cb != target_brand_id:
        return {
            "ok": False,
            "code": "switch_failed",
            "error": (
                f"CB unchanged (or wrong brand) after switch: "
                f"got={new_cb!r} want={target_brand_id!r}"
            ),
        }

    _log(f"[STEP] switch SUCCESS: cb {previous_brand_id or '?'} -> {new_cb}")

    return {
        "ok": True,
        "new_tokens": _build_new_tokens(tokens, fresh, new_cb),
        "previous_brand_id": previous_brand_id,
        "brand_id": new_cb,
    }


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


async def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        if not isinstance(payload, dict):
            raise ValueError("stdin payload must be a JSON object")
    except Exception as exc:
        _emit(
            {
                "ok": False,
                "code": "input_invalid",
                "error": f"stdin parse failed: {exc!r}"[:200],
            }
        )
        return

    try:
        result = await asyncio.wait_for(_run(payload), timeout=TOTAL_TIMEOUT_S)
    except asyncio.TimeoutError:
        result = {
            "ok": False,
            "code": "timeout",
            "error": f"exceeded {TOTAL_TIMEOUT_S}s total timeout",
        }
    except Exception as exc:
        _log(traceback.format_exc())
        result = {
            "ok": False,
            "code": "browser_error",
            "error": f"{type(exc).__name__}: {str(exc)[:200]}",
        }

    _emit(result)


def _emit(result: dict[str, Any]) -> None:
    """Print exactly one JSON object to stdout."""
    try:
        print(json.dumps(result), flush=True)
    except Exception:
        sys.stdout.write(
            json.dumps({"ok": False, "code": "browser_error", "error": "emit failed"})
        )
        sys.stdout.flush()


if __name__ == "__main__":
    asyncio.run(main())
