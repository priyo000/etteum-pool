import { describe, expect, test } from "bun:test";
import {
  isBadUpstreamRequest,
  isContentModerationError,
  isInvalidModelError,
  isNonAccountRequestError,
} from "../../src/proxy/errors";

describe("proxy error classification", () => {
  test("detects invalid model errors using existing phrases", () => {
    expect(isInvalidModelError("invalid_model_id: claude-x")).toBe(true);
    expect(isInvalidModelError("Invalid model requested")).toBe(true);
    expect(isInvalidModelError("MODEL_NOT_FOUND")).toBe(true);
    expect(isInvalidModelError("No such model: foo")).toBe(true);
  });

  test("does not classify unrelated errors as invalid model", () => {
    expect(isInvalidModelError(undefined)).toBe(false);
    expect(isInvalidModelError("")).toBe(false);
    expect(isInvalidModelError("upstream timeout")).toBe(false);
  });

  test("detects bad upstream request errors", () => {
    expect(isBadUpstreamRequest("Improperly formed request body")).toBe(true);
    expect(isBadUpstreamRequest("quota exhausted")).toBe(false);
  });

  test("detects content moderation errors", () => {
    expect(isContentModerationError("sensitive content detected")).toBe(true);
    expect(isContentModerationError("系统检测到敏感内容")).toBe(true);
    expect(isContentModerationError("temporary auth error")).toBe(false);
  });

  test("groups client-side errors that should not poison accounts", () => {
    expect(isNonAccountRequestError("invalid model")).toBe(true);
    expect(isNonAccountRequestError("improperly formed request")).toBe(true);
    expect(isNonAccountRequestError("content moderation")).toBe(true);
    expect(isNonAccountRequestError("401 unauthorized")).toBe(false);
  });
});
