"""
Canva team-join via pure HTTP (curl_cffi).

Replaces the old Camoufox-based flow with a fast direct HTTP call,
modelled exactly on the network trace captured from the real browser:

  1. GET  https://www.canva.com/brand/join?token=<INVITE>&referrer=team-invite
         → returns rendered HTML containing a `csrfToken` hidden input
  2. POST https://www.canva.com/brand/join?token=<INVITE>&referrer=team-invite&postStart=<rand>
         body: csrfToken=<scraped>
         → 302 with `Location: /login/switch?brand=<NEW_BRAND_ID>&redirect=...`
  3. (Optional) GET findbyuser to fetch the new team's displayName.

Stdin (JSON):
  {
    "email": "...",                # informational only
    "tokens": { caz, cb, cau, user_id, all_cookies },
    "invite_url": "https://www.canva.com/brand/join?token=...",
    "on_existing": "switch" | "skip" | "add"
  }

Stdout (one JSON line):
  success → {
    ok: true,
    new_tokens: { caz, cb, cau, user_id, all_cookies },
    previous_brand_id, brand_id, brand_name?,
    action: "joined" | "switched" | "already_member" | "skipped"
  }
  failure → {
    ok: false,
    code: "input_invalid" | "session_expired" | "invite_invalid"
         | "join_failed" | "timeout" | "browser_error",
    error: "...",
  }

Stderr emits [STEP] log lines so the dashboard can render live progress.
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
from urllib.parse import parse_qs, urlencode, urlparse

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

# Regex to pull `csrfToken` out of the rendered HTML. Canva embeds it
# either as a hidden form input or inline in a JSON blob. Try several
# shapes so we tolerate minor template changes.
CSRF_PATTERNS = (
    re.compile(r'name=["\']csrfToken["\']\s+value=["\']([A-Za-z0-9_\-]{20,})["\']'),
    re.compile(r'["\']csrfToken["\']\s*:\s*["\']([A-Za-z0-9_\-]{20,})["\']'),
    re.compile(r"csrfToken=([A-Za-z0-9_\-]{20,})"),
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _log(msg: str) -> None:
    """Stderr-only logger. Never touches stdout."""
    try:
        print(msg, file=sys.stderr, flush=True)
    except Exception:
        pass


def _parse_all_cookies(raw: Any) -> dict[str, str]:
    """
    `all_cookies` may arrive as:
      - JSON dict string  (legacy fetch_tokens format)
      - "name=val; name=val" header string
      - dict
      - None / empty
    Always return a flat `{name: value}` dict.
    """
    if not raw:
        return {}
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items()}
    if not isinstance(raw, str):
        return {}
    s = raw.strip()
    if not s:
        return {}
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
    """Canva packs the user id inside the base64-encoded CAU cookie."""
    if not cau:
        return ""
    try:
        decoded = json.loads(base64.b64decode(cau + "==").decode("utf-8", "ignore"))
        if isinstance(decoded, dict):
            return str(decoded.get("A", "") or "")
    except Exception:
        return ""
    return ""


def _extract_csrf(html: str) -> str:
    """Scrape the csrfToken out of a Canva-rendered HTML page."""
    if not html:
        return ""
    for pat in CSRF_PATTERNS:
        m = pat.search(html)
        if m:
            return m.group(1)
    return ""


def _extract_brand_from_location(location: str) -> str:
    """
    Pull the new brand id out of:
        /login/switch?brand=BAHK3S9zIOo&redirect=...
    Returns empty string if not present.
    """
    if not location:
        return ""
    try:
        # location may be relative ("/login/switch?...") or absolute
        path = location if location.startswith("http") else f"{CANVA_ORIGIN}{location}"
        qs = parse_qs(urlparse(path).query)
        return (qs.get("brand") or [""])[0]
    except Exception:
        return ""


def _random_post_start() -> str:
    """Mimic the `postStart=<rand>` Canva appends to its form action."""
    import secrets

    return secrets.token_hex(4) + secrets.token_hex(2)[:2]


def _build_session(cookies: dict[str, str]):
    """Construct a curl_cffi session impersonating Chrome with the user's cookies."""
    from curl_cffi import requests as cf_requests

    sess = cf_requests.Session(impersonate="chrome124")

    # Optional outbound proxy (same env var canva.py honors)
    proxy_url = os.getenv("BATCHER_PROXY_URL", "").strip()
    if proxy_url:
        sess.proxies = {"http": proxy_url, "https": proxy_url}

    # Inject cookies into the session jar for canva.com
    for name, value in cookies.items():
        if not name:
            continue
        try:
            sess.cookies.set(name, str(value), domain=".canva.com", path="/")
        except Exception:
            pass
    return sess


