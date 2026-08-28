import type { SongCandidate } from "./song-candidate-schema";
import { findDuplicateSong, type SongIndexEntry } from "./song-index";
import type { LyricBlock, SongBlock } from "./song-schema";

export type EditableSong = SongCandidate["song"];

function copySong(song: EditableSong): EditableSong {
  return structuredClone(song);
}

export function updateBlock(
  source: EditableSong,
  blockIndex: number,
  update: (block: SongBlock) => void
): EditableSong {
  const song = copySong(source);
  const block = song.blocks[blockIndex];
  if (!block) throw new Error("block_not_found");
  update(block);
  return song;
}

function lyricAt(song: EditableSong, blockIndex: number): LyricBlock {
  const block = song.blocks[blockIndex];
  if (!block || block.type !== "lyric") throw new Error("lyric_block_required");
  return block;
}

export function uniqueBlockId(blocks: SongBlock[], preferred: string): string {
  const stem = preferred.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "block";
  const used = new Set(blocks.map((block) => block.id));
  if (!used.has(stem)) return stem;
  let suffix = 2;
  while (used.has(`${stem}-${suffix}`)) suffix += 1;
  return `${stem}-${suffix}`;
}

export function updateLyricPhrase(
  source: EditableSong,
  blockIndex: number,
  phraseIndex: number,
  field: "chord" | "lyric",
  value: string,
  lyricSetIndex = 0
): EditableSong {
  const song = copySong(source);
  const block = lyricAt(song, blockIndex);
  if (phraseIndex < 0 || phraseIndex >= block.chords.length) throw new Error("phrase_not_found");
  if (field === "chord") block.chords[phraseIndex] = value;
  else if (block.lyrics) block.lyrics[phraseIndex] = value;
  else {
    const set = block.lyric_sets?.[lyricSetIndex];
    if (!set) throw new Error("lyric_set_not_found");
    set[phraseIndex] = value;
  }
  return song;
}

export function addLyricPhrase(source: EditableSong, blockIndex: number, afterIndex?: number): EditableSong {
  const song = copySong(source);
  const block = lyricAt(song, blockIndex);
  const insertAt = afterIndex === undefined
    ? block.chords.length
    : Math.max(0, Math.min(block.chords.length, afterIndex + 1));
  block.chords.splice(insertAt, 0, "1");
  block.lyrics?.splice(insertAt, 0, "");
  block.lyric_sets?.forEach((set) => set.splice(insertAt, 0, ""));
  block.widths?.splice(insertAt, 0, 1);
  return song;
}

export function deleteLyricPhrase(source: EditableSong, blockIndex: number, phraseIndex: number): EditableSong {
  const song = copySong(source);
  const block = lyricAt(song, blockIndex);
  if (block.chords.length <= 1) throw new Error("lyric_phrase_required");
  if (phraseIndex < 0 || phraseIndex >= block.chords.length) throw new Error("phrase_not_found");
  block.chords.splice(phraseIndex, 1);
  block.lyrics?.splice(phraseIndex, 1);
  block.lyric_sets?.forEach((set) => set.splice(phraseIndex, 1));
  block.widths?.splice(phraseIndex, 1);
  return song;
}

export function splitLyricPhraseAt(
  source: EditableSong,
  blockIndex: number,
  phraseIndex: number,
  characterIndex: number
): EditableSong {
  const song = copySong(source);
  const block = lyricAt(song, blockIndex);
  if (phraseIndex < 0 || phraseIndex >= block.chords.length) throw new Error("phrase_not_found");
  const rows = block.lyrics ? [block.lyrics] : block.lyric_sets ?? [];
  const primary = rows[0]?.[phraseIndex] ?? "";
  if (!Number.isInteger(characterIndex) || characterIndex <= 0 || characterIndex >= primary.length) {
    throw new Error("invalid_character_split_point");
  }
  block.chords.splice(phraseIndex, 1, block.chords[phraseIndex], block.chords[phraseIndex]);
  rows.forEach((row) => {
    const phrase = row[phraseIndex] ?? "";
    const splitAt = Math.min(characterIndex, phrase.length);
    row.splice(phraseIndex, 1, phrase.slice(0, splitAt), phrase.slice(splitAt));
  });
  if (block.widths) {
    const width = block.widths[phraseIndex] ?? 1;
    block.widths.splice(phraseIndex, 1, width / 2, width / 2);
  }
  return song;
}

