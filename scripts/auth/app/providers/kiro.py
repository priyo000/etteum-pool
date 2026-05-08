from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import secrets
import ssl
import time
import uuid
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, quote

import aiohttp

_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

KIRO_AUTH_BASE = os.getenv(
    "BATCHER_KIRO_AUTH_BASE", "https://prod.us-east-1.auth.desktop.kiro.dev"
)
KIRO_LOGIN_ENDPOINT = os.getenv(
    "BATCHER_KIRO_LOGIN_ENDPOINT", f"{KIRO_AUTH_BASE}/login"
)
KIRO_TOKEN_ENDPOINT = os.getenv(
    "BATCHER_KIRO_TOKEN_ENDPOINT", f"{KIRO_AUTH_BASE}/oauth/token"
)
KIRO_REGION = os.getenv("BATCHER_KIRO_REGION", "us-east-1")
KIRO_REDIRECT_URI = os.getenv(
    "BATCHER_KIRO_REDIRECT_URI",
    "kiro://kiro.kiroAgent/authenticate-success",
)
KIRO_USAGE_ENDPOINT = os.getenv(
    "BATCHER_KIRO_USAGE_ENDPOINT",
    "https://q.us-east-1.amazonaws.com/getUsageLimits",
)
KIRO_REFRESH_ENDPOINT = os.getenv(
    "BATCHER_KIRO_REFRESH_ENDPOINT",
    f"https://prod.{KIRO_REGION}.auth.desktop.kiro.dev/refreshToken",
)


def _generate_pkce_pair() -> tuple[str, str]:
    code_verifier = secrets.token_urlsafe(32)
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge


def _extract_code_from_kiro_url(url: str) -> str | None:
    if not url.startswith("kiro://"):
        return None
    params = parse_qs(urlparse(url).query)
    values = params.get("code")
    if not values:
        return None
    return values[0]


def _map_kiro_region(region: str) -> str:
    mapping = {
        "us-east-1": "us-east-1",
        "us-west-1": "us-east-1",
        "us-west-2": "us-east-1",
        "eu-west-1": "us-east-1",
        "eu-central-1": "us-east-1",
        "ap-southeast-1": "us-east-1",
        "ap-southeast-2": "us-east-1",
        "ap-northeast-1": "us-east-1",
    }
    normalized = str(region or "").strip().lower()
    if not normalized:
        return "us-east-1"
    return mapping.get(normalized, "us-east-1")


def _build_kiro_usage_url(profile_arn: str) -> str:
    if os.getenv("BATCHER_KIRO_USAGE_ENDPOINT"):
        base = KIRO_USAGE_ENDPOINT
    else:
        base = f"https://q.{_map_kiro_region(KIRO_REGION)}.amazonaws.com/getUsageLimits"

    params = ["origin=AI_EDITOR", "resourceType=AGENTIC_REQUEST"]
    if profile_arn:
        params.append(f"profileArn={quote(profile_arn, safe='')}")
    separator = "&" if "?" in base else "?"
    return base + separator + "&".join(params)


def _parse_kiro_usage_payload(payload: dict[str, Any]) -> dict[str, Any]:
    usage_breakdown = payload.get("usageBreakdownList") or []
    if not usage_breakdown:
        return {"limit": 0.0, "remaining": 0.0}

    usage = usage_breakdown[0] or {}
    subscription_type = str(
        payload.get("subscriptionType") or payload.get("subscription_type") or ""
    ).strip()
    subscription_title = str(
        payload.get("subscriptionTitle") or payload.get("subscription_title") or ""
    ).strip()
    usage_limit = float(usage.get("usageLimit") or 0)
    current_usage = float(usage.get("currentUsage") or 0)
    extra_bonus_credits = 0.0
    extra_bonus_usage = 0.0
    free_trial_limit = 0.0
    free_trial_usage = 0.0
    free_trial_status = str(
        ((usage.get("freeTrialInfo") or {}).get("freeTrialStatus")) or ""
    ).strip()
    total_credits = usage_limit
    total_usage = current_usage

    free_trial = usage.get("freeTrialInfo") or {}
    if str(free_trial.get("freeTrialStatus") or "").upper() == "ACTIVE":
        free_trial_limit = float(free_trial.get("usageLimit") or 0)
        free_trial_usage = float(free_trial.get("currentUsage") or 0)
        total_credits += free_trial_limit
        total_usage += free_trial_usage

    for bonus in usage.get("bonuses") or []:
        extra_bonus_credits += float((bonus or {}).get("usageLimit") or 0)
        extra_bonus_usage += float((bonus or {}).get("currentUsage") or 0)

    total_credits += extra_bonus_credits
    total_usage += extra_bonus_usage

    remaining = total_credits - total_usage
    if remaining < 0:
        remaining = 0.0
    bonus_credits = free_trial_limit + extra_bonus_credits
    account_tier = subscription_title or subscription_type or "free"
    return {
        "subscription_type": subscription_type,
        "subscription_title": subscription_title,
        "account_tier": account_tier,
        "limit": total_credits,
        "total_credits": total_credits,
        "remaining": remaining,
        "remaining_credits": remaining,
        "subscription_credits": usage_limit,
        "bonus_credits": bonus_credits,
        "usage_limit": usage_limit,
        "current_usage": current_usage,
        "total_usage": total_usage,
        "free_trial_status": free_trial_status,
        "free_trial_limit": free_trial_limit,
        "free_trial_usage": free_trial_usage,
        "days_until_reset": int(
            payload.get("daysUntilReset") or payload.get("days_until_reset") or 0
        ),
        "next_reset_date": payload.get("nextResetDate")
        or payload.get("next_reset_date"),
    }


