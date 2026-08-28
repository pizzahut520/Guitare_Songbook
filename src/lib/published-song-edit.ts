import { SongCandidateSchema, type SongCandidate } from "./song-candidate-schema";
import type { Song } from "./song-schema";

export function publishedSongToCandidate(song: Song, pageUrl: string): SongCandidate {
  const reference = song.source.reference;
  const sourceUrl = reference && /^https?:\/\//i.test(reference) ? reference : pageUrl;
  return SongCandidateSchema.parse({
    query: { title: song.title, artist: song.artist },
    matched_song: {
      title: song.title,
      artist: song.artist,
      edition: "已发布曲谱",
      confidence: 1
    },
    song,
    sources: [{ title: "当前已发布曲谱", url: sourceUrl, source_type: "reference" }],
    warnings: [],
    uncertain_fields: []
  });
}
