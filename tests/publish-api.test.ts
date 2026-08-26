import { describe, expect, it, vi } from "vitest";
import { normalizeSongIdentity, type SongIndexEntry } from "../src/lib/song-index";
import { createWorker, type Env } from "../worker/index";
import { fictitiousSongCandidate } from "./fixtures/fictitious-song-candidate";

const baseUrl = "https://guitare-songbook.guitare-songbook.workers.dev";
const allowedAccess = vi.fn(async () => ({ ok: true as const, email: "owner@example.com" }));

function env(index: SongIndexEntry[] = [], withToken = true): Env {
  return {
    ASSETS: { fetch: vi.fn(async () => Response.json(index)) },
    CF_ACCESS_TEAM_DOMAIN: "https://songbook-test.cloudflareaccess.com",
    CF_ACCESS_AUD: "test-audience",
    ACCESS_ALLOWED_EMAIL: "owner@example.com",
    ...(withToken ? { GITHUB_TOKEN: "test-only-github-token" } : {})
  };
}

function request(body: unknown) {
  return new Request(`${baseUrl}/api/songs/publish`, {
    method: "POST",
    headers: { origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("secure song publish API", () => {
  it("returns github_not_configured before accepting a publish", async () => {
    const response = await createWorker({ verifyAccess: allowedAccess }).fetch(
      request({ candidate: fictitiousSongCandidate, confirmed: true }),
      env([], false),
      {}
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "github_not_configured" } });
  });

  it("rejects an unconfirmed candidate and client-controlled paths", async () => {
    const createGitHubProvider = vi.fn();
    const worker = createWorker({ verifyAccess: allowedAccess, createGitHubProvider });
    const unconfirmed = await worker.fetch(
      request({ candidate: fictitiousSongCandidate, confirmed: false }), env(), {}
    );
    const injectedPath = await worker.fetch(
      request({
        candidate: fictitiousSongCandidate,
        confirmed: true,
        repository: "attacker/repo",
        branch: "evil",
        path: "../../secret"
      }),
      env(),
      {}
    );
    expect(unconfirmed.status).toBe(400);
    expect(injectedPath.status).toBe(400);
    expect(await injectedPath.json()).toMatchObject({ error: { code: "invalid_candidate" } });
    expect(createGitHubProvider).not.toHaveBeenCalled();
  });

  it("rejects Roman degrees before any GitHub request and returns only paths", async () => {
    const candidate = structuredClone(fictitiousSongCandidate);
    candidate.song.blocks[0].chords[0] = "IV";
    const createGitHubProvider = vi.fn();
    const response = await createWorker({ verifyAccess: allowedAccess, createGitHubProvider })
      .fetch(request({ candidate, confirmed: true }), env(), {});
    const body = await response.json() as {
      error: { code: string; issues: Array<{ path: string }> }
    };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_degree_notation");
    expect(body.error.issues).toMatchObject([{ path: "candidate.song.blocks.0.chords.0" }]);
    expect(JSON.stringify(body)).not.toContain("虚构歌词");
    expect(JSON.stringify(body)).not.toContain("IV");
    expect(createGitHubProvider).not.toHaveBeenCalled();
  });

  it("rejects invalid repeat references with safe field paths", async () => {
    const candidate = structuredClone(fictitiousSongCandidate) as unknown as {
      song: { blocks: unknown[] }
    };
    candidate.song.blocks.push({ id: "bad-repeat", type: "repeat", ref: "missing", times: 1 });
    const createGitHubProvider = vi.fn();
    const response = await createWorker({ verifyAccess: allowedAccess, createGitHubProvider })
      .fetch(request({ candidate, confirmed: true }), env(), {});
    const body = await response.json() as {
      error: { code: string; issues: Array<{ path: string }> }
    };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_candidate");
    expect(body.error.issues).toMatchObject([{ path: "candidate.song.blocks.1.ref" }]);
    expect(JSON.stringify(body)).not.toContain("虚构句子");
    expect(createGitHubProvider).not.toHaveBeenCalled();
  });

  it("recognizes 旅行的意义 as duplicate before calling GitHub", async () => {
    const candidate = structuredClone(fictitiousSongCandidate);
    candidate.song.slug = "new-but-equivalent-slug";
    candidate.song.title = "旅行的意义";
    candidate.song.artist = "陈绮贞";
    const existing = [{
      slug: "chen-qizhen-lvxing-de-yiyi",
      title: "旅行的意义",
      artist: "陈绮贞",
      url: "/song/chen-qizhen-lvxing-de-yiyi/",
      normalized_title: normalizeSongIdentity("旅行的意义"),
      normalized_artist: normalizeSongIdentity("陈绮贞")
    }];
    const createGitHubProvider = vi.fn();
    const response = await createWorker({ verifyAccess: allowedAccess, createGitHubProvider })
      .fetch(request({ candidate, confirmed: true }), env(existing), {});

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "duplicate_song",
        existing_song: { url: "/song/chen-qizhen-lvxing-de-yiyi/" }
      }
    });
    expect(createGitHubProvider).not.toHaveBeenCalled();
  });

  it("validates twice and sends only candidate.song to the default repository and branch", async () => {
    const editedCandidate = structuredClone(fictitiousSongCandidate);
    editedCandidate.song.blocks[0].chords[0] = "4   5";
    editedCandidate.song.blocks[0].lyrics[0] = "编辑后的虚构句子";
    const createSong = vi.fn(async () => ({
      commit_sha: "abc1234def5678",
      commit_url: "https://github.com/pizzahut520/Guitare_Songbook/commit/abc1234def5678",
      song_path: "src/content/songs/fictitious-stardust-post-office.json",
      deployment_pending: true as const
    }));
    const createGitHubProvider = vi.fn(() => ({
      createSong,
      checkRepositoryStatus: vi.fn()
    }));
    const response = await createWorker({ verifyAccess: allowedAccess, createGitHubProvider })
      .fetch(request({ candidate: editedCandidate, confirmed: true }), env(), {});

    expect(response.status).toBe(201);
    expect(createGitHubProvider).toHaveBeenCalledWith(
      "test-only-github-token",
      "pizzahut520/Guitare_Songbook",
      "main"
    );
    expect(createSong).toHaveBeenCalledWith(editedCandidate.song);
    expect(JSON.stringify(createSong.mock.calls)).not.toContain("warnings");
    expect(JSON.stringify(await response.json())).not.toContain("test-only-github-token");
  });

  it("checks repository status without writing and never exposes the token", async () => {
    const createSong = vi.fn();
    const checkRepositoryStatus = vi.fn(async () => ({
      status: "ok" as const,
      authenticated: true as const,
      repository_accessible: true as const,
      push_permission: true
    }));
    const createGitHubProvider = vi.fn(() => ({ createSong, checkRepositoryStatus }));
    const statusEnv = env();
    statusEnv.GITHUB_TOKEN = "  test-only-github-token  ";

    const response = await createWorker({ verifyAccess: allowedAccess, createGitHubProvider }).fetch(
      new Request(`${baseUrl}/api/github/status`),
      statusEnv,
      {}
    );

    expect(response.status).toBe(200);
    expect(createGitHubProvider).toHaveBeenCalledWith(
      "test-only-github-token",
      "pizzahut520/Guitare_Songbook",
      "main"
    );
    expect(checkRepositoryStatus).toHaveBeenCalledOnce();
    expect(createSong).not.toHaveBeenCalled();
    const body = JSON.stringify(await response.json());
    expect(body).toContain('"push_permission":true');
    expect(body).not.toContain("test-only-github-token");
  });

  it("protects repository status with Access before creating a GitHub provider", async () => {
    const createGitHubProvider = vi.fn();
    const response = await createWorker({
      verifyAccess: vi.fn(async () => ({
        ok: false as const,
        status: 401 as const,
        code: "access_required" as const,
        message: "Access required"
      })),
      createGitHubProvider
    }).fetch(new Request(`${baseUrl}/api/github/status`), env(), {});

    expect(response.status).toBe(401);
    expect(createGitHubProvider).not.toHaveBeenCalled();
  });
});
