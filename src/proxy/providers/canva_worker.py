#!/usr/bin/env python3
"""
Canva media generation worker.
Called via subprocess from the Canva TypeScript provider.

Input (stdin JSON):
  { mode: "image"|"video"|"quota", prompt?: str, cookies: {...}, timeout?: int }

Output (stdout JSON):
  { ok: bool, media_url?, thumbnail_url?, width?, height?, size?, quota_used?, quota_limit?, error? }

Requires: curl_cffi (for TLS fingerprint impersonation)
"""

import json
import sys
import time

CANVA_BASE = "https://www.canva.com"
POLL_INTERVAL = 3  # seconds
IMPERSONATE = "chrome131"

# Aspect ratio codes for Canva Magic Media (g.A field).
# Discovered empirically by probing different g.A values.
ASPECT_RATIOS = {
    "1:1": "A",  # 1200x1200 - Square
    "16:9": "B",  # 1600x912  - Landscape
    "5:4": "C",  # 1344x1088 - Landscape
    "4:3": "D",  # 1392x1040 - Landscape
    "2:1": "E",  # 1712x864  - Cinematic
    "9:16": "F",  # 912x1600  - Portrait
    "4:5": "G",  # 1088x1344 - Portrait
    "3:4": "H",  # 1040x1392 - Portrait
}
DEFAULT_ASPECT = "1:1"


def build_session(cookies: dict):
    """Create a curl_cffi session with Chrome TLS impersonation and Canva cookies."""
    from curl_cffi import requests

    session = requests.Session(impersonate=IMPERSONATE)

    # Set cookies from all_cookies if available, otherwise individual fields.
    # `all_cookies` arrives as ONE of:
    #   1. JSON-encoded dict string  →  legacy fetch_tokens format
    #   2. "name=val; name=val" string  →  modern join/switch format (preferred)
    #   3. dict already (rare; in-process tests)
    # All three must produce a flat {name: value} map. Losing cookies here
    # silently kills cf_clearance and triggers a Cloudflare 403 on every
    # subsequent request — verified-and-painful 2026-06-16.
    all_cookies: dict = {}
    raw_all = cookies.get("all_cookies")
    if raw_all:
        if isinstance(raw_all, dict):
            all_cookies = {str(k): str(v) for k, v in raw_all.items()}
        elif isinstance(raw_all, str):
            s = raw_all.strip()
            if s.startswith("{"):
                # JSON-dict format
                try:
                    parsed = json.loads(s)
                    if isinstance(parsed, dict):
                        all_cookies = {str(k): str(v) for k, v in parsed.items()}
                except (json.JSONDecodeError, TypeError):
                    pass
            else:
                # "name=val; name=val" header-style format
                for pair in s.split(";"):
                    pair = pair.strip()
                    if pair and "=" in pair:
                        k, v = pair.split("=", 1)
                        if k:
                            all_cookies[k.strip()] = v.strip()

    for name, value in all_cookies.items():
        session.cookies.set(name, str(value), domain=".canva.com")

    # Always set core cookies explicitly (override if present)
    if cookies.get("caz"):
        session.cookies.set("CAZ", cookies["caz"], domain=".canva.com")
    if cookies.get("cb"):
        session.cookies.set("CB", cookies["cb"], domain=".canva.com")
    if cookies.get("cau"):
        session.cookies.set("CAU", cookies["cau"], domain=".canva.com")

    return session


def build_headers(cookies: dict) -> dict:
    """Build Canva API headers."""
    return {
        "Origin": CANVA_BASE,
        "Referer": f"{CANVA_BASE}/",
        "Content-Type": "application/json;charset=UTF-8",
        "x-canva-brand": cookies.get("cb", ""),
        "x-canva-locale": "id-ID",
        "x-canva-accept-prefix": "no-prefix",
        "x-canva-active-user": cookies.get("cau", ""),
        "x-canva-authz": cookies.get("caz", ""),
        "x-canva-user": cookies.get("user_id", ""),
        "x-canva-request": "ingredientgeneration",
        "x-canva-app": "editor",
    }


