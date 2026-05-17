from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import aiohttp

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token"
CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
CODEX_SCOPE = "openid profile email offline_access"
DEFAULT_CALLBACK_PORT = int(os.getenv("CODEX_CALLBACK_PORT", "1455"))
REDIRECT_PATH = "/auth/callback"


def _debug(msg: str) -> None:
    if os.getenv("BATCHER_DEBUG", "").lower() == "true":
        print(f"[codex-debug] {msg}", flush=True)


def _generate_pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def _decode_jwt_payload(token: str) -> dict[str, Any]:
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = base64.urlsafe_b64decode(payload_b64.encode("ascii"))
        return json.loads(payload.decode("utf-8"))
    except Exception:
        return {}


def _extract_account_id(claims: dict[str, Any]) -> str:
    auth_claim = claims.get("https://api.openai.com/auth", {})
    if isinstance(auth_claim, dict):
        for key in ("chatgpt_account_id", "account_id", "user_id"):
            value = auth_claim.get(key)
            if value:
                return str(value)
    for key in ("chatgpt_account_id", "account_id", "sub"):
        value = claims.get(key)
        if value:
            return str(value)
    return ""


def _looks_like_refresh_token(secret: str) -> bool:
    s = secret.strip()
    if "@" in s:
        return False
    if len(s) < 100:
        return False
    return True


class _CallbackState:
    __slots__ = ("code", "error", "state", "lock")

    def __init__(self) -> None:
        self.code: str | None = None
        self.error: str | None = None
        self.state: str | None = None
        self.lock = threading.Lock()


def _make_handler(state: _CallbackState, expected_state: str):
    class CallbackHandler(BaseHTTPRequestHandler):
        def log_message(self, *args, **kwargs):  # silence
            return

        def do_GET(self):
            if not self.path.startswith(REDIRECT_PATH):
                self.send_response(404)
                self.end_headers()
                return
            params = parse_qs(urlparse(self.path).query)
            with state.lock:
                err = params.get("error", [None])[0]
                code = params.get("code", [None])[0]
                returned_state = params.get("state", [None])[0]
                if err:
                    state.error = f"{err}: {params.get('error_description', [''])[0]}"
                elif code:
                    if expected_state and returned_state != expected_state:
                        state.error = "state mismatch"
                    else:
                        state.code = code
                        state.state = returned_state

            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            body = b"<html><body><h2>Login complete. You may close this window.</h2></body></html>"
            try:
                self.wfile.write(body)
            except Exception:
                pass

    return CallbackHandler


def _start_callback_server(state: _CallbackState, expected_state: str, port: int) -> HTTPServer:
    handler_cls = _make_handler(state, expected_state)
    last_err: Exception | None = None
    for attempt_port in (port, port + 1, port + 2, 0):
        try:
            srv = HTTPServer(("127.0.0.1", attempt_port), handler_cls)
            thread = threading.Thread(target=srv.serve_forever, daemon=True)
            thread.start()
            return srv
        except OSError as exc:
            last_err = exc
            continue
    raise RetryableBatcherError(
        ErrorCode.browser_start_failed,
        f"could not bind callback server: {last_err}",
    )


async def _exchange_code(code: str, verifier: str, redirect_uri: str) -> dict[str, Any]:
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": CODEX_CLIENT_ID,
        "code_verifier": verifier,
    }
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(
            CODEX_TOKEN_URL,
            data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        ) as resp:
            text = await resp.text()
            if resp.status != 200:
                raise RetryableBatcherError(
                    ErrorCode.auth_token_extraction_failed,
                    f"token exchange failed ({resp.status}): {text[:200]}",
                )
            return json.loads(text)


async def _refresh_with_token(refresh_token: str) -> dict[str, Any]:
    form = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CODEX_CLIENT_ID,
        "scope": CODEX_SCOPE,
    }
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(
            CODEX_TOKEN_URL,
            data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        ) as resp:
            text = await resp.text()
            if resp.status != 200:
                raise NonRetryableBatcherError(
                    ErrorCode.auth_invalid_credentials,
                    f"refresh token exchange failed ({resp.status}): {text[:200]}",
                )
            return json.loads(text)


async def _fetch_usage(access_token: str) -> dict[str, Any] | None:
    headers = {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": "codex_cli_rs/0.1.0",
    }
    timeout = aiohttp.ClientTimeout(total=20)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(CODEX_USAGE_URL, headers=headers) as resp:
                if resp.status != 200:
                    return None
                return await resp.json()
    except Exception:
        return None


