import { beforeEach, describe, expect, test } from "bun:test";
import { addAuthLog, clearAuthLogs, getAuthLogs } from "../../src/auth/logs";

const MAX_LOGS = 500;

describe("auth log buffer", () => {
  beforeEach(() => {
    clearAuthLogs();
  });

  test("returns newest entries first", () => {
    const first = addAuthLog({ type: "step", message: "first" });
    const second = addAuthLog({ type: "step", message: "second" });

    expect(getAuthLogs()).toEqual([second, first]);
  });

  test("respects limit", () => {
    addAuthLog({ type: "step", message: "first" });
    const second = addAuthLog({ type: "step", message: "second" });

    expect(getAuthLogs(1)).toEqual([second]);
  });

  test("keeps only the latest logs after overflow", () => {
    for (let i = 0; i < MAX_LOGS + 5; i++) {
      addAuthLog({ type: "step", message: `log-${i}` });
    }

    const logs = getAuthLogs(MAX_LOGS + 10);
    expect(logs).toHaveLength(MAX_LOGS);
    expect(logs[0]?.message).toBe(`log-${MAX_LOGS + 4}`);
    expect(logs.at(-1)?.message).toBe("log-5");
  });

  test("clear removes current logs without requiring id reset", () => {
    const beforeClear = addAuthLog({ type: "step", message: "before" });
    clearAuthLogs();
    const afterClear = addAuthLog({ type: "step", message: "after" });

    expect(getAuthLogs()).toEqual([afterClear]);
    expect(afterClear.id).toBeGreaterThan(beforeClear.id);
  });
});
