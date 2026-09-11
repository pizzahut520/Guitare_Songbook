import { describe, expect, it } from "vitest";
import {
  createManualLyricDraft,
  ManualLyricsParseError,
  parseAnnotatedLyrics,
  type ManualSongFields
} from "../src/lib/manual-lyric-draft";
import { SongCandidateOutputSchema, SongCandidateSchema } from "../src/lib/song-candidate-schema";

const fields: ManualSongFields = {
  title: "标题", artist: "歌手", slug: "artist-song-title", lyricsCredit: "词作者",
  musicCredit: "曲作者", originalKey: "C", degreeKey: "C", capo: 0,
  language: "中文", tags: [], copyrightStatus: "private_reference"
};

describe("manual lyric draft parser", () => {
  it("normalizes line endings, trims only outside blank lines, and keeps text inert", () => {
    const draft = createManualLyricDraft(fields, "\r\n  第一行  \r\n\r\n<script>不执行</script> & français!\r\n\r\n");
    expect(draft.song.blocks).toHaveLength(2);
    expect(draft.song.blocks[0]).toMatchObject({ lyrics: ["  第一行  \n"], chords: [""] });
    expect(draft.song.blocks[1]).toMatchObject({ lyrics: ["<script>不执行</script> & français!"], chords: [""] });
  });

  it("is deterministic, creates unique neutral IDs, and never invents chords", () => {
    const first = createManualLyricDraft(fields, "你好\n\nHello, monde!");
    const second = createManualLyricDraft(fields, "你好\n\nHello, monde!");
    expect(first).toEqual(second);
    expect(first.song.blocks.map((block) => block.id)).toEqual(["section-1", "section-2"]);
    expect(first.song.blocks.every((block) => block.type !== "lyric" || block.chords[0] === "")).toBe(true);
    expect(first.song.blocks.every((block) => block.type !== "lyric" || block.section_role === "other")).toBe(true);
  });

  it("rejects empty lyric input and only becomes publishable after real degrees are entered", () => {
    expect(() => createManualLyricDraft(fields, " \r\n\t ")).toThrow("manual_lyrics_required");
    const draft = createManualLyricDraft(fields, "歌词");
    expect(SongCandidateSchema.safeParse(draft).success).toBe(false);
    draft.song.blocks.forEach((block) => {
      if (block.type === "lyric") block.chords[0] = "1";
    });
    expect(SongCandidateSchema.safeParse(draft).success).toBe(true);
  });

  it("allows no fake source URL for manual candidates while keeping AI output strict", () => {
    const draft = createManualLyricDraft(fields, "歌词");
    draft.song.blocks.forEach((block) => {
      if (block.type === "lyric") block.chords[0] = "1";
    });
    expect(SongCandidateSchema.safeParse(draft).success).toBe(true);
    expect(SongCandidateOutputSchema.safeParse(draft).success).toBe(false);
  });

  it("parses all supported headers into independently editable lyric lines", () => {
    const draft = createManualLyricDraft(fields, "[主歌]\r\n一\r\n二\n\n[预副歌]\n三\n[副歌]\n四\n[Bridge]\n五\n[尾段]\n六");
    const lyrics = draft.song.blocks.filter((block) => block.type === "lyric");
    expect(lyrics.map((block) => [block.section_role, block.lyrics?.[0]])).toEqual([
      ["verse", "一"], ["verse", "二"], ["pre_chorus", "三"], ["chorus", "四"], ["bridge", "五"], ["outro", "六"]
    ]);
    expect(lyrics[0].spacing).toBe("compact");
    expect(lyrics[1].spacing).toBe("generous");
    expect(parseAnnotatedLyrics("[桥段]\n七").summary.bridge).toBe(1);
  });

  it("pairs adjacent or named non-adjacent A/B sections without modifying their text", () => {
    const adjacent = createManualLyricDraft(fields, "[主歌 A]\nA  一\nA二\n[主歌 B]\nB一\nB二");
    expect(adjacent.song.blocks[0]).toMatchObject({ lyric_sets: [["A  一"], ["B一"]], variant_labels: ["A.", "B."] });
    const named = createManualLyricDraft(fields, "[副歌 A | 组一]\n甲\n[Bridge]\n间\n[副歌 B | 组一]\n乙");
    expect(named.song.blocks.filter((block) => block.type === "lyric").map((block) => block.id)).toEqual(["section-1", "section-2"]);
    expect(named.song.blocks[0]).toMatchObject({ lyric_sets: [["甲"], ["乙"]], section_role: "chorus" });
  });

  it("reports safe deterministic errors for invalid variant structure and headers", () => {
    const cases = [
      ["[主歌 A]\n一", "variant_a_without_b"],
      ["[主歌 B]\n一", "variant_b_without_a"],
      ["[主歌 A | g]\n一\n[主歌 A | g]\n二\n[主歌 B | g]\n三", "duplicate_variant"],
      ["[副歌 A]\n一\n二\n[副歌 B]\n三", "variant_line_count_mismatch"],
      ["[未知]\n测试秘密歌词", "unknown_section_header"]
    ] as const;
    cases.forEach(([text, code]) => {
      try { parseAnnotatedLyrics(text); throw new Error("expected parser error"); } catch (error) {
        expect(error).toBeInstanceOf(ManualLyricsParseError);
        expect((error as ManualLyricsParseError).details.code).toBe(code);
        expect(JSON.stringify(error)).not.toContain("测试秘密歌词");
      }
    });
  });

  it("keeps escaped headers, punctuation, full-width spaces and tabs as lyric text", () => {
    const draft = createManualLyricDraft(fields, "[其他]\n\\[不是标记]\n  内部　空格\t!?");
    expect(draft.song.blocks.filter((block) => block.type === "lyric").map((block) => block.lyrics?.[0])).toEqual([
      "[不是标记]", "  内部　空格\t!?"
    ]);
  });
});
