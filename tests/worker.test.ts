import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../worker/index";

function createEnv(options: { deepseekKey?: string } = {}) {
  const fetch = vi.fn(async () => new Response("static app", { status: 200 }));
  const env: Env = {
    ASSETS: { fetch },
    ...(options.deepseekKey ? { DEEPSEEK_API_KEY: options.deepseekKey } : {})
  };
  return { env, fetch };
}

describe("Cloudflare Worker routes", () => {
  it("returns an unconfigured health response without exposing secrets", async () => {
    const { env, fetch } = createEnv();
    const response = await worker.fetch(
      new Request("https://guitare-songbook.workers.dev/api/health"),
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      deepseek_configured: false
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports only whether a key is configured", async () => {
    const { env } = createEnv({ deepseekKey: "test-only-placeholder" });
    const response = await worker.fetch(
      new Request("https://guitare-songbook.workers.dev/api/health"),
      env
    );
    const text = await response.text();

    expect(JSON.parse(text)).toEqual({
      status: "ok",
      deepseek_configured: true
    });
    expect(text).not.toContain("test-only-placeholder");
  });

  it("returns 501 JSON for other API routes", async () => {
    const { env, fetch } = createEnv();
    const response = await worker.fetch(
      new Request("https://guitare-songbook.workers.dev/api/songs", {
        method: "POST"
      }),
      env
    );

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ status: "not_implemented" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("delegates non-API requests to the static assets binding", async () => {
    const { env, fetch } = createEnv();
    const request = new Request(
      "https://guitare-songbook.workers.dev/song/chen-qizhen-lvxing-de-yiyi/"
    );
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("static app");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(request);
  });
});
