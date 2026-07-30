import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HEADER_PATTERN =
  /^(歌名|专辑|專輯|艺人|藝人|原调|原調|Capo)：\s*(.*)$/i;
const KEY_PATTERN = /^\s*Key\s*[=:]\s*([A-G](?:#|b|♯|♭)?)\s*$/i;
const TEMPLATE_INSTRUCTION = /^填写方式：|^填寫方式：/;
const SECTION_PATTERN =
  /^\s*(?:\[([^\]]+)\]|(前奏|主歌\s*\d*|副歌|间奏|間奏|桥段|橋段|尾奏|intro|verse\s*\d*|chorus|bridge|interlude|outro)\s*[:：])\s*$/i;
const CHORD_PATTERN =
  /^[A-G](?:#|b|♯|♭)?(?:(?:maj|min|dim|aug|sus|add|m)\d*|\d+)*(?:\([^)]*\))?(?:\/[A-G](?:#|b|♯|♭)?)?$/i;
const DEGREE_NAMES = [
  "1",
  "♭2",
  "2",
  "♭3",
  "3",
  "4",
  "♯4",
  "5",
  "♭6",
  "6",
  "♭7",
  "7"
];
const NOTE_INDEX = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11
};

function normalizeAccidental(value) {
  return value.replaceAll("♯", "#").replaceAll("♭", "b");
}

function modulo(value, base) {
  return ((value % base) + base) % base;
}

function chordTokens(line) {
  return line
    .replace(/[|｜]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token && !/^(?:x|×)\s*\d+$/i.test(token));
}

export function isChordLine(line) {
  const tokens = chordTokens(line);
  return tokens.length > 0 && tokens.every((token) => CHORD_PATTERN.test(token));
}

export function chordToDegree(chord, key) {
  const normalizedChord = normalizeAccidental(chord);
  const normalizedKey = normalizeAccidental(key);
  const match = normalizedChord.match(
    /^([A-G](?:#|b)?)(.*?)(?:\/([A-G](?:#|b)?))?$/i
  );
  const keyIndex = NOTE_INDEX[normalizedKey];
  if (!match || keyIndex === undefined) return chord;

  const rootIndex = NOTE_INDEX[match[1]];
  if (rootIndex === undefined) return chord;

  const rootDegree = DEGREE_NAMES[modulo(rootIndex - keyIndex, 12)];
  const quality = match[2] ?? "";
  const bassIndex = match[3] ? NOTE_INDEX[match[3]] : undefined;
  const bass =
    bassIndex === undefined
      ? ""
      : `/${DEGREE_NAMES[modulo(bassIndex - keyIndex, 12)]}`;
  return `${rootDegree}${quality}${bass}`;
}

export function alignChordAndLyric(chordLine, lyricLine, key) {
  return {
    chords: [progressionFromLine(chordLine, key)],
    lyrics: [lyricLine.trim()]
  };
}

function splitParagraphs(lines) {
  const paragraphs = [];
  let current = [];
  for (const line of lines) {
    if (line.trim()) {
      current.push(line.trim());
    } else if (current.length) {
      paragraphs.push(current);
      current = [];
    }
  }
  if (current.length) paragraphs.push(current);
  return paragraphs;
}

function splitLongLine(line) {
  const cjkCount = [...line].filter((character) =>
    /[\p{Script=Han}]/u.test(character)
  ).length;
  if (line.length <= 80 && cjkCount <= 28) return [line];

  const pieces =
    line.match(/[^，。！？；：,.!?;:]+[，。！？；：,.!?;:]?/gu)?.map((part) => part.trim()) ??
    [line];
  return pieces.length > 1 ? pieces.filter(Boolean) : [line];
}

export function cleanLyricLines(lines) {
  const seenParagraphs = new Set();
  const output = [];
  let duplicateParagraphsRemoved = 0;
  let unsplitLongLines = 0;

  for (const paragraph of splitParagraphs(lines)) {
    const signature = paragraph.join("\n").replace(/\s+/g, "");
    if (paragraph.length > 1 && seenParagraphs.has(signature)) {
      duplicateParagraphsRemoved++;
      continue;
    }
    seenParagraphs.add(signature);

    for (const line of paragraph) {
      const pieces = splitLongLine(line);
      if (
        pieces.length === 1 &&
        (line.length > 80 ||
          [...line].filter((character) => /[\p{Script=Han}]/u.test(character)).length >
            28)
      ) {
        unsplitLongLines++;
      }
      output.push(...pieces);
    }
    output.push("");
  }

  if (output.at(-1) === "") output.pop();
  return { lines: output, duplicateParagraphsRemoved, unsplitLongLines };
}

function sectionLabel(line) {
  const match = line.match(SECTION_PATTERN);
  if (!match) return null;
  return (match[1] ?? match[2]).trim();
}

function safeId(label, index) {
  const normalized = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${normalized || "section"}-${String(index).padStart(2, "0")}`;
}

function progressionFromLine(line, key) {
  return chordTokens(line)
    .map((chord) => chordToDegree(chord, key))
    .join("   ");
}

function repeatFromLine(line) {
  return line.match(/(?:x|×)\s*(\d+)/i)?.[1];
}

function variantLyric(line) {
  const match = line.trim().match(/^([A-Z0-9]+)[.、:：]\s*(.+)$/i);
  return match ? { label: `${match[1].toUpperCase()}.`, lyric: match[2].trim() } : null;
}

export function parseChordBlocks(lines, key) {
  const blocks = [];
  const warnings = [];
  let activeSection = "歌曲";
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index];
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      index++;
      continue;
    }

    const label = sectionLabel(line);
    if (label) {
      activeSection = label;
      index++;
      continue;
    }

    if (KEY_PATTERN.test(line)) {
      index++;
      continue;
    }

    if (!isChordLine(line)) {
      warnings.push(`没有配对和弦的歌词：${line.trim().slice(0, 40)}`);
      index++;
      continue;
    }

    let nextIndex = index + 1;
    while (nextIndex < lines.length && !lines[nextIndex].trim()) nextIndex++;
    const nextLine = lines[nextIndex] ?? "";
    const variants = [];
    let variantIndex = nextIndex;
    while (variantIndex < lines.length) {
      const variant = variantLyric(lines[variantIndex]);
      if (!variant) break;
      variants.push(variant);
      variantIndex++;
    }

    if (variants.length >= 2) {
      const alignedVariants = variants.map((variant) =>
        alignChordAndLyric(line, variant.lyric, key)
      );
      blocks.push({
        id: safeId(activeSection, blocks.length + 1),
        type: "lyric",
        chords: alignedVariants[0].chords,
        lyric_sets: alignedVariants.map((variant) => variant.lyrics),
        variant_labels: variants.map((variant) => variant.label),
        spacing: "compact"
      });
      index = variantIndex;
      continue;
    }

    const nextIsLyric =
      nextLine.trim() &&
      !isChordLine(nextLine) &&
      !sectionLabel(nextLine) &&
      !KEY_PATTERN.test(nextLine);

    if (nextIsLyric) {
      const aligned = alignChordAndLyric(line, nextLine, key);
      blocks.push({
        id: safeId(activeSection, blocks.length + 1),
        type: "lyric",
        chords: aligned.chords,
        lyrics: aligned.lyrics,
        spacing: "normal"
      });
      index = nextIndex + 1;
      continue;
    }

    const repeat = repeatFromLine(line);
    const progression = progressionFromLine(line, key);
    const previous = blocks.at(-1);
    if (previous?.type === "instrument" && previous.label === activeSection) {
      previous.progression = `${previous.progression} | ${progression}`;
      if (repeat) previous.repeat = `×${repeat}`;
    } else {
      blocks.push({
        id: safeId(activeSection, blocks.length + 1),
        type: "instrument",
        label: activeSection,
        progression,
        ...(repeat ? { repeat: `×${repeat}` } : {})
      });
    }
    index++;
  }

  const compacted = compactRepeatedLyricBlocks(blocks);
  return {
    blocks: compacted.blocks,
    warnings,
    repeatedBlocksRemoved: compacted.removed
  };
}

export function compactRepeatedLyricBlocks(blocks) {
  const compacted = [];
  let removed = 0;
  let previousSignature = null;

  for (const block of blocks) {
    if (block.type === "instrument") {
      previousSignature = null;
      compacted.push(block);
      continue;
    }

    const signature = JSON.stringify({
      chords: block.chords,
      lyrics: block.lyrics,
      lyric_sets: block.lyric_sets
    });
    if (previousSignature === signature) {
      removed++;
      continue;
    }
    previousSignature = signature;
    compacted.push(block);
  }

  return { blocks: compacted, removed };
}

function parseHeaders(lines) {
  const headers = {};
  for (const line of lines) {
    const match = line.match(HEADER_PATTERN);
    if (!match) continue;
    const rawName = match[1].toLowerCase();
    const name =
      rawName === "歌名"
        ? "title"
        : rawName === "专辑" || rawName === "專輯"
          ? "album"
          : rawName === "艺人" || rawName === "藝人"
            ? "artist"
            : rawName === "原调" || rawName === "原調"
              ? "originalKey"
              : "capo";
    headers[name] = match[2].trim();
  }
  return headers;
}

function bodyFromLines(lines) {
  return lines.filter(
    (line) =>
      !HEADER_PATTERN.test(line) &&
      !TEMPLATE_INSTRUCTION.test(line.trim())
  );
}

function contentSignature(title, artist) {
  return `${title}\u001f${artist}`;
}

function fallbackSlug(title, artist) {
  const digest = createHash("sha256")
    .update(contentSignature(title, artist))
    .digest("hex")
    .slice(0, 12);
  return `song-${digest}`;
}

async function loadOverrides() {
  const overridePath = new URL("./song-import-overrides.json", import.meta.url);
  return JSON.parse(await readFile(overridePath, "utf8"));
}

function detectKey(lines, headers) {
  if (headers.originalKey) return normalizeAccidental(headers.originalKey);
  for (const line of lines) {
    const match = line.match(KEY_PATTERN);
    if (match) return normalizeAccidental(match[1]);
  }
  return "";
}

async function parseTextFile(filePath) {
  const text = await readFile(filePath, "utf8");
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const headers = parseHeaders(lines);
  const body = bodyFromLines(lines);
  const meaningful = body.filter(
    (line) => line.trim() && !sectionLabel(line) && !KEY_PATTERN.test(line)
  );
  const chordLineCount = body.filter(isChordLine).length;
  const cleaned = cleanLyricLines(
    body.filter((line) => !KEY_PATTERN.test(line) && !sectionLabel(line))
  );

  return {
    file: path.basename(filePath),
    ...headers,
    originalKey: detectKey(body, headers),
    abandoned: meaningful.length === 0,
    chordLineCount,
    cleaned
  };
}

export function songFromParsed(parsed, override) {
  const parsedBlocks = parseChordBlocks(parsed.body ?? [], parsed.originalKey);
  const warnings = [...parsedBlocks.warnings];
  if (!override) {
    warnings.push("缺少已核实的 slug、词曲作者、语言和标签覆盖信息");
  }
  if (!parsed.originalKey || !parsedBlocks.blocks.length || warnings.length) {
    return {
      song: null,
      warnings,
      repeatedBlocksRemoved: parsedBlocks.repeatedBlocksRemoved
    };
  }

  return {
    song: {
      schema_version: 1,
      slug: override.slug,
      title: parsed.title,
      artist: parsed.artist,
      credits: override.credits,
      original_key: override.original_key ?? parsed.originalKey,
      degree_key: override.degree_key ?? parsed.originalKey,
      capo:
        override.capo ??
        (Number.parseInt(parsed.capo || "0", 10) || 0),
      language: override.language,
      tags: override.tags,
      source: {
        type: "user_text",
        reference: override.source_reference ?? parsed.file
      },
      copyright_status: "private_reference",
      blocks: parsedBlocks.blocks
    },
    warnings,
    repeatedBlocksRemoved: parsedBlocks.repeatedBlocksRemoved
  };
}

function parseArguments(argv) {
  const options = {
    inputDirectory: argv[0],
    outputDirectory: "src/content/songs",
    stagingDirectory: "tmp/song-import",
    writeSongs: false
  };
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] === "--output") options.outputDirectory = argv[++index];
    else if (argv[index] === "--staging") options.stagingDirectory = argv[++index];
    else if (argv[index] === "--write-songs") options.writeSongs = true;
  }
  return options;
}

export async function importSongTexts(options) {
  if (!options.inputDirectory) {
    throw new Error(
      "用法：pnpm songs:import <TXT目录> [--staging <临时目录>] [--write-songs]"
    );
  }

  const overrides = await loadOverrides();
  const overrideMap = new Map(
    overrides.map((override) => [
      contentSignature(override.title, override.artist),
      override
    ])
  );
  const entries = (await readdir(options.inputDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".txt"))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

  await mkdir(options.stagingDirectory, { recursive: true });
  if (options.writeSongs) await mkdir(options.outputDirectory, { recursive: true });

  const reportEntries = [];
  for (const entry of entries) {
    const parsed = await parseTextFile(path.join(options.inputDirectory, entry.name));
    parsed.body = bodyFromLines(
      (await readFile(path.join(options.inputDirectory, entry.name), "utf8"))
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n")
        .split("\n")
    );
    const status = parsed.abandoned
      ? "abandoned"
      : parsed.chordLineCount
        ? "chorded"
        : "needs_chords";
    const override = overrideMap.get(contentSignature(parsed.title, parsed.artist));
    let generatedSong = null;
    let warnings = [];
    let repeatedBlocksRemoved = 0;

    if (status === "chorded") {
      const result = songFromParsed(parsed, override);
      generatedSong = result.song;
      warnings = result.warnings;
      repeatedBlocksRemoved = result.repeatedBlocksRemoved;
      if (generatedSong && options.writeSongs) {
        await writeFile(
          path.join(options.outputDirectory, `${generatedSong.slug}.json`),
          `${JSON.stringify(generatedSong, null, 2)}\n`,
          "utf8"
        );
      }
    }

    const stagingName = `${fallbackSlug(parsed.title, parsed.artist)}.json`;
    await writeFile(
      path.join(options.stagingDirectory, stagingName),
      `${JSON.stringify(
        {
          file: parsed.file,
          title: parsed.title,
          album: parsed.album,
          artist: parsed.artist,
          original_key: parsed.originalKey || null,
          status,
          cleaned_lyrics: parsed.cleaned.lines,
          duplicate_paragraphs_removed: parsed.cleaned.duplicateParagraphsRemoved,
          unsplit_long_lines: parsed.cleaned.unsplitLongLines,
          repeated_chord_blocks_removed: repeatedBlocksRemoved,
          warnings
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    reportEntries.push({
      file: parsed.file,
      title: parsed.title,
      artist: parsed.artist,
      status,
      chord_lines: parsed.chordLineCount,
      duplicate_paragraphs_removed: parsed.cleaned.duplicateParagraphsRemoved,
      unsplit_long_lines: parsed.cleaned.unsplitLongLines,
      repeated_chord_blocks_removed: repeatedBlocksRemoved,
      generated_slug: generatedSong?.slug ?? null,
      warnings
    });
  }

  const report = {
    source_directory: path.resolve(options.inputDirectory),
    total_files: reportEntries.length,
    abandoned: reportEntries.filter((entry) => entry.status === "abandoned").length,
    needs_chords: reportEntries.filter((entry) => entry.status === "needs_chords").length,
    chorded: reportEntries.filter((entry) => entry.status === "chorded").length,
    generated: reportEntries.filter((entry) => entry.generated_slug).length,
    entries: reportEntries
  };
  await writeFile(
    path.join(options.stagingDirectory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  return report;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await importSongTexts(options);
  console.log(
    JSON.stringify(
      {
        total_files: report.total_files,
        abandoned: report.abandoned,
        needs_chords: report.needs_chords,
        chorded: report.chorded,
        generated: report.generated,
        staging_directory: path.resolve(options.stagingDirectory)
      },
      null,
      2
    )
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
