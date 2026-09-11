import { describe, expect, it } from "vitest";
import { createManualLyricDraft, type ManualSongFields } from "../src/lib/manual-lyric-draft";
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
});
