import { describe, expect, it } from "vitest";
import song from "../src/content/songs/chen-qizhen-lvxing-de-yiyi.json";
import { SongSchema } from "../src/lib/song-schema";

describe("song data", () => {
  it("accepts the golden sample", () => {
    const parsed = SongSchema.parse(song);
    expect(parsed.title).toBe("旅行的意义");
    expect(parsed.blocks).toHaveLength(13);
  });

  it("keeps every lyric phrase aligned with its chord phrase", () => {
    const parsed = SongSchema.parse(song);
    const lyricBlocks = parsed.blocks.filter((block) => block.type === "lyric");

    lyricBlocks.forEach((block) => {
      if (block.lyrics) {
        expect(block.lyrics).toHaveLength(block.chords.length);
      }
      block.lyric_sets?.forEach((set) => {
        expect(set).toHaveLength(block.chords.length);
      });
    });
  });

  it("retains provenance and private-reference copyright status", () => {
    const parsed = SongSchema.parse(song);
    expect(parsed.source.type).toBe("user_document");
    expect(parsed.copyright_status).toBe("private_reference");
  });
});

