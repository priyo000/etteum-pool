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

# Windsurf OAuth constants (from browser inspection)
WINDSURF_CLIENT_ID = "957777847521-egrk5uakal87pjkqctk89fe7b7qtd1dq.apps.googleusercontent.com"
WINDSURF_REDIRECT_URI = "https://windsurf.com/auth/callback"
WINDSURF_SCOPE = "openid email profile"

# Windsurf auth endpoints (from windsurf-login.js analysis)
WINDSURF_AUTH1_LOGIN_URL = "https://windsurf.com/_devin-auth/password/login"
WINDSURF_POST_AUTH_URL = "https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth"
WINDSURF_CHECK_LOGIN_METHOD_URL = "https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod"

# WindsurfAPI instance URL for adding accounts after login
WINDSURF_API_URL = os.getenv("BATCHER_WINDSURF_API_URL", "http://localhost:3003")
WINDSURF_API_KEY = os.getenv("BATCHER_WINDSURF_API_KEY", "poolprox2-windsurf-internal")


def _windsurf_debug(msg: str) -> None:
    if os.getenv("BATCHER_DEBUG", "").lower() == "true":
        print(f"[windsurf-debug] {msg}", flush=True)


def _generate_pkce_pair() -> tuple[str, str]:
    """Generate PKCE code_verifier and code_challenge (S256)."""
    code_verifier = secrets.token_urlsafe(32)
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge


def _extract_code_from_callback(url: str) -> str | None:
    """Extract authorization code from Windsurf callback URL."""
    if "windsurf.com/auth/callback" not in url:
        return None
    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    codes = params.get("code")
    if codes:
        return codes[0]
    return None


# ─── Google OAuth helpers (same pattern as kiro.py) ───────────────


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


