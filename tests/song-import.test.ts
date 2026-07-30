import { describe, expect, it } from "vitest";
import {
  alignChordAndLyric,
  chordToDegree,
  cleanLyricLines,
  compactRepeatedLyricBlocks,
  isChordLine,
  parseChordBlocks,
  songFromParsed
} from "../scripts/import-song-texts.mjs";

describe("song text importer", () => {
  it("recognizes chord rows without mistaking prose for chords", () => {
    expect(isChordLine("A    E    D/F#    E")).toBe(true);
    expect(isChordLine("Gm7 Bbm7 Csus4 D7sus4")).toBe(true);
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

  it("combines only explicitly marked A/B lyric variants under one chord row", () => {
    const parsed = parseChordBlocks(
      [
        "C   Gm",
        "A: 看沉默的电话 它什么都不说",
        "B: 看你紧闭的嘴唇 它什么都不说"
      ],
      "C"
    );

    expect(parsed.warnings).toEqual([]);
    expect(parsed.blocks).toEqual([
      expect.objectContaining({
        chords: ["1   5m"],
        lyric_sets: [
          ["看沉默的电话 它什么都不说"],
          ["看你紧闭的嘴唇 它什么都不说"]
        ],
        variant_labels: ["A.", "B."],
        spacing: "compact"
      })
    ]);
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

  it("compacts only immediately repeated lyric blocks", () => {
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

  it("preserves a recurring lyric after another lyric block", () => {
    const recurring = {
      id: "recurring",
      type: "lyric",
      chords: ["1   5"],
      lyrics: ["反复出现的歌词"],
      spacing: "normal"
    };
    const other = {
      id: "other",
      type: "lyric",
      chords: ["4   5"],
      lyrics: ["中间的歌词"],
      spacing: "normal"
    };

    const compacted = compactRepeatedLyricBlocks([
      recurring,
      other,
      { ...recurring, id: "recurring-again" }
    ]);

    expect(compacted.removed).toBe(0);
    expect(compacted.blocks).toHaveLength(3);
  });

  it("keeps the source key for degree conversion while allowing playable-key overrides", () => {
    const result = songFromParsed(
      {
        title: "测试歌曲",
        artist: "测试艺人",
        originalKey: "G",
        capo: "",
        file: "测试歌曲.txt",
        body: ["G   C", "测试歌词"]
      },
      {
        slug: "test-song",
        credits: { lyrics: "测试", music: "测试" },
        original_key: "G♭",
        degree_key: "C",
        capo: 6,
        language: "zh-CN",
        tags: ["测试"],
        source_reference: "核对来源"
      }
    );

    expect(result.warnings).toEqual([]);
    expect(result.song).toMatchObject({
      original_key: "G♭",
      degree_key: "C",
      capo: 6,
      source: { reference: "核对来源" },
      blocks: [{ chords: ["1   4"] }]
    });
  });
});
