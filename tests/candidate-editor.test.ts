import { describe, expect, it } from "vitest";
import {
  addInstrumentBlock,
  addLyricBlock,
  addLyricPhrase,
  applyCandidateSongEdit,
  deleteLyricPhrase,
  deleteBlock,
  expandRepeatBlock,
  markBlockAsRepeat,
  mergeLyricPhrases,
  mergeAdjacentLyricBlocks,
  moveLyricChord,
  moveBlock,
  splitLyricPhraseAt,
  splitLyricBlock,
  summarizeSongChanges,
  updateRepeat,
  updateLyricPhrase
} from "../src/lib/candidate-editor";
import { publishedSongToCandidate } from "../src/lib/published-song-edit";
import { SongCandidateSchema } from "../src/lib/song-candidate-schema";
import { normalizeSongIdentity } from "../src/lib/song-index";
import { buildSongRenderBlocks } from "../src/lib/song-render-model";
import { SongSchema } from "../src/lib/song-schema";
import { fictitiousSongCandidate } from "./fixtures/fictitious-song-candidate";

function candidate() {
  const value = SongCandidateSchema.parse(structuredClone(fictitiousSongCandidate));
  value.song.blocks = [
    {
      id: "verse-1",
      type: "lyric",
      chords: ["1", "5"],
      lyric_sets: [["甲一", "甲二"], ["乙一", "乙二"]],
      variant_labels: ["A", "B"],
      spacing: "normal",
      section_role: "verse"
    },
    {
      id: "verse-2",
      type: "lyric",
      chords: ["4", "5"],
      lyric_sets: [["甲三", "甲四"], ["乙三", "乙四"]],
      variant_labels: ["A", "B"],
      spacing: "normal",
      section_role: "verse"
    }
  ];
  return SongCandidateSchema.parse(value);
}