async def _refresh_kiro_access_token(tokens: dict[str, str]) -> dict[str, str] | None:
    refresh_token = str(tokens.get("refresh_token") or "").strip()
    if not refresh_token:
        return None

    try:
        timeout = aiohttp.ClientTimeout(total=20)
        async with aiohttp.ClientSession(timeout=timeout) as client:
            async with client.post(
                KIRO_REFRESH_ENDPOINT,
                json={"refreshToken": refresh_token},
                headers={"Content-Type": "application/json"},
                ssl=_SSL_CTX,
            ) as resp:
                body = await resp.text()
                if resp.status != 200:
                    _kiro_auth_debug(
                        f"refresh failed status={resp.status} body={body[:200]}"
                    )
                    return None
                payload = json.loads(body)
    except Exception as exc:
        _kiro_auth_debug(f"refresh request error={exc}")
        return None

    access_token = str(payload.get("accessToken") or "").strip()
    if not access_token:
        return None

    tokens["access_token"] = access_token
    next_refresh = str(payload.get("refreshToken") or "").strip()
    if next_refresh:
        tokens["refresh_token"] = next_refresh
    if payload.get("expiresIn") is not None:
        tokens["expires_in"] = str(payload.get("expiresIn"))
    if payload.get("expiresAt") is not None:
        tokens["expires_at"] = str(payload.get("expiresAt"))
    return tokens


def _kiro_auth_debug_enabled() -> bool:
    return os.getenv("BATCHER_KIRO_AUTH_DEBUG", "false").lower() == "true"


def _kiro_auth_debug(message: str) -> None:
    if _kiro_auth_debug_enabled():
        print(f"[kiro-auth] {message}", flush=True)


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
            target_url = await _target_url(target)
            _kiro_auth_debug(
                f"email step target={target_url or 'n/a'} selector={selector}"
            )

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
            _kiro_auth_debug(f"email active={await _active_element_snapshot(target)}")

            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass

            try:
                await locator.press_sequentially(email, delay=60)
            except Exception as exc:
                _kiro_auth_debug(f"email type failed err={exc}")
                continue

            await asyncio.sleep(0.5)
            value = await locator.input_value()
            _kiro_auth_debug(f"email typed value={value!r}")
            if email.lower() != str(value).lower().strip():
                continue

            clicked = await _click_google_next(target)
            if not clicked:
                await locator.press("Enter")
            await _wait_for_google_email_transition(target)
            return True
        except Exception as exc:
            _kiro_auth_debug(f"email fill error err={exc}")
            continue
    return False


