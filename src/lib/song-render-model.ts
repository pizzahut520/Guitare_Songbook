import type { Song, SongBlock } from "./song-schema";

export type RenderableBlock = Exclude<SongBlock, { type: "repeat" }>;

export interface RenderBlock {
  renderId: string;
  sourceId: string;
  repeated: boolean;
  sectionLabel?: string;
  repeat?: {
    label: string;
    index: number;
    times: number;
  };
  block: RenderableBlock;
}

const SECTION_LABELS = {
  verse: "主歌",
  pre_chorus: "预副歌",
  chorus: "副歌",
  bridge: "Bridge",
  outro: "尾声",
  other: "段落"
} as const;

export function sectionLabel(block: RenderableBlock): string | undefined {
  if (block.type === "instrument") return block.label;
  if (block.type !== "lyric") return undefined;
  return block.section_label || (block.section_role ? SECTION_LABELS[block.section_role] : undefined);
}

export function gridTemplate(widths: number[] | undefined, count: number): string {
  return (widths ?? Array.from({ length: count }, () => 1))
    .map((width) => `${width}fr`)
    .join(" ");
}

export function lyricRows(block: Extract<RenderableBlock, { type: "lyric" }>): string[][] {
  return block.lyrics ? [block.lyrics] : block.lyric_sets ?? [];
}

export function buildSongRenderBlocks(song: Pick<Song, "blocks">): RenderBlock[] {
  const playable = new Map<string, RenderableBlock>();
  const rendered: RenderBlock[] = [];
  for (const block of song.blocks) {
    if (block.type === "repeat") {
      const target = playable.get(block.ref);
      if (!target) continue;
      const label = block.section_label || sectionLabel(target) || "重复段落";
      for (let repeatIndex = 0; repeatIndex < block.times; repeatIndex += 1) {
        rendered.push({
          renderId: `${block.id}-${repeatIndex + 1}`,
          sourceId: block.ref,
          repeated: true,
          sectionLabel: sectionLabel(target),
          repeat: { label, index: repeatIndex + 1, times: block.times },
          block: target
        });
      }
      continue;
    }
    rendered.push({
      renderId: block.id,
      sourceId: block.id,
      repeated: false,
      sectionLabel: sectionLabel(block),
      block
    });
    if (block.type === "lyric" || block.type === "instrument") playable.set(block.id, block);
  }
  return rendered;
}
