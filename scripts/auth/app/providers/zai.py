from __future__ import annotations

import asyncio
import json
import os
import re
import ssl
import time
from typing import Any
from urllib.parse import urlparse

import aiohttp

_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter

# Reuse Google OAuth helpers from kiro adapter
from app.providers.kiro import (
    _fill_google_email_step,
    _fill_google_password_step,
    _is_email_step,
    _is_password_step,
    _click_continue_button,
    _handle_google_gaplustos,
    _handle_google_consent_continue,
    _detect_google_blocking_challenge,
)

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

ZAI_AUTH_URL = "https://chat.z.ai/auth"
ZAI_API_BASE = "https://chat.z.ai"
ZAI_FE_VERSION = "prod-fe-1.1.22"


def _zai_debug_enabled() -> bool:
    return os.getenv("BATCHER_ZAI_AUTH_DEBUG", "false").lower() == "true"


def _zai_debug(message: str) -> None:
    if _zai_debug_enabled():
        print(f"[zai-auth] {message}", flush=True)


def _extract_jwt_from_url(url: str) -> str | None:
    """Extract JWT token from URL hash fragment: #token=eyJ..."""
    if "#token=" not in url:
        return None
    fragment = url.split("#token=", 1)[1]
    # Token may be followed by & or end of string
    token = fragment.split("&")[0].strip()
    return token if token else None


def _decode_jwt_payload(token: str) -> dict[str, Any]:
    """Decode JWT payload (no verification) to extract user_id."""
    import base64

    parts = token.split(".")
    if len(parts) != 3:
        return {}
    # Add padding
    payload_b64 = parts[1] + "=" * (4 - len(parts[1]) % 4)
    try:
        payload_bytes = base64.urlsafe_b64decode(payload_b64)
        return json.loads(payload_bytes)
    except Exception:
        return {}


