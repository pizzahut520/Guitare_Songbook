import { z } from "zod";

export const SongIndexEntrySchema = z.object({
  slug: z.string(),
  title: z.string(),
  artist: z.string(),
  url: z.string(),
  normalized_title: z.string(),
  normalized_artist: z.string()
});

export const SongIndexSchema = z.array(SongIndexEntrySchema);
export type SongIndexEntry = z.infer<typeof SongIndexEntrySchema>;

export function normalizeSongIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

export function findDuplicateSong(
  songs: SongIndexEntry[],
  candidate: { slug: string; title: string; artist: string }
): SongIndexEntry | undefined {
  const normalizedTitle = normalizeSongIdentity(candidate.title);
  const normalizedArtist = normalizeSongIdentity(candidate.artist);
  return songs.find((song) =>
    song.slug === candidate.slug ||
    (song.normalized_title === normalizedTitle && song.normalized_artist === normalizedArtist)
  );
}
