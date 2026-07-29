import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { SongSchema } from "./lib/song-schema";

const songs = defineCollection({
  loader: glob({ pattern: "**/*.json", base: "./src/content/songs" }),
  schema: SongSchema
});

export const collections = { songs };

