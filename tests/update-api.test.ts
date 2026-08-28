import { describe, expect, it, vi } from "vitest";
import { createWorker, type Env } from "../worker/index";
import { SongSchema } from "../src/lib/song-schema";
import { publishedSongToCandidate } from "../src/lib/published-song-edit";
import { fictitiousSongCandidate } from "./fixtures/fictitious-song-candidate";

const baseUrl = "https://guitare-songbook.guitare-songbook.workers.dev";
const sha = "abcdef1234567";
const allowedAccess = vi.fn(async () => ({ ok: true as const, email: "owner@example.com" }));
const song = SongSchema.parse({
  ...structuredClone(fictitiousSongCandidate.song),
  source: { type: "user_text", reference: "本地参考" }
});

function env(): Env {
  return {
    ASSETS: { fetch: vi.fn(async () => new Response("static")) },
    CF_ACCESS_TEAM_DOMAIN: "https://songbook-test.cloudflareaccess.com",
    CF_ACCESS_AUD: "test-audience",
    ACCESS_ALLOWED_EMAIL: "owner@example.com",
    GITHUB_TOKEN: "test-only-github-token"
  };
}

function updateRequest(payload: unknown) {
  return new Request(`${baseUrl}/api/songs/update`, {
    method: "POST",
    headers: { origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

function candidate() {
  return publishedSongToCandidate(song, `${baseUrl}/song/${song.slug}/`);
}

describe("safe published-song editing API", () => {
  it("loads the trusted song revision without creating a DeepSeek provider", async () => {
    const getSongRevision = vi.fn(async () => ({ song, sha }));
    const updateSong = vi.fn();
    const createProvider = vi.fn();
    const worker = createWorker({
      verifyAccess: allowedAccess,
      createProvider,
      createGitHubProvider: () => ({
        getSongRevision,
        updateSong,
        createSong: vi.fn(),
        checkRepositoryStatus: vi.fn()
      })
    });

    const response = await worker.fetch(
      new Request(`${baseUrl}/api/songs/${song.slug}/edit`),
      env(),
      {}
    );
    const body = await response.json() as { candidate: ReturnType<typeof candidate>; expected_sha: string };

    expect(response.status).toBe(200);
    expect(body.candidate.song).toEqual(song);
    expect(body.expected_sha).toBe(sha);
    expect(getSongRevision).toHaveBeenCalledWith(song.slug);
    expect(updateSong).not.toHaveBeenCalled();
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("updates with the edited full candidate but sends only candidate.song to GitHub", async () => {
    const edited = candidate();
    edited.song.blocks[0] = {
      ...edited.song.blocks[0],
      type: "lyric",
      chords: ["4"],
      lyrics: ["仅用于测试的编辑文本"],
      spacing: "generous"
    };
    const getSongRevision = vi.fn(async () => ({ song, sha }));
    const updateSong = vi.fn(async () => ({
      commit_sha: "fedcba7654321",
      commit_url: "https://github.com/owner/repo/commit/fedcba7654321",
      song_path: `src/content/songs/${song.slug}.json`,
      deployment_pending: true as const
    }));
    const createProvider = vi.fn();
    const worker = createWorker({
      verifyAccess: allowedAccess,
      createProvider,
      createGitHubProvider: () => ({
        getSongRevision,
        updateSong,
        createSong: vi.fn(),
        checkRepositoryStatus: vi.fn()
      })
    });

    const response = await worker.fetch(updateRequest({
      candidate: edited,
      song_id: song.slug,
      expected_sha: sha,
      confirmed: true
    }), env(), {});

    expect(response.status).toBe(200);
    expect(updateSong).toHaveBeenCalledOnce();
    expect(updateSong).toHaveBeenCalledWith(edited.song, sha);
    expect(JSON.stringify(updateSong.mock.calls)).not.toContain("uncertain_fields");
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("does not overwrite when the expected GitHub SHA is stale", async () => {
    const updateSong = vi.fn();
    const worker = createWorker({
      verifyAccess: allowedAccess,
      createGitHubProvider: () => ({
        getSongRevision: vi.fn(async () => ({ song, sha: "fedcba7654321" })),
        updateSong,
        createSong: vi.fn(),
        checkRepositoryStatus: vi.fn()
      })
    });

    const response = await worker.fetch(updateRequest({
      candidate: candidate(), song_id: song.slug, expected_sha: sha, confirmed: true
    }), env(), {});

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "github_conflict" } });
    expect(updateSong).not.toHaveBeenCalled();
  });

  it("rejects client paths and immutable identity changes before any GitHub write", async () => {
    const updateSong = vi.fn();
    const createGitHubProvider = vi.fn(() => ({
      getSongRevision: vi.fn(async () => ({ song, sha })),
      updateSong,
      createSong: vi.fn(),
      checkRepositoryStatus: vi.fn()
    }));
    const worker = createWorker({ verifyAccess: allowedAccess, createGitHubProvider });
    const injected = await worker.fetch(updateRequest({
      candidate: candidate(), song_id: song.slug, expected_sha: sha, confirmed: true,
      path: "../../secrets", repository: "attacker/repo"
    }), env(), {});
    const renamed = candidate();
    renamed.song.title = "另一个标题";
    const identityChange = await worker.fetch(updateRequest({
      candidate: renamed, song_id: song.slug, expected_sha: sha, confirmed: true
    }), env(), {});

    expect(injected.status).toBe(400);
    expect(identityChange.status).toBe(400);
    expect(updateSong).not.toHaveBeenCalled();
  });

  it("rejects invalid repeat and degree structures without leaking lyrics", async () => {
    const invalid = candidate() as ReturnType<typeof candidate> & { song: { blocks: unknown[] } };
    invalid.song.blocks.push({ id: "bad-repeat", type: "repeat", ref: "missing", times: 1 });
    const createGitHubProvider = vi.fn();
    const response = await createWorker({ verifyAccess: allowedAccess, createGitHubProvider }).fetch(
      updateRequest({ candidate: invalid, song_id: song.slug, expected_sha: sha, confirmed: true }),
      env(),
      {}
    );
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(text).toContain("invalid_candidate");
    expect(text).not.toContain("仅用于测试");
    expect(text).not.toContain("candidate\":");
    expect(createGitHubProvider).not.toHaveBeenCalled();
  });
});
