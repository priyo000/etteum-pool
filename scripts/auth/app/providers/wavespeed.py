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

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

WAVESPEED_LOGIN_URL = "https://wavespeed.ai/center/default/google/login?redirect=https://wavespeed.ai/"
WAVESPEED_ACCESSKEY_URL = (
    "https://wavespeed.ai/center/default/api/v1/accesskey/create"
)


def _ws_debug_enabled() -> bool:
    return os.getenv("BATCHER_WAVESPEED_DEBUG", "false").lower() == "true"


def _ws_debug(message: str) -> None:
    if _ws_debug_enabled():
        print(f"[wavespeed-auth] {message}", flush=True)


# ---------------------------------------------------------------------------
# Google OAuth helpers (shared with kiro/codebuddy)
# ---------------------------------------------------------------------------


async def _target_url(target: Any) -> str:
    try:
        return str(target.url)
    except Exception:
        return ""


async def _active_element_snapshot(target: Any) -> str:
    try:
        return str(
            await target.evaluate(
                """() => {
                    const el = document.activeElement;
                    if (!el) return 'none';
                    const tag = (el.tagName || '').toLowerCase();
                    const id = el.id ? `#${el.id}` : '';
                    const name = el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : '';
                    return `${tag}${id}${name}`;
                }"""
            )
        )
    except Exception:
        return "unknown"


async def _wait_for_google_email_transition(target: Any) -> bool:
    try:
        await target.wait_for_function(
            """() => {
                const host = window.location.host || '';
                const path = window.location.pathname || '';
                const visible = (selectors) => selectors.some((sel) =>
                    Array.from(document.querySelectorAll(sel)).some((el) => el.offsetParent !== null)
                );
                const hasEmail = visible(['#identifierId', 'input[name="identifier"]', 'input[type="email"]']);
                const hasPassword = visible(['input[name="Passwd"]', 'input[type="password"]']);
                if (!host.includes('accounts.google.com')) return true;
                if (hasPassword) return true;
                if (path.includes('/signin/challenge/pwd')) return true;
                return !hasEmail && !path.includes('/signin/identifier');
            }""",
            timeout=10000,
        )
        return True
    except Exception:
        return False


async def _wait_for_google_password_transition(target: Any) -> bool:
    try:
        await target.wait_for_function(
            """() => {
                const host = window.location.host || '';
                const path = window.location.pathname || '';
                const hasPassword = Array.from(
                    document.querySelectorAll('input[name="Passwd"], input[type="password"]')
                ).some((el) => el.offsetParent !== null);
                if (!host.includes('accounts.google.com')) return true;
                if (!path.includes('/challenge/pwd')) return true;
                return !hasPassword;
            }""",
            timeout=12000,
        )
        return True
    except Exception:
        return False


