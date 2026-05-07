export function isInvalidModelError(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes("invalid_model_id") ||
    normalized.includes("invalid model") ||
    normalized.includes("model_not_found") ||
    normalized.includes("no such model")
  );
}

export function isBadUpstreamRequest(error?: string): boolean {
  if (!error) return false;
  return error.toLowerCase().includes("improperly formed request");
}

export function isContentModerationError(error?: string): boolean {
  if (!error) return false;
  return (
    error.includes("敏感内容") ||
    error.includes("sensitive content") ||
    error.includes("系统检测到") ||
    error.includes("content moderation")
  );
}

export function isNonAccountRequestError(error?: string): boolean {
  if (!error) return false;
  return (
    isInvalidModelError(error) ||
    // Content moderation is NOT included here — allow retry with other accounts
    // because false positives are common and different accounts may succeed.
    isBadUpstreamRequest(error)
  );
}
