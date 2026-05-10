from __future__ import annotations

import asyncio
import hashlib
import base64
import json
import os
import re
import secrets
import time
import uuid
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import aiohttp

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# Moclaw auth constants
_MOCLAW_AUTH0_DOMAIN = "https://login.us.auth0.com"
_MOCLAW_GOOGLE_CLIENT_ID = "870216976608-q7pjgck3d643hi35crp0u49p3gtph36a.apps.googleusercontent.com"
_MOCLAW_REDIRECT_URI = f"{_MOCLAW_AUTH0_DOMAIN}/login/callback"
_MOCLAW_SCOPE = "openid profile email"
_MOCLAW_BASE_URL = "https://moclaw.ai"


def _moclaw_debug(msg: str) -> None:
    if os.getenv("BATCHER_DEBUG", "").lower() == "true":
        print(f"[moclaw-debug] {msg}", flush=True)


def _generate_pkce_pair() -> tuple[str, str]:
    code_verifier = secrets.token_urlsafe(32)
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge


def _extract_code_from_callback(url: str) -> str | None:
    """Extract authorization code from Auth0 callback URL."""
    if "/login/callback" not in url:
        return None
    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    codes = params.get("code")
    if codes:
        return codes[0]
    return None


# ─── Google OAuth helpers (reused from kiro/windsurf patterns) ──────────

