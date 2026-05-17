#!/usr/bin/env python3

import argparse
import asyncio
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.providers.kiro import KiroProviderAdapter
from app.providers.kiro_pro import KiroProProviderAdapter
from app.providers.codebuddy import CodeBuddyProviderAdapter
from app.providers.wavespeed import WavespeedProviderAdapter
from app.providers.canva import CanvaProviderAdapter
from app.providers.yepapi import YepAPIAdapter
from app.providers.zai import ZaiProviderAdapter
from app.providers.windsurf import WindsurfProviderAdapter
from app.providers.moclaw import MoclawProviderAdapter
from app.providers.codex import CodexProviderAdapter
from app.providers.base import NormalizedAccount
from app.errors.exceptions import BatcherError, RetryableBatcherError

MAX_RETRIES = 3
BASE_DELAY = 2.0
MAX_DELAY = 15.0
PROVIDER_TIMEOUT = 180
KIRO_PRO_TIMEOUT = 600  # 10 minutes for kiro-pro (upgrade + payment takes longer)


def emit(data: dict):
    try:
        print(json.dumps(data), flush=True)
    except BrokenPipeError:
        pass


def retry_delay(attempt: int) -> float:
    return min(BASE_DELAY * (2**attempt), MAX_DELAY)


async def _run_provider_once(adapter, account: NormalizedAccount) -> dict:
    provider_name = adapter.name
    session = None
    try:
        session = await adapter.bootstrap_session(account)
        emit(
            {
                "type": "progress",
                "provider": provider_name,
                "step": "browser_launch",
                "message": "Browser session ready",
            }
        )

        auth_state = await adapter.authenticate(account, session)
        emit(
            {
                "type": "progress",
                "provider": provider_name,
                "step": "authenticated",
                "message": "Authenticated",
            }
        )

        tokens = await adapter.fetch_tokens(account, auth_state, session)
        emit(
            {
                "type": "progress",
                "provider": provider_name,
                "step": "tokens",
                "message": "Tokens obtained",
            }
        )

        quota = None
        try:
            quota = await adapter.fetch_quota(account, tokens, session)
            quota_msg = "Quota fetched"
            if isinstance(quota, dict):
                if quota.get("gift_claimed"):
                    gift_credits = quota.get("gift_credits", 0)
                    emit(
                        {
                            "type": "progress",
                            "provider": provider_name,
                            "step": "claim",
                            "message": f"VIP bonus claimed: +{int(gift_credits)} credits",
                        }
                    )

                remain = (
                    quota.get("remaining_credits")
                    or quota.get("remaining")
                    or quota.get("credit_capacity_remain")
                )
                total = (
                    quota.get("total_credits")
                    or quota.get("limit")
                    or quota.get("credit_capacity_size")
                    or quota.get("credit_total_dosage")
                )
                if remain is not None and total is not None:
                    quota_msg = f"Quota fetched: {float(remain):.0f}/{float(total):.0f} credits remaining"
                elif total is not None:
                    quota_msg = f"Quota fetched: {float(total):.0f} credits total"
                elif remain is not None:
                    quota_msg = f"Quota fetched: {float(remain):.0f} credits remaining"
            emit(
                {
                    "type": "progress",
                    "provider": provider_name,
                    "step": "quota",
                    "message": quota_msg,
                }
            )
        except Exception as e:
            emit(
                {
                    "type": "progress",
                    "provider": provider_name,
                    "step": "quota_skip",
                    "message": f"Quota fetch skipped: {e}",
                }
            )

        # Save browser cookie header string for billing API access
        if session and isinstance(session, dict):
            page = session.get("page")
            if page:
                try:
                    context = page.context
                    browser_cookies = await context.cookies()
                    if browser_cookies:
                        cookie_header = "; ".join(
                            f"{c['name']}={c['value']}" for c in browser_cookies
                        )
                        tokens["web_cookie"] = cookie_header
                except Exception:
                    pass

        # Post-login hook (e.g., kiro-pro auto-upgrade)
        upgrade_result = None
        if hasattr(adapter, "post_login_hook"):
            try:
                upgrade_result = await adapter.post_login_hook(account, tokens, session, quota)
            except Exception as e:
                emit(
                    {
                        "type": "progress",
                        "provider": provider_name,
                        "step": "upgrade_error",
                        "message": str(e),
                    }
                )
                upgrade_result = {"upgrade_success": False, "upgrade_error": str(e)}

        result = {
            "success": True,
            "provider": provider_name,
            "credentials": tokens,
            "quota": quota,
        }
        if upgrade_result is not None:
            result["upgrade"] = upgrade_result
            if upgrade_result.get("quota"):
                result["quota"] = upgrade_result["quota"]
        return result
    finally:
        if session is not None:
            try:
                await adapter.cleanup_session(session)
            except Exception:
                pass