class ZaiProviderAdapter(ProviderAdapter):
    """
    Z.ai Provider Adapter

    Login flow:
    1. Navigate to https://chat.z.ai/auth
    2. Click "Continue with Google"
    3. Complete Google OAuth (email + password)
    4. Capture JWT token from redirect URL hash (#token=eyJ...)

    Credentials stored:
    - jwt_token: The JWT bearer token for API access
    - user_id: Extracted from JWT payload
    """

    name = "zai"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [part.strip() for part in raw_line.split("|")]

        if len(parts) != 2:
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "zai account must be email|password (Google account credentials)",
            )

        email = parts[0]
        password = parts[1]

        if not email or not password:
            raise NonRetryableBatcherError(
                ErrorCode.input_missing_required_field,
                "zai account requires email and password",
            )

        if not _EMAIL_PATTERN.match(email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "zai account email format is invalid",
            )

        return NormalizedAccount(
            provider=self.name,
            identifier=email,
            secret=password,
            raw=raw_line,
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        if os.getenv("BATCHER_ENABLE_CAMOUFOX", "false").lower() != "true":
            return {"stub": True}

        try:
            from browserforge.fingerprints import Screen
            from camoufox.async_api import AsyncCamoufox

            state: dict[str, Any] = {
                "jwt_token": None,
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
            page.set_default_timeout(15000)

            # Navigate directly to Z.ai Google OAuth endpoint
            # This redirects straight to accounts.google.com (like Kiro does)
            _zai_debug("navigating to chat.z.ai/oauth/google/login")

            await page.goto(
                f"{ZAI_API_BASE}/oauth/google/login",
                wait_until="domcontentloaded",
                timeout=30000,
            )
            await asyncio.sleep(3.0)
            _zai_debug(f"after navigation: {page.url[:100]}")

            # Perform Google login immediately in bootstrap (before returning)
            # This prevents race conditions between bootstrap and authenticate
            if "accounts.google.com" in page.url:
                _zai_debug("on Google login page, performing login now")

                # Fill email
                for attempt in range(10):
                    if await _is_email_step(page):
                        result = await _fill_google_email_step(page, account.identifier)
                        _zai_debug(f"email fill: {result}")
                        if result:
                            await asyncio.sleep(3.0)
                            break
                    await asyncio.sleep(1.0)

                # Fill password
                for attempt in range(10):
                    if await _is_password_step(page):
                        result = await _fill_google_password_step(page, account.secret)
                        _zai_debug(f"password fill: {result}")
                        if result:
                            await asyncio.sleep(5.0)
                            break
                    # Check if already redirected to Z.ai
                    if "chat.z.ai" in page.url:
                        break
                    await asyncio.sleep(1.0)

                # Wait for redirect back to Z.ai
                _zai_debug(f"after login: {page.url[:100]}")
                if "chat.z.ai" in page.url:
                    try:
                        await page.wait_for_load_state("networkidle", timeout=10000)
                    except Exception:
                        pass
                    await asyncio.sleep(2.0)

            # Try to get token
            if "chat.z.ai" in page.url:
                for _wait in range(5):
                    try:
                        token = await page.evaluate("() => localStorage.getItem('token') || ''")
                    except Exception:
                        token = ""
                    if token:
                        _zai_debug("token captured after Google login")
                        state["jwt_token"] = token
                        break
                    await asyncio.sleep(1.0)

            # Wait for Google OAuth redirect
            _zai_debug("waiting for Google OAuth page")
            await asyncio.sleep(2.0)

            state.update(
                {
                    "manager": manager,
                    "browser": browser,
                    "page": page,
                    "account": account.identifier,
                }
            )
            return state
        except (RetryableBatcherError, NonRetryableBatcherError):
            raise
        except Exception as exc:
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                str(exc) or "camoufox bootstrap failed for zai",
            ) from exc

    async def authenticate(
        self, account: NormalizedAccount, session: Any
    ) -> dict[str, Any]:
        if session is None or session.get("stub"):
            return {
                "authenticated": True,
                "jwt_token": "stub-jwt-token",
            }

        page = session.get("page")
        if page is None:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state, "missing browser page"
            )

        # Check if token was already captured during bootstrap (auto-login)
        if session.get("jwt_token"):
            _zai_debug("token already captured during bootstrap")
            return {"authenticated": True, "jwt_token": session["jwt_token"]}

        email_transition_deadline = 0.0
        password_transition_deadline = 0.0
        email_step_started_at: float | None = None

        for _ in range(90):
            # Check if we've been redirected back to Z.ai with token
            try:
                current_url = page.url
            except Exception:
                raise RetryableBatcherError(
                    ErrorCode.browser_unexpected_state, "zai browser page lost"
                )

            # Check for JWT token in URL
            jwt_token = _extract_jwt_from_url(current_url)
            if jwt_token:
                _zai_debug("JWT token captured from URL redirect")
                session["jwt_token"] = jwt_token
                return {"authenticated": True, "jwt_token": jwt_token}

            # Check if we're back on chat.z.ai (token might be in localStorage)
            if "chat.z.ai" in current_url and "/oauth/" not in current_url:
                _zai_debug("redirected to chat.z.ai, checking localStorage")
                # Give the SPA time to process the OAuth callback and store token
                try:
                    await page.wait_for_load_state("networkidle", timeout=10000)
                except Exception:
                    pass
                for _wait in range(10):
                    await asyncio.sleep(1.5)
                    try:
                        token = await page.evaluate(
                            "() => localStorage.getItem('token') || ''"
                        )
                    except Exception:
                        token = ""
                    if token:
                        _zai_debug("JWT token captured from localStorage")
                        session["jwt_token"] = token
                        return {"authenticated": True, "jwt_token": token}
                # After 15s of waiting, give up on this iteration
                _zai_debug("no token found in localStorage after waiting")
                await asyncio.sleep(1.0)
                continue

            parsed_url = urlparse(current_url) if current_url else None
            current_host = parsed_url.netloc if parsed_url else ""
            now = time.monotonic()

            # Handle Google SetSID redirects
            if "SetSID" in current_url or "/accounts/set" in current_url.lower():
                await asyncio.sleep(0.5)
                continue

            # Handle Google gaplustos page
            if await _handle_google_gaplustos(page):
                await asyncio.sleep(0.8)
                continue

            # Handle Google consent/continue page
            if await _handle_google_consent_continue(page):
                await asyncio.sleep(0.8)
                continue

            # Google OAuth flow
            on_google_auth = "accounts.google.com" in current_host
            if on_google_auth:
                # Check for blocking challenges
                challenge = await _detect_google_blocking_challenge(page)
                if challenge:
                    raise RetryableBatcherError(
                        ErrorCode.browser_challenge_blocked,
                        f"Google blocking challenge detected: {challenge}",
                    )

                at_password_step = await _is_password_step(page)
                at_email_step = await _is_email_step(page)

                if at_email_step and not at_password_step:
                    if email_step_started_at is None:
                        email_step_started_at = now
                    elif now - email_step_started_at > 60.0:
                        raise RetryableBatcherError(
                            ErrorCode.browser_challenge_blocked,
                            "zai: email step stuck > 60s (possible captcha)",
                        )
                    if now < email_transition_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    if await _fill_google_email_step(page, account.identifier):
                        email_transition_deadline = time.monotonic() + 6.0
                        await asyncio.sleep(1.0)
                        continue

                if at_password_step:
                    email_step_started_at = None
                    if now < password_transition_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    if await _fill_google_password_step(page, account.secret):
                        password_transition_deadline = time.monotonic() + 8.0
                        await asyncio.sleep(1.0)
                        continue

                if at_email_step or at_password_step:
                    await asyncio.sleep(0.6)
                    continue
            else:
                email_step_started_at = None

            # Generic continue button click
            _zai_debug(f"generic continue host={current_host}")
            await _click_continue_button(page)
            await asyncio.sleep(1.0)

        raise RetryableBatcherError(
            ErrorCode.auth_temporary_failure,
            "zai: JWT token not received after Google OAuth",
        )

    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any,
    ) -> dict[str, str]:
        _ = account

        jwt_token = auth_state.get("jwt_token") or (
            session.get("jwt_token") if isinstance(session, dict) else None
        )

        if not jwt_token:
            # Try one more time from localStorage
            page = session.get("page") if isinstance(session, dict) else None
            if page:
                try:
                    jwt_token = await page.evaluate(
                        "() => localStorage.getItem('token') || ''"
                    )
                except Exception:
                    pass

        if not jwt_token or jwt_token == "stub-jwt-token":
            if jwt_token == "stub-jwt-token":
                return {"jwt_token": "stub-jwt-token", "user_id": "stub-user-id"}
            raise NonRetryableBatcherError(
                ErrorCode.provider_token_exchange_failed,
                "zai: failed to obtain JWT token",
            )

        # Decode user_id from JWT payload
        payload = _decode_jwt_payload(jwt_token)
        user_id = payload.get("id") or payload.get("user_id") or ""

        return {
            "jwt_token": jwt_token,
            "user_id": user_id,
        }

    async def fetch_quota(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
    ) -> dict[str, Any] | None:
        _ = account
        _ = session

        jwt_token = tokens.get("jwt_token", "")
        if not jwt_token or jwt_token.startswith("stub-"):
            return {"limit": 999999, "remaining": 999999}

        # Verify token works by calling /api/models
        try:
            timeout = aiohttp.ClientTimeout(total=15)
            async with aiohttp.ClientSession(timeout=timeout) as client:
                async with client.get(
                    f"{ZAI_API_BASE}/api/models",
                    headers={
                        "Authorization": f"Bearer {jwt_token}",
                        "x-fe-version": ZAI_FE_VERSION,
                    },
                    ssl=_SSL_CTX,
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        model_count = len(data.get("data", []))
                        _zai_debug(f"quota check OK, {model_count} models available")
                        return {
                            "limit": 999999,
                            "remaining": 999999,
                            "total_credits": 999999,
                            "remaining_credits": 999999,
                            "models_available": model_count,
                        }

                    if resp.status in (401, 403):
                        raise NonRetryableBatcherError(
                            ErrorCode.auth_invalid_credentials,
                            "zai: JWT token is invalid or expired",
                        )

                    body = await resp.text()
                    _zai_debug(f"quota check failed status={resp.status} body={body[:200]}")
                    return {"limit": 999999, "remaining": 999999}
        except (NonRetryableBatcherError, RetryableBatcherError):
            raise
        except aiohttp.ServerTimeoutError as exc:
            raise RetryableBatcherError(
                ErrorCode.network_timeout, "zai quota check timeout"
            ) from exc
        except aiohttp.ClientConnectionError as exc:
            raise RetryableBatcherError(
                ErrorCode.network_connection_error, "zai quota connection error"
            ) from exc
        except Exception:
            return {"limit": 999999, "remaining": 999999}

    async def cleanup_session(self, session: Any) -> None:
        if not isinstance(session, dict):
            return

        manager = session.get("manager")
        if manager is None:
            return

        try:
            await manager.__aexit__(None, None, None)
        except Exception:
            return