def generate_media(
    cookies: dict,
    prompt: str,
    mode: str = "image",
    timeout: int = 90,
    count: int = 1,
    aspect: str = DEFAULT_ASPECT,
) -> dict:
    """Generate image or video via Canva's ingredientgeneration API."""
    session = build_session(cookies)
    headers = build_headers(cookies)

    if not cookies.get("caz"):
        return {"ok": False, "error": "missing caz cookie"}

    # Determine media type
    media_type = "MAGIC_MEDIA" if mode == "image" else "MAGIC_MEDIA_VIDEO"
    aspect_code = ASPECT_RATIOS.get(aspect, ASPECT_RATIOS[DEFAULT_ASPECT])

    # Build request body
    # Always use batch mode (A?=O) for images — single mode (A?=F) generates
    # URLs without .png extension that often return 403
    if mode == "image":
        body = {
            "a": "B",
            "b": {"A": media_type},
            "A?": "O",
            "f": prompt,
            "g": {"A?": "A", "A": aspect_code},
            "k": min(count, 4),
            "BB": False,
        }
    else:
        body = {
            "a": "B",
            "b": {"A": media_type},
            "A?": "F",
            "A": prompt,
            "BB": False,
        }

    try:
        resp = session.post(
            f"{CANVA_BASE}/_ajax/ingredientgeneration", headers=headers, json=body
        )
    except Exception as e:
        return {"ok": False, "error": f"request failed: {e}"}

    if resp.status_code == 403:
        return {"ok": False, "error": "forbidden - cookies expired or invalid"}
    if resp.status_code == 429:
        return {
            "ok": False,
            "error": "rate limited / quota exhausted",
            "quota_exhausted": True,
        }
    if resp.status_code != 200:
        return {
            "ok": False,
            "error": f"create job failed: HTTP {resp.status_code} {resp.text[:200]}",
        }

    data = resp.json()
    job_id = data.get("A", "")
    if not job_id:
        return {"ok": False, "error": f"no job_id in response: {resp.text[:200]}"}

    # Poll for completion
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(POLL_INTERVAL)

        try:
            r = session.get(
                f"{CANVA_BASE}/_ajax/ingredientgeneration?jobId={job_id}",
                headers=headers,
            )
        except Exception:
            continue

        if r.status_code != 200:
            continue

        d = r.json()
        state = d.get("B", "")

        if state == "C":  # Done
            # Canva changed response structure: results moved from F.g to F.f
            # F.f contains dicts with B=url, G=thumbnail, J=width, K=height
            # F.g now contains plain media ID strings (not URLs)
            f_block = d.get("F", {})
            results = f_block.get("f", []) or f_block.get("g", [])
            if not results:
                return {"ok": False, "error": "generation completed but no results"}

            # Normalize: F.f items use J/K for dimensions, F.g items use I/H
            normalized = []
            for item in results:
                if isinstance(item, dict):
                    normalized.append(
                        {
                            "B": item.get("B", ""),
                            "G": item.get("G", ""),
                            "width": item.get("J") or item.get("I"),
                            "height": item.get("K") or item.get("H"),
                        }
                    )
                elif isinstance(item, str) and item.startswith("http"):
                    normalized.append(
                        {"B": item, "G": "", "width": None, "height": None}
                    )
                else:
                    continue

            if not normalized:
                return {
                    "ok": False,
                    "error": "generation completed but no usable results",
                }

            # Single result
            if len(normalized) == 1:
                item = normalized[0]
                return {
                    "ok": True,
                    "media_url": item["B"],
                    "thumbnail_url": item["G"],
                    "width": item["width"],
                    "height": item["height"],
                    "mode": mode,
                    "count": 1,
                }

            # Multiple results
            images = []
            for item in normalized:
                images.append(
                    {
                        "url": item["B"],
                        "thumbnail": item["G"],
                        "width": item["width"],
                        "height": item["height"],
                    }
                )
            return {
                "ok": True,
                "images": images,
                "media_url": images[0]["url"] if images else "",
                "thumbnail_url": images[0]["thumbnail"] if images else "",
                "mode": mode,
                "count": len(images),
            }

        if state == "E":  # Error
            return {"ok": False, "error": "generation failed (state=E)"}

        # state == "B" means still processing, continue polling

    return {"ok": False, "error": f"timeout after {timeout}s (state={state})"}


def fetch_quota(cookies: dict) -> dict:
    """Fetch Canva quota usage."""
    session = build_session(cookies)
    headers = build_headers(cookies)
    headers["x-canva-request"] = "getquota"

    cb = cookies.get("cb", "")
    user_id = cookies.get("user_id", "")

    try:
        resp = session.post(
            f"{CANVA_BASE}/_ajax/quota/quota/get",
            headers=headers,
            json={"A": "C", "B": cb, "C": user_id},
        )
    except Exception as e:
        return {"ok": False, "error": f"quota request failed: {e}"}

    if resp.status_code != 200:
        return {"ok": False, "error": f"quota HTTP {resp.status_code}"}

    q = resp.json().get("A", {})
    raw_used = q.get("C")
    raw_limit = q.get("D")

    if (
        isinstance(raw_used, (int, float))
        and isinstance(raw_limit, (int, float))
        and raw_limit > 0
    ):
        return {
            "ok": True,
            "quota_used": int(raw_used),
            "quota_limit": int(raw_limit),
            "quota_remaining": int(raw_limit) - int(raw_used),
        }

    return {"ok": False, "error": "could not parse quota response"}


def main():
    """Read input from stdin, execute, write output to stdout."""
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError) as e:
        print(json.dumps({"ok": False, "error": f"invalid input: {e}"}))
        sys.exit(1)

    mode = input_data.get("mode", "image")
    cookies = input_data.get("cookies", {})
    prompt = input_data.get("prompt", "")
    timeout = input_data.get("timeout", 90)
    count = input_data.get("count", 1)
    aspect = input_data.get("aspect", DEFAULT_ASPECT)

    if mode == "quota":
        result = fetch_quota(cookies)
    elif mode in ("image", "video"):
        if not prompt:
            result = {"ok": False, "error": "prompt is required"}
        else:
            result = generate_media(cookies, prompt, mode, timeout, count, aspect)
    else:
        result = {"ok": False, "error": f"unknown mode: {mode}"}

    print(json.dumps(result))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
