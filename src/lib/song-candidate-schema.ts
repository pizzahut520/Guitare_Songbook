import { z } from "zod";
import { SongSchema } from "./song-schema";

const nonEmptyText = z.string().trim().min(1);

export const SongQuerySchema = z.object({
  title: nonEmptyText.max(100),
  artist: nonEmptyText.max(100).optional()
});

export const CandidateSourceSchema = z.object({
  title: nonEmptyText.max(300),
  url: z.url().refine((url) => url.startsWith("https://") || url.startsWith("http://"), {
    message: "来源必须使用 http(s) URL"
  }),
  source_type: z.enum(["metadata", "lyrics", "chords", "reference", "other"])
});

export const CandidateUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative()
});

const WebSearchSongSchema = SongSchema.extend({
  source: SongSchema.shape.source.extend({
    type: z.literal("web_search")
  }),
  copyright_status: z.literal("private_reference")
});

const candidateShape = {
  query: SongQuerySchema,
  matched_song: z.object({
    title: nonEmptyText.max(200),
    artist: nonEmptyText.max(200),
    version: nonEmptyText.max(200).optional(),
    edition: nonEmptyText.max(200).optional(),
    confidence: z.number().min(0).max(1)
  }),
  song: WebSearchSongSchema,
  sources: z.array(CandidateSourceSchema).min(1).max(12),
  warnings: z.array(nonEmptyText.max(500)).max(30),
  uncertain_fields: z.array(nonEmptyText.max(200)).max(50)
};

export const SongCandidateOutputSchema = z.object(candidateShape);

export const SongCandidateSchema = z.object({
  ...candidateShape,
  usage: CandidateUsageSchema.optional()
});

export type SongQuery = z.infer<typeof SongQuerySchema>;
export type SongCandidate = z.infer<typeof SongCandidateSchema>;