async def _is_email_step(page: Any) -> bool:
    try:
        return bool(
            await page.evaluate(
                """() => {
                    const input = document.querySelector('input[type="email"]');
                    if (input && input.offsetParent !== null) return true;
                    const identifierEl = document.querySelector('#identifierId');
                    if (identifierEl && identifierEl.offsetParent !== null) return true;
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _is_password_step(page: Any) -> bool:
    try:
        return bool(
            await page.evaluate(
                """() => {
                    const inputs = document.querySelectorAll('input[type="password"]');
                    for (const input of inputs) {
                        if (input.offsetParent !== null) return true;
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _wait_for_google_email_transition(page: Any) -> None:
    for _ in range(12):
        await asyncio.sleep(0.5)
        if await _is_password_step(page):
            return
        try:
            if "accounts.google.com" not in page.url:
                return
        except Exception:
            return


async def _wait_for_google_password_transition(page: Any) -> None:
    for _ in range(16):
        await asyncio.sleep(0.5)
        if not await _is_password_step(page):
            return
        try:
            if "accounts.google.com" not in page.url:
                return
        except Exception:
            return


async def _fill_google_email_step(page: Any, email: str) -> bool:
    try:
        selectors = [
            'input[type="email"]',
            "#identifierId",
            'input[name="identifier"]',
        ]
        for selector in selectors:
            locator = page.locator(selector).first
            try:
                if await locator.count() == 0 or not await locator.is_visible():
                    continue
                await locator.click()
                await locator.fill(email)
                await asyncio.sleep(0.3)

                # Click Next
                clicked = await page.evaluate(
                    """() => {
                        for (const sel of ['#identifierNext button', '#passwordNext button', '#submit']) {
                            const el = document.querySelector(sel);
                            if (el && el.offsetParent !== null) { el.click(); return true; }
                        }
                        for (const btn of document.querySelectorAll('button, div[role="button"]')) {
                            if (!btn.offsetParent) continue;
                            const txt = (btn.textContent || '').toLowerCase().trim();
                            if (['next','continue','lanjutkan','berikutnya','далее'].some(k => txt.includes(k))) {
                                btn.click(); return true;
                            }
                        }
                        return false;
                    }"""
                )
                if not clicked:
                    await locator.press("Enter")
                await _wait_for_google_email_transition(page)
                return True
            except Exception:
                continue
        return False
    except Exception:
        return False


async def _fill_google_password_step(page: Any, password: str) -> bool:
    try:
        selectors = [
            'input[type="password"]',
            'input[name="Passwd"]',
            'input[name="password"]',
        ]
        for selector in selectors:
            locator = page.locator(selector).first
            try:
                if await locator.count() == 0 or not await locator.is_visible():
                    continue
                await locator.click()
                await locator.fill(password)
                await asyncio.sleep(0.3)

                value = await locator.input_value()
                if len(str(value)) < len(password):
                    continue

                clicked = await page.evaluate(
                    """() => {
                        for (const sel of ['#passwordNext button', '#submit', '#identifierNext button']) {
                            const el = document.querySelector(sel);
                            if (el && el.offsetParent !== null) { el.click(); return true; }
                        }
                        for (const btn of document.querySelectorAll('button, div[role="button"]')) {
                            if (!btn.offsetParent) continue;
                            const txt = (btn.textContent || '').toLowerCase().trim();
                            if (['next','continue','lanjutkan','berikutnya','далее'].some(k => txt.includes(k))) {
                                btn.click(); return true;
                            }
                        }
                        return false;
                    }"""
                )
                if not clicked:
                    await locator.press("Enter")
                await _wait_for_google_password_transition(page)
                return True
            except Exception:
                continue
        return False
    except Exception:
        return False


async def _handle_google_consent(page: Any) -> bool:
    try:
        current_url = page.url
        if "accounts.google.com" not in current_url:
            return False
        return bool(
            await page.evaluate(
                """() => {
                    const el = document.querySelector('#submit_approve_access button, #submit_approve_access');
                    if (el && el.offsetParent !== null) { el.click(); return true; }
                    const keywords = ['continue','allow','lanjut','izinkan','разрешить','продолжить',
                        'weiter','erlauben','continuer','autoriser','continuar','permitir','続行','허용','继续','允许'];
                    for (const btn of document.querySelectorAll('button, div[role="button"]')) {
                        const txt = (btn.textContent || '').trim().toLowerCase();
                        if (!txt || btn.offsetParent === null) continue;
                        if (keywords.some(k => txt.includes(k))) { btn.click(); return true; }
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _handle_google_gaplustos(page: Any) -> bool:
    try:
        current_url = page.url
        if "/speedbump/gaplustos" not in current_url:
            return False
        for selector in [
            "#gaplustosNext button",
            "#confirm",
            'input[name="confirm"]',
            'input[type="submit"]',
        ]:
            locator = page.locator(selector).first
            try:
                if await locator.count() == 0 or not await locator.is_visible():
                    continue
                await locator.click(force=True)
                return True
            except Exception:
                continue
        return False
    except Exception:
        return False


async def _detect_google_challenge(page: Any) -> str | None:
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "accounts.google.com" not in current_url:
        return None
    try:
        marker = str(
            await page.evaluate(
                """() => {
                    const text = (document.body?.innerText || '').toLowerCase();
                    const markers = [
                        'captcha',
                        'try again later',
                        'this browser or app may not be secure',
                        'this browser may not be secure',
                        'unusual traffic',
                        "verify it's you",
                        "confirm it's you",
                    ];
                    for (const candidate of markers) {
                        if (text.includes(candidate)) return candidate;
                    }
                    const path = window.location.pathname || '';
                    if (path.includes('/challenge/') && !path.includes('/challenge/pwd')) {
                        return 'google challenge';
                    }
                    return '';
                }"""
            )
        ).strip()
        return marker or None
    except Exception:
        return None


async def _click_continue_button(page: Any) -> None:
    await page.evaluate(
        """() => {
            for (const sel of ['#gaplustosNext button', '#identifierNext button', '#passwordNext button', '#submit', '#confirm']) {
                const el = document.querySelector(sel);
                if (el && el.offsetParent !== null) { el.click(); return; }
            }
            for (const btn of document.querySelectorAll('button, div[role="button"], input[type="submit"]')) {
                if (!btn.offsetParent) continue;
                const txt = (btn.textContent || btn.value || '').toLowerCase().trim();
                if (!txt) continue;
                const keywords = ['next','continue','accept','understand','agree','ok','got it','login','sign in',
                    'mengerti','lanjutkan','setuju','masuk','lewati','berikutnya',
                    'далее','продолжить','принять','понятно','войти','пропустить',
                    'зрозуміло','далі','продовжити','прийняти','увійти','пропустити',
                    'weiter','akzeptieren','verstanden','anmelden',
                    'suivant','continuer','accepter','compris',
                    'siguiente','continuar','aceptar','entendido',
                    'avanti','continua','accetta','capito',
                    'próximo','aceitar','entendi',
                    '次へ','続行','同意','ログイン',
                    '다음','계속','동의','로그인',
                    '下一步','继续','同意','登录',
                    'ถัดไป','ดำเนินการต่อ','ยอมรับ','เข้าสู่ระบบ'];
                if (keywords.some((k) => txt.includes(k))) { btn.click(); return; }
            }
        }"""
    )


async def _click_google_account_in_chooser(page: Any, identifier: str) -> bool:
    """Try to click a matching account in Google's account chooser."""
    try:
        # Find any account tile matching the email identifier
        return bool(
            await page.evaluate(
                f"""() => {{
                    const email = {json.dumps(identifier)};
                    // Try to find account by displayed email or name
                    const tiles = document.querySelectorAll('[data-identifier], [data-email]');
                    for (const tile of tiles) {{
                        const d = (tile.getAttribute('data-identifier') || tile.getAttribute('data-email') || '');
                        if (d.toLowerCase().trim() === email.toLowerCase().trim()) {{
                            tile.click(); return true;
                        }}
                    }}
                    // Fallback: click on any div containing the email text
                    const allDivs = document.querySelectorAll('div, span');
                    for (const el of allDivs) {{
                        if ((el.textContent || '').toLowerCase().trim() === email.toLowerCase().trim()) {{
                            el.click(); return true;
                        }}
                    }}
                    return false;
                }}"""
            )
        )
    except Exception:
        return False


# ─── Provider Adapter ───────────────────────────────────────────────────


class MoclawProviderAdapter(ProviderAdapter):
    name = "moclaw"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [part.strip() for part in raw_line.split("|")]

        if len(parts) < 2:
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "moclaw account must be email|password (Google account credentials)",
            )

        email = parts[0]
        password = parts[1]

        if not email or not password:
            raise NonRetryableBatcherError(
                ErrorCode.input_missing_required_field,
                "moclaw account requires email and password",
            )

        if not _EMAIL_PATTERN.match(email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "moclaw account email format is invalid",
            )

        return NormalizedAccount(
            provider=self.name,
            identifier=email,
            secret=password,
            raw=raw_line,
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        """
        Launch Camoufox and navigate to moclaw.ai/auth.
        The actual Google OAuth link (with correct Auth0 state) will be
        obtained by clicking "Continue with Google" in authenticate().
        """
        if os.getenv("BATCHER_ENABLE_CAMOUFOX", "false").lower() != "true":
            return {"stub": True}

        try:
            from browserforge.fingerprints import Screen
            from camoufox.async_api import AsyncCamoufox

            state: dict[str, Any] = {
                "auth_code": None,
                "stub": False,
            }

            camoufox_kwargs: dict[str, Any] = {
                "headless": os.getenv("BATCHER_CAMOUFOX_HEADLESS", "true").lower()
                == "true",
                "os": "windows",
                "block_webrtc": True,
                "humanize": False,
                "screen": Screen(max_width=1920, max_height=1080),
            }

            proxy_url = os.getenv("BATCHER_PROXY_URL", "")
            if proxy_url:
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
            page.set_default_timeout(20000)

            # Intercept responses to catch callback redirect
            def on_response(response: Any) -> None:
                if state.get("auth_code"):
                    return
                try:
                    location = response.headers.get("location", "")
                    code = _extract_code_from_callback(location)
                    if code:
                        state["auth_code"] = code
                        _moclaw_debug(f"Got auth code from redirect header: {code[:20]}...")
                except Exception:
                    return

            page.on("response", on_response)

            # Intercept requests to catch navigation to callback URL
            async def route_handler(route: Any) -> None:
                if state.get("auth_code"):
                    await route.continue_()
                    return

                request_url = route.request.url
                code = _extract_code_from_callback(request_url)
                if code:
                    state["auth_code"] = code
                    _moclaw_debug(f"Got auth code from request intercept: {code[:20]}...")
                    await route.continue_()
                    return
                await route.continue_()

            await page.route("**/*", route_handler)

            # Clear any stale cookies / localStorage to ensure a completely fresh browser session
            try:
                await page.context.clear_cookies()
                await page.evaluate("() => { try { localStorage.clear(); } catch(e) {} }")
                _moclaw_debug("Cleared cookies and localStorage for fresh session")
            except Exception as e:
                _moclaw_debug(f"Clear cookies failed: {e}")

            _moclaw_debug("Navigating to moclaw.ai/auth...")
            await page.goto(f"{_MOCLAW_BASE_URL}/auth", wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(1.5)

            state.update(
                {
                    "manager": manager,
                    "browser": browser,
                    "page": page,
                    "account": account.identifier,
                }
            )
            return state
        except Exception as exc:
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                str(exc) or "camoufox bootstrap failed for moclaw",
            ) from exc

    async def authenticate(
        self, account: NormalizedAccount, session: Any
    ) -> dict[str, Any]:
        """
        1. Click "Continue with Google" on moclaw.ai/auth to get the real OAuth URL.
        2. Handle Google email/password/sign-in flow.
        3. Wait for redirect back to moclaw.ai after successful login.
        """
        if session is None or session.get("stub"):
            return {
                "authenticated": True,
                "authorization_code": "stub-auth-code",
                "code_verifier": "stub-code-verifier",
            }

        page = session.get("page")
        if page is None:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state, "missing browser page"
            )

        email_transition_deadline = 0.0
        password_transition_deadline = 0.0
        email_step_started_at: float | None = None
        clicked_google = False

        for _ in range(120):
            code = session.get("auth_code")
            if code:
                _moclaw_debug("Auth code captured via intercept! Waiting for redirect to /chat...")
                # Wait for browser to actually land on moclaw.ai/chat
                for _ in range(30):
                    try:
                        cur = page.url
                        if "moclaw.ai" in cur and "/chat" in cur:
                            _moclaw_debug(f"Landed on /chat: {cur}")
                            break
                        if "moclaw.ai" in cur and "/auth" not in cur and "accounts.google.com" not in cur:
                            _moclaw_debug(f"Landed on moclaw.ai (not /chat): {cur}")
                            break
                    except Exception:
                        pass
                    await asyncio.sleep(1.0)
                return {
                    "authenticated": True,
                    "authorization_code": code,
                }

            try:
                current_url = page.url
            except Exception:
                raise RetryableBatcherError(
                    ErrorCode.browser_unexpected_state, "browser page lost"
                )

            parsed_url = urlparse(current_url)
            current_host = parsed_url.netloc or ""
            now = time.monotonic()

            # Check direct callback URL
            code_from_url = _extract_code_from_callback(current_url)
            if code_from_url:
                session["auth_code"] = code_from_url
                _moclaw_debug("Auth code found in current URL")
                return {
                    "authenticated": True,
                    "authorization_code": code_from_url,
                }

            # If we landed on moclaw.ai after login, the code may have been consumed already
            if "moclaw.ai" in current_host and "/login/callback" not in current_url and "/auth" not in current_url:
                _moclaw_debug(f"Landed on moclaw post-login: {current_url}")
                if session.get("auth_code"):
                    return {
                        "authenticated": True,
                        "authorization_code": session["auth_code"],
                    }
                return {
                    "authenticated": True,
                    "authorization_code": "",
                    "logged_in_directly": True,
                }

            # On moclaw auth page — click Continue with Google if not yet clicked
            if current_host in ("moclaw.ai", "www.moclaw.ai") and "/auth" in current_url and not clicked_google:
                try:
                    clicked = await page.evaluate(
                        """() => {
                            const btns = document.querySelectorAll('button');
                            for (const btn of btns) {
                                const txt = (btn.textContent || '').toLowerCase();
                                if (txt.includes('continue with google') || txt.includes('google')) {
                                    btn.click(); return true;
                                }
                            }
                            return false;
                        }"""
                    )
                    if clicked:
                        _moclaw_debug("Clicked 'Continue with Google' on moclaw.ai/auth")
                        clicked_google = True
                        await asyncio.sleep(2.5)
                        continue
                    else:
                        # Fallback: try Playwright locator
                        loc = page.locator('button:has-text("Continue with Google"), button:has-text("Google")').first
                        if await loc.count() > 0 and await loc.is_visible():
                            await loc.click()
                            _moclaw_debug("Clicked 'Continue with Google' via locator")
                            clicked_google = True
                            await asyncio.sleep(2.5)
                            continue
                except Exception as e:
                    _moclaw_debug(f"Failed to click Google button: {e}")
                # If we can't find the button but we're still on /auth, maybe already logged in?
                _moclaw_debug("No Google button found, checking if already logged in...")
                await asyncio.sleep(1)
                continue

            # Google OAuth pages
            if "accounts.google.com" in current_host:
                if "SetSID" in current_url or "/accounts/set" in current_url.lower():
                    await asyncio.sleep(0.5)
                    continue

                if await _handle_google_gaplustos(page):
                    await asyncio.sleep(0.8)
                    continue

                if await _handle_google_consent(page):
                    await asyncio.sleep(0.8)
                    continue

                challenge = await _detect_google_challenge(page)
                if challenge:
                    raise NonRetryableBatcherError(
                        ErrorCode.browser_challenge_blocked,
                        f"Google blocked login: {challenge}",
                    )

                at_password_step = await _is_password_step(page)
                at_email_step = await _is_email_step(page)

                if at_email_step and not at_password_step:
                    if email_step_started_at is None:
                        email_step_started_at = now
                    elif now - email_step_started_at > 60.0:
                        raise RetryableBatcherError(
                            ErrorCode.browser_challenge_blocked,
                            "moclaw: email step stuck > 60s (possible captcha)",
                        )
                    if now < email_transition_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    if await _fill_google_email_step(page, account.identifier):
                        email_transition_deadline = time.monotonic() + 6.0
                        _moclaw_debug(f"Email filled: {account.identifier}")
                        await asyncio.sleep(1.0)
                        continue

                if at_password_step:
                    email_step_started_at = None
                    if now < password_transition_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    if await _fill_google_password_step(page, account.secret):
                        password_transition_deadline = time.monotonic() + 8.0
                        _moclaw_debug("Password filled")
                        await asyncio.sleep(1.5)
                        continue

                # Account chooser (when already signed into Google)
                if "/signin/accountchooser" in current_url or "/v3/signin" in current_url:
                    if await _click_google_account_in_chooser(page, account.identifier):
                        _moclaw_debug("Clicked matching Google account in chooser")
                        await asyncio.sleep(1.5)
                        continue

            await _click_continue_button(page)
            await asyncio.sleep(0.5)

        raise RetryableBatcherError(
            ErrorCode.auth_timeout,
            "Moclaw Google OAuth login timed out after 60s",
        )

    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any,
    ) -> dict[str, str]:
        """
        After successful OAuth redirect to moclaw.ai:
        1. Navigate to /chat
        2. Activate free trial if button present
        3. Extract moclaw.ai cookies as session credentials
        """
        if session is None or session.get("stub"):
            return {"access_token": "stub-moclaw-token", "email": account.identifier}

        page = session.get("page")
        if not page:
            raise RetryableBatcherError(
                ErrorCode.auth_token_extraction_failed,
                "No browser page available for token extraction",
            )

        # Ensure we're on moclaw.ai
        try:
            current_url = page.url
            _moclaw_debug(f"fetch_tokens current URL: {current_url}")
        except Exception as e:
            _moclaw_debug(f"Could not get current URL: {e}")
            current_url = ""

        # Navigate to /chat only if not already there
        if "moclaw.ai/chat" not in current_url:
            try:
                _moclaw_debug("Navigating to moclaw.ai/chat...")
                await page.goto("https://moclaw.ai/chat", wait_until="domcontentloaded", timeout=20000)
                await asyncio.sleep(3.0)
                _moclaw_debug(f"moclaw.ai/chat loaded: {page.url}")
            except Exception as e:
                _moclaw_debug(f"moclaw.ai/chat navigation: {e}")
        else:
            _moclaw_debug("Already on /chat, skipping navigation")
            await asyncio.sleep(1.0)

        # Try to activate free trial
        await self._activate_free_trial(page)

        # Extract Auth0 SPA tokens from localStorage (primary credential)
        # Poll up to 10s since Auth0 SDK may take time to store tokens
        auth0_tokens = None
        for _ in range(20):
            auth0_tokens = await self._extract_auth0_tokens(page)
            if auth0_tokens:
                break
            await asyncio.sleep(0.5)
        if auth0_tokens:
            _moclaw_debug(f"Got Auth0 tokens: access_token={auth0_tokens['access_token'][:50]}...")
            return {
                "access_token": auth0_tokens["access_token"],
                "refresh_token": auth0_tokens.get("refresh_token", ""),
                "expires_in": str(auth0_tokens.get("expires_in", 86400)),
                "email": account.identifier,
                "method": "auth0_spa",
            }

        # Fallback: extract cookies
        _moclaw_debug("No Auth0 tokens in localStorage, falling back to cookies")
        moclaw_cookies = await self._extract_moclaw_cookies(page)
        if moclaw_cookies:
            _moclaw_debug(f"Found moclaw.ai cookies: {moclaw_cookies[:120]}...")
            return {
                "access_token": "cookie-session",
                "cookies": moclaw_cookies,
                "email": account.identifier,
                "method": "cookie",
            }

        _moclaw_debug("No credentials found")
        code = auth_state.get("authorization_code", "")
        return {
            "auth_code": code,
            "email": account.identifier,
            "method": "google_oauth_code",
        }

    async def _activate_free_trial(self, page: Any) -> None:
        """Poll for and click 'Start Free Trial' button on moclaw.ai/chat."""
        try:
            for _ in range(40):
                clicked = await page.evaluate(
                    """() => {
                        for (const btn of document.querySelectorAll('button, a, div[role="button"]')) {
                            const txt = (btn.textContent || '').trim().toLowerCase();
                            if (txt === 'start free trial') { btn.click(); return 'trial'; }
                        }
                        return '';
                    }"""
                )
                if clicked:
                    _moclaw_debug("Clicked 'Start Free Trial' button")
                    await asyncio.sleep(2.0)
                    return
                await asyncio.sleep(0.5)
            _moclaw_debug("Free trial button not found after polling")
        except Exception as e:
            _moclaw_debug(f"Trial activation error: {e}")

    async def _extract_auth0_tokens(self, page: Any) -> dict[str, Any] | None:
        """Extract access_token and refresh_token from Auth0 SPA SDK localStorage."""
        try:
            data = await page.evaluate(
                """() => {
                    const key = '@@auth0spajs@@::R7QyN3rYIv2DSEqkgQJjfSvvb6XFxMOu::https://api.moclaw.ai::openid profile email offline_access';
                    const raw = localStorage.getItem(key);
                    if (!raw) return null;
                    try { return JSON.parse(raw); } catch { return null; }
                }"""
            )
            if data and isinstance(data, dict):
                body = data.get("body")
                if body and body.get("access_token"):
                    return body
        except Exception as e:
            _moclaw_debug(f"Auth0 token extraction error: {e}")
        return None

    async def _extract_moclaw_cookies(self, page: Any) -> str | None:
        """Extract session cookies for moclaw.ai / auth.moclaw.ai domains only."""
        try:
            context = page.context
            cookies = await context.cookies()
            moclaw_cookies = []
            for cookie in cookies:
                domain = cookie.get("domain", "")
                name = cookie.get("name", "")
                value = cookie.get("value", "")
                if not value:
                    continue
                # Only include cookies for moclaw.ai domain (not google)
                if domain == "moclaw.ai" or domain.endswith(".moclaw.ai"):
                    moclaw_cookies.append(f"{name}={value}")
                    _moclaw_debug(f"  Cookie [{domain}]: {name}={value[:30]}...")
            if moclaw_cookies:
                return "; ".join(moclaw_cookies)
        except Exception as e:
            _moclaw_debug(f"Moclaw cookie extraction error: {e}")
        return None

    async def _dump_local_storage(self, page: Any) -> dict[str, str] | None:
        """Dump every key in localStorage (for discovery)."""
        try:
            data = await page.evaluate(
                """() => {
                    try {
                        const result = {};
                        for (let i = 0; i < localStorage.length; i++) {
                            const k = localStorage.key(i);
                            if (k !== null) result[k] = localStorage.getItem(k);
                        }
                        return result;
                    } catch (e) { return null; }
                }"""
            )
            if isinstance(data, dict):
                return {str(k): str(v) for k, v in data.items()}
            return None
        except Exception:
            return None

    async def _extract_tokens_from_cookies(self, page: Any) -> dict[str, str] | None:
        try:
            context = page.context
            cookies = await context.cookies()
            _moclaw_debug(f"Checking {len(cookies)} cookies...")
            for cookie in cookies:
                domain = cookie.get("domain", "")
                name = cookie.get("name", "")
                value = cookie.get("value", "")
                if "moclaw" in domain and value and len(value) > 20:
                    _moclaw_debug(f"  Cookie: {name}={value[:30]}... (domain={domain})")
                    if name in ("__session", "session", "access_token", "auth_token",
                                "sb-access-token", "next-auth.session-token",
                                "__Secure-next-auth.session-token"):
                        return {
                            "access_token": value,
                            "cookie_domain": domain,
                            "cookie_name": name,
                            "method": "cookie",
                        }
        except Exception as e:
            _moclaw_debug(f"Cookie extraction error: {e}")
        return None

    async def fetch_quota(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
    ) -> dict[str, Any] | None:
        """
        Moclaw.ai quota is currently unknown.
        Return a placeholder quota until real endpoint is reverse-engineered.
        """
        access_token = tokens.get("access_token")
        if not access_token or access_token.startswith("stub-"):
            return {"remaining_credits": 1000, "total_credits": 1000}

        # TODO: probe real quota endpoint when known
        # e.g. GET https://moclaw.ai/api/v1/user/quota with Bearer token
        return {"remaining_credits": 1000, "total_credits": 1000}

    async def cleanup_session(self, session: Any) -> None:
        if session is None or session.get("stub"):
            return
        try:
            browser = session.get("browser")
            manager = session.get("manager")
            if browser:
                await browser.close()
            if manager:
                await manager.__aexit__(None, None, None)
        except Exception:
            pass
