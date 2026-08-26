import { describe, expect, it, vi } from "vitest";
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

  it("sends only one request when publish is double-clicked", async () => {
    const guard = createPublishGuard();
    const send = vi.fn(async () => undefined);
    const publish = async () => {
      if (!guard.begin()) return;
      await send();
    };
    await Promise.all([publish(), publish()]);
    expect(send).toHaveBeenCalledOnce();
  });
});
