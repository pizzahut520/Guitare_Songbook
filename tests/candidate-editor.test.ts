import { describe, expect, it } from "vitest";
import {
  addInstrumentBlock,
  addLyricBlock,
  addLyricPhrase,
  applyCandidateSongEdit,
  combineLyricBlocksAsVariants,
  combineLyricRangesAsVariants,
  compareLyricChordCompatibility,
  convertLyricsToVariants,
  deleteLyricPhrase,
  deleteBlock,
  expandRepeatBlock,
  markBlockAsRepeat,
  mergeLyricPhrases,
  mergeAdjacentLyricBlocks,
  moveLyricChord,
  moveBlock,
  removeLyricVariant,
  splitLyricPhraseAt,
  splitLyricBlock,
  splitVariantsIntoBlocks,
  swapLyricVariants,
  summarizeSongChanges,
  updateRepeat,
  updateLyricVariantLabel,
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

function ordinaryLyricSong() {
  const song = candidate().song;
  song.blocks = [
    {
      id: "verse-a",
      type: "lyric",
      chords: ["| 1   5 |", "6m  4"],
      lyrics: ["  A 内部 空格", "A 第二句"],
      spacing: "normal",
      section_role: "verse"
    },
    {
      id: "instrument-1",
      type: "instrument",
      label: "间奏",
      progression: "| 1 | 5 |"
    },
    {
      id: "verse-b",
      type: "lyric",
      chords: ["|  1 5 |", "6m 4"],
      lyrics: ["B 第一行", "B 第二句"],
      spacing: "normal",
      section_role: "verse"
    },
    {
      id: "chorus-a",
      type: "lyric",
      chords: ["4", "5"],
      lyrics: ["副歌 A 一", "副歌 A 二"],
      spacing: "normal"
    },
    {
      id: "chorus-b",
      type: "lyric",
      chords: ["4", "5"],
      lyrics: ["副歌 B 一", "副歌 B 二"],
      spacing: "normal"
    }
  ];
  return song;
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

  it("converts ordinary lyrics to A/B without changing spaces or its input", () => {
    const source = ordinaryLyricSong();
    const converted = convertLyricsToVariants(source, 0);
    expect(source.blocks[0]).toMatchObject({ lyrics: ["  A 内部 空格", "A 第二句"] });
    expect(converted.blocks[0]).toMatchObject({
      chords: ["| 1   5 |", "6m  4"],
      lyric_sets: [["  A 内部 空格", "A 第二句"], ["", ""]],
      variant_labels: ["A.", "B."]
    });
    expect("lyrics" in converted.blocks[0]).toBe(false);
    expect(SongSchema.safeParse(converted).success).toBe(true);
  });

  it("edits, swaps, and removes B while retaining every additional lyric set", () => {
    let song = convertLyricsToVariants(ordinaryLyricSong(), 0);
    song = updateLyricPhrase(song, 0, 1, "lyric", "B  内部 空格", 1);
    song = updateLyricVariantLabel(song, 0, 1, "B. 现场版");
    song = swapLyricVariants(song, 0);
    expect(song.blocks[0]).toMatchObject({
      lyric_sets: [["", "B  内部 空格"], ["  A 内部 空格", "A 第二句"]],
      variant_labels: ["B. 现场版", "A."]
    });
    song = removeLyricVariant(song, 0);
    expect(song.blocks[0]).toMatchObject({ lyrics: ["", "B  内部 空格"] });

    const threeSets = candidate().song;
    const lyric = threeSets.blocks[0] as { lyric_sets: string[][]; variant_labels: string[] };
    lyric.lyric_sets.push(["丙一", "丙二"]);
    lyric.variant_labels.push("C");
    const retained = removeLyricVariant(threeSets, 0);
    expect(retained.blocks[0]).toMatchObject({ lyric_sets: [["甲一", "甲二"], ["丙一", "丙二"]] });
  });

  it("combines adjacent or separated ordinary blocks only when chord tokens match", () => {
    const source = ordinaryLyricSong();
    const compatibility = compareLyricChordCompatibility(
      source.blocks[0] as Parameters<typeof compareLyricChordCompatibility>[0],
      source.blocks[2] as Parameters<typeof compareLyricChordCompatibility>[1]
    );
    expect(compatibility).toEqual({ compatible: true });
    const combined = combineLyricBlocksAsVariants(source, 0, 2);
    expect(combined.blocks.map((block) => block.id)).toEqual(["verse-a", "instrument-1", "chorus-a", "chorus-b"]);
    expect(combined.blocks[0]).toMatchObject({
      chords: ["| 1   5 |", "6m  4"],
      lyric_sets: [["  A 内部 空格", "A 第二句"], ["B 第一行", "B 第二句"]]
    });
    expect(() => combineLyricBlocksAsVariants(source, 0, 3)).toThrow("chord_token_mismatch");
    const mismatchedLength = ordinaryLyricSong();
    (mismatchedLength.blocks[2] as { chords: string[] }).chords.pop();
    expect(() => combineLyricBlocksAsVariants(mismatchedLength, 0, 2)).toThrow("phrase_count_mismatch");
  });

  it("pairs non-adjacent ranges in one edit and keeps unselected blocks ordered", () => {
    const source = ordinaryLyricSong();
    const paired = combineLyricRangesAsVariants(source, [0, 3], [2, 4]);
    expect(paired.blocks.map((block) => block.id)).toEqual(["verse-a", "instrument-1", "chorus-a"]);
    expect(paired.blocks[0]).toMatchObject({ lyric_sets: [["  A 内部 空格", "A 第二句"], ["B 第一行", "B 第二句"]] });
    expect(paired.blocks[2]).toMatchObject({ lyric_sets: [["副歌 A 一", "副歌 A 二"], ["副歌 B 一", "副歌 B 二"]] });
    expect(SongSchema.safeParse(paired).success).toBe(true);
  });

  it("splits every lyric variant into unique ordinary blocks without losing content", () => {
    const source = candidate().song;
    const lyric = source.blocks[0] as { lyric_sets: string[][]; variant_labels: string[] };
    lyric.lyric_sets.push(["丙一", "丙二"]);
    lyric.variant_labels.push("C");
    const split = splitVariantsIntoBlocks(source, 0);
    expect(split.blocks.slice(0, 3).map((block) => block.id)).toEqual([
      "verse-1", "verse-1-variant-2", "verse-1-variant-3"
    ]);
    expect(split.blocks.slice(0, 3).map((block) => (block as { lyrics: string[] }).lyrics)).toEqual([
      ["甲一", "甲二"], ["乙一", "乙二"], ["丙一", "丙二"]
    ]);
    expect(new Set(split.blocks.map((block) => block.id)).size).toBe(split.blocks.length);
    expect(SongSchema.safeParse(split).success).toBe(true);
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