export function mergeLyricPhrases(
  source: EditableSong,
  blockIndex: number,
  firstPhraseIndex: number
): EditableSong {
  const song = copySong(source);
  const block = lyricAt(song, blockIndex);
  if (firstPhraseIndex < 0 || firstPhraseIndex + 1 >= block.chords.length) {
    throw new Error("phrase_not_found");
  }
  if (block.chords[firstPhraseIndex] !== block.chords[firstPhraseIndex + 1]) {
    throw new Error("different_chords_cannot_merge_losslessly");
  }
  const rows = block.lyrics ? [block.lyrics] : block.lyric_sets ?? [];
  rows.forEach((row) => {
    row.splice(firstPhraseIndex, 2, `${row[firstPhraseIndex] ?? ""}${row[firstPhraseIndex + 1] ?? ""}`);
  });
  block.chords.splice(firstPhraseIndex + 1, 1);
  if (block.widths) {
    block.widths.splice(
      firstPhraseIndex,
      2,
      (block.widths[firstPhraseIndex] ?? 1) + (block.widths[firstPhraseIndex + 1] ?? 1)
    );
  }
  return song;
}

export function moveLyricChord(
  source: EditableSong,
  blockIndex: number,
  phraseIndex: number,
  direction: -1 | 1
): EditableSong {
  const song = copySong(source);
  const block = lyricAt(song, blockIndex);
  const target = phraseIndex + direction;
  if (phraseIndex < 0 || phraseIndex >= block.chords.length || target < 0 || target >= block.chords.length) {
    throw new Error("chord_move_out_of_range");
  }
  [block.chords[phraseIndex], block.chords[target]] = [block.chords[target], block.chords[phraseIndex]];
  return song;
}

function slicedLyric(block: LyricBlock, start: number, end?: number): LyricBlock {
  return {
    ...structuredClone(block),
    chords: block.chords.slice(start, end),
    ...(block.lyrics ? { lyrics: block.lyrics.slice(start, end) } : {}),
    ...(block.lyric_sets
      ? { lyric_sets: block.lyric_sets.map((set) => set.slice(start, end)) }
      : {}),
    ...(block.widths ? { widths: block.widths.slice(start, end) } : {})
  };
}

export function splitLyricBlock(source: EditableSong, blockIndex: number, phraseIndex: number): EditableSong {
  const song = copySong(source);
  const block = lyricAt(song, blockIndex);
  if (phraseIndex <= 0 || phraseIndex >= block.chords.length) throw new Error("invalid_split_point");
  const first = slicedLyric(block, 0, phraseIndex);
  const second = slicedLyric(block, phraseIndex);
  second.id = uniqueBlockId(song.blocks, `${block.id}-part-2`);
  song.blocks.splice(blockIndex, 1, first, second);
  return song;
}

function compatibleLyrics(left: LyricBlock, right: LyricBlock): boolean {
  return Boolean(left.lyrics) === Boolean(right.lyrics) &&
    (left.lyric_sets?.length ?? 0) === (right.lyric_sets?.length ?? 0) &&
    JSON.stringify(left.variant_labels ?? []) === JSON.stringify(right.variant_labels ?? []) &&
    left.spacing === right.spacing &&
    left.section_role === right.section_role;
}

export function mergeAdjacentLyricBlocks(source: EditableSong, firstIndex: number): EditableSong {
  const song = copySong(source);
  const left = lyricAt(song, firstIndex);
  const right = lyricAt(song, firstIndex + 1);
  if (!compatibleLyrics(left, right)) throw new Error("lyric_blocks_incompatible");
  left.chords.push(...right.chords);
  left.lyrics?.push(...(right.lyrics ?? []));
  left.lyric_sets?.forEach((set, index) => set.push(...(right.lyric_sets?.[index] ?? [])));
  if (left.widths || right.widths) {
    left.widths = [
      ...(left.widths ?? Array.from({ length: left.chords.length - right.chords.length }, () => 1)),
      ...(right.widths ?? Array.from({ length: right.chords.length }, () => 1))
    ];
  }
  song.blocks.splice(firstIndex + 1, 1);
  return song;
}

