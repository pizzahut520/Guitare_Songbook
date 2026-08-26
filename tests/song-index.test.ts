import { describe, expect, it } from "vitest";
import travel from "../src/content/songs/chen-qizhen-lvxing-de-yiyi.json";
import { findDuplicateSong, normalizeSongIdentity } from "../src/lib/song-index";

describe("lyric-free song duplicate index", () => {
  const existing = [{
    slug: travel.slug,
    title: travel.title,
    artist: travel.artist,
    url: `/song/${travel.slug}/`,
    normalized_title: normalizeSongIdentity(travel.title),
    normalized_artist: normalizeSongIdentity(travel.artist)
  }];

  it("recognizes the golden 旅行的意义 song by normalized title and artist", () => {
    expect(findDuplicateSong(existing, {
      slug: "different-slug",
      title: " 旅行・的 意义 ",
      artist: "陈 绮贞"
    })).toEqual(existing[0]);
  });

  it("recognizes a duplicate slug and ignores unrelated songs", () => {
    expect(findDuplicateSong(existing, {
      slug: travel.slug,
      title: "其他歌曲",
      artist: "其他歌手"
    })).toEqual(existing[0]);
    expect(findDuplicateSong(existing, {
      slug: "new-song",
      title: "新歌",
      artist: "新歌手"
    })).toBeUndefined();
  });
});