async def run_provider(adapter, account: NormalizedAccount) -> dict:
    provider_name = adapter.name
    last_error = None

    emit(
        {
            "type": "progress",
            "provider": provider_name,
            "step": "init",
            "message": "Initializing...",
        }
    )

    for attempt in range(MAX_RETRIES):
        try:
            timeout = KIRO_PRO_TIMEOUT if provider_name == "kiro-pro" else PROVIDER_TIMEOUT
            return await asyncio.wait_for(
                _run_provider_once(adapter, account), timeout=timeout
            )
        except asyncio.TimeoutError:
            last_error = TimeoutError(f"provider timed out after {timeout}s")
            # For kiro-pro: don't retry on timeout — upgrade/payment phase is long-running
            # and retrying would restart from login which wastes time
            if provider_name == "kiro-pro":
                emit(
                    {
                        "type": "error",
                        "provider": provider_name,
                        "error": f"timed out after {timeout}s (no retry for kiro-pro upgrade)",
                    }
                )
                return {
                    "success": False,
                    "provider": provider_name,
                    "error": f"timed out after {timeout}s",
                }
            if attempt < MAX_RETRIES - 1:
                delay = retry_delay(attempt)
                emit(
                    {
                        "type": "progress",
                        "provider": provider_name,
                        "step": "retry",
                        "message": f"Timeout after {timeout}s — retrying in {delay:.0f}s (attempt {attempt + 2}/{MAX_RETRIES})",
                    }
                )
                await asyncio.sleep(delay)
            else:
                emit(
                    {
                        "type": "error",
                        "provider": provider_name,
                        "error": f"timed out after {PROVIDER_TIMEOUT}s",
                    }
                )
                return {
                    "success": False,
                    "provider": provider_name,
                    "error": f"timed out after {PROVIDER_TIMEOUT}s",
                }
        except RetryableBatcherError as e:
            last_error = e
            if attempt < MAX_RETRIES - 1:
                delay = retry_delay(attempt)
                emit(
                    {
                        "type": "progress",
                        "provider": provider_name,
                        "step": "retry",
                        "message": f"Retryable error: {e.message} — retrying in {delay:.0f}s (attempt {attempt + 2}/{MAX_RETRIES})",
                    }
                )
                await asyncio.sleep(delay)
            else:
                emit(
                    {
                        "type": "error",
                        "provider": provider_name,
                        "error": e.message,
                        "code": e.code.value,
                    }
                )
                return {"success": False, "provider": provider_name, "error": e.message}
        except BatcherError as e:
            emit(
                {
                    "type": "error",
                    "provider": provider_name,
                    "error": e.message,
                    "code": e.code.value,
                }
            )
            return {"success": False, "provider": provider_name, "error": e.message}
        except Exception as e:
            last_error = e
            if attempt < MAX_RETRIES - 1:
                delay = retry_delay(attempt)
                emit(
                    {
                        "type": "progress",
                        "provider": provider_name,
                        "step": "retry",
                        "message": f"Error: {e} — retrying in {delay:.0f}s (attempt {attempt + 2}/{MAX_RETRIES})",
                    }
                )
                await asyncio.sleep(delay)
            else:
                emit({"type": "error", "provider": provider_name, "error": str(e)})
                return {"success": False, "provider": provider_name, "error": str(e)}

    emit({"type": "error", "provider": provider_name, "error": str(last_error)})
    return {"success": False, "provider": provider_name, "error": str(last_error)}


