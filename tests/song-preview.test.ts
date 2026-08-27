import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { setSafeText } from "../src/lib/song-preview";
import { buildSongRenderBlocks } from "../src/lib/song-render-model";
import songSheetSource from "../src/components/SongSheet.astro?raw";
import previewSource from "../src/lib/song-preview.ts?raw";
import { SongSchema } from "../src/lib/song-schema";
import { fictitiousSongCandidate } from "./fixtures/fictitious-song-candidate";

const styles = readFileSync(new URL("../src/styles/global.css", import.meta.url), "utf8");

describe("candidate preview safety", () => {
  it("assigns HTML and script characters as inert text content", () => {
    const target: { textContent: string | null } = { textContent: null };
    const hostile = '<img src=x onerror=alert(1)><script>throw new Error("x")</script>';
    setSafeText(target, hostile);
    expect(target.textContent).toBe(hostile);
    expect(target).not.toHaveProperty("innerHTML");
  });

  it("uses the shared render model and shared sheet class contract in both renderers", () => {
    for (const source of [songSheetSource, previewSource]) {
      expect(source).toContain("buildSongRenderBlocks");
      expect(source).toContain("sheet-section__heading");
      expect(source).toContain("theory-legend__content");
    }
  });

  it("expands repeats with the same label and keeps every lyric set", () => {
    const song = SongSchema.parse(structuredClone(fictitiousSongCandidate.song));
    song.blocks = [
      {
        id: "chorus-1",
        type: "lyric",
        chords: ["1", "5"],
        lyric_sets: [["甲", "乙"], ["丙", "丁"]],
        spacing: "normal",
        section_role: "chorus"
      },
      { id: "repeat-1", type: "repeat", ref: "chorus-1", times: 2 }
    ];
    const rendered = buildSongRenderBlocks(song);
    expect(rendered).toHaveLength(3);
    expect(rendered[1]).toMatchObject({
      sourceId: "chorus-1",
      sectionLabel: "副歌",
      repeat: { label: "副歌", index: 1, times: 2 }
    });
    expect(rendered[2].block).toMatchObject({ lyric_sets: [["甲", "乙"], ["丙", "丁"]] });
  });

  it("keeps semantic collapsed theory and print rules that expose its content", () => {
    expect(songSheetSource).toContain('<details class="theory-legend"');
    expect(previewSource).toContain('element("details", "theory-legend")');
    expect(styles).toContain(".theory-legend:not([open]) > .theory-legend__content");
    expect(styles).toMatch(/\.song-toolbar,[\s\S]*display:\s*none\s*!important/);
  });
});
