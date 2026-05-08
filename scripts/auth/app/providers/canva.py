from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from typing import Any

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter
from app.providers.kiro import (
    _fill_google_email_step,
    _fill_google_password_step,
    _handle_google_gaplustos,
    _handle_google_consent_continue,
    _detect_google_blocking_challenge,
    _is_email_step,
    _is_password_step,
    _click_continue_button,
)

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

CANVA_LOGIN_URL = "https://www.canva.com/login"
CANVA_QUOTA_URL = "https://www.canva.com/_ajax/quota/quota/get"


class CanvaProviderAdapter(ProviderAdapter):
    name = "canva"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [p.strip() for p in raw_line.split("|")]
        if len(parts) != 2:
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "canva account must be email|password",
            )
        email, password = parts
        if not email or not password:
            raise NonRetryableBatcherError(
                ErrorCode.input_missing_required_field,
                "canva account requires email and password",
            )
        if not _EMAIL_PATTERN.match(email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "canva account email format is invalid",
            )
        return NormalizedAccount(
            provider=self.name, identifier=email, secret=password, raw=raw_line
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        try:
            from browserforge.fingerprints import Screen
            from camoufox.async_api import AsyncCamoufox

            camoufox_kwargs: dict[str, Any] = {
                "headless": os.getenv("BATCHER_CAMOUFOX_HEADLESS", "true").lower() == "true",
                "os": "windows",
                "block_webrtc": True,
                "humanize": False,
                "screen": Screen(max_width=1920, max_height=1080),
            }
            proxy_url = os.getenv("BATCHER_PROXY_URL", "")
            if proxy_url:
                from urllib.parse import urlparse
                parsed = urlparse(proxy_url)
                proxy_cfg: dict[str, Any] = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
                if parsed.username:
                    proxy_cfg["username"] = parsed.username
                if parsed.password:
                    proxy_cfg["password"] = parsed.password
                camoufox_kwargs["proxy"] = proxy_cfg
                camoufox_kwargs["geoip"] = True

            manager = AsyncCamoufox(**camoufox_kwargs)
            browser = await manager.__aenter__()
            page = await browser.new_page()
            page.set_default_timeout(15000)

            await page.goto(CANVA_LOGIN_URL, wait_until="domcontentloaded", timeout=20000)
            await asyncio.sleep(3)

            return {
                "manager": manager,
                "browser": browser,
                "page": page,
                "popup": None,
                "cookies": None,
            }
        except Exception as exc:
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                str(exc) or "canva camoufox bootstrap failed",
            ) from exc

    async def authenticate(self, account: NormalizedAccount, session: Any) -> dict[str, Any]:
        if session is None or session.get("stub"):
            return {"authenticated": True}

        page = session["page"]

        async with page.expect_popup() as popup_info:
            await page.evaluate("""() => {
                for (const el of document.querySelectorAll('button, a, div[role="button"]')) {
                    if ((el.textContent||'').toLowerCase().includes('google') && el.offsetParent) {
                        el.click(); return;
                    }
                }
            }""")
        popup = await popup_info.value
        session["popup"] = popup
        await asyncio.sleep(2)

        if "accounts.google.com" not in popup.url:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state,
                f"canva: expected Google OAuth, got {popup.url[:80]}",
            )

        email_done = False
        password_done = False

        for _ in range(60):
            try:
                current_url = popup.url
            except Exception:
                break

            if "accounts.google.com" not in current_url:
                break

            try:
                if await _handle_google_gaplustos(popup):
                    await asyncio.sleep(0.8)
                    continue

                if await _handle_google_consent_continue(popup):
                    await asyncio.sleep(0.8)
                    continue

                at_email = await _is_email_step(popup)
                at_password = await _is_password_step(popup)

                if at_email and not email_done:
                    if await _fill_google_email_step(popup, account.identifier):
                        email_done = True
                        await asyncio.sleep(1)
                        continue

                if at_password and not password_done:
                    if await _fill_google_password_step(popup, account.secret):
                        password_done = True
                        await asyncio.sleep(1)
                        continue

                if not at_email and not at_password:
                    challenge = await _detect_google_blocking_challenge(popup)
                    if challenge:
                        raise RetryableBatcherError(
                            ErrorCode.browser_challenge_blocked,
                            f"canva: Google challenge detected: {challenge}",
                        )

                await _click_continue_button(popup)
            except RetryableBatcherError:
                raise
            except NonRetryableBatcherError:
                raise
            except Exception:
                break

            await asyncio.sleep(1)

        for _ in range(10):
            try:
                _ = popup.url
                await asyncio.sleep(1)
            except Exception:
                break

        await asyncio.sleep(2)

        try:
            await page.evaluate("""() => {
                for (const el of document.querySelectorAll('button, a, div[role="button"]')) {
                    const txt = (el.textContent || '').toLowerCase().trim();
                    if ((txt.includes('skip') || txt.includes('lewati') || txt.includes('not now') || txt.includes('nanti')) && el.offsetParent !== null) {
                        el.click(); return;
                    }
                }
            }""")
            await asyncio.sleep(1)
        except Exception:
            pass

        cookies = await page.context.cookies()
        canva_cookies = {}
        for c in cookies:
            if "canva.com" in c.get("domain", ""):
                canva_cookies[c["name"]] = c["value"]

        if not canva_cookies.get("CAZ"):
            await page.reload()
            await asyncio.sleep(3)
            cookies = await page.context.cookies()
            for c in cookies:
                if "canva.com" in c.get("domain", ""):
                    canva_cookies[c["name"]] = c["value"]

        if not canva_cookies.get("CAZ"):
            raise NonRetryableBatcherError(
                ErrorCode.auth_invalid_credentials,
                "canva: login failed — no CAZ cookie after OAuth",
            )

        session["cookies"] = canva_cookies
        return {"authenticated": True, "cookies": canva_cookies}

    async def fetch_tokens(self, account: NormalizedAccount, auth_state: dict[str, Any], session: Any) -> dict[str, str]:
        cookies = auth_state.get("cookies") or (session or {}).get("cookies") or {}
        if not cookies.get("CAZ"):
            raise NonRetryableBatcherError(
                ErrorCode.provider_unsupported_response,
                "canva: no CAZ cookie",
            )

        cau = cookies.get("CAU", "")
        user_id = ""
        try:
            user_info = json.loads(base64.b64decode(cau + "=="))
            user_id = user_info.get("A", "")
        except Exception:
            pass

        return {
            "caz": cookies.get("CAZ", ""),
            "cb": cookies.get("CB", ""),
            "cau": cau,
            "user_id": user_id,
            "cl": cookies.get("CL", ""),
            "cs": cookies.get("CS", ""),
            "cdi": cookies.get("CDI", ""),
            "cid": cookies.get("CID", ""),
            "cui": cookies.get("CUI", ""),
            "cul": cookies.get("CUL", ""),
            "cf_clearance": cookies.get("cf_clearance", ""),
            "all_cookies": json.dumps(cookies),
        }

    async def fetch_quota(self, account: NormalizedAccount, tokens: dict[str, str], session: Any) -> dict[str, Any] | None:
        import aiohttp
        import ssl

        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE

        caz = tokens.get("caz", "")
        cb = tokens.get("cb", "")
        cau = tokens.get("cau", "")
        user_id = tokens.get("user_id", "")

        cookie_str = f"CAZ={caz}; CB={cb}; CAU={cau}"
        headers = {
            "Content-Type": "application/json;charset=UTF-8",
            "Origin": "https://www.canva.com",
            "Referer": "https://www.canva.com/ai",
            "Cookie": cookie_str,
            "x-canva-authz": caz,
            "x-canva-brand": cb,
            "x-canva-user": user_id,
            "x-canva-active-user": cau,
            "x-canva-accept-prefix": "no-prefix",
            "x-canva-request": "getquota",
            "x-canva-app": "home",
        }

        try:
            timeout = aiohttp.ClientTimeout(total=15)
            async with aiohttp.ClientSession(timeout=timeout) as client:
                async with client.post(
                    CANVA_QUOTA_URL,
                    json={"A": "C", "B": cb, "C": user_id},
                    headers=headers,
                    ssl=ssl_ctx,
                ) as resp:
                    if resp.status != 200:
                        return {"limit": 100, "remaining": 100}
                    data = await resp.json()
                    q = data.get("A", {})
                    used = q.get("C", 0)
                    limit = q.get("D", 100)
                    return {
                        "limit": float(limit),
                        "remaining": float(limit - used),
                        "remaining_credits": float(limit - used),
                        "total_credits": float(limit),
                        "current_usage": float(used),
                    }
        except Exception:
            return {"limit": 100, "remaining": 100}

    async def cleanup_session(self, session: Any) -> None:
        if not isinstance(session, dict):
            return
        manager = session.get("manager")
        if manager:
            try:
                await manager.__aexit__(None, None, None)
            except Exception:
                pass
