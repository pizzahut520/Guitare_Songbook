import { formatHarmony, keyAtTranspose } from "./music";
import { buildSongRenderBlocks, gridTemplate, lyricRows } from "./song-render-model";
import type { Song } from "./song-schema";

export interface PreviewOptions {
  mode: "degree" | "chord";
  transpose: number;
}

export function setSafeText(target: Pick<Node, "textContent">, value: string | number): void {
  target.textContent = String(value);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string | number
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) setSafeText(node, text);
  return node;
}

function renderHeader(song: Song, options: PreviewOptions): HTMLElement {
  const header = element("header", "song-header");
  const credits = element("div", "song-header__credits");
  credits.append(
    element("strong", undefined, `演唱：${song.artist}`),
    element("span", undefined, `词：${song.credits.lyrics}`),
    element("span", undefined, `曲：${song.credits.music}`)
  );
  const title = element("div", "song-header__title");
  title.append(
    element("p", undefined, "GUITARE SONGBOOK"),
    element("h1", undefined, song.title),
    element("span", undefined, song.artist)
  );
  const key = element("dl", "song-header__key");
  for (const [label, value] of [
    ["原调", song.original_key],
    ["级数基准", options.mode === "chord"
      ? keyAtTranspose(song.degree_key, options.transpose)
      : song.degree_key],
    ["Capo", String(song.capo)]
  ]) {
    const row = element("div");
    row.append(element("dt", undefined, label), element("dd", undefined, value));
    key.append(row);
  }
  header.append(credits, title, key);
  return header;
}

function harmony(value: string, song: Song, options: PreviewOptions): string {
  return formatHarmony(value, song.degree_key, options.mode, options.transpose);
}

export function renderSongPreview(container: HTMLElement, song: Song, options: PreviewOptions): void {
  const article = element("article", "song-sheet song-sheet--preview");
  article.dataset.songSheet = "preview";
  article.dataset.degreeKey = song.degree_key;
  article.append(renderHeader(song, options));
  const body = element("div", "song-body");

  for (const { block, renderId } of buildSongRenderBlocks(song)) {
    if (block.type === "instrument") {
      const section = element("section", "instrument-block");
      section.dataset.blockId = renderId;
      section.append(
        element("span", "instrument-label", `[${block.label}]`),
        element("span", "instrument-progression", harmony(block.progression, song, options))
      );
      if (block.repeat) section.append(element("strong", "repeat-mark", block.repeat));
      body.append(section);
      continue;
    }
    if (block.type === "lyric") {
      const rows = lyricRows(block);
      const labels = block.variant_labels ?? [];
      const section = element("section", `lyric-block spacing-${block.spacing}`);
      section.dataset.blockId = renderId;
      section.style.setProperty("--phrase-grid", gridTemplate(block.widths, block.chords.length));
      const desktop = element("div", "desktop-lyric");
      const chordRow = element("div", "chord-row phrase-grid");
      chordRow.setAttribute("aria-label", "和弦");
      block.chords.forEach((chord) => chordRow.append(element("span", undefined, harmony(chord, song, options))));
      desktop.append(chordRow);
      rows.forEach((row, rowIndex) => {
        const line = element("div", "lyric-line");
        if (labels[rowIndex]) line.append(element("span", "variant-label", labels[rowIndex]));
        const lyricRow = element("div", "lyric-row phrase-grid");
        row.forEach((phrase) => lyricRow.append(element("span", undefined, phrase || "\u00a0")));
        line.append(lyricRow);
        desktop.append(line);
      });
      const mobile = element("div", "mobile-lyric");
      const mobileGrid = element("div", "mobile-phrase-grid");
      block.chords.forEach((chord, phraseIndex) => {
        const phrase = element("div", "mobile-phrase");
        phrase.append(element("span", "mobile-phrase__chord", harmony(chord, song, options)));
        rows.forEach((row, rowIndex) => {
          const variant = element("div", "mobile-phrase__variant");
          if (labels[rowIndex]) variant.append(element("span", "mobile-variant__label", labels[rowIndex]));
          variant.append(element("span", "mobile-phrase__lyric", row[phraseIndex] || "\u00a0"));
          phrase.append(variant);
        });
        mobileGrid.append(phrase);
      });
      mobile.append(mobileGrid);
      section.append(desktop, mobile);
      body.append(section);
      continue;
    }
    const legend = element("section", "theory-legend");
    legend.dataset.blockId = renderId;
    legend.append(element("h2", undefined, block.title));
    const grid = element("div", "legend-grid");
    block.items.forEach((item) => {
      const row = element("p");
      row.append(element("strong", undefined, item.quality), document.createTextNode(` = ${item.formula}`));
      grid.append(row);
    });
    legend.append(grid);
    if (block.note) legend.append(element("p", "legend-note", block.note));
    body.append(legend);
  }
  article.append(body);
  container.replaceChildren(article);
}