export function moveBlock(source: EditableSong, blockIndex: number, direction: -1 | 1): EditableSong {
  const song = copySong(source);
  const target = blockIndex + direction;
  if (blockIndex < 0 || blockIndex >= song.blocks.length || target < 0 || target >= song.blocks.length) {
    return song;
  }
  [song.blocks[blockIndex], song.blocks[target]] = [song.blocks[target], song.blocks[blockIndex]];
  return song;
}

export function deleteBlock(source: EditableSong, blockIndex: number): EditableSong {
  const song = copySong(source);
  if (!song.blocks[blockIndex]) throw new Error("block_not_found");
  song.blocks.splice(blockIndex, 1);
  if (!song.blocks.some((block) => block.type === "lyric" || block.type === "instrument")) {
    throw new Error("song_requires_playable_block");
  }
  return song;
}

function repeatContent(block: Extract<SongBlock, { type: "lyric" | "instrument" }>): unknown {
  const copy = structuredClone(block) as Record<string, unknown>;
  delete copy.id;
  delete copy.section_label;
  if (block.type === "lyric") delete copy.section_role;
  else delete copy.label;
  return copy;
}

export function blocksHaveEqualRepeatContent(
  current: Extract<SongBlock, { type: "lyric" | "instrument" }>,
  target: Extract<SongBlock, { type: "lyric" | "instrument" }>
): boolean {
  return current.type === target.type &&
    JSON.stringify(repeatContent(current)) === JSON.stringify(repeatContent(target));
}

export function markBlockAsRepeat(
  source: EditableSong,
  blockIndex: number,
  ref: string,
  allowContentReplacement = false
): EditableSong {
  const song = copySong(source);
  const current = song.blocks[blockIndex];
  const targetIndex = song.blocks.findIndex((block) => block.id === ref);
  const target = song.blocks[targetIndex];
  if (!current || targetIndex < 0 || targetIndex >= blockIndex ||
    !target || (target.type !== "lyric" && target.type !== "instrument")) {
    throw new Error("invalid_repeat_ref");
  }
  if (
    (current.type !== "lyric" && current.type !== "instrument") ||
    !blocksHaveEqualRepeatContent(current, target)
  ) {
    if (!allowContentReplacement) throw new Error("repeat_content_mismatch");
  }
  song.blocks[blockIndex] = {
    id: current.id,
    type: "repeat",
    ref,
    times: 1,
    ...(current.type === "lyric" && current.section_label
      ? { section_label: current.section_label }
      : {})
  };
  return song;
}

export function addLyricBlock(source: EditableSong, afterIndex = source.blocks.length - 1): EditableSong {
  const song = copySong(source);
  const id = uniqueBlockId(song.blocks, "verse-new");
  song.blocks.splice(Math.max(0, Math.min(song.blocks.length, afterIndex + 1)), 0, {
    id,
    type: "lyric",
    chords: ["1"],
    lyrics: [""],
    section_role: "verse",
    section_label: "新段落",
    spacing: "normal"
  });
  return song;
}

export function addInstrumentBlock(source: EditableSong, afterIndex = source.blocks.length - 1): EditableSong {
  const song = copySong(source);
  const id = uniqueBlockId(song.blocks, "instrument-new");
  song.blocks.splice(Math.max(0, Math.min(song.blocks.length, afterIndex + 1)), 0, {
    id,
    type: "instrument",
    label: "新器乐段",
    progression: "| 1 |"
  });
  return song;
}

export function updateRepeat(
  source: EditableSong,
  blockIndex: number,
  changes: { ref?: string; times?: number; section_label?: string }
): EditableSong {
  const song = copySong(source);
  const block = song.blocks[blockIndex];
  if (!block || block.type !== "repeat") throw new Error("repeat_block_required");
  Object.assign(block, changes);
  return song;
}

