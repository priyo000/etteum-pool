"""
Kiro Pro Upgrade — Generate Stripe URL + Autopay with VCC.

Ported from enowxai reference (kiro_login_upgrade.py + kiro_autopay.py).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import ssl
from typing import Any, Optional, Tuple
from urllib.parse import quote

import httpx

_SSL_VERIFY = not os.getenv("BATCHER_SKIP_SSL_VERIFY", "")

KIRO_HOME_URL = "https://app.kiro.dev/home"
KIRO_SUB_URL = "https://app.kiro.dev/service/KiroWebPortalService/operation/GenerateSubscriptionManagementUrl"
DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0"
DEFAULT_SUB_TYPE = "Q_DEVELOPER_STANDALONE_PRO"


def _emit(data: dict) -> None:
    try:
        print(json.dumps(data), flush=True)
    except BrokenPipeError:
        pass


def _progress(step: str, message: str) -> None:
    _emit({"type": "progress", "provider": "kiro-pro", "step": step, "message": message})


# ---------------------------------------------------------------------------
# Stripe URL Generation (HTTP-only, no browser)
# ---------------------------------------------------------------------------

async def generate_stripe_url(access_token: str, profile_arn: str) -> str:
    """Generate Stripe checkout URL using Kiro web portal API."""
    import cbor2

    if not access_token or not profile_arn:
        return ""

    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True, verify=_SSL_VERIFY) as client:
            headers = {"User-Agent": DEFAULT_USER_AGENT}
            cookies = {"AccessToken": access_token, "Idp": "Google"}

            resp = await client.get(KIRO_HOME_URL, headers=headers, cookies=cookies)
            body = resp.text
            final_url = str(resp.url)

            if "/signin" in final_url:
                _progress("upgrade_url_fail", "Token rejected for Stripe URL generation")
                return ""

            uid_match = re.search(r'<meta\s+name="user-id"\s+content="([^"]+)"', body)
            if not uid_match:
                _progress("upgrade_url_fail", "Could not extract user-id from Kiro portal")
                return ""

            user_id = uid_match.group(1)
            cookies["UserId"] = user_id

            resp2 = await client.get(KIRO_HOME_URL, headers=headers, cookies=cookies)
            body2 = resp2.text

            csrf_match = re.search(r'<meta\s+name="csrf-token"\s+content="([^"]+)"', body2)
            if not csrf_match:
                _progress("upgrade_url_fail", "Could not extract csrf-token from Kiro portal")
                return ""

            csrf_token = csrf_match.group(1)

            payload = {
                "subscriptionType": DEFAULT_SUB_TYPE,
                "profileArn": profile_arn,
            }
            encoded = cbor2.dumps(payload)

            sub_headers = {
                "User-Agent": DEFAULT_USER_AGENT,
                "Accept": "application/cbor",
                "Content-Type": "application/cbor",
                "smithy-protocol": "rpc-v2-cbor",
                "x-amz-user-agent": "aws-sdk-js/1.0.0 ua/2.1 os/Windows lang/js md/browser#Firefox_unknown m/N,M,E",
                "Authorization": f"Bearer {access_token}",
                "x-csrf-token": csrf_token,
                "Origin": "https://app.kiro.dev",
                "Referer": "https://app.kiro.dev/account/usage",
            }

            sub_resp = await client.post(
                KIRO_SUB_URL,
                content=encoded,
                headers=sub_headers,
                cookies={"AccessToken": access_token, "UserId": user_id, "Idp": "Google"},
            )

            if sub_resp.status_code == 200:
                result = cbor2.loads(sub_resp.content)
                url = result.get("encodedVerificationUrl", "")
                if url:
                    return url

            _progress("upgrade_url_fail", f"Subscription API returned {sub_resp.status_code}")
            return ""
    except Exception as exc:
        _progress("upgrade_url_fail", f"Stripe URL generation failed: {exc}")
        return ""


# ---------------------------------------------------------------------------
# Stripe Autopay (Browser automation)
# ---------------------------------------------------------------------------

_REACT_SET_INPUT_JS = """
([element_id, value]) => {
    const el = document.getElementById(element_id);
    if (!el) return false;
    const tag = el.tagName;
    const proto = tag === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}
