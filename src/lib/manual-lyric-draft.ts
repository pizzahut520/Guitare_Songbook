import type { SongCandidate } from "./song-candidate-schema";
import type { EditableSong } from "./candidate-editor";

export interface ManualSongFields {
  title: string; artist: string; slug: string; lyricsCredit: string; musicCredit: string;
  originalKey: string; degreeKey: string; capo: number; language: string; tags: string[];
  sourceReference?: string; copyrightStatus: "private_reference" | "public_domain" | "licensed";
}

export type ManualEditableCandidate = Omit<SongCandidate, "song"> & { song: EditableSong };
export type ManualSectionRole = "verse" | "pre_chorus" | "chorus" | "bridge" | "outro" | "other";

export interface ManualParseErrorDetails {
  code: "manual_lyrics_required" | "unknown_section_header" | "invalid_section_header" |
    "variant_a_without_b" | "variant_b_without_a" | "duplicate_variant" | "variant_line_count_mismatch";
  line: number;
  section_role?: ManualSectionRole;
  group?: string;
}

/** Contains metadata only: never the source line or lyric text. */
export class ManualLyricsParseError extends Error {
  readonly details: ManualParseErrorDetails;
  constructor(details: ManualParseErrorDetails) {
    super(details.code);
    this.name = "ManualLyricsParseError";
    this.details = details;
  }
}

interface ParsedLine { text: string; line: number; blankBefore: boolean; }
export interface ParsedManualSection {
  role: ManualSectionRole; label: string; headerLine?: number; variant?: "A" | "B"; group?: string;
  lines: ParsedLine[];
}
export interface ParsedAnnotatedLyrics {
  sections: ParsedManualSection[];
  warnings: string[];
  summary: Record<ManualSectionRole, number> & { variantPairs: number; ordinaryBlocks: number };
}

const sectionNames: Record<string, { role: ManualSectionRole; label: string }> = {
  "主歌": { role: "verse", label: "主歌" }, "预副歌": { role: "pre_chorus", label: "预副歌" },
  "副歌": { role: "chorus", label: "副歌" }, "bridge": { role: "bridge", label: "Bridge" },
  "桥段": { role: "bridge", label: "Bridge" }, "尾段": { role: "outro", label: "尾段" },
  "其他": { role: "other", label: "其他" }
};
const isBlank = (line: string) => /^[ \t]*$/.test(line);

function normalizedLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && isBlank(lines[0])) lines.shift();
  while (lines.length && isBlank(lines.at(-1) ?? "")) lines.pop();
  return lines;
}

function parseHeader(line: string, lineNumber: number): Omit<ParsedManualSection, "lines"> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[")) return undefined;
  if (!trimmed.endsWith("]")) throw new ManualLyricsParseError({ code: "invalid_section_header", line: lineNumber });
  const [sectionPart, ...groupParts] = trimmed.slice(1, -1).split("|");
  const group = groupParts.length ? groupParts.join("|").trim() : undefined;
  if (group !== undefined && (!group || group.length > 40)) {
    throw new ManualLyricsParseError({ code: "invalid_section_header", line: lineNumber });
  }
  const match = sectionPart.trim().match(/^(主歌|预副歌|副歌|bridge|桥段|尾段|其他)(?:\s+([ab]))?$/i);
  if (!match) throw new ManualLyricsParseError({ code: "unknown_section_header", line: lineNumber });
  const descriptor = sectionNames[match[1].toLocaleLowerCase()];
  return { ...descriptor, headerLine: lineNumber, ...(match[2] ? { variant: match[2].toUpperCase() as "A" | "B" } : {}), ...(group ? { group } : {}) };
}

