import { z } from "zod";

const nonEmptyText = z.string().trim().min(1);

export const InstrumentBlockSchema = z.object({
  id: nonEmptyText,
  type: z.literal("instrument"),
  label: nonEmptyText,
  progression: nonEmptyText,
  repeat: z.string().trim().optional()
});

export const LyricBlockSchema = z
  .object({
    id: nonEmptyText,
    type: z.literal("lyric"),
    chords: z.array(z.string()).min(1),
    lyrics: z.array(z.string()).optional(),
    lyric_sets: z.array(z.array(z.string())).optional(),
    variant_labels: z.array(z.string()).optional(),
    widths: z.array(z.number().positive()).optional(),
    spacing: z.enum(["compact", "normal", "generous"]).default("normal")
  })
  .superRefine((block, context) => {
    if (!block.lyrics && !block.lyric_sets) {
      context.addIssue({
        code: "custom",
        message: "歌词块必须包含 lyrics 或 lyric_sets"
      });
      return;
    }

    if (block.lyrics && block.lyric_sets) {
      context.addIssue({
        code: "custom",
        message: "歌词块不能同时包含 lyrics 和 lyric_sets"
      });
    }

    if (block.lyrics && block.lyrics.length !== block.chords.length) {
      context.addIssue({
        code: "custom",
        message: "lyrics 与 chords 的分句数量必须一致"
      });
    }

    block.lyric_sets?.forEach((set, index) => {
      if (set.length !== block.chords.length) {
        context.addIssue({
          code: "custom",
          message: `lyric_sets[${index}] 与 chords 的分句数量必须一致`
        });
      }
    });

    if (
      block.variant_labels &&
      block.lyric_sets &&
      block.variant_labels.length !== block.lyric_sets.length
    ) {
      context.addIssue({
        code: "custom",
        message: "variant_labels 与 lyric_sets 的数量必须一致"
      });
    }

    if (block.widths && block.widths.length !== block.chords.length) {
      context.addIssue({
        code: "custom",
        message: "widths 与 chords 的分句数量必须一致"
      });
    }
  });

export const TheoryLegendBlockSchema = z.object({
  id: nonEmptyText,
  type: z.literal("theory_legend"),
  title: nonEmptyText.default("和弦结构（相对根音）"),
  items: z.array(
    z.object({
      quality: nonEmptyText,
      formula: nonEmptyText
    })
  ),
  note: z.string().trim().optional()
});

export const SongBlockSchema = z.discriminatedUnion("type", [
  InstrumentBlockSchema,
  LyricBlockSchema,
  TheoryLegendBlockSchema
]);

export const SongSchema = z.object({
  schema_version: z.literal(1),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: nonEmptyText,
  artist: nonEmptyText,
  credits: z.object({
    lyrics: nonEmptyText,
    music: nonEmptyText
  }),
  original_key: nonEmptyText,
  degree_key: nonEmptyText,
  capo: z.number().int().min(0).max(12),
  language: nonEmptyText,
  tags: z.array(nonEmptyText).default([]),
  source: z.object({
    type: z.enum(["user_document", "user_text", "public_domain", "licensed"]),
    reference: z.string().trim().optional()
  }),
  copyright_status: z.enum(["private_reference", "public_domain", "licensed"]),
  blocks: z.array(SongBlockSchema).min(1)
});

export type Song = z.infer<typeof SongSchema>;
export type SongBlock = z.infer<typeof SongBlockSchema>;
export type LyricBlock = z.infer<typeof LyricBlockSchema>;

