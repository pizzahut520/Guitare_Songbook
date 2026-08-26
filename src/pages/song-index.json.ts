import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { normalizeSongIdentity } from "../lib/song-index";

export const prerender = true;

export const GET: APIRoute = async () => {
  const songs = await getCollection("songs");
  const index = songs.map(({ data }) => ({
    slug: data.slug,
    title: data.title,
    artist: data.artist,
    url: `/song/${data.slug}/`,
    normalized_title: normalizeSongIdentity(data.title),
    normalized_artist: normalizeSongIdentity(data.artist)
  }));
  return Response.json(index, {
    headers: { "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" }
  });
};
