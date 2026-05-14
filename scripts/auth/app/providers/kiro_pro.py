"""
Kiro Pro provider adapter — separate bot from Kiro Free.

Features:
- Browser engine choice (camoufox or chromium)
- Login and token fetch only (upgrade disabled)
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from typing import Any
from urllib.parse import urlencode

from app.providers.kiro import (
    KiroProviderAdapter,
    KIRO_LOGIN_ENDPOINT,
    KIRO_REDIRECT_URI,
    _generate_pkce_pair,
    _kiro_auth_debug,
)
from app.providers.base import NormalizedAccount


def _emit(data: dict) -> None:
    try:
        print(json.dumps(data), flush=True)
    except BrokenPipeError:
        pass


def _debug(msg: str) -> None:
    _kiro_auth_debug(msg)


class KiroProProviderAdapter(KiroProviderAdapter):
    name = "kiro-pro"

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        engine = os.getenv("BATCHER_BROWSER_ENGINE", "chromium").lower()

        if engine == "chromium":
            try:
                return await self._bootstrap_chromium(account)
            except Exception as e:
                _debug(f"chromium launch failed: {e}, falling back to camoufox")
                _emit({
                    "type": "progress",
                    "provider": "kiro-pro",
                    "step": "browser_fallback",
                    "message": "Chromium unavailable, using camoufox",
                })

        return await self._bootstrap_camoufox(account)

    async def _bootstrap_camoufox(self, account: NormalizedAccount) -> Any:
        """Launch Camoufox with route handler that doesn't abort OAuth redirect."""
        from browserforge.fingerprints import Screen
        from camoufox.async_api import AsyncCamoufox
        from app.providers.kiro import _extract_code_from_kiro_url

        code_verifier, code_challenge = _generate_pkce_pair()
        state: dict[str, Any] = {
            "auth_code": None,
            "code_verifier": code_verifier,
            "stub": False,
            "engine": "camoufox",
        }

        headless_requested = os.getenv("BATCHER_CAMOUFOX_HEADLESS", "true").lower() == "true"
        has_display = bool(os.getenv("DISPLAY") or os.getenv("WAYLAND_DISPLAY"))
        headless = headless_requested if has_display else True

        try:
            camoufox_kwargs: dict[str, Any] = {
                "headless": headless,
                "os": "windows",
                "block_webrtc": True,
                "humanize": False,
                "screen": Screen(max_width=1920, max_height=1080),
            }
            proxy_url = os.getenv("BATCHER_PROXY_URL", "")
            if proxy_url:
                from urllib.parse import urlparse
                parsed = urlparse(proxy_url)
                proxy_cfg: dict[str, Any] = {
                    "server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
                }
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

            def on_response(response: Any) -> None:
                if state.get("auth_code"):
                    return
                try:
                    location = response.headers.get("location", "")
                    code = _extract_code_from_kiro_url(location)
                    if code:
                        state["auth_code"] = code
                except Exception:
                    return

            page.on("response", on_response)

            async def route_handler(route: Any) -> None:
                if state.get("auth_code"):
                    await route.continue_()
                    return
                req_url = route.request.url
                code = _extract_code_from_kiro_url(req_url)
                if code:
                    state["auth_code"] = code
                    await route.continue_()
                    return
                await route.continue_()

            await page.route("**/*", route_handler)

            auth_url = f"{KIRO_LOGIN_ENDPOINT}?" + urlencode({
                "idp": "Google",
                "redirect_uri": KIRO_REDIRECT_URI,
                "code_challenge": code_challenge,
                "code_challenge_method": "S256",
                "state": str(uuid.uuid4()),
            })
            await page.goto(auth_url, wait_until="domcontentloaded", timeout=20000)

            state.update({
                "manager": manager,
                "browser": browser,
                "page": page,
                "account": account.identifier,
            })
            return state

        except Exception as exc:
            from app.errors.codes import ErrorCode
            from app.errors.exceptions import RetryableBatcherError
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                str(exc) or "camoufox bootstrap failed",
            )

    async def _bootstrap_chromium(self, account: NormalizedAccount) -> Any:
        """Launch Chromium via Playwright with stealth settings."""
        from playwright.async_api import async_playwright

        headless = os.getenv("BATCHER_CAMOUFOX_HEADLESS", "true").lower() == "true"
        proxy_url = os.getenv("BATCHER_PROXY_URL", "")

        code_verifier, code_challenge = _generate_pkce_pair()
        state: dict[str, Any] = {
            "auth_code": None,
            "code_verifier": code_verifier,
            "stub": False,
            "engine": "chromium",
        }

        try:
            pw = await async_playwright().start()

            launch_kwargs: dict[str, Any] = {
                "headless": headless,
                "args": [
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                ],
            }

            if proxy_url:
                from urllib.parse import urlparse
                parsed = urlparse(proxy_url)
                proxy_cfg: dict[str, Any] = {
                    "server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
                }
                if parsed.username:
                    proxy_cfg["username"] = parsed.username
                if parsed.password:
                    proxy_cfg["password"] = parsed.password
                launch_kwargs["proxy"] = proxy_cfg

            browser = await pw.chromium.launch(**launch_kwargs)
            context = await browser.new_context(
                viewport={"width": 1920, "height": 1080},
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            )

            # Stealth: remove webdriver flag
            await context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            """)

            page = await context.new_page()
            page.set_default_timeout(15000)

            from app.providers.kiro import _extract_code_from_kiro_url

            def on_response(response: Any) -> None:
                if state.get("auth_code"):
                    return
                try:
                    location = response.headers.get("location", "")
                    code = _extract_code_from_kiro_url(location)
                    if code:
                        state["auth_code"] = code
                except Exception:
                    pass

            page.on("response", on_response)

            async def route_handler(route: Any) -> None:
                if state.get("auth_code"):
                    await route.continue_()
                    return
                req_url = route.request.url
                code = _extract_code_from_kiro_url(req_url)
                if code:
                    state["auth_code"] = code
                    await route.continue_()
                    return
                await route.continue_()

            await page.route("**/*", route_handler)

            auth_url = f"{KIRO_LOGIN_ENDPOINT}?" + urlencode({
                "idp": "Google",
                "redirect_uri": KIRO_REDIRECT_URI,
                "code_challenge": code_challenge,
                "code_challenge_method": "S256",
                "state": str(uuid.uuid4()),
            })

            await page.goto(auth_url, wait_until="domcontentloaded", timeout=20000)

            state.update({
                "page": page,
                "context": context,
                "browser": browser,
                "playwright": pw,
                "account": account.identifier,
            })
            return state

        except Exception as exc:
            from app.errors.codes import ErrorCode
            from app.errors.exceptions import RetryableBatcherError
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                str(exc) or "chromium bootstrap failed",
            )

    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any = None,
    ) -> dict[str, str]:
        # Get tokens from parent (HTTP token exchange, doesn't need browser)
        return await super().fetch_tokens(account, auth_state, session)

    async def post_login_hook(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
        existing_quota: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """Auto-upgrade to Pro tier after successful login."""
        upgrade_flag = os.getenv("BATCHER_KIRO_PRO_UPGRADE", "")
        _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_check",
               "message": f"BATCHER_KIRO_PRO_UPGRADE={upgrade_flag!r}"})
        if upgrade_flag.lower() != "true":
            return None

        from app.providers.kiro_pro_upgrade import (
            generate_stripe_url,
            run_stripe_autopay,
        )
        from app.providers.vcc_pool import VCCPool

        # Check if already Pro tier using existing quota or fresh fetch
        pre_quota = existing_quota
        if pre_quota is None:
            try:
                pre_quota = await self.fetch_quota(account, tokens, session)
            except Exception:
                pass

        if isinstance(pre_quota, dict):
            pre_tier = pre_quota.get("account_tier", "")
            if "pro" in pre_tier.lower():
                _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_complete",
                       "message": f"Already Pro tier ({pre_tier}), skipping upgrade"})
                return {
                    "upgrade_success": True,
                    "upgrade_tier": pre_tier,
                    "card_last4": "",
                    "quota": pre_quota,
                }

        _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_start",
               "message": "Starting Pro upgrade..."})

        access_token = tokens.get("access_token", "")
        profile_arn = tokens.get("profile_arn", "")

        # Step 1: Generate Stripe URL
        _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_generating_url",
               "message": "Generating Stripe checkout URL..."})
        stripe_url = await generate_stripe_url(access_token, profile_arn)
        if not stripe_url:
            return {"upgrade_success": False, "upgrade_error": "stripe_url_generation_failed"}

        _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_url_ok",
               "message": "Stripe URL obtained"})

        # Step 2: Get card from VCC pool
        pool = VCCPool.from_env()
        if pool.remaining() == 0:
            _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_no_cards",
                   "message": "No VCC cards available in pool"})
            return {"upgrade_success": False, "upgrade_error": "no_cards_available"}

        address = json.loads(os.getenv("BATCHER_BILLING_ADDRESS", "{}"))
        page = session.get("page") if isinstance(session, dict) else None
        if not page:
            return {"upgrade_success": False, "upgrade_error": "no_browser_page_for_upgrade"}

        # Step 3: Iterate cards until success or pool exhausted
        last_error = "no_cards_tried"
        for card in pool:
            card_dict = {
                "number": card.number,
                "exp_month": card.exp_month,
                "exp_year": card.exp_year,
                "cvv": card.cvv,
                "name": card.name,
            }

            success, message, card_status = await run_stripe_autopay(
                page, stripe_url, card_dict, address
            )

            _emit({"type": "upgrade_card_result", "provider": "kiro-pro",
                   "card_last4": card.last4, "card_status": card_status})

            if success:
                pool.mark_success(card)
                # Step 4: Verify Pro tier (with retry — Kiro API may take time to propagate)
                _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_verifying",
                       "message": "Payment complete, verifying Pro tier..."})
                for verify_attempt in range(5):
                    try:
                        if verify_attempt > 0:
                            await asyncio.sleep(3.0)
                        quota = await self.fetch_quota(account, tokens, session)
                        tier = (quota or {}).get("account_tier", "")
                        if "pro" in tier.lower():
                            _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_complete",
                                   "message": f"Upgraded to {tier}"})
                            return {
                                "upgrade_success": True,
                                "upgrade_tier": tier,
                                "card_last4": card.last4,
                                "quota": quota,
                            }
                    except Exception:
                        pass
                # Payment succeeded but tier not reflected yet — still count as success
                _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_complete",
                       "message": "Payment succeeded (tier propagation pending)"})
                return {
                    "upgrade_success": True,
                    "upgrade_tier": "Pro (pending)",
                    "card_last4": card.last4,
                }

            if card_status == "declined":
                pool.mark_declined(card)
                _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_card_declined",
                       "message": f"Card ****{card.last4} declined, trying next..."})
                last_error = message
                continue
            else:
                last_error = message
                break

        _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_failed",
               "message": f"Upgrade failed: {last_error}"})
        return {"upgrade_success": False, "upgrade_error": last_error}

    async def cleanup_session(self, session: Any) -> None:
        """Clean up browser session (supports both camoufox and chromium)."""
        if not isinstance(session, dict):
            return

        engine = session.get("engine", "camoufox")

        if engine == "chromium":
            browser = session.get("browser")
            pw = session.get("playwright")
            try:
                if browser:
                    await browser.close()
            except Exception:
                pass
            try:
                if pw:
                    await pw.stop()
            except Exception:
                pass
        else:
            await super().cleanup_session(session)