describe("candidate structure editor pure operations", () => {
  it("edits, adds, and deletes aligned lyric phrases without losing lyric_sets", () => {
    let song = candidate().song;
    song = updateLyricPhrase(song, 0, 1, "chord", "57");
    song = updateLyricPhrase(song, 0, 1, "lyric", "乙二改", 1);
    song = addLyricPhrase(song, 0, 0);
    expect(song.blocks[0]).toMatchObject({
      chords: ["1", "1", "57"],
      lyric_sets: [["甲一", "", "甲二"], ["乙一", "", "乙二改"]]
    });
    song = deleteLyricPhrase(song, 0, 1);
    expect(song.blocks[0]).toMatchObject({
      chords: ["1", "57"],
      lyric_sets: [["甲一", "甲二"], ["乙一", "乙二改"]]
    });
    expect(SongSchema.safeParse(song).success).toBe(true);
  });

  it("splits and merges compatible lyric blocks while preserving every lyric set", () => {
    const original = candidate().song;
    const split = splitLyricBlock(original, 0, 1);
    expect(split.blocks).toHaveLength(3);
    expect(split.blocks[1]).toMatchObject({
      chords: ["5"],
      lyric_sets: [["甲二"], ["乙二"]]
    });
    const merged = mergeAdjacentLyricBlocks(original, 0);
    expect(merged.blocks).toHaveLength(1);
    expect(merged.blocks[0]).toMatchObject({
      chords: ["1", "5", "4", "5"],
      lyric_sets: [["甲一", "甲二", "甲三", "甲四"], ["乙一", "乙二", "乙三", "乙四"]]
    });
  });

  it("moves blocks and converts or expands a repeat with unique IDs", () => {
    const original = candidate().song;
    expect(moveBlock(original, 1, -1).blocks.map((block) => block.id)).toEqual(["verse-2", "verse-1"]);
    let repeated = markBlockAsRepeat(original, 1, "verse-1", true);
    repeated = updateRepeat(repeated, 1, { times: 2, section_label: "重复两次" });
    expect(repeated.blocks[1]).toMatchObject({
      type: "repeat", ref: "verse-1", times: 2, section_label: "重复两次"
    });
    expect(buildSongRenderBlocks(repeated)).toHaveLength(3);
    const expanded = expandRepeatBlock(repeated, 1);
    expect(expanded.blocks[1]).toMatchObject({ type: "lyric", chords: ["1", "5"] });
    expect(expanded.blocks[1].id).not.toBe("verse-1");
    expect(new Set(expanded.blocks.map((block) => block.id)).size).toBe(expanded.blocks.length);
  });

  it("refuses to delete the final playable block", () => {
    const only = candidate().song;
    only.blocks.splice(1, 1);
    expect(() => deleteBlock(only, 0)).toThrow("song_requires_playable_block");
  });

  it("resets confirmation and reruns duplicate detection after every edit", () => {
    const base = candidate();
    const index = [{
      slug: "another-slug",
      title: base.song.title,
      artist: base.song.artist,
      url: "/song/existing/",
      normalized_title: normalizeSongIdentity(base.song.title),
      normalized_artist: normalizeSongIdentity(base.song.artist)
    }];
    const state = applyCandidateSongEdit({ candidate: base, confirmed: true }, base.song, index);
    expect(state.confirmed).toBe(false);
    expect(state.duplicate?.url).toBe("/song/existing/");
  });

  it("splits lyrics at an exact character position without losing lyric variants", () => {
    let song = splitLyricPhraseAt(candidate().song, 0, 0, 1);
    expect(song.blocks[0]).toMatchObject({
      chords: ["1", "1", "5"],
      lyric_sets: [["甲", "一", "甲二"], ["乙", "一", "乙二"]]
    });
    song = updateLyricPhrase(song, 0, 2, "lyric", "When I sing", 0);
    song = updateLyricPhrase(song, 0, 2, "lyric", "While I sing", 1);
    song = splitLyricPhraseAt(song, 0, 2, 6);
    expect((song.blocks[0] as { lyric_sets: string[][] }).lyric_sets).toEqual([
      ["甲", "一", "When I", " sing"],
      ["乙", "一", "While ", "I sing"]
    ]);
  });

  it("only merges phrases losslessly and moves chord positions without changing lyrics", () => {
    let song = candidate().song;
    song = updateLyricPhrase(song, 0, 1, "chord", "1");
    const merged = mergeLyricPhrases(song, 0, 0);
    expect(merged.blocks[0]).toMatchObject({
      chords: ["1"],
      lyric_sets: [["甲一甲二"], ["乙一乙二"]]
    });
    expect(() => mergeLyricPhrases(candidate().song, 0, 0)).toThrow(
      "different_chords_cannot_merge_losslessly"
    );
    const moved = moveLyricChord(candidate().song, 0, 0, 1);
    expect(moved.blocks[0]).toMatchObject({
      chords: ["5", "1"],
      lyric_sets: [["甲一", "甲二"], ["乙一", "乙二"]]
    });
  });

  it("requires explicit confirmation before replacing a different block with a repeat", () => {
    const song = candidate().song;
    expect(() => markBlockAsRepeat(song, 1, "verse-1")).toThrow("repeat_content_mismatch");
    expect(markBlockAsRepeat(song, 1, "verse-1", true).blocks[1]).toMatchObject({
      type: "repeat", ref: "verse-1", times: 1
    });
  });

  it("adds uniquely identified playable blocks and summarizes deterministic changes", () => {
    const original = candidate().song;
    const withLyric = addLyricBlock(original);
    const edited = addInstrumentBlock(withLyric);
    expect(new Set(edited.blocks.map((block) => block.id)).size).toBe(edited.blocks.length);
    expect(edited.blocks.at(-2)?.type).toBe("lyric");
    expect(edited.blocks.at(-1)?.type).toBe("instrument");
    expect(summarizeSongChanges(original, edited)).toMatchObject({
      addedLyricPhrases: 1,
      changedBlockIds: expect.arrayContaining(["verse-new", "instrument-new"])
    });
  });

  it("converts an existing non-web-search song to an editable candidate", () => {
    const existing = SongSchema.parse({
      ...structuredClone(fictitiousSongCandidate.song),
      source: { type: "user_text", reference: "本地参考" }
    });
    const editable = publishedSongToCandidate(
      existing,
      `https://songbook.example/song/${existing.slug}/`
    );
    expect(editable.song).toEqual(existing);
    expect(editable.query).toEqual({ title: existing.title, artist: existing.artist });
    expect(SongCandidateSchema.safeParse(editable).success).toBe(true);
  });
});

describe("repeat schema rules", () => {
  function parseBlocks(blocks: unknown[]) {
    const value = structuredClone(fictitiousSongCandidate);
    value.song.blocks = blocks as typeof value.song.blocks;
    return SongCandidateSchema.safeParse(value);
  }

  const lyric = {
    id: "chorus-1",
    type: "lyric",
    chords: ["1"],
    lyrics: ["虚构句"],
    spacing: "normal"
  };

  it("accepts a legal backward repeat and expands it for rendering", () => {
    const parsed = parseBlocks([lyric, {
      id: "chorus-repeat-1", type: "repeat", ref: "chorus-1", times: 2, section_label: "副歌重复"
    }]);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(buildSongRenderBlocks(parsed.data.song)).toHaveLength(3);
  });

  it.each([
    ["missing ref", [lyric, { id: "r", type: "repeat", ref: "missing", times: 1 }]],
    ["forward ref", [{ id: "r", type: "repeat", ref: "chorus-1", times: 1 }, lyric]],
    ["self ref", [{ id: "r", type: "repeat", ref: "r", times: 1 }]],
    ["repeat references repeat", [
      lyric,
      { id: "r1", type: "repeat", ref: "chorus-1", times: 1 },
      { id: "r2", type: "repeat", ref: "r1", times: 1 }
    ]],
    ["duplicate block id", [lyric, { ...lyric }]]
  ])("rejects %s", (_label, blocks) => {
    expect(parseBlocks(blocks).success).toBe(false);
  });
});