async def _fill_google_password_step(target: Any, password: str) -> bool:
    for selector in ['input[name="Passwd"]', 'input[type="password"]']:
        try:
            target_url = await _target_url(target)
            _kiro_auth_debug(
                f"password step target={target_url or 'n/a'} selector={selector}"
            )

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
            _kiro_auth_debug(
                f"password active={await _active_element_snapshot(target)}"
            )

            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass

            try:
                await locator.press_sequentially(password, delay=70)
            except Exception as exc:
                _kiro_auth_debug(f"password type failed err={exc}")
                continue

            await asyncio.sleep(0.5)
            value = await locator.input_value()
            _kiro_auth_debug(f"password typed length={len(str(value))}")
            if len(str(value)) < len(password):
                continue

            clicked = await _click_google_next(target)
            if not clicked:
                await locator.press("Enter")
            await _wait_for_google_password_transition(target)
            return True
        except Exception as exc:
            _kiro_auth_debug(f"password fill error err={exc}")
            continue
    return False


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

        for selector in ["#gaplustosNext button", "#confirm", 'input[name="confirm"]', 'input[type="submit"]']:
            locator = page.locator(selector).first
            try:
                if await locator.count() == 0 or not await locator.is_visible():
                    continue
                await locator.click(force=True)
                _kiro_auth_debug(f"gaplustos clicked selector={selector}")
                return True
            except Exception:
                continue

        return bool(
            await page.evaluate(
                """() => {
                    const el = document.querySelector('#gaplustosNext button');
                    if (el && el.offsetParent !== null) { el.click(); return true; }
                    for (const btn of document.querySelectorAll('button, input[type="submit"]')) {
                        if (!btn.offsetParent) continue;
                        btn.click();
                        return true;
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
                    const el = document.querySelector('#submit_approve_access button, #submit_approve_access');
                    if (el && el.offsetParent !== null) { el.click(); return true; }
                    const keywords = ['continue','allow','lanjut','продолжить','разрешить','продовжити','дозволити',
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
                        'verify it’s you',
                        "confirm it's you",
                        'confirm it’s you',
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


async def _poll_kiro_callback(page: Any, session: dict[str, Any]) -> str | None:
    code = str(session.get("auth_code") or "").strip()
    if code:
        return code
    try:
        current_url = page.url
    except Exception:
        return None
    extracted = _extract_code_from_kiro_url(current_url)
    if extracted:
        session["auth_code"] = extracted
        return extracted
    return None


class KiroProviderAdapter(ProviderAdapter):
    name = "kiro"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [part.strip() for part in raw_line.split("|")]

        if len(parts) not in (2, 3):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "kiro account must be email|password or email|password|totp_secret",
            )

        email = parts[0]
        password = parts[1]
        totp_secret = parts[2] if len(parts) == 3 else ""

        if not email or not password:
            raise NonRetryableBatcherError(
                ErrorCode.input_missing_required_field,
                "kiro account requires email and password",
            )

        if not _EMAIL_PATTERN.match(email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "kiro account email format is invalid",
            )

        metadata: dict[str, str] = {}
        if totp_secret:
            metadata["totp_secret"] = totp_secret

        return NormalizedAccount(
            provider=self.name,
            identifier=email,
            secret=password,
            metadata=metadata,
            raw=raw_line,
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
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
                "headless": os.getenv("BATCHER_CAMOUFOX_HEADLESS", "true").lower() == "true"
                == "true",
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

                request_url = route.request.url
                code = _extract_code_from_kiro_url(request_url)
                if code:
                    state["auth_code"] = code
                    await route.abort()
                    return
                await route.continue_()

            await page.route("**/*", route_handler)

            auth_url = f"{KIRO_LOGIN_ENDPOINT}?" + urlencode(
                {
                    "idp": "Google",
                    "redirect_uri": KIRO_REDIRECT_URI,
                    "code_challenge": code_challenge,
                    "code_challenge_method": "S256",
                    "state": str(uuid.uuid4()),
                }
            )
            await page.goto(auth_url, wait_until="domcontentloaded", timeout=20000)

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
            if "rate-limit" in account.identifier:
                raise RetryableBatcherError(
                    ErrorCode.auth_rate_limited, "kiro rate limited"
                )
            if "invalid" in account.identifier:
                raise NonRetryableBatcherError(
                    ErrorCode.auth_invalid_credentials,
                    "kiro invalid credentials",
                )
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

        for _ in range(90):
            code = await _poll_kiro_callback(page, session)
            if code:
                return {
                    "authenticated": True,
                    "authorization_code": code,
                    "code_verifier": session.get("code_verifier", ""),
                }

            try:
                current_url = page.url
            except Exception:
                raise RetryableBatcherError(
                    ErrorCode.browser_unexpected_state, "kiro browser page lost"
                )

            parsed_url = urlparse(current_url) if current_url else None
            current_host = parsed_url.netloc if parsed_url else ""
            current_path = parsed_url.path if parsed_url else ""
            now = time.monotonic()

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
                            "kiro captcha suspected: email step stuck > 60s",
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

            _kiro_auth_debug(
                f"generic continue host={current_host} path={current_path or '/'}"
            )
            await _click_continue_button(page)
            await asyncio.sleep(1.0)

        raise RetryableBatcherError(
            ErrorCode.auth_temporary_failure,
            "kiro authorization code not received",
        )

    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any,
    ) -> dict[str, str]:
        _ = account
        _ = session

        code = auth_state.get("authorization_code", "")
        code_verifier = auth_state.get("code_verifier", "")
        if not code or not code_verifier:
            raise NonRetryableBatcherError(
                ErrorCode.provider_unsupported_response,
                "missing authorization code or code verifier",
            )

        if code == "stub-auth-code":
            return {
                "access_token": "stub-access-token",
                "refresh_token": "stub-refresh-token",
            }

        try:
            timeout = aiohttp.ClientTimeout(total=20)
            async with aiohttp.ClientSession(timeout=timeout) as client:
                async with client.post(
                    KIRO_TOKEN_ENDPOINT,
                    json={
                        "code": code,
                        "code_verifier": code_verifier,
                        "redirect_uri": KIRO_REDIRECT_URI,
                    },
                    headers={"Content-Type": "application/json"},
                    ssl=_SSL_CTX,
                ) as resp:
                    if resp.status == 200:
                        payload = await resp.json()
                        access_token = payload.get("accessToken", "")
                        refresh_token = payload.get("refreshToken", "")
                        profile_arn = str(
                            payload.get("profileArn")
                            or payload.get("profile_arn")
                            or ""
                        ).strip()
                        expires_at = payload.get("expiresAt")
                        expires_in = payload.get("expiresIn")
                        if not access_token:
                            raise NonRetryableBatcherError(
                                ErrorCode.provider_unsupported_response,
                                "kiro token response missing accessToken",
                            )
                        tokens = {
                            "access_token": access_token,
                            "refresh_token": refresh_token,
                        }
                        if profile_arn:
                            tokens["profile_arn"] = profile_arn
                        if expires_at is not None:
                            tokens["expires_at"] = str(expires_at)
                        if expires_in is not None:
                            tokens["expires_in"] = str(expires_in)
                        return tokens

                    if resp.status == 429:
                        raise RetryableBatcherError(
                            ErrorCode.http_429, "kiro token endpoint rate limited"
                        )

                    if resp.status >= 500:
                        raise RetryableBatcherError(
                            ErrorCode.http_5xx,
                            f"kiro token endpoint server error ({resp.status})",
                        )

                    body = await resp.text()
                    raise NonRetryableBatcherError(
                        ErrorCode.provider_unsupported_response,
                        f"kiro token endpoint rejected request ({resp.status}): {body[:120]}",
                    )
        except aiohttp.ServerTimeoutError as exc:
            raise RetryableBatcherError(
                ErrorCode.network_timeout, "kiro token timeout"
            ) from exc
        except aiohttp.ClientConnectionError as exc:
            raise RetryableBatcherError(
                ErrorCode.network_connection_error, "kiro token connection error"
            ) from exc

    async def fetch_quota(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
    ) -> dict[str, Any] | None:
        _ = account
        _ = session

        access_token = str(tokens.get("access_token") or "").strip()
        if access_token.startswith("stub-"):
            return {"limit": 0, "remaining": 0}

        profile_arn = str(
            tokens.get("profile_arn") or tokens.get("profileArn") or ""
        ).strip()
        usage_url = _build_kiro_usage_url(profile_arn)

        for attempt in range(2):
            access_token = str(tokens.get("access_token") or "").strip()
            if not access_token:
                refreshed = await _refresh_kiro_access_token(tokens)
                if not refreshed:
                    return None
                access_token = str(tokens.get("access_token") or "").strip()

            try:
                timeout = aiohttp.ClientTimeout(total=20)
                async with aiohttp.ClientSession(timeout=timeout) as client:
                    async with client.get(
                        usage_url,
                        headers={
                            "Authorization": f"Bearer {access_token}",
                            "Content-Type": "application/json",
                            "User-Agent": "enowXGateway/1.0.0",
                        },
                        ssl=_SSL_CTX,
                    ) as resp:
                        if resp.status == 200:
                            payload = await resp.json()
                            return _parse_kiro_usage_payload(payload)

                        if resp.status in (401, 403) and attempt == 0:
                            refreshed = await _refresh_kiro_access_token(tokens)
                            if refreshed:
                                continue

                        if resp.status == 429:
                            raise RetryableBatcherError(
                                ErrorCode.http_429, "kiro quota endpoint rate limited"
                            )

                        if resp.status >= 500:
                            raise RetryableBatcherError(
                                ErrorCode.http_5xx,
                                f"kiro quota endpoint server error ({resp.status})",
                            )

                        body = await resp.text()
                        raise RetryableBatcherError(
                            ErrorCode.provider_quota_fetch_failed,
                            f"kiro quota endpoint failed ({resp.status}): {body[:200]}",
                        )
            except aiohttp.ServerTimeoutError as exc:
                raise RetryableBatcherError(
                    ErrorCode.network_timeout, "kiro quota timeout"
                ) from exc
            except aiohttp.ClientConnectionError as exc:
                raise RetryableBatcherError(
                    ErrorCode.network_connection_error, "kiro quota connection error"
                ) from exc

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
