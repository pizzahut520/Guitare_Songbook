import { describe, expect, it } from "vitest";
import {
  alignChordAndLyric,
  chordToDegree,
  cleanLyricLines,
  compactRepeatedLyricBlocks,
  isChordLine
} from "../scripts/import-song-texts.mjs";

describe("song text importer", () => {
  it("recognizes chord rows without mistaking prose for chords", () => {
    expect(isChordLine("A    E    D/F#    E")).toBe(true);
    expect(isChordLine("妳就是妳 帶著微笑對我眨眼睛")).toBe(false);
  });

  it("converts absolute chords and slash bass notes to degrees", () => {
    expect(chordToDegree("A", "A")).toBe("1");
    expect(chordToDegree("C#m7", "A")).toBe("3m7");
    expect(chordToDegree("D/F#", "A")).toBe("4/6");
    expect(chordToDegree("Dm7/A", "A")).toBe("4m7/1");
  });

  it("aligns a chord row with its lyric row", () => {
    const aligned = alignChordAndLyric(
      "A     E     D/F#    E",
      "妳 就是妳 帶著微笑對我拼命眨眼睛",
      "A"
    );
    expect(aligned.chords).toEqual(["1   5   4/6   5"]);
    expect(aligned.lyrics).toEqual(["妳 就是妳 帶著微笑對我拼命眨眼睛"]);
  });

  it("removes only exact repeated multi-line paragraphs", () => {
    const cleaned = cleanLyricLines([
      "第一句",
      "第二句",
      "",
      "不同的一句",
      "",
      "第一句",
      "第二句"
    ]);
    expect(cleaned.duplicateParagraphsRemoved).toBe(1);
    expect(cleaned.lines.filter((line: string) => line === "第一句")).toHaveLength(1);
    expect(cleaned.lines).toContain("不同的一句");
  });

  it("compacts exact repeated lyric blocks only within one continuous section", () => {
    const repeated = {
      id: "chorus",
      type: "lyric",
      chords: ["1   5"],
      lyrics: ["同一段歌词"],
      spacing: "normal"
    };
    const divider = {
      id: "interlude",
      type: "instrument",
      label: "间奏",
      progression: "1   5"
    };
    const compacted = compactRepeatedLyricBlocks([
      repeated,
      { ...repeated, id: "chorus-repeat" },
      divider,
      { ...repeated, id: "chorus-after-interlude" }
    ]);
    expect(compacted.removed).toBe(1);
    expect(compacted.blocks).toHaveLength(3);
  });
});