async def _is_password_step(target: Any) -> bool:
    try:
        return bool(
            await target.evaluate(
                """() => {
                    for (const el of document.querySelectorAll('input[type="password"], input[name="Passwd"]')) {
                        if (el.offsetParent !== null) return true;
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _is_email_step(target: Any) -> bool:
    try:
        return bool(
            await target.evaluate(
                """() => {
                    for (const el of document.querySelectorAll('input[type="email"], input[name="identifier"], #identifierId')) {
                        if (el.offsetParent !== null) return true;
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _click_google_next(target: Any) -> bool:
    try:
        return bool(
            await target.evaluate(
                """() => {
                    const bySubmit = document.querySelector('#identifierNext button, #passwordNext button');
                    if (bySubmit && bySubmit.offsetParent !== null) {
                        bySubmit.click();
                        return true;
                    }
                    for (const el of document.querySelectorAll('div.VfPpkd-RLmnJb, button, div[role="button"]')) {
                        const parentBtn = el.closest('button, div[role="button"]') || el;
                        if (parentBtn && parentBtn.offsetParent !== null) {
                            parentBtn.click();
                            return true;
                        }
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _fill_google_email_step(target: Any, email: str) -> bool:
    for selector in ["#identifierId"]:
        try:
            _ws_debug(f"email step selector={selector}")
            try:
                await target.wait_for_selector(selector, state="visible", timeout=3000)
            except Exception:
                pass

            locator = target.locator(selector).first
            if await locator.count() == 0 or not await locator.is_visible():
                continue

            await locator.scroll_into_view_if_needed()
            await locator.click(force=True)
            await asyncio.sleep(0.2)

            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass

            try:
                await locator.press_sequentially(email, delay=60)
            except Exception:
                continue

            await asyncio.sleep(0.5)
            value = await locator.input_value()
            if email.lower() != str(value).lower().strip():
                continue

            clicked = await _click_google_next(target)
            if not clicked:
                await locator.press("Enter")
            await _wait_for_google_email_transition(target)
            return True
        except Exception:
            continue
    return False


async def _fill_google_password_step(target: Any, password: str) -> bool:
    for selector in ['input[name="Passwd"]', 'input[type="password"]']:
        try:
            _ws_debug(f"password step selector={selector}")
            try:
                await target.wait_for_selector(selector, state="visible", timeout=3000)
            except Exception:
                pass

            locator = target.locator(selector).first
            if await locator.count() == 0 or not await locator.is_visible():
                continue

            await locator.scroll_into_view_if_needed()
            await locator.click(force=True)
            await asyncio.sleep(0.2)

            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass

            try:
                await locator.press_sequentially(password, delay=70)
            except Exception:
                continue

            await asyncio.sleep(0.5)
            value = await locator.input_value()
            if len(str(value)) < len(password):
                continue

            clicked = await _click_google_next(target)
            if not clicked:
                await locator.press("Enter")
            await _wait_for_google_password_transition(target)
            return True
        except Exception:
            continue
    return False


async def _click_continue_button(page: Any) -> None:
    await page.evaluate(
        """() => {
            const keywords = ['next', 'continue', 'accept', 'i understand', 'agree', 'ok', 'got it', 'login', 'sign in'];
            for (const btn of document.querySelectorAll('button, div[role="button"], input[type="submit"]')) {
                const txt = (btn.textContent || btn.value || '').toLowerCase().trim();
                if (!txt) continue;
                if (keywords.some((k) => txt.includes(k)) && btn.offsetParent !== null) {
                    btn.click();
                    return;
                }
            }
        }"""
    )


async def _handle_google_gaplustos(page: Any) -> bool:
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "/speedbump/gaplustos" not in current_url:
        return False

    try:
        try:
            await page.wait_for_selector(
                '#confirm, input[name="confirm"], input[type="submit"]',
                state="visible",
                timeout=5000,
            )
        except Exception:
            pass

        for selector in ["#confirm", 'input[name="confirm"]', 'input[type="submit"]']:
            locator = page.locator(selector).first
            try:
                if await locator.count() == 0 or not await locator.is_visible():
                    continue
                await locator.click(force=True)
                return True
            except Exception:
                continue

        return bool(
            await page.evaluate(
                """() => {
                    const candidates = [
                        document.querySelector('#confirm'),
                        document.querySelector('input[name="confirm"]'),
                        ...Array.from(document.querySelectorAll('input[type="submit"], button'))
                    ];
                    for (const el of candidates) {
                        if (!el || el.offsetParent === null) continue;
                        const txt = (el.value || el.textContent || '').toLowerCase().trim();
                        if (txt.includes('mengerti') || txt.includes('understand') || txt.includes('confirm')) {
                            el.click();
                            return true;
                        }
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _handle_google_consent_continue(page: Any) -> bool:
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "accounts.google.com" not in current_url:
        return False

    try:
        return bool(
            await page.evaluate(
                """() => {
                    for (const btn of document.querySelectorAll('button, div[role="button"]')) {
                        const txt = (btn.textContent || '').trim().toLowerCase();
                        if (!txt || btn.offsetParent === null) continue;
                        if (txt === 'continue' || txt.includes('allow') || txt.includes('lanjut')) {
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


async def _detect_google_blocking_challenge(page: Any) -> str | None:
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
                        'verify it\u2019s you',
                        "confirm it's you",
                        'confirm it\u2019s you',
                    ];
                    for (const candidate of markers) {
                        if (text.includes(candidate)) return candidate;
                    }
                    if ((window.location.pathname || '').includes('/challenge/')) {
                        return 'google challenge';
                    }
                    return '';
                }"""
            )
        ).strip()
        return marker or None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Wavespeed Provider
# ---------------------------------------------------------------------------


class WavespeedProviderAdapter(ProviderAdapter):
    name = "wavespeed"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [part.strip() for part in raw_line.split("|")]
        if len(parts) < 2:
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "wavespeed account must be email|password",
            )

        email = parts[0]
        password = parts[1]

        if not email or not password:
            raise NonRetryableBatcherError(
                ErrorCode.input_missing_required_field,
                "wavespeed account requires email and password",
            )

        if not _EMAIL_PATTERN.match(email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "wavespeed account email format is invalid",
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
                "stub": False,
                "logged_in": False,
                "token_cookie": None,
            }

            camoufox_kwargs: dict[str, Any] = {
                "headless": os.getenv("BATCHER_CAMOUFOX_HEADLESS", "true").lower() == "true"
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

            await page.goto(
                WAVESPEED_LOGIN_URL, wait_until="domcontentloaded", timeout=20000
            )

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
                str(exc) or "camoufox bootstrap failed",
            ) from exc

    async def authenticate(
        self, account: NormalizedAccount, session: Any
    ) -> dict[str, Any]:
        if session is None or session.get("stub"):
            return {"authenticated": True, "token_cookie": "stub-jwt-token"}

        page = session.get("page")
        if page is None:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state, "missing browser page"
            )

        email_transition_deadline = 0.0
        password_transition_deadline = 0.0
        email_step_started_at: float | None = None

        for _ in range(90):
            try:
                current_url = page.url
            except Exception:
                raise RetryableBatcherError(
                    ErrorCode.browser_unexpected_state, "wavespeed browser page lost"
                )

            parsed_url = urlparse(current_url) if current_url else None
            current_host = parsed_url.netloc if parsed_url else ""
            now = time.monotonic()

            if "wavespeed.ai" in current_host and "google" not in current_url:
                cookies = await page.context.cookies("https://wavespeed.ai")
                token_cookie = None
                for cookie in cookies:
                    if cookie.get("name") == "token":
                        token_cookie = cookie.get("value")
                        break

                if token_cookie:
                    _ws_debug("login complete, token cookie obtained")
                    session["logged_in"] = True
                    session["token_cookie"] = token_cookie
                    return {
                        "authenticated": True,
                        "token_cookie": token_cookie,
                    }

                await asyncio.sleep(1.0)
                cookies = await page.context.cookies("https://wavespeed.ai")
                for cookie in cookies:
                    if cookie.get("name") == "token":
                        token_cookie = cookie.get("value")
                        break
                if token_cookie:
                    session["logged_in"] = True
                    session["token_cookie"] = token_cookie
                    return {
                        "authenticated": True,
                        "token_cookie": token_cookie,
                    }

            if "SetSID" in current_url or "/accounts/set" in current_url.lower():
                await asyncio.sleep(0.5)
                continue

            if await _handle_google_gaplustos(page):
                await asyncio.sleep(0.8)
                continue

            if await _handle_google_consent_continue(page):
                await asyncio.sleep(0.8)
                continue

            on_google_auth = "accounts.google.com" in current_host
            if on_google_auth:
                at_password_step = await _is_password_step(page)
                at_email_step = await _is_email_step(page)

                if at_email_step and not at_password_step:
                    if email_step_started_at is None:
                        email_step_started_at = now
                    elif now - email_step_started_at > 60.0:
                        raise RetryableBatcherError(
                            ErrorCode.browser_challenge_blocked,
                            "wavespeed captcha suspected: email step stuck > 60s",
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

            _ws_debug(f"generic continue host={current_host}")
            await _click_continue_button(page)
            await asyncio.sleep(1.0)

        raise RetryableBatcherError(
            ErrorCode.auth_temporary_failure,
            "wavespeed login did not complete — token cookie not received",
        )

    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any,
    ) -> dict[str, str]:
        token_cookie = auth_state.get("token_cookie", "")
        if not token_cookie:
            raise NonRetryableBatcherError(
                ErrorCode.provider_unsupported_response,
                "missing wavespeed token cookie",
            )

        if token_cookie == "stub-jwt-token":
            return {"api_key": "stub-wavespeed-api-key"}

        try:
            timeout = aiohttp.ClientTimeout(total=20)
            async with aiohttp.ClientSession(timeout=timeout) as client:
                async with client.post(
                    WAVESPEED_ACCESSKEY_URL,
                    json={"name": "enowx"},
                    headers={
                        "Content-Type": "application/json",
                        "Cookie": f"token={token_cookie}",
                    },
                    ssl=_SSL_CTX,
                ) as resp:
                    body = await resp.text()
                    _ws_debug(f"accesskey create status={resp.status} body={body[:300]}")

                    if resp.status == 200:
                        payload = json.loads(body)
                        if payload.get("code") != 200:
                            raise NonRetryableBatcherError(
                                ErrorCode.provider_unsupported_response,
                                f"wavespeed accesskey create failed: {payload.get('message', 'unknown')}",
                            )
                        data = payload.get("data", {})
                        api_key = data.get("key", "")
                        key_id = str(data.get("key_id", ""))
                        if not api_key:
                            raise NonRetryableBatcherError(
                                ErrorCode.provider_unsupported_response,
                                "wavespeed accesskey response missing key",
                            )
                        tokens = {
                            "api_key": api_key,
                            "key_id": key_id,
                        }
                        if data.get("name"):
                            tokens["key_name"] = data["name"]
                        return tokens

                    if resp.status == 401:
                        raise NonRetryableBatcherError(
                            ErrorCode.auth_invalid_credentials,
                            "wavespeed token cookie expired or invalid",
                        )

                    if resp.status == 429:
                        raise RetryableBatcherError(
                            ErrorCode.http_429,
                            "wavespeed accesskey endpoint rate limited",
                        )

                    if resp.status >= 500:
                        raise RetryableBatcherError(
                            ErrorCode.http_5xx,
                            f"wavespeed accesskey endpoint server error ({resp.status})",
                        )

                    raise NonRetryableBatcherError(
                        ErrorCode.provider_unsupported_response,
                        f"wavespeed accesskey create rejected ({resp.status}): {body[:120]}",
                    )
        except aiohttp.ServerTimeoutError as exc:
            raise RetryableBatcherError(
                ErrorCode.network_timeout, "wavespeed accesskey timeout"
            ) from exc
        except aiohttp.ClientConnectionError as exc:
            raise RetryableBatcherError(
                ErrorCode.network_connection_error,
                "wavespeed accesskey connection error",
            ) from exc

    async def fetch_quota(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
    ) -> dict[str, Any] | None:
        return None

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
