export function isInvalidModelError(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes("invalid_model_id") ||
    normalized.includes("invalid model") ||
    normalized.includes("model_not_found") ||
    normalized.includes("no such model") ||
    normalized.includes("model is not supported") ||
    normalized.includes("model not supported")
  );
}

export function isBadUpstreamRequest(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes("improperly formed request") ||
    normalized.includes("unsupported parameter")
  );
}

export function isContentModerationError(error?: string): boolean {
  if (!error) return false;
  return (
    error.includes("敏感内容") ||
    error.includes("sensitive content") ||
    error.includes("系统检测到") ||
    error.includes("content moderation") ||
    error.includes("Content moderation") ||
    error.includes("content_filter") ||
    error.includes("flagged as potentially sensitive")
  );
}

/**
 * Errors that are caused by the request content itself, not the account.
 * These should NOT be retried with different accounts since the same content
 * will trigger the same error regardless of which account is used.
 */
export function isNonAccountRequestError(error?: string): boolean {
  if (!error) return false;
  return (
    isInvalidModelError(error) ||
    isContentModerationError(error) ||
    isBadUpstreamRequest(error)
  );
}

/**
 * Transient errors that are temporary and should not permanently mark an account as errored.
 * These include network issues, timeouts, rate limits, upstream server errors,
 * and bad-request errors that are caused by the request format (not the account).
 * Account stays "active" but error is logged.
 */
export function isTransientError(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    // Network / connectivity
    normalized.includes("timeout") ||
    normalized.includes("etimedout") ||
    normalized.includes("request timeout") ||
    normalized.includes("network error") ||
    normalized.includes("econnreset") ||
    normalized.includes("econnrefused") ||
    normalized.includes("enotfound") ||
    normalized.includes("socket hang up") ||
    normalized.includes("fetch failed") ||
    normalized.includes("dns") ||
    normalized.includes("connection") ||
    normalized.includes("aborted") ||
    normalized.includes("eai again") ||
    normalized.includes("temporary failure") ||
    // Upstream server errors (not account-specific)
    normalized.includes("(500)") ||
    normalized.includes("(502)") ||
    normalized.includes("(503)") ||
    normalized.includes("(504)") ||
    normalized.includes("error 500") ||
    normalized.includes("error 502") ||
    normalized.includes("error 503") ||
    normalized.includes("error 504") ||
    normalized.includes("status 500") ||
    normalized.includes("status 502") ||
    normalized.includes("status 503") ||
    normalized.includes("status 504") ||
    normalized.includes("internal server error") ||
    normalized.includes("bad gateway") ||
    normalized.includes("service unavailable") ||
    normalized.includes("gateway timeout") ||
    // Rate limiting (temporary)
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("(429)") ||
    // Bad request format (not account issue — request content caused it)
    normalized.includes("parse message failed") ||
    normalized.includes("invalid request") ||
    normalized.includes("(400)") ||
    // Stream errors (temporary)
    normalized.includes("stream error") ||
    normalized.includes("stream read timeout") ||
    normalized.includes("stream failed")
  );
}
