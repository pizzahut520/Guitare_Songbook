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
      "  test-github-token  ",
      "pizzahut520/Guitare_Songbook",
      "main",
      { fetch: fetchMock }
    );
    const result = await provider.createSong(song);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.headers).toMatchObject({
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer test-github-token",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "Guitare-Songbook-Worker/1.0"
      });
    }
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

  it.each<[number, GitHubProviderError["code"], GitHubProviderError["reason"]]>([
    [401, "github_auth_failed", "bad_credentials"],
    [409, "github_conflict", undefined],
    [422, "duplicate_song", undefined],
    [429, "github_rate_limited", "rate_limited"]
  ])("maps GitHub HTTP %i to %s", async (status, code, reason) => {
    const fetchMock = vi.fn(async () =>
      fetchMock.mock.calls.length === 1 ? response(404) : response(status)
    );
    const provider = new GitHubContentsProvider("test-token", "owner/repo", "main", {
      fetch: fetchMock
    });
    await expect(provider.createSong(song)).rejects.toEqual(
      expect.objectContaining<Partial<GitHubProviderError>>({ code, reason })
    );
  });

  it.each([
    ["User agent required", "github_auth_failed", "user_agent_required", {}],
    [
      "Resource not accessible by personal access token",
      "github_auth_failed",
      "insufficient_permissions",
      {}
    ],
    ["Protected branch update failed", "github_conflict", "branch_protected", {}],
    ["API rate limit exceeded", "github_rate_limited", "rate_limited", {
      "x-ratelimit-remaining": "0"
    }]
  ])("maps safe 403 reason for %s", async (message, code, reason, headers) => {
    const fetchMock = vi.fn(async () =>
      fetchMock.mock.calls.length === 1
        ? response(404)
        : Response.json({ message, sensitive_detail: "must not escape" }, { status: 403, headers })
    );
    const provider = new GitHubContentsProvider("test-token", "owner/repo", "main", {
      fetch: fetchMock
    });
    let caught: unknown;
    try {
      await provider.createSong(song);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code, reason });
    expect(JSON.stringify(caught)).not.toContain("must not escape");
    expect(JSON.stringify(caught)).not.toContain(message);
  });

  it("checks repository status with one read-only GET and exposes only push permission", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      permissions: { push: true, admin: false },
      private: true,
      sensitive_field: "must not escape"
    }));
    const provider = new GitHubContentsProvider(
      " test-token ",
      "pizzahut520/Guitare_Songbook",
      "main",
      { fetch: fetchMock }
    );
    const result = await provider.checkRepositoryStatus();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/pizzahut520/Guitare_Songbook",
      expect.objectContaining({ method: "GET" })
    );
    expect(result).toEqual({
      status: "ok",
      authenticated: true,
      repository_accessible: true,
      push_permission: true
    });
    expect(JSON.stringify(result)).not.toContain("test-token");
    expect(JSON.stringify(result)).not.toContain("must not escape");
  });
});