async def main(email: str, password: str):
    emit(
        {
            "type": "progress",
            "provider": "all",
            "step": "start",
            "message": f"Starting login for {email}...",
        }
    )

    proxy_url = os.getenv("BATCHER_PROXY_URL", "")
    http_proxy = os.getenv("HTTP_PROXY", "")
    if proxy_url or http_proxy:
        emit(
            {
                "type": "progress",
                "provider": "all",
                "step": "proxy",
                "message": f"Proxy: {proxy_url or http_proxy}",
            }
        )
    else:
        emit(
            {
                "type": "progress",
                "provider": "all",
                "step": "proxy",
                "message": "No proxy configured",
            }
        )

    concurrent = int(os.getenv("BATCHER_CONCURRENT", "2"))
    priority = os.getenv("BATCHER_PRIORITY", "standard").lower()
    allowed_providers = {
        item.strip().lower()
        for item in os.getenv("ENOWX_ALLOWED_PROVIDERS", "").split(",")
        if item.strip()
    }

    if allowed_providers:
        provider_specs = {
            "kiro": (KiroProviderAdapter(), NormalizedAccount(provider="kiro", identifier=email, secret=password)),
            "codebuddy": (CodeBuddyProviderAdapter(), NormalizedAccount(provider="codebuddy", identifier=email, secret=password)),
            "canva": (CanvaProviderAdapter(), NormalizedAccount(provider="canva", identifier=email, secret=password)),
            "zai": (ZaiProviderAdapter(), NormalizedAccount(provider="zai", identifier=email, secret=password)),
            "windsurf": (WindsurfProviderAdapter(), NormalizedAccount(provider="windsurf", identifier=email, secret=password)),
            "moclaw": (MoclawProviderAdapter(), NormalizedAccount(provider="moclaw", identifier=email, secret=password)),
            "kiro-pro": (KiroProProviderAdapter(), NormalizedAccount(provider="kiro-pro", identifier=email, secret=password)),
            "codex": (CodexProviderAdapter(), NormalizedAccount(provider="codex", identifier=email, secret=password)),
        }
        tasks = []
        task_names = []
        for name in ["kiro", "kiro-pro", "codebuddy", "canva", "zai", "windsurf", "moclaw", "codex"]:
            if name in allowed_providers:
                adapter, account = provider_specs[name]
                tasks.append(run_provider(adapter, account))
                task_names.append(name)
        results = await asyncio.gather(*tasks, return_exceptions=True)
        result = {"type": "result"}
        for name in ["kiro", "kiro-pro", "codebuddy", "wavespeed", "canva", "yepapi", "zai", "windsurf", "moclaw", "codex"]:
            result[name] = {"success": False, "provider": name, "error": "skipped"}
        for name, provider_result in zip(task_names, results):
            if isinstance(provider_result, BaseException):
                provider_result = {"success": False, "provider": name, "error": str(provider_result)}
            result[name] = provider_result
        emit(result)
        return

    kiro_account = NormalizedAccount(provider="kiro", identifier=email, secret=password)
    cb_account = NormalizedAccount(
        provider="codebuddy", identifier=email, secret=password
    )
    ws_account = NormalizedAccount(
        provider="wavespeed", identifier=email, secret=password
    )
    canva_account = NormalizedAccount(
        provider="canva", identifier=email, secret=password
    )
    yep_account = NormalizedAccount(
        provider="yepapi", identifier=email, secret=password
    )

    kiro_adapter = KiroProviderAdapter()
    cb_adapter = CodeBuddyProviderAdapter()
    ws_adapter = WavespeedProviderAdapter()
    canva_adapter = CanvaProviderAdapter()
    yep_adapter = YepAPIAdapter()

    ws_skipped = {"success": False, "provider": "wavespeed", "error": "skipped"}
    canva_skipped = {"success": False, "provider": "canva", "error": "skipped"}
    yep_skipped = {"success": False, "provider": "yepapi", "error": "skipped"}

    kiro_skipped = {"success": False, "provider": "kiro", "error": "skipped"}
    cb_skipped = {"success": False, "provider": "codebuddy", "error": "skipped"}

    run_canva = priority == "canva" or concurrent >= 4
    canva_result = canva_skipped

    if concurrent == 1:
        if priority == "max":
            cb_result = await run_provider(cb_adapter, cb_account)
            if isinstance(cb_result, BaseException):
                cb_result = {"success": False, "provider": "codebuddy", "error": str(cb_result)}
            result = {"type": "result", "kiro": kiro_skipped, "codebuddy": cb_result, "wavespeed": ws_skipped, "canva": canva_skipped, "yepapi": yep_skipped}
        elif priority == "wavespeed":
            ws_result = await run_provider(ws_adapter, ws_account)
            if isinstance(ws_result, BaseException):
                ws_result = {"success": False, "provider": "wavespeed", "error": str(ws_result)}
            result = {"type": "result", "kiro": kiro_skipped, "codebuddy": cb_skipped, "wavespeed": ws_result, "canva": canva_skipped, "yepapi": yep_skipped}
        elif priority == "canva":
            canva_result = await run_provider(canva_adapter, canva_account)
            if isinstance(canva_result, BaseException):
                canva_result = {"success": False, "provider": "canva", "error": str(canva_result)}
            result = {"type": "result", "kiro": kiro_skipped, "codebuddy": cb_skipped, "wavespeed": ws_skipped, "canva": canva_result, "yepapi": yep_skipped}
        elif priority == "yepapi":
            yep_result = await run_provider(yep_adapter, yep_account)
            if isinstance(yep_result, BaseException):
                yep_result = {"success": False, "provider": "yepapi", "error": str(yep_result)}
            result = {"type": "result", "kiro": kiro_skipped, "codebuddy": cb_skipped, "wavespeed": ws_skipped, "canva": canva_skipped, "yepapi": yep_result}
        else:
            kiro_result = await run_provider(kiro_adapter, kiro_account)
            if isinstance(kiro_result, BaseException):
                kiro_result = {"success": False, "provider": "kiro", "error": str(kiro_result)}
            result = {"type": "result", "kiro": kiro_result, "codebuddy": cb_skipped, "wavespeed": ws_skipped, "canva": canva_skipped, "yepapi": yep_skipped}
        emit(result)
        return

    if concurrent == 2:
        kiro_result, cb_result = await asyncio.gather(
            run_provider(kiro_adapter, kiro_account),
            run_provider(cb_adapter, cb_account),
            return_exceptions=True,
        )
        if isinstance(kiro_result, BaseException):
            kiro_result = {"success": False, "provider": "kiro", "error": str(kiro_result)}
        if isinstance(cb_result, BaseException):
            cb_result = {"success": False, "provider": "codebuddy", "error": str(cb_result)}
        result = {"type": "result", "kiro": kiro_result, "codebuddy": cb_result, "wavespeed": ws_skipped, "canva": canva_skipped, "yepapi": yep_skipped}
        emit(result)
        return

    run_yepapi = concurrent >= 5
    yep_result = yep_skipped

    tasks = [
        run_provider(kiro_adapter, kiro_account),
        run_provider(cb_adapter, cb_account),
        run_provider(ws_adapter, ws_account),
    ]
    if run_canva:
        tasks.append(run_provider(canva_adapter, canva_account))
    if run_yepapi:
        tasks.append(run_provider(yep_adapter, yep_account))

    results = await asyncio.gather(*tasks, return_exceptions=True)

    kiro_result = results[0]
    cb_result = results[1]
    ws_result = results[2]
    idx = 3
    if run_canva and idx < len(results):
        canva_result = results[idx]
        idx += 1
    if run_yepapi and idx < len(results):
        yep_result = results[idx]

    if isinstance(kiro_result, BaseException):
        kiro_result = {"success": False, "provider": "kiro", "error": str(kiro_result)}
    if isinstance(cb_result, BaseException):
        cb_result = {"success": False, "provider": "codebuddy", "error": str(cb_result)}
    if isinstance(ws_result, BaseException):
        ws_result = {"success": False, "provider": "wavespeed", "error": str(ws_result)}
    if isinstance(canva_result, BaseException):
        canva_result = {"success": False, "provider": "canva", "error": str(canva_result)}
    if isinstance(yep_result, BaseException):
        yep_result = {"success": False, "provider": "yepapi", "error": str(yep_result)}

    result = {
        "type": "result",
        "kiro": kiro_result,
        "codebuddy": cb_result,
        "wavespeed": ws_result,
        "canva": canva_result,
        "yepapi": yep_result,
    }
    emit(result)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    args = parser.parse_args()

    asyncio.run(main(args.email, args.password))