async def _try_fill_openai_login(page: Any, email: str, password: str) -> None:
    try:
        for _ in range(20):
            try:
                cur = page.url
            except Exception:
                return
            if "auth.openai.com" not in cur:
                return
            try:
                email_loc = page.locator(
                    'input[name="username"], input[type="email"], input[autocomplete="username"]'
                ).first
                if await email_loc.count() > 0 and await email_loc.is_visible():
                    val = await email_loc.input_value()
                    if not val:
                        await email_loc.fill(email)
                        await asyncio.sleep(0.3)
                        clicked = await page.evaluate(
                            """() => {
                                for (const sel of ['button[type=submit]', 'button[name=action]', 'button._button-login-id', 'button[data-action-button-primary=true]']) {
                                    const el = document.querySelector(sel);
                                    if (el && el.offsetParent !== null) { el.click(); return true; }
                                }
                                return false;
                            }"""
                        )
                        if not clicked:
                            try:
                                await email_loc.press("Enter")
                            except Exception:
                                pass
                        await asyncio.sleep(2.0)
                        continue
            except Exception:
                pass
            try:
                pw_loc = page.locator('input[name="password"], input[type="password"]').first
                if await pw_loc.count() > 0 and await pw_loc.is_visible():
                    val = await pw_loc.input_value()
                    if not val:
                        await pw_loc.fill(password)
                        await asyncio.sleep(0.3)
                        clicked = await page.evaluate(
                            """() => {
                                for (const sel of ['button[type=submit]', 'button._button-login-password', 'button[data-action-button-primary=true]']) {
                                    const el = document.querySelector(sel);
                                    if (el && el.offsetParent !== null) { el.click(); return true; }
                                }
                                return false;
                            }"""
                        )
                        if not clicked:
                            try:
                                await pw_loc.press("Enter")
                            except Exception:
                                pass
                        await asyncio.sleep(3.0)
                        return
            except Exception:
                pass
            await asyncio.sleep(1.0)
    except Exception:
        return