function legacySections(lines: string[]): ParsedManualSection[] {
  const sections: ParsedManualSection[] = [];
  let group: string[] = [];
  for (const line of lines) {
    if (isBlank(line)) { if (group.length) group.push(line); continue; }
    if (group.length && isBlank(group.at(-1) ?? "")) {
      sections.push({ role: "other", label: "其他", lines: [{ text: group.join("\n"), line: 0, blankBefore: false }] });
      group = [];
    }
    group.push(line.replace(/^([ \t]*)\\\[/, "$1["));
  }
  if (group.length) sections.push({ role: "other", label: "其他", lines: [{ text: group.join("\n"), line: 0, blankBefore: false }] });
  return sections;
}

function validateVariantPairs(sections: ParsedManualSection[]): { pairs: Map<number, number>; warnings: string[] } {
  const pairs = new Map<number, number>();
  const grouped = new Map<string, { A?: number; B?: number }>();
  sections.forEach((section, index) => {
    if (!section.variant || !section.group) return;
    const key = `${section.role}\u0000${section.group}`;
    const entry = grouped.get(key) ?? {};
    if (entry[section.variant] !== undefined) throw new ManualLyricsParseError({ code: "duplicate_variant", line: section.headerLine ?? 0, section_role: section.role, group: section.group });
    entry[section.variant] = index;
    grouped.set(key, entry);
  });
  for (const entry of grouped.values()) {
    if (entry.A === undefined || entry.B === undefined) {
      const index = entry.A ?? entry.B!;
      const section = sections[index];
      throw new ManualLyricsParseError({ code: section.variant === "A" ? "variant_a_without_b" : "variant_b_without_a", line: section.headerLine ?? 0, section_role: section.role, group: section.group });
    }
    pairs.set(entry.A, entry.B); pairs.set(entry.B, entry.A);
  }
  sections.forEach((section, index) => {
    if (!section.variant || section.group || pairs.has(index)) return;
    if (section.variant === "B") throw new ManualLyricsParseError({ code: "variant_b_without_a", line: section.headerLine ?? 0, section_role: section.role });
    const next = sections[index + 1];
    if (!next || next.variant !== "B" || next.group || next.role !== section.role) {
      throw new ManualLyricsParseError({ code: "variant_a_without_b", line: section.headerLine ?? 0, section_role: section.role });
    }
    pairs.set(index, index + 1); pairs.set(index + 1, index);
  });
  const warnings: string[] = [];
  for (const [aIndex, bIndex] of pairs) {
    if (sections[aIndex].variant !== "A") continue;
    const left = sections[aIndex], right = sections[bIndex];
    if (left.lines.length !== right.lines.length) throw new ManualLyricsParseError({ code: "variant_line_count_mismatch", line: right.headerLine ?? 0, section_role: left.role, group: left.group });
    if (left.lines.some((line, index) => line.blankBefore !== right.lines[index].blankBefore)) warnings.push("variant_spacing_mismatch");
  }
  return { pairs, warnings };
}

/** Parses explicit headers only. It never infers song structure, repeated lyrics, or chords. */
export function parseAnnotatedLyrics(text: string): ParsedAnnotatedLyrics {
  const lines = normalizedLines(text);
  if (!lines.some((line) => !isBlank(line))) throw new ManualLyricsParseError({ code: "manual_lyrics_required", line: 0 });
  const hasHeader = lines.some((line) => line.trim().startsWith("[") && !line.trim().startsWith("\\["));
  if (!hasHeader) {
    const sections = legacySections(lines);
    return { sections, warnings: [], summary: { verse: 0, pre_chorus: 0, chorus: 0, bridge: 0, outro: 0, other: sections.length, variantPairs: 0, ordinaryBlocks: sections.length } };
  }
  const sections: ParsedManualSection[] = [];
  let current: ParsedManualSection | undefined;
  let pendingBlank = false;
  lines.forEach((original, index) => {
    const lineNumber = index + 1;
    const escaped = /^([ \t]*)\\\[/.exec(original);
    if (escaped) {
      if (!current) current = { role: "other", label: "其他", lines: [] };
      current.lines.push({ text: `${escaped[1]}${original.slice(escaped[1].length + 1)}`, line: lineNumber, blankBefore: pendingBlank });
      pendingBlank = false;
      return;
    }
    const header = parseHeader(original, lineNumber);
    if (header) { if (current) sections.push(current); current = { ...header, lines: [] }; pendingBlank = false; return; }
    if (isBlank(original)) { if (current?.lines.length) pendingBlank = true; return; }
    if (!current) current = { role: "other", label: "其他", lines: [] };
    current.lines.push({ text: original, line: lineNumber, blankBefore: pendingBlank });
    pendingBlank = false;
  });
  if (current) sections.push(current);
  const { pairs, warnings } = validateVariantPairs(sections);
  const summary: ParsedAnnotatedLyrics["summary"] = { verse: 0, pre_chorus: 0, chorus: 0, bridge: 0, outro: 0, other: 0, variantPairs: 0, ordinaryBlocks: 0 };
  sections.forEach((section, index) => {
    if (section.variant === "B" && pairs.has(index)) return;
    summary[section.role] += section.lines.length;
    if (section.variant === "A" && pairs.has(index)) summary.variantPairs += 1;
    else if (!section.variant) summary.ordinaryBlocks += section.lines.length;
  });
  return { sections, warnings, summary };
}

function blocksFromParsed(parsed: ParsedAnnotatedLyrics): EditableSong["blocks"] {
  const { pairs } = validateVariantPairs(parsed.sections);
  const blocks: EditableSong["blocks"] = [];
  parsed.sections.forEach((section, sectionIndex) => {
    if (section.variant === "B" && pairs.has(sectionIndex)) return;
    const paired = pairs.has(sectionIndex) ? parsed.sections[pairs.get(sectionIndex)!] : undefined;
    section.lines.forEach((line, lineIndex) => {
      const next = section.lines[lineIndex + 1];
      const spacing: "compact" | "normal" | "generous" = next
        ? (next.blankBefore ? "normal" : "compact")
        : (sectionIndex < parsed.sections.length - 1 ? "generous" : "normal");
      const base = { id: `section-${blocks.length + 1}`, type: "lyric" as const, chords: [""], section_role: section.role, ...(lineIndex === 0 ? { section_label: section.label } : {}), spacing };
      blocks.push(paired ? { ...base, lyric_sets: [[line.text], [paired.lines[lineIndex].text]], variant_labels: ["A.", "B."] } : { ...base, lyrics: [line.text] });
    });
  });
  return blocks;
}

/** Empty chords are browser-draft placeholders; SongCandidateSchema still requires real degrees to publish. */
export function createManualLyricDraft(fields: ManualSongFields, lyricsText: string): ManualEditableCandidate {
  const parsed = parseAnnotatedLyrics(lyricsText);
  return {
    query: { title: fields.title, artist: fields.artist }, matched_song: { title: fields.title, artist: fields.artist, confidence: 1 },
    sources: [], warnings: parsed.warnings, uncertain_fields: [],
    song: {
      schema_version: 1, slug: fields.slug, title: fields.title, artist: fields.artist,
      credits: { lyrics: fields.lyricsCredit, music: fields.musicCredit }, original_key: fields.originalKey,
      degree_key: fields.degreeKey, capo: fields.capo, language: fields.language, tags: fields.tags,
      source: { type: "user_text", ...(fields.sourceReference ? { reference: fields.sourceReference } : {}) },
      copyright_status: fields.copyrightStatus, blocks: blocksFromParsed(parsed)
    }
  };
}
