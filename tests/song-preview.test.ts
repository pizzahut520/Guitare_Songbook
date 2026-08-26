import { describe, expect, it } from "vitest";
import { setSafeText } from "../src/lib/song-preview";

describe("candidate preview safety", () => {
  it("assigns HTML and script characters as inert text content", () => {
    const target: { textContent: string | null } = { textContent: null };
    const hostile = '<img src=x onerror=alert(1)><script>throw new Error("x")</script>';
    setSafeText(target, hostile);
    expect(target.textContent).toBe(hostile);
    expect(target).not.toHaveProperty("innerHTML");
  });
});