def _is_login_redirect(url: str) -> bool:
    u = (url or "").lower()
    return any(seg in u for seg in ("/login", "/signin", "/signup"))


# ---------------------------------------------------------------------------
# Core flow
# ---------------------------------------------------------------------------


async def _run(payload: dict[str, Any]) -> dict[str, Any]:
    # ---- 1. Validate input ----------------------------------------------
    invite_url = (payload.get("invite_url") or "").strip()
    tokens = payload.get("tokens") or {}
    on_existing = (payload.get("on_existing") or "switch").strip().lower()
    if on_existing not in ("switch", "skip", "add"):
        on_existing = "switch"

    if not invite_url:
        return {"ok": False, "code": "input_invalid", "error": "invite_url required"}
    if not isinstance(tokens, dict) or not tokens.get("caz"):
        return {"ok": False, "code": "input_invalid", "error": "tokens.caz required"}

    # ---- 2. Build cookie jar --------------------------------------------
    cookie_map = _parse_all_cookies(tokens.get("all_cookies"))
    if tokens.get("caz"):
        cookie_map["CAZ"] = str(tokens["caz"])
    if tokens.get("cb"):
        cookie_map["CB"] = str(tokens["cb"])
    if tokens.get("cau"):
        cookie_map["CAU"] = str(tokens["cau"])

    previous_brand_id = str(tokens.get("cb", "") or cookie_map.get("CB", ""))
    user_id = str(
        tokens.get("user_id", "")
        or _derive_user_id_from_cau(str(tokens.get("cau", "")))
    )

    _log(f"[STEP] preparing http session ({len(cookie_map)} cookies)")
    sess = _build_session(cookie_map)

    # ---- 3. GET invite page → scrape csrfToken --------------------------
    _log("[STEP] fetching invite page to scrape csrfToken")
    try:
        r = sess.get(
            invite_url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Upgrade-Insecure-Requests": "1",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
            },
            timeout=PER_REQUEST_TIMEOUT_S,
            allow_redirects=True,
        )
    except Exception as exc:
        _log(f"[STEP] invite GET failed: {exc!r}")
        return {
            "ok": False,
            "code": "browser_error",
            "error": f"invite GET failed: {exc!r}"[:200],
        }

    final_url = str(r.url or "")
    _log(f"[STEP] invite GET status={r.status_code} url={final_url}")

    if _is_login_redirect(final_url):
        return {
            "ok": False,
            "code": "session_expired",
            "error": f"invite GET redirected to {final_url}",
        }

    html = r.text or ""
    low = html.lower()

    # Canva sometimes serves an "invite invalid" page with 200.
    if any(
        p in low
        for p in (
            "invitation is no longer valid",
            "invite link is invalid",
            "invite has expired",
            "this link has expired",
            "couldn't find that invite",
            "couldn't find this invite",
        )
    ):
        return {
            "ok": False,
            "code": "invite_invalid",
            "error": "invite page reports invalid/expired link",
        }

    # Already-member fast path (server may render an "already a member" page).
    if any(
        p in low
        for p in (
            "you are already a member",
            "you're already a member",
            "already a member of this team",
        )
    ):
        _log("[STEP] server indicates already-member")
        new_cb = previous_brand_id
        return {
            "ok": True,
            "new_tokens": _build_new_tokens(tokens, cookie_map, new_cb),
            "previous_brand_id": previous_brand_id,
            "brand_id": new_cb,
            "brand_name": "",
            "action": "already_member",
        }

    csrf_token = _extract_csrf(html)
    if not csrf_token:
        # No CSRF found — but maybe the server already auto-accepted via
        # GET redirect chain. Check team list via findbyuser to confirm.
        _log("[STEP] no csrfToken in HTML — checking findbyuser to verify auto-join")
        teams = await _list_teams(sess, user_id)
        if teams.get("ok"):
            new_brand_id, brand_name = _detect_newly_joined_brand(
                invite_url, teams.get("brands", []), previous_brand_id
            )
            if new_brand_id and new_brand_id != previous_brand_id:
                return {
                    "ok": True,
                    "new_tokens": _build_new_tokens(
                        tokens, _read_session_cookies(sess), new_brand_id
                    ),
                    "previous_brand_id": previous_brand_id,
                    "brand_id": new_brand_id,
                    "brand_name": brand_name,
                    "action": "switched",
                }
        return {
            "ok": False,
            "code": "join_failed",
            "error": "csrfToken not found in invite page",
        }

    _log(f"[STEP] csrfToken found (len={len(csrf_token)})")

    # ---- 4. on_existing=skip: short-circuit if already in another team ---
    if on_existing == "skip":
        teams = await _list_teams(sess, user_id)
        in_another = any(
            (not b.get("personal")) and b.get("id") != _extract_invite_brand_hint(html)
            for b in teams.get("brands", [])
        )
        if in_another:
            _log("[STEP] on_existing=skip and account is already in another team")
            return {
                "ok": True,
                "new_tokens": _build_new_tokens(tokens, cookie_map, previous_brand_id),
                "previous_brand_id": previous_brand_id,
                "brand_id": previous_brand_id,
                "brand_name": "",
                "action": "skipped",
            }

    # ---- 5. POST /brand/join with csrfToken -----------------------------
    post_url = (
        invite_url
        + ("&" if "?" in invite_url else "?")
        + f"postStart={_random_post_start()}"
    )
    _log("[STEP] posting brand-join form")
    try:
        r2 = sess.post(
            post_url,
            data={"csrfToken": csrf_token},
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": CANVA_ORIGIN,
                "Referer": invite_url,
                "Upgrade-Insecure-Requests": "1",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "same-origin",
            },
            timeout=PER_REQUEST_TIMEOUT_S,
            allow_redirects=False,  # we want to inspect the 302 ourselves
        )
    except Exception as exc:
        _log(f"[STEP] join POST failed: {exc!r}")
        return {
            "ok": False,
            "code": "join_failed",
            "error": f"POST failed: {exc!r}"[:200],
        }

    _log(f"[STEP] join POST status={r2.status_code}")
    location = r2.headers.get("location") or r2.headers.get("Location") or ""

    if r2.status_code in (301, 302, 303, 307, 308) and location:
        new_brand_id = _extract_brand_from_location(location)
        _log(f"[STEP] redirect Location: {location}")
        if not new_brand_id:
            # Some flows redirect straight to onboarding without brand= param.
            # Fall through and verify via team list.
            _log("[STEP] no brand in Location — verifying via findbyuser")
        # Follow the redirect chain so cookies (CB swap) get applied.
        try:
            sess.get(
                location
                if location.startswith("http")
                else f"{CANVA_ORIGIN}{location}",
                headers={"User-Agent": USER_AGENT, "Referer": post_url},
                timeout=PER_REQUEST_TIMEOUT_S,
                allow_redirects=True,
            )
        except Exception:
            pass

        # Verify via findbyuser to get displayName. Canva needs ~500-1000ms
        # to propagate the new membership server-side, so do a small retry.
        await asyncio.sleep(0.8)
        teams = await _list_teams(sess, user_id)
        if not new_brand_id:
            new_brand_id, brand_name = _detect_newly_joined_brand(
                invite_url, teams.get("brands", []), previous_brand_id
            )
        else:
            brand_name = _lookup_brand_name(teams.get("brands", []), new_brand_id)
            if not brand_name:
                # One quick retry — server may still be propagating.
                await asyncio.sleep(1.0)
                teams = await _list_teams(sess, user_id)
                brand_name = _lookup_brand_name(teams.get("brands", []), new_brand_id)

        if not new_brand_id:
            return {
                "ok": False,
                "code": "join_failed",
                "error": "POST succeeded but no brand id resolved",
            }

        action = (
            "switched"
            if previous_brand_id and previous_brand_id != new_brand_id
            else "joined"
        )
        _log(
            f"[STEP] join SUCCESS: {action} brand_id={new_brand_id} ({brand_name or '?'})"
        )
        return {
            "ok": True,
            "new_tokens": _build_new_tokens(
                tokens, _read_session_cookies(sess), new_brand_id
            ),
            "previous_brand_id": previous_brand_id,
            "brand_id": new_brand_id,
            "brand_name": brand_name or "",
            "action": action,
        }

    # Non-redirect → error.
    body_snippet = (r2.text or "")[:300]
    return {
        "ok": False,
        "code": "join_failed",
        "error": f"POST returned {r2.status_code}: {body_snippet}",
    }