"""


async def _fill_by_id(page: Any, element_id: str, value: str) -> bool:
    if not value:
        return False
    try:
        locator = page.locator(f"#{element_id}")
        await locator.wait_for(state="attached", timeout=5000)
        return bool(await page.evaluate(_REACT_SET_INPUT_JS, [element_id, value]))
    except Exception:
        return False


async def _human_type_by_id(page: Any, element_id: str, value: str) -> bool:
    if not value:
        return False
    try:
        locator = page.locator(f"#{element_id}")
        await locator.wait_for(state="visible", timeout=5000)
        await locator.click(timeout=3000)
        try:
            await locator.press("ControlOrMeta+A", timeout=1500)
            await locator.press("Backspace", timeout=1500)
        except Exception:
            pass
        await locator.type(value, delay=55)
        await page.wait_for_timeout(120)
        current_value = await locator.input_value(timeout=1500)
        if "".join(str(current_value or "").split()) == "".join(str(value or "").split()):
            return True
    except Exception:
        pass
    return await _fill_by_id(page, element_id, value)


async def _select_by_id(page: Any, element_id: str, value: str) -> bool:
    if not value:
        return False
    try:
        locator = page.locator(f"#{element_id}")
        await locator.wait_for(state="attached", timeout=5000)
        # Use Playwright's native select_option for <select> elements
        try:
            await locator.select_option(value, timeout=3000)
            return True
        except Exception:
            pass
        # Fallback: try React setter
        return bool(await page.evaluate(_REACT_SET_INPUT_JS, [element_id, value]))
    except Exception:
        return False


async def _wait_for_stripe_tax_settle(page: Any, deadline_s: float = 8.0) -> None:
    inflight: set = set()

    def on_req(r):
        u = r.url
        if "api.stripe.com" in u or "checkout.stripe.com" in u:
            inflight.add(id(r))

    def on_done(r):
        inflight.discard(id(r))

    page.on("request", on_req)
    page.on("requestfinished", on_done)
    page.on("requestfailed", on_done)
    try:
        deadline = asyncio.get_event_loop().time() + deadline_s
        idle_since = None
        await page.wait_for_timeout(300)
        while asyncio.get_event_loop().time() < deadline:
            if len(inflight) == 0:
                if idle_since is None:
                    idle_since = asyncio.get_event_loop().time()
                elif asyncio.get_event_loop().time() - idle_since >= 0.8:
                    return
            else:
                idle_since = None
            await page.wait_for_timeout(100)
    finally:
        try:
            page.remove_listener("request", on_req)
            page.remove_listener("requestfinished", on_done)
            page.remove_listener("requestfailed", on_done)
        except Exception:
            pass


def _parse_money_amount(raw: str) -> Optional[float]:
    if not raw:
        return None
    cleaned = re.sub(r"[^0-9,.\-]", "", raw)
    if not cleaned:
        return None
    if "," in cleaned and "." in cleaned:
        cleaned = cleaned.replace(",", "")
    elif "," in cleaned:
        parts = cleaned.split(",")
        if len(parts[-1]) in (1, 2):
            cleaned = ".".join(parts)
        else:
            cleaned = "".join(parts)
    try:
        return float(cleaned)
    except ValueError:
        return None


async def _read_total_due_today(page: Any) -> Optional[dict]:
    script = r"""
    () => {
        const labels = ["total due today","amount due today","total due","due today"];
        const amountRegex = /(?:rp|idr|sgd|myr|thb|php|vnd|hkd|twd|jpy|krw|cny|inr|brl|mxn|\$|usd|eur|gbp|aud|cad)?\s*-?\d[\d.,]*/ig;
        const candidates = [];
        const nodes = Array.from(document.querySelectorAll("body *"));
        function normalize(text) { return (text || "").replace(/\s+/g, " ").trim(); }
        function collectCandidate(label, text, depth) {
            const normalized = normalize(text);
            if (!normalized || normalized.length > 700) return;
            const matches = Array.from(normalized.matchAll(amountRegex));
            if (!matches.length) return;
            const amount = matches[matches.length - 1][0];
            candidates.push({ label, text: normalized, amount, depth, length: normalized.length });
        }
        for (const node of nodes) {
            const own = normalize(`${node.getAttribute("aria-label") || ""} ${node.textContent || ""}`);
            if (!own) continue;
            const lower = own.toLowerCase();
            const label = labels.find(entry => lower === entry || lower.startsWith(`${entry} `) || lower.includes(`${entry} `));
            if (!label) continue;
            collectCandidate(label, own, 0);
            let parent = node.parentElement;
            for (let depth = 1; parent && depth <= 5; depth++) {
                collectCandidate(label, parent.textContent || "", depth);
                parent = parent.parentElement;
            }
        }
        if (!candidates.length) return null;
        candidates.sort((a, b) => { if (a.depth !== b.depth) return a.depth - b.depth; return a.length - b.length; });
        return candidates[0];
    }
    """
    try:
        row = await page.evaluate(script)
        return row if isinstance(row, dict) else None
    except Exception:
        return None


class EligibilityError(Exception):
    pass


async def _assert_zero_checkout_total(page: Any) -> None:
    row = None
    for attempt in range(3):
        row = await _read_total_due_today(page)
        if row:
            break
        if attempt < 2:
            await asyncio.sleep(1.0)

    if not row:
        raise EligibilityError("Total due today row not found")

    amount = str(row.get("amount") or "").strip()
    parsed = _parse_money_amount(amount)
    if parsed is None:
        raise EligibilityError(f"Total due today unreadable: {amount}")

    if abs(parsed) > 0.000001:
        raise EligibilityError(f"Total due today is non-zero: {amount}")

    _progress("upgrade_safety_check", f"Eligibility confirmed: total due today = {amount}")


async def detect_success(page: Any) -> bool:
    try:
        url_raw = page.url or ""
        url = url_raw.lower()
        if "/success" in url or "/thank" in url or "subscription-success" in url:
            return True
        if "app.kiro.dev" in url:
            return True
        ok = await page.query_selector("[data-testid='payment-success']")
        return ok is not None
    except Exception:
        return False


async def detect_failure(page: Any) -> Optional[str]:
    try:
        field_error = await page.evaluate("""
            () => {
                const containers = Array.from(document.querySelectorAll('.FieldError-container, .FieldError, [class*="FieldError"]'));
                for (const c of containers) {
                    const txt = (c.innerText || '').trim();
                    if (txt.length > 0) return txt.slice(0, 200);
                }
                return null;
            }
        """)
        if field_error:
            normalized = " ".join(field_error.strip().lower().split())
            terminal = ["declin", "insufficient", "invalid", "expired", "unable to authenticate"]
            if any(p in normalized for p in terminal):
                return f"declined: {field_error[:200]}"

        if "/failed" in (page.url or "").lower():
            return "stripe_failed_url"
        return None
    except Exception:
        return None


async def detect_captcha(page: Any) -> Optional[Any]:
    try:
        handle = await page.evaluate_handle("""
            () => {
                const iframes = Array.from(document.querySelectorAll('iframe'));
                for (const f of iframes) {
                    const src = (f.src || '').toLowerCase();
                    if (!src.includes('hcaptcha') && !src.includes('captcha')) continue;
                    const cs = getComputedStyle(f);
                    if (cs.visibility !== 'visible' || cs.display === 'none') continue;
                    const r = f.getBoundingClientRect();
                    if (r.width < 300 || r.height < 300) continue;
                    return f;
                }
                return null;
            }
        """)
        element = handle.as_element()
        if element is None:
            return None
        box = await element.bounding_box()
        if not box or box["width"] < 300 or box["height"] < 300:
            return None
        return element
    except Exception:
        return None


async def click_hcaptcha_checkbox(page: Any) -> bool:
    try:
        for frame in page.frames:
            frame_url = (frame.url or "").lower()
            if "hcaptcha" not in frame_url:
                continue
            try:
                clicked = await frame.evaluate("""() => {
                    const cb = document.querySelector('#checkbox, [role="checkbox"], .check');
                    if (!cb) return '';
                    const rect = cb.getBoundingClientRect();
                    if (rect.width < 5 || rect.height < 5) return '';
                    cb.click();
                    return 'clicked';
                }""")
                if clicked:
                    return True
            except Exception:
                pass

        iframes = await page.query_selector_all("iframe")
        for iframe in iframes:
            try:
                src = await iframe.get_attribute("src") or ""
                if "hcaptcha" not in src.lower():
                    continue
                box = await iframe.bounding_box()
                if not box or box["width"] < 30 or box["height"] < 30:
                    continue
                if box["height"] < 120:
                    await page.mouse.click(box["x"] + 28, box["y"] + box["height"] / 2)
                    return True
            except Exception:
                continue
        return False
    except Exception:
        return False


async def autofill_stripe(page: Any, card: dict, address: dict) -> None:
    """Autofill Stripe Checkout form."""
    try:
        await page.wait_for_selector("#cardNumber", state="attached", timeout=20000)
    except Exception as exc:
        raise RuntimeError("Stripe card form not visible") from exc

    card_number = (card.get("number") or "").strip()
    exp_month = str(card.get("exp_month") or "").zfill(2)
    exp_year = str(card.get("exp_year") or "")[-2:]
    exp_str = f"{exp_month} / {exp_year}" if exp_month and exp_year else ""
    cvc = (card.get("cvv") or card.get("cvc") or "").strip()
    name = (address.get("name") or card.get("name") or "").strip()
    country = (address.get("country") or "").strip().upper()
    line1 = (address.get("line1") or "").strip()
    line2 = (address.get("line2") or "").strip()
    city = (address.get("city") or "").strip()
    state = (address.get("state") or "").strip()
    postal = (address.get("postal_code") or "").strip()

    await _human_type_by_id(page, "cardNumber", card_number)
    await _human_type_by_id(page, "cardExpiry", exp_str)
    await _human_type_by_id(page, "cardCvc", cvc)
    await _fill_by_id(page, "billingName", name)

    if country:
        await _select_by_id(page, "billingCountry", country)

    await _fill_by_id(page, "billingAddressLine1", line1)
    if line2:
        await _fill_by_id(page, "billingAddressLine2", line2)
    await _fill_by_id(page, "billingLocality", city)
    if state:
        await _select_by_id(page, "billingAdministrativeArea", state)
    await _fill_by_id(page, "billingPostalCode", postal)

    await _wait_for_stripe_tax_settle(page)
    await _assert_zero_checkout_total(page)

    _progress("upgrade_paying", "Submitting payment...")

    pay_selectors = [
        'button[data-testid="hosted-payment-submit-button"]',
        'button[type="submit"]',
    ]
    for selector in pay_selectors:
        try:
            btn = page.locator(selector).first
            if await btn.count() == 0:
                continue
            await btn.wait_for(state="attached", timeout=5000)
            deadline = asyncio.get_event_loop().time() + 15.0
            while asyncio.get_event_loop().time() < deadline:
                if await btn.is_enabled():
                    break
                await page.wait_for_timeout(250)
            await btn.evaluate("""
                el => {
                    const r = el.getBoundingClientRect();
                    const x = r.left + r.width / 2;
                    const y = r.top + r.height / 2;
                    const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
                    for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
                        el.dispatchEvent(new MouseEvent(type, opts));
                    }
                    el.click();
                    const form = el.closest('form');
                    if (form && form.requestSubmit) { try { form.requestSubmit(el); } catch (_) {} }
                }
            """)
            await page.wait_for_timeout(1000)
            return
        except Exception:
            continue
    raise RuntimeError("Stripe pay button not available")


async def run_stripe_autopay(
    page: Any,
    stripe_url: str,
    card: dict,
    address: dict,
) -> Tuple[bool, str, str]:
    """
    Navigate to Stripe checkout and complete payment.

    Returns (success, message, card_status).
    card_status: "success", "declined", or "error"
    """
    try:
        _progress("upgrade_navigating", "Navigating to Stripe checkout...")
        await page.goto(stripe_url, wait_until="domcontentloaded", timeout=30000)

        _progress("upgrade_autofilling", "Autofilling payment details...")
        try:
            await autofill_stripe(page, card, address)
        except EligibilityError as exc:
            return False, f"not_eligible: {exc}", "error"
        except RuntimeError as exc:
            return False, str(exc), "error"

        max_polls = int(5 * 60 / 0.5)
        for poll in range(max_polls):
            if await detect_success(page):
                return True, "Payment succeeded", "success"

            failure = await detect_failure(page)
            if failure:
                if "declin" in failure.lower():
                    return False, failure, "declined"
                return False, failure, "error"

            captcha_el = await detect_captcha(page)
            if captcha_el:
                _progress("upgrade_captcha", "hCaptcha detected, attempting...")
                clicked = await click_hcaptcha_checkbox(page)
                if clicked:
                    await asyncio.sleep(3.0)
                    continue
                # Wait for captcha to resolve (user or service)
                for _ in range(60):
                    await asyncio.sleep(1.0)
                    box = None
                    try:
                        box = await captcha_el.bounding_box()
                    except Exception:
                        break
                    if not box or box.get("width", 0) < 50:
                        break
                continue

            await asyncio.sleep(0.5)

        return False, "Timeout waiting for payment result", "error"

    except Exception as exc:
        return False, f"Autopay error: {exc}", "error"
