import { describe, expect, it } from "vitest";
import { createPublishGuard } from "../src/lib/publish-guard";

describe("publish double-click guard", () => {
  it("allows one active submission and locks permanently after success", () => {
    const guard = createPublishGuard();
    expect(guard.begin()).toBe(true);
    expect(guard.begin()).toBe(false);
    guard.succeed();
    expect(guard.begin()).toBe(false);
    expect(guard.locked).toBe(true);
  });

  it("allows a retry only after a failed submission", () => {
    const guard = createPublishGuard();
    expect(guard.begin()).toBe(true);
    guard.fail();
    expect(guard.begin()).toBe(true);
  });
});
