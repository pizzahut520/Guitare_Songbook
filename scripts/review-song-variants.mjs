import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SONG_DIRECTORY = new URL("../src/content/songs/", import.meta.url);
const GOLDEN_SAMPLE = "chen-qizhen-lvxing-de-yiyi";

function sameChords(left, right) {
  return JSON.stringify(left.chords) === JSON.stringify(right.chords);
}

function lyricPreview(block) {
  if (block.lyrics) return block.lyrics.join(" / ");
  return (block.lyric_sets ?? []).map((row) => row.join(" / ")).join(" | ");
}

export function findVariantCandidates(song) {
  if (song.slug === GOLDEN_SAMPLE) return [];

  const blocks = song.blocks;
  const candidates = [];

  for (let first = 0; first < blocks.length; first++) {
    if (blocks[first]?.type !== "lyric" || blocks[first].lyric_sets) continue;

    const possibleLengths = [];
    for (let length = 2; first + length * 2 <= blocks.length; length++) {
      const matches = Array.from({ length }, (_, offset) => {
        const left = blocks[first + offset];
        const right = blocks[first + length + offset];
        return (
          left?.type === "lyric" &&
          right?.type === "lyric" &&
          !left.lyric_sets &&
          !right.lyric_sets &&
          sameChords(left, right)
        );
      }).every(Boolean);
      if (matches) possibleLengths.push(length);
    }

    const length = possibleLengths.at(-1);
    if (!length) continue;

    candidates.push({
        song: song.slug,
        title: song.title,
        first_start: first,
        second_start: first + length,
        block_count: length,
        confidence: "review",
        first_preview: lyricPreview(blocks[first]),
        second_preview: lyricPreview(blocks[first + length]),
        decision: ""
    });
  }

  return candidates
    .sort((left, right) => right.block_count - left.block_count)
    .filter(
      (candidate, index, all) =>
        !all.slice(0, index).some((selected) => {
          const candidateEnd = candidate.second_start + candidate.block_count;
          const selectedEnd = selected.second_start + selected.block_count;
          return candidate.first_start < selectedEnd && candidateEnd > selected.first_start;
        })
    )
    .sort((left, right) => left.first_start - right.first_start);
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function parseCsv(content) {
  content = content.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (character === '"') {
      if (quoted && content[index + 1] === '"') {
        cell += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && content[index + 1] === "\n") index++;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  const [headers, ...values] = rows;
  return values.map((valueRow) =>
    Object.fromEntries(headers.map((header, index) => [header, valueRow[index] ?? ""]))
  );
}

export async function applyVariantReview(reviewPath) {
  const decisions = parseCsv(await readFile(path.resolve(reviewPath), "utf8")).filter(
    (candidate) => candidate.decision.trim().toLowerCase() === "merge"
  );
  const grouped = Map.groupBy(decisions, (candidate) => candidate.song);
  let mergedPairs = 0;

  for (const [slug, songDecisions] of grouped) {
    if (slug === GOLDEN_SAMPLE) throw new Error("黄金样本不允许批量修改");

    const songUrl = new URL(`${slug}.json`, SONG_DIRECTORY);
    const song = JSON.parse(await readFile(songUrl, "utf8"));
    const sorted = songDecisions.sort(
      (left, right) => Number(right.first_start) - Number(left.first_start)
    );

    for (const decision of sorted) {
      const first = Number(decision.first_start);
      const second = Number(decision.second_start);
      const length = Number(decision.block_count);
      if (second !== first + length) throw new Error(`${slug}: 候选段落不相邻`);

      for (let offset = 0; offset < length; offset++) {
        const left = song.blocks[first + offset];
        const right = song.blocks[second + offset];
        if (
          left?.type !== "lyric" ||
          right?.type !== "lyric" ||
          left.lyric_sets ||
          right.lyric_sets ||
          !sameChords(left, right)
        ) {
          throw new Error(`${slug}: 审核表与歌曲内容不再匹配，请重新生成`);
        }
        left.lyric_sets = [left.lyrics, right.lyrics];
        delete left.lyrics;
        left.variant_labels = ["A.", "B."];
        left.spacing = "compact";
        mergedPairs++;
      }

      song.blocks.splice(second, length);
    }

    await writeFile(songUrl, `${JSON.stringify(song, null, 2)}\n`, "utf8");
  }

  return { songs: grouped.size, mergedPairs };
}

export async function createVariantReview(outputPath = "tmp/song-variant-review.csv") {
  const files = (await readdir(SONG_DIRECTORY)).filter((file) => file.endsWith(".json"));
  const candidates = [];

  for (const file of files) {
    const song = JSON.parse(await readFile(new URL(file, SONG_DIRECTORY), "utf8"));
    candidates.push(...findVariantCandidates(song));
  }

  const headers = [
    "song",
    "title",
    "first_start",
    "second_start",
    "block_count",
    "confidence",
    "first_preview",
    "second_preview",
    "decision"
  ];
  const rows = [
    headers.map(csvCell).join(","),
    ...candidates.map((candidate) =>
      headers.map((header) => csvCell(candidate[header])).join(",")
    )
  ];

  const absoluteOutput = path.resolve(outputPath);
  await mkdir(path.dirname(absoluteOutput), { recursive: true });
  // Excel on Windows needs a UTF-8 BOM to recognize Chinese CSV text correctly.
  await writeFile(absoluteOutput, `\uFEFF${rows.join("\r\n")}\r\n`, "utf8");
  return { output: absoluteOutput, candidates };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--apply") {
    const reviewPath = process.argv[3] ?? "tmp/song-variant-review.csv";
    const result = await applyVariantReview(reviewPath);
    console.log(`Merged ${result.mergedPairs} block pairs in ${result.songs} songs`);
  } else {
    const result = await createVariantReview(process.argv[2]);
    console.log(`Generated ${result.candidates.length} candidates: ${result.output}`);
  }
}
