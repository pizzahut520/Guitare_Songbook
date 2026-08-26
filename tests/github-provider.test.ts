import { describe, expect, it, vi } from "vitest";
import { GitHubContentsProvider, GitHubProviderError } from "../worker/providers/github";
import { SongSchema } from "../src/lib/song-schema";
import { fictitiousSongCandidate } from "./fixtures/fictitious-song-candidate";

function response(status: number, body: unknown = {}) {
  return Response.json(body, { status });
}

describe("GitHub Contents provider with mocked fetch", () => {
  const song = SongSchema.parse(fictitiousSongCandidate.song);
  it("creates only the fixed song path without a sha overwrite field", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      fetchMock.mock.calls.length === 1
        ? response(404)
        : response(201, {
            commit: {
              sha: "abc1234def5678",
              html_url: "https://github.com/pizzahut520/Guitare_Songbook/commit/abc1234def5678"
            }
          })
    );
    const provider = new GitHubContentsProvider(
      "test-github-token",
      "pizzahut520/Guitare_Songbook",
      "main",
      { fetch: fetchMock }
    );
    const result = await provider.createSong(song);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/contents/src/content/songs/xugou-yuedui-xingchen-youju.json?ref=main"
    );
    const [putUrl, putInit] = fetchMock.mock.calls[1];
    expect(String(putUrl)).toContain(
      "/contents/src/content/songs/xugou-yuedui-xingchen-youju.json"
    );
    const body = JSON.parse(String(putInit?.body));
    expect(body).not.toHaveProperty("sha");
    expect(body.message).toBe("feat(songbook): add 虚构乐队 - 星尘邮局");
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0)))))
      .toEqual(song);
    expect(result).toEqual({
      commit_sha: "abc1234def5678",
      commit_url: "https://github.com/pizzahut520/Guitare_Songbook/commit/abc1234def5678",
      song_path: "src/content/songs/xugou-yuedui-xingchen-youju.json",
      deployment_pending: true
    });
    expect(JSON.stringify(result)).not.toContain("test-github-token");
  });

  it("does not PUT when the target path already exists", async () => {
    const fetchMock = vi.fn(async () => response(200));
    const provider = new GitHubContentsProvider("test-token", "owner/repo", "main", {
      fetch: fetchMock
    });
    await expect(provider.createSong(song)).rejects.toMatchObject({
      code: "duplicate_song"
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each<[number, GitHubProviderError["code"]]>([
    [401, "github_auth_failed"],
    [409, "github_conflict"],
    [422, "duplicate_song"],
    [429, "github_rate_limited"]
  ])("maps GitHub HTTP %i to %s", async (status, code) => {
    const fetchMock = vi.fn(async () =>
      fetchMock.mock.calls.length === 1 ? response(404) : response(status)
    );
    const provider = new GitHubContentsProvider("test-token", "owner/repo", "main", {
      fetch: fetchMock
    });
    await expect(provider.createSong(song)).rejects.toEqual(
      expect.objectContaining<Partial<GitHubProviderError>>({ code })
    );
  });
});
