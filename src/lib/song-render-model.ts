import type { Song, SongBlock } from "./song-schema";

export type RenderableBlock = Exclude<SongBlock, { type: "repeat" }>;

export interface RenderBlock {
  renderId: string;
  sourceId: string;
  repeated: boolean;
  block: RenderableBlock;
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
      for (let repeatIndex = 0; repeatIndex < block.times; repeatIndex += 1) {
        rendered.push({
          renderId: `${block.id}-${repeatIndex + 1}`,
          sourceId: block.ref,
          repeated: true,
          block: target
        });
      }
      continue;
    }
    rendered.push({ renderId: block.id, sourceId: block.id, repeated: false, block });
    if (block.type === "lyric" || block.type === "instrument") playable.set(block.id, block);
  }
  return rendered;
}
