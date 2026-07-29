import { describe, expect, it } from "vitest";
import { degreeToChord, keyAtTranspose } from "../src/lib/music";

describe("degree notation", () => {
  it("converts ordinary and altered degrees", () => {
    expect(degreeToChord("1 4 6m ♭7", "C")).toBe("C F Am B♭");
  });

  it("converts qualities and slash bass notes", () => {
    expect(degreeToChord("3m7♭5 5sus4 4/6 2/♯4", "C")).toBe(
      "Em7♭5 Gsus4 F/A D/F♯"
    );
  });

  it("normalizes secondary-dominant notation", () => {
    expect(degreeToChord("6(7)", "C")).toBe("A7");
  });

  it("transposes chord names without changing degree data", () => {
    expect(degreeToChord("1 4 5", "C", 2)).toBe("D G A");
    expect(keyAtTranspose("C", 2)).toBe("D");
  });
});

