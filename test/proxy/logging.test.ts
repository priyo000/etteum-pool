import { describe, expect, test } from "bun:test";
import { prepareLogBody } from "../../src/proxy/logging";

describe("prepareLogBody", () => {
  test("returns small values unchanged", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    expect(prepareLogBody(body)).toBe(body);
  });

  test("truncates very large values without mutating the original", () => {
    const body = { messages: [{ role: "user", content: "x".repeat(70_000) }] };
    const logged = prepareLogBody(body);

    expect(body.messages[0]?.content).toHaveLength(70_000);
    expect(logged).not.toBe(body);
    expect(logged).toMatchObject({ truncated: true, maxBytes: 65_536 });
    expect((logged as { preview: string }).preview.length).toBeGreaterThan(0);
  });
});