async def _list_teams(sess, user_id: str) -> dict[str, Any]:
    """
    Call /_ajax/organizationmanagement/brandsandorganizations/findbyuser.
    Returns {ok, brands: [{id, displayName, personal, memberCount, plan}]} or {ok: False, ...}.
    """
    if not user_id:
        return {"ok": False, "error": "user_id required"}
    url = (
        f"{CANVA_ORIGIN}/_ajax/organizationmanagement/brandsandorganizations/findbyuser"
        f"?userId={user_id}&brandProjection=MEMBER_COUNT&brandProjection=BRAND_PLAN_DESCRIPTION"
        f"&organizationProjection=C&includeDeleted=false&includeLocked=false"
        f"&projectRoleInBrand=false"
    )
    # Current CB (best effort, for the x-canva-brand header)
    cb = ""
    try:
        for c in sess.cookies:
            if c.name == "CB":
                cb = c.value
                break
    except Exception:
        pass

    try:
        r = sess.get(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
                "x-canva-app": "home",
                "x-canva-user": user_id,
                "x-canva-brand": cb,
                "x-canva-accept-prefix": "no-prefix",
                "x-canva-request": "findbrandsandorganizationsbyuser",
            },
            timeout=PER_REQUEST_TIMEOUT_S,
        )
        if r.status_code != 200:
            return {"ok": False, "status": r.status_code, "error": "non-200"}
        text = r.text or ""
        # Strip the anti-XSSI prefix Canva uses: `)]}'` or similar
        text = re.sub(r"^.*?({)", r"\1", text, count=1, flags=re.DOTALL)
        data = json.loads(text)
        brands_raw = data.get("A") or []
        brands = []
        for b in brands_raw:
            if not isinstance(b, dict):
                continue
            brands.append(
                {
                    "id": b.get("id", ""),
                    "brandname": b.get("brandname", ""),
                    "displayName": b.get("displayName", "") or b.get("brandname", ""),
                    "personal": bool(b.get("personal", False)),
                    "memberCount": int(b.get("memberCount", 0) or 0),
                    "plan": b.get("brandPlanDescription", ""),
                }
            )
        return {"ok": True, "brands": brands}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def _detect_newly_joined_brand(
    invite_url: str,
    brands: list[dict[str, Any]],
    previous_brand_id: str,
) -> tuple[str, str]:
    """
    Pick the brand most likely to be the one we just joined: the one whose
    id != previous and isn't the personal brand. If multiple non-personal
    brands exist (account in several teams), prefer the most recently
    updated. Returns (brand_id, brand_name).
    """
    candidates = [
        b
        for b in brands
        if b.get("id") and b["id"] != previous_brand_id and not b.get("personal")
    ]
    if not candidates:
        return "", ""
    # Just pick first non-personal — order from findbyuser tends to put newest last,
    # but without timestamps in our projection we keep it simple.
    last = candidates[-1]
    return str(last.get("id", "")), str(last.get("displayName", ""))


