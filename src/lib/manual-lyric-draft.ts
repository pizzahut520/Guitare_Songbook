import type { SongCandidate } from "./song-candidate-schema";
import type { EditableSong } from "./candidate-editor";

export interface ManualSongFields {
  title: string;
  artist: string;
  slug: string;
  lyricsCredit: string;
  musicCredit: string;
  originalKey: string;
  degreeKey: string;
  capo: number;
  language: string;
  tags: string[];
  sourceReference?: string;
  copyrightStatus: "private_reference" | "public_domain" | "licensed";
}

export type ManualEditableCandidate = Omit<SongCandidate, "song"> & { song: EditableSong };

/** Converts pasted user text without inferring musical structure. Empty chord
 * strings are draft-only placeholders; SongCandidateSchema requires real
 * degree expressions before publishing. */
export function createManualLyricDraft(fields: ManualSongFields, lyricsText: string): ManualEditableCandidate {
  const lines = lyricsText.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && /^[ \t]*$/.test(lines[0])) lines.shift();
  while (lines.length && /^[ \t]*$/.test(lines.at(-1) ?? "")) lines.pop();
  if (!lines.some((line) => !/^[ \t]*$/.test(line))) throw new Error("manual_lyrics_required");

  const groups: string[] = [];
  let group: string[] = [];
  for (const line of lines) {
    if (/^[ \t]*$/.test(line)) {
      if (group.length) group.push(line);
      continue;
    }
    if (group.length && /^[ \t]*$/.test(group.at(-1) ?? "")) {
      groups.push(group.join("\n"));
      group = [];
    }
    group.push(line);
  }
  if (group.length) groups.push(group.join("\n"));

  return {
    query: { title: fields.title, artist: fields.artist },
    matched_song: { title: fields.title, artist: fields.artist, confidence: 1 },
    sources: [], warnings: [], uncertain_fields: [],
    song: {
      schema_version: 1, slug: fields.slug, title: fields.title, artist: fields.artist,
      credits: { lyrics: fields.lyricsCredit, music: fields.musicCredit },
      original_key: fields.originalKey, degree_key: fields.degreeKey, capo: fields.capo,
      language: fields.language, tags: fields.tags,
      source: { type: "user_text", ...(fields.sourceReference ? { reference: fields.sourceReference } : {}) },
      copyright_status: fields.copyrightStatus,
      blocks: groups.map((lyrics, index) => ({
        id: `section-${index + 1}`, type: "lyric" as const, chords: [""], lyrics: [lyrics],
        section_role: "other" as const, section_label: `段落 ${index + 1}`, spacing: "normal" as const
      }))
    }
  };
}