class CodexProviderAdapter(ProviderAdapter):
    name = "codex"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [p.strip() for p in raw_line.split("|")]
        if len(parts) < 2 or not parts[0] or not parts[1]:
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "codex account must be email|password OR email|refresh_token",
            )
        email = parts[0]
        secret = parts[1]
        if not _EMAIL_PATTERN.match(email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "codex account email format is invalid",
            )
        secret_kind = "refresh_token" if _looks_like_refresh_token(secret) else "password"
        return NormalizedAccount(
            provider=self.name,
            identifier=email,
            secret=secret,
            metadata={"secret_kind": secret_kind},
            raw=raw_line,
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        secret_kind = account.metadata.get("secret_kind", "password")
        if secret_kind == "refresh_token":
            return {"mode": "refresh_token", "stub": True}

        if os.getenv("BATCHER_ENABLE_CAMOUFOX", "false").lower() != "true":
            return {"mode": "password", "stub": True}

        try:
            from browserforge.fingerprints import Screen
            from camoufox.async_api import AsyncCamoufox
        except Exception as exc:
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                f"camoufox import failed: {exc}",
            ) from exc

        verifier, challenge = _generate_pkce_pair()
        oauth_state = secrets.token_urlsafe(24)
        callback_state = _CallbackState()

        port = DEFAULT_CALLBACK_PORT
        srv = _start_callback_server(callback_state, oauth_state, port)
        bound_port = srv.server_address[1]
        redirect_uri = f"http://localhost:{bound_port}{REDIRECT_PATH}"

        params = {
            "client_id": CODEX_CLIENT_ID,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": CODEX_SCOPE,
            "connection": "email",
            "prompt": "login",
            "screen_hint": "login",
            "state": oauth_state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "id_token_add_organizations": "true",
            "codex_cli_simplified_flow": "true",
            "originator": "codex_cli_rs",
        }
        authorize_url = f"{CODEX_AUTHORIZE_URL}?{urlencode(params)}"

        camoufox_kwargs: dict[str, Any] = {
            "headless": os.getenv("BATCHER_CAMOUFOX_HEADLESS", "false").lower() == "true",
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

        try:
            manager = AsyncCamoufox(**camoufox_kwargs)
            browser = await manager.__aenter__()
            page = await browser.new_page()
            page.set_default_timeout(120000)
            await page.goto(authorize_url, wait_until="domcontentloaded", timeout=30000)
        except Exception as exc:
            try:
                srv.shutdown()
            except Exception:
                pass
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                f"camoufox launch failed: {exc}",
            ) from exc

        return {
            "mode": "password",
            "stub": False,
            "manager": manager,
            "browser": browser,
            "page": page,
            "callback_server": srv,
            "callback_state": callback_state,
            "oauth_state": oauth_state,
            "verifier": verifier,
            "redirect_uri": redirect_uri,
        }

    async def authenticate(
        self, account: NormalizedAccount, session: Any
    ) -> dict[str, Any]:
        if session is None:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state, "no session for codex auth"
            )

        mode = session.get("mode", "password")

        if mode == "refresh_token":
            data = await _refresh_with_token(account.secret)
            return {
                "mode": "refresh_token",
                "token_data": data,
                "input_refresh_token": account.secret,
            }

        if session.get("stub"):
            return {
                "mode": "password",
                "authorization_code": "stub-codex-code",
                "verifier": "stub-verifier",
                "redirect_uri": "http://localhost:0/stub",
            }

        page = session.get("page")
        callback_state: _CallbackState = session["callback_state"]

        fill_task = asyncio.create_task(
            _try_fill_openai_login(page, account.identifier, account.secret)
        )

        timeout_seconds = int(os.getenv("CODEX_LOGIN_TIMEOUT", "300"))
        deadline = time.monotonic() + timeout_seconds

        try:
            while time.monotonic() < deadline:
                with callback_state.lock:
                    if callback_state.error:
                        raise NonRetryableBatcherError(
                            ErrorCode.auth_invalid_credentials,
                            f"codex callback error: {callback_state.error}",
                        )
                    if callback_state.code:
                        return {
                            "mode": "password",
                            "authorization_code": callback_state.code,
                            "verifier": session["verifier"],
                            "redirect_uri": session["redirect_uri"],
                        }
                await asyncio.sleep(0.5)
        finally:
            fill_task.cancel()
            try:
                await fill_task
            except Exception:
                pass

        raise RetryableBatcherError(
            ErrorCode.auth_timeout,
            f"codex login timed out after {timeout_seconds}s",
        )

    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any,
    ) -> dict[str, str]:
        mode = auth_state.get("mode", "password")

        if mode == "refresh_token":
            data = auth_state["token_data"]
            access_token = data.get("access_token", "")
            refresh_token = data.get("refresh_token") or auth_state.get("input_refresh_token", "")
            id_token = data.get("id_token", "")
        else:
            code = auth_state.get("authorization_code", "")
            verifier = auth_state.get("verifier", "")
            redirect_uri = auth_state.get("redirect_uri", "")
            if not code or code == "stub-codex-code":
                raise RetryableBatcherError(
                    ErrorCode.auth_token_extraction_failed,
                    "no authorization_code returned",
                )
            data = await _exchange_code(code, verifier, redirect_uri)
            access_token = data.get("access_token", "")
            refresh_token = data.get("refresh_token", "")
            id_token = data.get("id_token", "")

        if not access_token:
            raise RetryableBatcherError(
                ErrorCode.auth_token_extraction_failed,
                "no access_token in token response",
            )

        expires_in = int(data.get("expires_in") or 3600)
        expires_at = str(int(time.time()) + expires_in)

        claims = _decode_jwt_payload(id_token) if id_token else {}
        email = claims.get("email", "") or account.identifier
        account_id = _extract_account_id(claims)

        if not account_id:
            usage = await _fetch_usage(access_token)
            if usage:
                if not email:
                    email = usage.get("email", "") or email
                account_id = (
                    str(usage.get("account_id") or usage.get("chatgpt_account_id") or "")
                )

        return {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "id_token": id_token,
            "expires_at": expires_at,
            "email": email,
            "account_id": account_id,
            "method": "oauth_pkce" if mode == "password" else "refresh_token",
        }

    async def fetch_quota(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
    ) -> dict[str, Any] | None:
        access_token = tokens.get("access_token", "")
        if not access_token:
            return None
        usage = await _fetch_usage(access_token)
        if not usage:
            return {"remaining_credits": 100, "total_credits": 100}
        primary = (usage.get("rate_limit") or {}).get("primary_window") or {}
        used_percent = float(primary.get("used_percent") or 0.0)
        remaining = max(0.0, 100.0 - used_percent)
        return {
            "remaining_credits": remaining,
            "total_credits": 100,
            "current_usage": used_percent,
        }

    async def cleanup_session(self, session: Any) -> None:
        if not isinstance(session, dict):
            return
        srv = session.get("callback_server")
        if srv is not None:
            try:
                srv.shutdown()
            except Exception:
                pass
        browser = session.get("browser")
        manager = session.get("manager")
        try:
            if browser:
                await browser.close()
        except Exception:
            pass
        try:
            if manager:
                await manager.__aexit__(None, None, None)
        except Exception:
            pass