def _lookup_brand_name(brands: list[dict[str, Any]], brand_id: str) -> str:
    for b in brands:
        if b.get("id") == brand_id:
            return str(b.get("displayName", "") or b.get("brandname", ""))
    return ""


def _extract_invite_brand_hint(html: str) -> str:
    """Try to find the target brand id inside the rendered invite HTML."""
    if not html:
        return ""
    m = re.search(r"(BA[A-Za-z0-9_\-]{8,})", html)
    return m.group(1) if m else ""


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
    Compose the updated `tokens` payload, with the new CB applied.

    Critically: we MERGE three sources so we never lose cookies that the
    Cloudflare/Canva proxy needs (cf_clearance, __cf_bm, __cuid, CDI, CL,
    CS, etc.). If we only use ``fresh_cookies`` from the session jar,
    curl_cffi's redirect chain may have stripped most non-essential
    cookies, leaving us with just CAZ/CAU/CB \u2014 enough for the join itself
    but not enough for subsequent API calls (findbyuser etc. \u2192 403).

    Order of precedence (later wins):
      1. Original ``tokens.all_cookies`` from the DB        (baseline jar)
      2. fresh_cookies from the live session                (post-join updates)
      3. Explicit individual fields (caz/cb/cau)            (canonical truth)
      4. ``new_brand_id`` parameter                         (overrides CB)
    """
    # ---- Layer 1: original cookies from DB ---------------------------------
    merged = _parse_all_cookies(original_tokens.get("all_cookies"))
    # Also seed from individual fields if the all_cookies blob was empty.
    for key, src_key in (("CAZ", "caz"), ("CB", "cb"), ("CAU", "cau")):
        v = original_tokens.get(src_key)
        if v and key not in merged:
            merged[key] = str(v)

    # ---- Layer 2: fresh cookies from the live session ----------------------
    for k, v in fresh_cookies.items():
        if k and v:
            merged[k] = str(v)

    # ---- Layer 3: derive canonical CAZ/CAU/CB ------------------------------
    caz = merged.get("CAZ", "") or str(original_tokens.get("caz", ""))
    cau = merged.get("CAU", "") or str(original_tokens.get("cau", ""))
    cb = new_brand_id or merged.get("CB", "") or str(original_tokens.get("cb", ""))

    # Normalize the canonical fields back into the merged jar.
    if caz:
        merged["CAZ"] = caz
    if cau:
        merged["CAU"] = cau
    if cb:
        merged["CB"] = cb

    user_id = str(original_tokens.get("user_id", "") or _derive_user_id_from_cau(cau))

    # Render the jar back to "name=val; name=val" so canva.py can keep
    # using the same wire format it already understands.
    all_cookies_str = "; ".join(f"{k}={v}" for k, v in merged.items() if k)

    # ── Safeguard: refuse to shrink an established jar ────────────────────
    # If the original tokens had a substantial cookie blob (e.g. with
    # `cf_clearance`) but our merged output is way smaller, something went
    # wrong — the session jar got cleared mid-flow. Fall back to the
    # original blob + just override CB, instead of persisting a stripped
    # jar that will 403 on every subsequent request. See accounts 109/110
    # corruption incident (2026-06).
    original_all = str(original_tokens.get("all_cookies", "") or "")
    if len(original_all) > 200 and len(all_cookies_str) < len(original_all) * 0.5:
        try:
            print(
                f"[STEP] WARN: merged jar shrunk ({len(all_cookies_str)} vs original {len(original_all)}); "
                f"falling back to original + new CB",
                file=sys.stderr,
                flush=True,
            )
        except Exception:
            pass
        # Re-render from the ORIGINAL jar with just CB overridden.
        original_map = _parse_all_cookies(original_all)
        if cb:
            original_map["CB"] = cb
        if caz and "CAZ" not in original_map:
            original_map["CAZ"] = caz
        if cau and "CAU" not in original_map:
            original_map["CAU"] = cau
        all_cookies_str = "; ".join(f"{k}={v}" for k, v in original_map.items() if k)

    return {
        "caz": caz,
        "cb": cb,
        "cau": cau,
        "user_id": user_id,
        "all_cookies": all_cookies_str,
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
