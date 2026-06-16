"""
List Canva teams (brands) for a given account.

Calls /_ajax/organizationmanagement/brandsandorganizations/findbyuser to
enumerate every brand the user is a member of (personal + teams).

Stdin (JSON):
  {
    "tokens": { caz, cb, cau, user_id, all_cookies },
  }

Stdout (one JSON):
  success → {
    ok: true,
    brands: [
      { id, brandname, displayName, personal, memberCount, plan }
    ],
  }
  failure → { ok: false, code, error }
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

CANVA_ORIGIN = "https://www.canva.com"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
)
PER_REQUEST_TIMEOUT_S = 12
TOTAL_TIMEOUT_S = 20


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


async def _run(payload: dict[str, Any]) -> dict[str, Any]:
    tokens = payload.get("tokens") or {}
    if not isinstance(tokens, dict) or not tokens.get("caz"):
        return {"ok": False, "code": "input_invalid", "error": "tokens.caz required"}

    cookie_map = _parse_all_cookies(tokens.get("all_cookies"))
    if tokens.get("caz"):
        cookie_map["CAZ"] = str(tokens["caz"])
    if tokens.get("cb"):
        cookie_map["CB"] = str(tokens["cb"])
    if tokens.get("cau"):
        cookie_map["CAU"] = str(tokens["cau"])

    user_id = str(
        tokens.get("user_id", "")
        or _derive_user_id_from_cau(str(tokens.get("cau", "")))
    )
    if not user_id:
        return {
            "ok": False,
            "code": "input_invalid",
            "error": "user_id missing and could not derive from CAU",
        }

    cb = cookie_map.get("CB", "") or str(tokens.get("cb", ""))

    from curl_cffi import requests as cf_requests

    sess = cf_requests.Session(impersonate="chrome124")
    proxy_url = os.getenv("BATCHER_PROXY_URL", "").strip()
    if proxy_url:
        sess.proxies = {"http": proxy_url, "https": proxy_url}
    for name, value in cookie_map.items():
        try:
            sess.cookies.set(name, str(value), domain=".canva.com", path="/")
        except Exception:
            pass

    url = (
        f"{CANVA_ORIGIN}/_ajax/organizationmanagement/brandsandorganizations/findbyuser"
        f"?userId={user_id}&brandProjection=MEMBER_COUNT&brandProjection=BRAND_PLAN_DESCRIPTION"
        f"&organizationProjection=C&includeDeleted=false&includeLocked=false"
        f"&projectRoleInBrand=false"
    )
    _log(f"[STEP] GET findbyuser user_id={user_id}")
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
    except Exception as exc:
        return {
            "ok": False,
            "code": "browser_error",
            "error": f"GET failed: {exc!r}"[:200],
        }

    _log(f"[STEP] findbyuser status={r.status_code}")
    if r.status_code in (401, 403):
        return {
            "ok": False,
            "code": "session_expired",
            "error": f"HTTP {r.status_code}",
        }
    if r.status_code != 200:
        return {"ok": False, "code": "browser_error", "error": f"HTTP {r.status_code}"}

    text = r.text or ""
    text = re.sub(r"^.*?({)", r"\1", text, count=1, flags=re.DOTALL)
    try:
        data = json.loads(text)
    except Exception as exc:
        return {"ok": False, "code": "browser_error", "error": f"json parse: {exc}"}

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
                "error": f"stdin parse: {exc!r}"[:200],
            }
        )
        return

    try:
        result = await asyncio.wait_for(_run(payload), timeout=TOTAL_TIMEOUT_S)
    except asyncio.TimeoutError:
        result = {
            "ok": False,
            "code": "timeout",
            "error": f"exceeded {TOTAL_TIMEOUT_S}s",
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
    try:
        print(json.dumps(result), flush=True)
    except Exception:
        sys.stdout.write(
            json.dumps({"ok": False, "code": "browser_error", "error": "emit failed"})
        )
        sys.stdout.flush()


if __name__ == "__main__":
    asyncio.run(main())
