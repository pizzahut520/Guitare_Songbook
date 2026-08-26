import { describe, expect, it, vi } from "vitest";
import { checkDeepSeekStatus } from "../worker/providers/deepseek";
import { LlmProviderError, LlmProviderTimeoutError } from "../worker/providers/llm-provider";
import { createWorker, type Env } from "../worker/index";

const baseUrl = "https://guitare-songbook.guitare-songbook.workers.dev";
const testKey = "test-only-key-never-return";
const allowedAccess = vi.fn(async () => ({
  ok: true as const,
  email: "owner@example.com"
}));

function env(): Env {
  return {
    ASSETS: { fetch: vi.fn() },
    CF_ACCESS_TEAM_DOMAIN: "https://songbook-test.cloudflareaccess.com",
    CF_ACCESS_AUD: "test-audience",
    ACCESS_ALLOWED_EMAIL: "owner@example.com",
    DEEPSEEK_API_KEY: testKey
  };
}

function statusRequest() {
  return new Request(`${baseUrl}/api/deepseek/status`);
}

describe("DeepSeek sanitized status probe with mocked fetch", () => {
  it("reports reachability, authentication, and model availability", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: [{ id: "deepseek-chat" }, { id: "deepseek-v4-flash" }] })
    );
    const result = await checkDeepSeekStatus(testKey, { fetch: fetchMock });

    expect(result).toEqual({
      status: "ok",
      reachable: true,
      authenticated: true,
      responses_model_available: true
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.com/models",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: `Bearer ${testKey}` },
        signal: expect.any(AbortSignal)
      })
    );
    expect(JSON.stringify(result)).not.toContain(testKey);
  });

  it.each([
    [401, "provider_auth_failed"],
    [402, "provider_billing_failed"],
    [403, "provider_forbidden"],
    [429, "provider_rate_limited"],
    [500, "provider_upstream_error"],
    [503, "provider_upstream_error"]
  ])("maps upstream HTTP %i to %s", async (status, expectedCode) => {
    const checkProviderStatus = vi.fn(async () => {
      throw new LlmProviderError("safe internal message", "upstream", status);
    });
    const worker = createWorker({ verifyAccess: allowedAccess, checkProviderStatus });
    const response = await worker.fetch(statusRequest(), env(), {});
    const text = await response.text();

    expect(JSON.parse(text)).toMatchObject({ error: { code: expectedCode } });
    expect(text).not.toContain(testKey);
  });

  it("maps a network failure to provider_unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("socket details that must stay internal");
    });
    await expect(checkDeepSeekStatus(testKey, { fetch: fetchMock })).rejects.toMatchObject({
      kind: "unreachable"
    });

    const worker = createWorker({
      verifyAccess: allowedAccess,
      checkProviderStatus: async () => {
        throw new LlmProviderError("internal network details", "unreachable");
      }
    });
    const response = await worker.fetch(statusRequest(), env(), {});
    expect(await response.json()).toMatchObject({ error: { code: "provider_unreachable" } });
  });

  it("maps the ten-second probe abort to provider_timeout", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
      })
    );
    await expect(
      checkDeepSeekStatus(testKey, { fetch: fetchMock, timeoutMs: 1 })
    ).rejects.toBeInstanceOf(LlmProviderTimeoutError);

    const worker = createWorker({
      verifyAccess: allowedAccess,
      checkProviderStatus: async () => {
        throw new LlmProviderTimeoutError();
      }
    });
    const response = await worker.fetch(statusRequest(), env(), {});
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: "provider_timeout" } });
  });

  it("keeps only safe standard error code and type metadata", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "invalid_api_key",
            type: "authentication_error",
            message: `raw response ${testKey}`
          }
        },
        { status: 401 }
      )
    );

    let error: unknown;
    try {
      await checkDeepSeekStatus(testKey, { fetch: fetchMock });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      upstreamStatus: 401,
      providerErrorCode: "invalid_api_key",
      providerErrorType: "authentication_error"
    });
    expect(JSON.stringify(error)).not.toContain(testKey);
  });

  it("does not call the probe when Access verification fails", async () => {
    const checkProviderStatus = vi.fn();
    const worker = createWorker({
      checkProviderStatus,
      verifyAccess: vi.fn(async () => ({
        ok: false as const,
        status: 401 as const,
        code: "access_required" as const,
        message: "需要 Cloudflare Access 身份验证"
      }))
    });
    const response = await worker.fetch(statusRequest(), env(), {});

    expect(response.status).toBe(401);
    expect(checkProviderStatus).not.toHaveBeenCalled();
  });
});