export function expandRepeatBlock(source: EditableSong, blockIndex: number): EditableSong {
  const song = copySong(source);
  const repeat = song.blocks[blockIndex];
  if (!repeat || repeat.type !== "repeat") throw new Error("repeat_block_required");
  const target = song.blocks.slice(0, blockIndex).find((block) => block.id === repeat.ref);
  if (!target || (target.type !== "lyric" && target.type !== "instrument")) {
    throw new Error("invalid_repeat_ref");
  }
  const copies = Array.from({ length: repeat.times }, (_, index) => ({
    ...structuredClone(target),
    id: uniqueBlockId(
      [...song.blocks, ...song.blocks.slice(blockIndex + 1)],
      `${target.id}-copy-${index + 1}`
    )
  }));
  const used = new Set(song.blocks.map((block) => block.id));
  copies.forEach((copy) => {
    let id = copy.id;
    let suffix = 2;
    while (used.has(id)) id = `${copy.id}-${suffix++}`;
    copy.id = id;
    used.add(id);
  });
  song.blocks.splice(blockIndex, 1, ...copies);
  return song;
}

export interface CandidateEditState {
  candidate: SongCandidate;
  confirmed: boolean;
  duplicate?: SongIndexEntry;
}

export function applyCandidateSongEdit(
  state: CandidateEditState,
  song: EditableSong,
  index: SongIndexEntry[]
): CandidateEditState {
  const candidate = { ...state.candidate, song };
  return {
    candidate,
    confirmed: false,
    duplicate: findDuplicateSong(index, song)
  };
}

export interface SongChangeSummary {
  changedBlockIds: string[];
  repeatConversions: number;
  repeatExpansions: number;
  changedChords: number;
  movedChordPositions: number;
  addedLyricPhrases: number;
  removedLyricPhrases: number;
  blockOrderChanged: boolean;
  instrumentProgressionChanges: number;
}

export function summarizeSongChanges(original: EditableSong, edited: EditableSong): SongChangeSummary {
  const before = new Map(original.blocks.map((block) => [block.id, block]));
  const after = new Map(edited.blocks.map((block) => [block.id, block]));
  const changedBlockIds = new Set<string>();
  let repeatConversions = 0;
  let repeatExpansions = 0;
  let changedChords = 0;
  let movedChordPositions = 0;
  let addedLyricPhrases = 0;
  let removedLyricPhrases = 0;
  let instrumentProgressionChanges = 0;

  for (const [id, block] of before) {
    const next = after.get(id);
    if (!next) {
      changedBlockIds.add(id);
      if (block.type === "repeat") repeatExpansions += 1;
      if (block.type === "lyric") removedLyricPhrases += block.chords.length;
      continue;
    }
    if (JSON.stringify(block) !== JSON.stringify(next)) changedBlockIds.add(id);
    if (block.type !== "repeat" && next.type === "repeat") repeatConversions += 1;
    if (block.type === "instrument" && next.type === "instrument" && block.progression !== next.progression) {
      instrumentProgressionChanges += 1;
    }
    if (block.type === "lyric" && next.type === "lyric") {
      const overlap = Math.min(block.chords.length, next.chords.length);
      for (let index = 0; index < overlap; index += 1) {
        if (block.chords[index] !== next.chords[index]) changedChords += 1;
      }
      const beforeSorted = [...block.chords].sort().join("\u0000");
      const afterSorted = [...next.chords].sort().join("\u0000");
      if (beforeSorted === afterSorted && block.chords.join("\u0000") !== next.chords.join("\u0000")) {
        movedChordPositions += 1;
      }
      addedLyricPhrases += Math.max(0, next.chords.length - block.chords.length);
      removedLyricPhrases += Math.max(0, block.chords.length - next.chords.length);
    }
  }
  for (const [id, block] of after) {
    if (before.has(id)) continue;
    changedBlockIds.add(id);
    if (block.type === "lyric") addedLyricPhrases += block.chords.length;
  }
  const sharedBeforeOrder = original.blocks.map((block) => block.id).filter((id) => after.has(id));
  const sharedAfterOrder = edited.blocks.map((block) => block.id).filter((id) => before.has(id));
  return {
    changedBlockIds: [...changedBlockIds],
    repeatConversions,
    repeatExpansions,
    changedChords,
    movedChordPositions,
    addedLyricPhrases,
    removedLyricPhrases,
    blockOrderChanged: sharedBeforeOrder.join("\u0000") !== sharedAfterOrder.join("\u0000"),
    instrumentProgressionChanges
  };
}
