import { describe, expect, it, vi } from "vitest";
import { LlmProviderError, LlmProviderTimeoutError } from "../worker/providers/llm-provider";
import { createWorker, type Env } from "../worker/index";
import { fictitiousSongCandidate } from "./fixtures/fictitious-song-candidate";

const baseUrl = "https://guitare-songbook.guitare-songbook.workers.dev";
const allowedAccess = vi.fn(async () => ({
  ok: true as const,
  email: "owner@example.com"
}));

function createEnv(deepseekKey?: string) {
  const fetch = vi.fn(async () => new Response("static app", { status: 200 }));
  const env: Env = {
    ASSETS: { fetch },
    CF_ACCESS_TEAM_DOMAIN: "https://songbook-test.cloudflareaccess.com",
    CF_ACCESS_AUD: "test-audience",
    ACCESS_ALLOWED_EMAIL: "owner@example.com",
    ...(deepseekKey ? { DEEPSEEK_API_KEY: deepseekKey } : {})
  };
  return { env, fetch };
}

function generateRequest(
  body: unknown = { title: "星尘邮局", artist: "虚构乐队" },
  origin = baseUrl
) {
  return new Request(`${baseUrl}/api/songs/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body)
  });
}

function workerReturning(value: unknown) {
  return createWorker({
    createProvider: () => ({
      generateSongCandidate: vi.fn(async () => value)
    }),
    verifyAccess: allowedAccess
  });
}

describe("Cloudflare Worker security and routes", () => {
  it("returns 401 for an unauthenticated API request", async () => {
    const { env } = createEnv();
    const response = await createWorker().fetch(
      new Request(`${baseUrl}/api/health`),
      env,
      {}
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "access_required" } });
  });

  it("keeps the authenticated health route working", async () => {
    const { env } = createEnv();
    const response = await workerReturning(fictitiousSongCandidate).fetch(
      new Request(`${baseUrl}/api/health`),
      env,
      {}
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      deepseek_configured: false,
      github_configured: false
    });
  });

  it("returns 503 when the provider secret is not configured", async () => {
    const { env } = createEnv();
    const response = await workerReturning(fictitiousSongCandidate).fetch(
      generateRequest(),
      env,
      {}
    );

    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("DEEPSEEK_API_KEY");
  });

  it("rejects a cross-origin POST with 403", async () => {
    const { env } = createEnv("test-only-key");
    const response = await workerReturning(fictitiousSongCandidate).fetch(
      generateRequest(undefined, "https://attacker.example"),
      env,
      {}
    );

    expect(response.status).toBe(403);
  });

  it("rejects invalid input and non-JSON content", async () => {
    const { env } = createEnv("test-only-key");
    const worker = workerReturning(fictitiousSongCandidate);
    const invalidInput = await worker.fetch(
      generateRequest({ title: "" }),
      env,
      {}
    );
    const wrongType = await worker.fetch(
      new Request(`${baseUrl}/api/songs/generate`, {
        method: "POST",
        headers: { origin: baseUrl, "content-type": "text/plain" },
        body: "not json"
      }),
      env,
      {}
    );

    expect(invalidInput.status).toBe(400);
    expect(wrongType.status).toBe(400);
  });

  it("rejects oversized request bodies", async () => {
    const { env } = createEnv("test-only-key");
    const response = await workerReturning(fictitiousSongCandidate).fetch(
      generateRequest({ title: "虚".repeat(2_100) }),
      env,
      {}
    );

    expect(response.status).toBe(400);
  });

  it("returns a valid mock candidate and never exposes the API key", async () => {
    const apiKey = "test-only-secret-never-return";
    const { env } = createEnv(apiKey);
    const response = await workerReturning({
      ...fictitiousSongCandidate,
      usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 }
    }).fetch(generateRequest(), env, {});
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text).song.title).toBe("星尘邮局");
    expect(text).not.toContain(apiKey);
  });

  it("returns 502 for invalid JSON/provider errors", async () => {
    const { env } = createEnv("test-only-key");
    const worker = createWorker({
      createProvider: () => ({
        generateSongCandidate: vi.fn(async () => {
          throw new LlmProviderError("invalid JSON", "invalid_output");
        })
      }),
      verifyAccess: allowedAccess
    });
    const response = await worker.fetch(generateRequest(), env, {});

    expect(response.status).toBe(502);
  });

  it("returns 502 when the generated song fails SongSchema", async () => {
    const { env } = createEnv("test-only-key");
    const invalidCandidate = structuredClone(fictitiousSongCandidate);
    invalidCandidate.song.blocks[0].chords = ["1", "5"];
    const response = await workerReturning(invalidCandidate).fetch(
      generateRequest(),
      env,
      {}
    );

    expect(response.status).toBe(502);
    const body = await response.json() as {
      error: { reason?: string; issues?: Array<{ path: string; code: string }> }
    };
    expect(body.error.reason).toBe("candidate_schema_failed");
    expect(body.error.issues).toEqual([
      { path: "song.blocks.0", code: "custom" }
    ]);
    expect(JSON.stringify(body)).not.toContain("虚构歌词");
  });

  it("returns 504 when the provider times out", async () => {
    const { env } = createEnv("test-only-key");
    const worker = createWorker({
      createProvider: () => ({
        generateSongCandidate: vi.fn(async () => {
          throw new LlmProviderTimeoutError();
        })
      }),
      verifyAccess: allowedAccess
    });
    const response = await worker.fetch(generateRequest(), env, {});

    expect(response.status).toBe(504);
  });

  it("delegates original static pages without Access context", async () => {
    const { env, fetch } = createEnv();
    const request = new Request(`${baseUrl}/song/chen-qizhen-lvxing-de-yiyi/`);
    const response = await workerReturning(fictitiousSongCandidate).fetch(request, env, {});

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("static app");
    expect(fetch).toHaveBeenCalledWith(request);
  });

  it("never creates or calls the DeepSeek provider when Access verification fails", async () => {
    const { env } = createEnv("test-only-key");
    const generateSongCandidate = vi.fn();
    const createProvider = vi.fn(() => ({ generateSongCandidate }));
    const worker = createWorker({
      createProvider,
      verifyAccess: vi.fn(async () => ({
        ok: false as const,
        status: 401 as const,
        code: "invalid_access_token" as const,
        message: "Access 身份令牌无效"
      }))
    });
    const response = await worker.fetch(generateRequest(), env, {});

    expect(response.status).toBe(401);
    expect(createProvider).not.toHaveBeenCalled();
    expect(generateSongCandidate).not.toHaveBeenCalled();
  });
});