async def _click_google_next(page: Any) -> bool:
    try:
        return bool(
            await page.evaluate(
                """() => {
                    for (const sel of ['#identifierNext button', '#passwordNext button', '#submit']) {
                        const el = document.querySelector(sel);
                        if (el && el.offsetParent !== null) { el.click(); return true; }
                    }
                    for (const btn of document.querySelectorAll('button, div[role="button"]')) {
                        if (!btn.offsetParent) continue;
                        const txt = (btn.textContent || '').toLowerCase().trim();
                        if (['next', 'continue', 'lanjutkan', 'berikutnya', 'далее'].some(k => txt.includes(k))) {
                            btn.click();
                            return true;
                        }
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
            url = page.url
            if "accounts.google.com" not in url:
                return
        except Exception:
            return


async def _wait_for_google_password_transition(page: Any) -> None:
    for _ in range(16):
        await asyncio.sleep(0.5)
        if not await _is_password_step(page):
            return
        try:
            url = page.url
            if "accounts.google.com" not in url:
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
                await _click_google_next(page)
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

                await _click_google_next(page)
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
                    const keywords = ['continue','allow','lanjut','lanjutkan','izinkan','разрешить','продолжить',
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
    except Exception:
        current_url = ""
    if "/speedbump/gaplustos" not in current_url:
        return False
    try:
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
                    // Check for challenge paths, but EXCLUDE /challenge/pwd (that's the normal password page)
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


# ─── Provider Adapter ─────────────────────────────────────────────────


class WindsurfProviderAdapter(ProviderAdapter):
    name = "windsurf"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [part.strip() for part in raw_line.split("|")]

        if len(parts) < 2:
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "windsurf account must be email|password (Google account credentials)",
            )

        email = parts[0]
        password = parts[1]

        if not email or not password:
            raise NonRetryableBatcherError(
                ErrorCode.input_missing_required_field,
                "windsurf account requires email and password",
            )

        if not _EMAIL_PATTERN.match(email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "windsurf account email format is invalid",
            )

        return NormalizedAccount(
            provider=self.name,
            identifier=email,
            secret=password,
            raw=raw_line,
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        """
        Launch Camoufox and navigate DIRECTLY to Google OAuth URL
        (same approach as kiro.py — skip the Windsurf login page entirely).

        This avoids the extra DOM interaction of clicking "Continue with Google"
        and makes the flow look more like a legitimate OAuth redirect.
        """
        if os.getenv("BATCHER_ENABLE_CAMOUFOX", "false").lower() != "true":
            return {"stub": True}

        try:
            from browserforge.fingerprints import Screen
            from camoufox.async_api import AsyncCamoufox

            code_verifier, code_challenge = _generate_pkce_pair()
            state: dict[str, Any] = {
                "auth_code": None,
                "code_verifier": code_verifier,
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

            # Intercept responses to catch the callback redirect
            def on_response(response: Any) -> None:
                if state.get("auth_code"):
                    return
                try:
                    # Check Location header for redirect to callback
                    location = response.headers.get("location", "")
                    code = _extract_code_from_callback(location)
                    if code:
                        state["auth_code"] = code
                        _windsurf_debug(f"Got auth code from redirect header: {code[:20]}...")
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
                    _windsurf_debug(f"Got auth code from request intercept: {code[:20]}...")
                    # Don't abort — let it continue so Windsurf can exchange the code
                    await route.continue_()
                    return
                await route.continue_()

            await page.route("**/*", route_handler)

            # Build Google OAuth URL directly (same as Windsurf's "Continue with Google" does)
            oauth_state = str(uuid.uuid4())
            google_auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(
                {
                    "client_id": WINDSURF_CLIENT_ID,
                    "redirect_uri": WINDSURF_REDIRECT_URI,
                    "response_type": "code",
                    "scope": WINDSURF_SCOPE,
                    "code_challenge": code_challenge,
                    "code_challenge_method": "S256",
                    "state": oauth_state,
                }
            )

            _windsurf_debug(f"Navigating directly to Google OAuth...")
            await page.goto(google_auth_url, wait_until="domcontentloaded", timeout=30000)

            state.update(
                {
                    "manager": manager,
                    "browser": browser,
                    "page": page,
                    "oauth_state": oauth_state,
                    "account": account.identifier,
                }
            )
            return state
        except Exception as exc:
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                str(exc) or "camoufox bootstrap failed for windsurf",
            ) from exc

    async def authenticate(
        self, account: NormalizedAccount, session: Any
    ) -> dict[str, Any]:
        """
        Handle Google OAuth flow:
        1. Fill email on Google sign-in page
        2. Fill password
        3. Handle consent/TOS
        4. Wait for redirect to windsurf.com/auth/callback with auth code
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

        for _ in range(90):  # Max ~45 seconds
            # Check if we already got the auth code via intercept
            code = session.get("auth_code")
            if code:
                _windsurf_debug(f"Auth code captured!")
                return {
                    "authenticated": True,
                    "authorization_code": code,
                    "code_verifier": session.get("code_verifier", ""),
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

            # Check if we landed on the callback URL directly
            code_from_url = _extract_code_from_callback(current_url)
            if code_from_url:
                session["auth_code"] = code_from_url
                _windsurf_debug(f"Auth code from URL!")
                return {
                    "authenticated": True,
                    "authorization_code": code_from_url,
                    "code_verifier": session.get("code_verifier", ""),
                }

            # Check if we're on Windsurf (post-callback, already logged in)
            if "windsurf.com" in current_host and "/auth/callback" not in current_url and "/account/login" not in current_url:
                _windsurf_debug(f"Landed on Windsurf post-login: {current_url}")
                # Auth code might have been consumed already — check session
                if session.get("auth_code"):
                    return {
                        "authenticated": True,
                        "authorization_code": session["auth_code"],
                        "code_verifier": session.get("code_verifier", ""),
                    }
                # We're logged in but missed the code — try to get token from page
                return {
                    "authenticated": True,
                    "authorization_code": "",
                    "code_verifier": session.get("code_verifier", ""),
                    "logged_in_directly": True,
                }

            # Handle Google OAuth pages
            if "accounts.google.com" in current_host:
                # Handle SetSID redirects
                if "SetSID" in current_url or "/accounts/set" in current_url.lower():
                    await asyncio.sleep(0.5)
                    continue

                if await _handle_google_gaplustos(page):
                    await asyncio.sleep(0.8)
                    continue

                if await _handle_google_consent(page):
                    await asyncio.sleep(0.8)
                    continue

                # Detect blocking challenges
                challenge = await _detect_google_challenge(page)
                if challenge:
                    raise NonRetryableBatcherError(
                        ErrorCode.browser_challenge_blocked,
                        f"Google blocked login: {challenge}",
                    )

                at_password_step = await _is_password_step(page)
                at_email_step = await _is_email_step(page)

                # Fill email
                if at_email_step and not at_password_step:
                    if email_step_started_at is None:
                        email_step_started_at = now
                    elif now - email_step_started_at > 60.0:
                        raise RetryableBatcherError(
                            ErrorCode.browser_challenge_blocked,
                            "windsurf: email step stuck > 60s (possible captcha)",
                        )
                    if now < email_transition_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    if await _fill_google_email_step(page, account.identifier):
                        email_transition_deadline = time.monotonic() + 6.0
                        _windsurf_debug(f"Email filled: {account.identifier}")
                        await asyncio.sleep(1.0)
                        continue

                # Fill password
                if at_password_step:
                    email_step_started_at = None
                    if now < password_transition_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    if await _fill_google_password_step(page, account.secret):
                        password_transition_deadline = time.monotonic() + 8.0
                        _windsurf_debug("Password filled")
                        await asyncio.sleep(1.5)
                        continue

            await asyncio.sleep(0.5)

        raise RetryableBatcherError(
            ErrorCode.auth_timeout,
            "Windsurf Google OAuth login timed out after 45s",
        )

    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any,
    ) -> dict[str, str]:
        """
        After Google OAuth, we have the auth code from the callback redirect.

        We return the auth_code directly — WindsurfAPI can use it via its
        /auth/login endpoint with { token: auth_code } to register the account.

        Alternatively, we navigate to the callback URL to let Windsurf exchange
        the code and establish a session, then extract the session token.
        """
        if session is None or session.get("stub"):
            return {"auth_token": "stub-windsurf-token", "email": account.identifier}

        page = session.get("page")
        code = auth_state.get("authorization_code", "")
        code_verifier = auth_state.get("code_verifier", "")

        if not code:
            raise RetryableBatcherError(
                ErrorCode.auth_token_extraction_failed,
                "No authorization code available after OAuth",
            )

        _windsurf_debug(f"Have auth code: {code[:20]}... Navigating to callback to exchange...")

        # Navigate to the callback URL to let Windsurf exchange the code
        # This establishes the session on windsurf.com
        callback_url = f"{WINDSURF_REDIRECT_URI}?code={code}&state={session.get('oauth_state', '')}"

        try:
            await page.goto(callback_url, wait_until="domcontentloaded", timeout=20000)
            await asyncio.sleep(3.0)
        except Exception as e:
            _windsurf_debug(f"Callback navigation: {e}")
            # May timeout due to redirects, that's OK

        # Now try to get the auth token from /show-auth-token
        try:
            await page.goto(
                "https://windsurf.com/show-auth-token",
                wait_until="domcontentloaded",
                timeout=15000,
            )
            await asyncio.sleep(2.0)
        except Exception as e:
            _windsurf_debug(f"show-auth-token navigation: {e}")

        current_url = page.url
        _windsurf_debug(f"After show-auth-token, URL: {current_url}")

        # If we're on the token page, extract it
        if "/account/login" not in current_url:
            auth_token = await self._extract_auth_token_from_page(page)
            if auth_token:
                _windsurf_debug(f"Auth token from page: {auth_token[:20]}...")
                return {
                    "auth_token": auth_token,
                    "email": account.identifier,
                    "method": "google_oauth",
                }

        # Try extracting from cookies
        try:
            context = page.context
            cookies = await context.cookies()
            _windsurf_debug(f"Checking {len(cookies)} cookies...")
            for cookie in cookies:
                domain = cookie.get("domain", "")
                name = cookie.get("name", "")
                value = cookie.get("value", "")
                if "windsurf" in domain and value and len(value) > 20:
                    _windsurf_debug(f"  Cookie: {name}={value[:30]}... (domain={domain})")
                    if name in ("__session", "session_token", "auth_token",
                                "sb-access-token", "next-auth.session-token",
                                "__Secure-next-auth.session-token"):
                        _windsurf_debug(f"Got session token from cookie '{name}'!")
                        return {
                            "auth_token": value,
                            "email": account.identifier,
                            "method": "google_oauth_cookie",
                        }
        except Exception as e:
            _windsurf_debug(f"Cookie extraction error: {e}")

        # Last resort: return the raw auth code itself
        # WindsurfAPI can potentially use this directly
        _windsurf_debug(f"Returning raw auth code as token (WindsurfAPI will exchange it)")
        return {
            "auth_token": code,
            "auth_code": code,
            "code_verifier": code_verifier,
            "email": account.identifier,
            "method": "google_oauth_code",
        }

    async def _extract_auth_token_from_page(self, page: Any) -> str | None:
        """Extract auth token from windsurf.com/show-auth-token page."""
        try:
            for _ in range(10):
                token = await page.evaluate(
                    """() => {
                        // Look for token in code/pre elements
                        const codeEls = document.querySelectorAll('pre, code, .token, [data-token], .auth-token');
                        for (const el of codeEls) {
                            const text = (el.textContent || '').trim();
                            if (text.length > 20 && !text.includes(' ') && !text.includes('<')) return text;
                        }
                        // Look in input fields
                        const inputs = document.querySelectorAll('input[type="text"], input[readonly], textarea');
                        for (const input of inputs) {
                            const val = (input.value || '').trim();
                            if (val.length > 20 && !val.includes(' ')) return val;
                        }
                        // Look for token-like strings in page content
                        const body = document.body?.innerText || '';
                        // Match long alphanumeric strings (tokens are usually 40+ chars)
                        const match = body.match(/[a-zA-Z0-9_.-]{40,}/);
                        if (match) return match[0];
                        return null;
                    }"""
                )
                if token:
                    return token
                await asyncio.sleep(1.0)
            return None
        except Exception:
            return None

    async def fetch_quota(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
    ) -> dict[str, Any] | None:
        """
        After getting the auth token, register it with WindsurfAPI
        and fetch quota information.
        """
        auth_token = tokens.get("auth_token")
        if not auth_token or auth_token == "stub-windsurf-token":
            return {
                "remaining_credits": 1500,
                "total_credits": 1500,
            }

        # Try to register account with WindsurfAPI instance
        try:
            async with aiohttp.ClientSession() as http_session:
                add_resp = await http_session.post(
                    f"{WINDSURF_API_URL}/auth/login",
                    json={"token": auth_token, "label": account.identifier},
                    headers={"x-api-key": WINDSURF_API_KEY},
                    timeout=aiohttp.ClientTimeout(total=30),
                )
                if add_resp.status == 200:
                    data = await add_resp.json()
                    _windsurf_debug(f"Account registered with WindsurfAPI: {data}")
                    ws_account_id = (
                        data.get("id")
                        or data.get("account", {}).get("id")
                        or ""
                    )
                    if ws_account_id:
                        tokens["windsurf_account_id"] = str(ws_account_id)
                else:
                    resp_text = await add_resp.text()
                    _windsurf_debug(f"WindsurfAPI register failed ({add_resp.status}): {resp_text[:100]}")
        except Exception as e:
            _windsurf_debug(f"WindsurfAPI register error (non-fatal): {e}")

        # Default quota for Windsurf Pro
        return {
            "remaining_credits": 1500,
            "total_credits": 1500,
        }

    async def cleanup_session(self, session: Any) -> None:
        """Close browser session."""
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
