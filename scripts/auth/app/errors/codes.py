from enum import Enum


class ErrorCode(str, Enum):
    # Input / Validation
    input_invalid_format = "INPUT_INVALID_FORMAT"
    input_missing_required_field = "INPUT_MISSING_REQUIRED_FIELD"

    # Auth / Account
    auth_invalid_credentials = "AUTH_INVALID_CREDENTIALS"
    auth_2fa_required_but_missing = "AUTH_2FA_REQUIRED_BUT_MISSING"
    auth_2fa_invalid_code = "AUTH_2FA_INVALID_CODE"
    auth_account_locked = "AUTH_ACCOUNT_LOCKED"
    auth_account_suspended = "AUTH_ACCOUNT_SUSPENDED"
    auth_rate_limited = "AUTH_RATE_LIMITED"
    auth_temporary_failure = "AUTH_TEMPORARY_FAILURE"

    # Network / Transport
    network_timeout = "NETWORK_TIMEOUT"
    network_connection_error = "NETWORK_CONNECTION_ERROR"
    network_dns_error = "NETWORK_DNS_ERROR"
    http_429 = "HTTP_429"
    http_5xx = "HTTP_5XX"
    http_4xx_non_429 = "HTTP_4XX_NON_429"

    # Browser Automation
    browser_start_failed = "BROWSER_START_FAILED"
    browser_navigation_failed = "BROWSER_NAVIGATION_FAILED"
    browser_element_not_found = "BROWSER_ELEMENT_NOT_FOUND"
    browser_challenge_blocked = "BROWSER_CHALLENGE_BLOCKED"
    browser_unexpected_state = "BROWSER_UNEXPECTED_STATE"

    # Provider Business
    provider_quota_fetch_failed = "PROVIDER_QUOTA_FETCH_FAILED"
    provider_token_exchange_failed = "PROVIDER_TOKEN_EXCHANGE_FAILED"
    provider_unsupported_response = "PROVIDER_UNSUPPORTED_RESPONSE"

    # System / Internal
    db_write_failed = "DB_WRITE_FAILED"
    db_constraint_violation = "DB_CONSTRAINT_VIOLATION"
    internal_unhandled = "INTERNAL_UNHANDLED"
