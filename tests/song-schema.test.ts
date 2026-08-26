import { describe, expect, it } from "vitest";
import { z } from "zod";
import song from "../src/content/songs/chen-qizhen-lvxing-de-yiyi.json";
import luKou from "../src/content/songs/lu-kou-zhang-zhen-yue.json";
import { DegreeExpressionSchema, SongSchema } from "../src/lib/song-schema";

const songModules = import.meta.glob<{ default: unknown }>(
  "../src/content/songs/*.json",
  { eager: true }
);

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

  it("accepts every existing song with strict degree notation", () => {
    for (const [path, module] of Object.entries(songModules)) {
      expect(() => SongSchema.parse(module.default), path).not.toThrow();
    }
  });

  it.each(["I", "IV", "iii7", "bVI", "G", "Am", "#4", "b2"])(
    "rejects invalid degree input %s",
    (expression) => {
      expect(DegreeExpressionSchema.safeParse(expression).success).toBe(false);
    }
  );

  it("exports degree restrictions into JSON Schema", () => {
    expect(z.toJSONSchema(DegreeExpressionSchema)).toMatchObject({
      type: "string",
      minLength: 1,
      pattern: expect.any(String)
    });
  });

  it("keeps 路口 entirely in Arabic degree notation", () => {
    const parsed = SongSchema.parse(luKou);
    const degreeFields = parsed.blocks.flatMap((block) =>
      block.type === "instrument" ? [block.progression] : block.type === "lyric" ? block.chords : []
    );
    expect(degreeFields.join(" ")).not.toMatch(/\b[ivx]+\b/i);
    expect(parsed.original_key).toBe("G♯");
    expect(parsed.degree_key).toBe("G");
    expect(parsed.capo).toBe(1);
  });
});

