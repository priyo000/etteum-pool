"""
Captcha Solver — handles captcha challenges on Stripe checkout pages.

Default: manual solve (pause and wait for user in non-headless mode).
Optional: capsolver API for automatic solving.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import aiohttp


def _debug(msg: str) -> None:
    if os.getenv("BATCHER_KIRO_AUTH_DEBUG", "false").lower() == "true":
        print(f"[captcha] {msg}", flush=True)


def _emit(data: dict) -> None:
    try:
        print(json.dumps(data), flush=True)
    except BrokenPipeError:
        pass


class CaptchaSolver:
    def __init__(self):
        self.service = os.getenv("BATCHER_CAPTCHA_SERVICE", "none").lower()
        self.api_key = os.getenv("BATCHER_CAPTCHA_API_KEY", "")
        self.is_headless = os.getenv("BATCHER_CAMOUFOX_HEADLESS", "true").lower() == "true"

    async def detect_captcha(self, page: Any) -> dict[str, str] | None:
        """Detect if a captcha is present on the page. Returns captcha info or None."""
        try:
            info = await page.evaluate("""() => {
                // reCAPTCHA v2
                const recaptchaFrame = document.querySelector('iframe[src*="recaptcha"]');
                if (recaptchaFrame) {
                    const src = recaptchaFrame.getAttribute('src') || '';
                    const match = src.match(/[?&]k=([^&]+)/);
                    return { type: 'recaptcha_v2', siteKey: match ? match[1] : '' };
                }
                // reCAPTCHA v3 (invisible)
                const recaptchaV3 = document.querySelector('.grecaptcha-badge');
                if (recaptchaV3) {
                    const scripts = document.querySelectorAll('script[src*="recaptcha"]');
                    for (const s of scripts) {
                        const match = s.src.match(/[?&]render=([^&]+)/);
                        if (match && match[1] !== 'explicit') return { type: 'recaptcha_v3', siteKey: match[1] };
                    }
                    return { type: 'recaptcha_v3', siteKey: '' };
                }
                // Turnstile
                const turnstile = document.querySelector('[data-sitekey]');
                if (turnstile) {
                    return { type: 'turnstile', siteKey: turnstile.getAttribute('data-sitekey') || '' };
                }
                // hCaptcha
                const hcaptcha = document.querySelector('iframe[src*="hcaptcha"]');
                if (hcaptcha) {
                    const container = document.querySelector('[data-sitekey]');
                    return { type: 'hcaptcha', siteKey: container ? container.getAttribute('data-sitekey') : '' };
                }
                return null;
            }""")
            if info:
                _debug(f"detected captcha: {info}")
            return info
        except Exception as e:
            _debug(f"captcha detection error: {e}")
            return None

    async def solve(self, page: Any, page_url: str) -> bool:
        """Attempt to solve captcha. Returns True if solved or no captcha present."""
        captcha_info = await self.detect_captcha(page)
        if not captcha_info:
            return True

        captcha_type = captcha_info.get("type", "")
        site_key = captcha_info.get("siteKey", "")

        # Try auto-solve if service configured
        if self.service == "capsolver" and self.api_key:
            _emit({
                "type": "progress",
                "provider": "kiro-pro",
                "step": "captcha_auto",
                "message": f"Attempting auto-solve ({captcha_type})...",
            })
            token = await self._capsolver_solve(captcha_type, site_key, page_url)
            if token:
                injected = await self._inject_token(page, captcha_type, token)
                if injected:
                    _debug("captcha auto-solved successfully")
                    return True
                _debug("failed to inject captcha token")

        # Fallback: manual solve (only in non-headless mode)
        if not self.is_headless:
            return await self.wait_manual_solve(page)

        _debug("captcha present but no solver available and running headless")
        return False

    async def _capsolver_solve(
        self, captcha_type: str, site_key: str, page_url: str
    ) -> str | None:
        """Solve captcha via Capsolver API."""
        if not site_key:
            _debug("no site_key found, cannot auto-solve")
            return None

        task_type_map = {
            "recaptcha_v2": "ReCaptchaV2TaskProxyLess",
            "recaptcha_v3": "ReCaptchaV3TaskProxyLess",
            "turnstile": "AntiTurnstileTaskProxyLess",
            "hcaptcha": "HCaptchaTaskProxyLess",
        }

        task_type = task_type_map.get(captcha_type)
        if not task_type:
            _debug(f"unsupported captcha type for capsolver: {captcha_type}")
            return None

        create_payload: dict[str, Any] = {
            "clientKey": self.api_key,
            "task": {
                "type": task_type,
                "websiteURL": page_url,
                "websiteKey": site_key,
            },
        }

        if captcha_type == "recaptcha_v3":
            create_payload["task"]["pageAction"] = "submit"
            create_payload["task"]["minScore"] = 0.7

        try:
            timeout = aiohttp.ClientTimeout(total=120)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                # Create task
                async with session.post(
                    "https://api.capsolver.com/createTask",
                    json=create_payload,
                ) as resp:
                    result = await resp.json()
                    if result.get("errorId", 0) != 0:
                        _debug(f"capsolver create error: {result.get('errorDescription')}")
                        return None
                    task_id = result.get("taskId")
                    if not task_id:
                        _debug("capsolver: no taskId returned")
                        return None

                # Poll for result
                for _ in range(60):
                    await asyncio.sleep(2)
                    async with session.post(
                        "https://api.capsolver.com/getTaskResult",
                        json={"clientKey": self.api_key, "taskId": task_id},
                    ) as resp:
                        result = await resp.json()
                        status = result.get("status", "")
                        if status == "ready":
                            solution = result.get("solution", {})
                            token = solution.get("gRecaptchaResponse") or solution.get("token") or ""
                            if token:
                                _debug("capsolver: got solution token")
                                return token
                            _debug(f"capsolver: ready but no token in solution: {solution}")
                            return None
                        if status == "failed":
                            _debug(f"capsolver task failed: {result.get('errorDescription')}")
                            return None

                _debug("capsolver: timeout waiting for solution")
                return None
        except Exception as e:
            _debug(f"capsolver error: {e}")
            return None

    async def _inject_token(self, page: Any, captcha_type: str, token: str) -> bool:
        """Inject solved captcha token into the page."""
        try:
            if captcha_type in ("recaptcha_v2", "recaptcha_v3"):
                await page.evaluate(f"""(token) => {{
                    document.getElementById('g-recaptcha-response').value = token;
                    if (typeof ___grecaptcha_cfg !== 'undefined') {{
                        Object.entries(___grecaptcha_cfg.clients).forEach(([k, v]) => {{
                            const callback = v?.S?.S?.callback || v?.S?.callback;
                            if (typeof callback === 'function') callback(token);
                        }});
                    }}
                }}""", token)
                return True
            elif captcha_type == "turnstile":
                await page.evaluate(f"""(token) => {{
                    const input = document.querySelector('[name="cf-turnstile-response"]');
                    if (input) input.value = token;
                    if (typeof turnstile !== 'undefined') {{
                        const widgets = document.querySelectorAll('[data-sitekey]');
                        widgets.forEach(w => {{
                            const id = w.getAttribute('id');
                            if (id) turnstile.getResponse(id);
                        }});
                    }}
                }}""", token)
                return True
            elif captcha_type == "hcaptcha":
                await page.evaluate(f"""(token) => {{
                    document.querySelector('[name="h-captcha-response"]').value = token;
                    document.querySelector('[name="g-recaptcha-response"]').value = token;
                }}""", token)
                return True
            return False
        except Exception as e:
            _debug(f"inject token error: {e}")
            return False

    async def wait_manual_solve(self, page: Any, timeout: int = 120) -> bool:
        """Wait for user to manually solve captcha in non-headless browser."""
        _emit({
            "type": "progress",
            "provider": "kiro-pro",
            "step": "captcha_manual",
            "message": f"Captcha detected — please solve manually in the browser (timeout: {timeout}s)",
        })

        start = asyncio.get_event_loop().time()
        while (asyncio.get_event_loop().time() - start) < timeout:
            captcha_info = await self.detect_captcha(page)
            if not captcha_info:
                _debug("captcha resolved (manual)")
                return True
            # Check if page navigated away (payment submitted)
            try:
                url = page.url
                if "checkout.stripe.com" not in url:
                    return True
            except Exception:
                pass
            await asyncio.sleep(2)

        _debug("manual captcha solve timed out")
        return False
