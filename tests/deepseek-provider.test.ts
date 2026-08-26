import { describe, expect, it, vi } from "vitest";
import { DeepSeekProvider } from "../worker/providers/deepseek";
import { LlmProviderError, LlmProviderTimeoutError } from "../worker/providers/llm-provider";
import { fictitiousSongCandidate } from "./fixtures/fictitious-song-candidate";

function event(type: string, extra: Record<string, unknown> = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
}

function responseFromChunks(chunks: Uint8Array[]) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

function responseFromText(value: string) {
  return responseFromChunks([new TextEncoder().encode(value)]);
}

function successfulSse(reasoning = "private reasoning") {
  const json = JSON.stringify(fictitiousSongCandidate);
  const midpoint = Math.floor(json.length / 2);
  return [
    event("response.created"),
    event("response.reasoning_text.delta", { delta: reasoning }),
    event("response.output_text.delta", { delta: json.slice(0, midpoint) }),
    event("response.output_text.delta", { delta: json.slice(midpoint) }),
    event("response.completed", {
      response: { usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }
    })
  ].join("");
}

function completedWithText(text: string, extraOutput: unknown[] = []) {
  return event("response.completed", {
    response: {
      status: "completed",
      output: [
        ...extraOutput,
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text }]
        }
      ]
    }
  });
}

function hangingResponse(signal: AbortSignal, initial = "") {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      if (initial) controller.enqueue(new TextEncoder().encode(initial));
      signal.addEventListener("abort", () =>
        controller.error(new DOMException("Aborted", "AbortError"))
      );
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

describe("DeepSeek semantic SSE provider with mocked fetch", () => {
  it("invokes fetch without binding the provider instance as receiver", async () => {
    let receiver: unknown = "not-called";
    const receiverSensitiveFetch = async function (
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit
    ) {
      receiver = this;
      if (this instanceof DeepSeekProvider) throw new TypeError("Illegal invocation");
      return responseFromText(successfulSse());
    } as typeof fetch;
    const provider = new DeepSeekProvider("test-only-key", { fetch: receiverSensitiveFetch });

    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).resolves.toMatchObject({
      song: { title: "星尘邮局" }
    });
    expect(receiver).not.toBe(provider);
  });

  it("uses streaming Responses API, forced web search, JSON Schema, and 8000 tokens", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      responseFromText(successfulSse())
    );
    const log = vi.fn();
    const provider = new DeepSeekProvider("test-only-key", { fetch: fetchMock, log });
    const result = await provider.generateSongCandidate(fictitiousSongCandidate.query);

    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(url).toBe("https://api.deepseek.com/responses");
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      stream: true,
      max_output_tokens: 8000,
      reasoning: { effort: "low" },
      tools: [{ type: "web_search" }],
      tool_choice: { type: "web_search" },
      text: { format: { type: "json_schema", name: "song_candidate" } }
    });
    expect(result).toMatchObject({
      song: { title: "星尘邮局" },
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
    });
    expect(JSON.stringify(result)).not.toContain("private reasoning");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private reasoning");
  });

  it("handles SSE frames split across arbitrary chunks", async () => {
    const bytes = new TextEncoder().encode(successfulSse());
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromChunks(chunks))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).resolves.toMatchObject({
      song: { title: "星尘邮局" }
    });
  });

  it("preserves UTF-8 characters split across byte chunks", async () => {
    const text = successfulSse();
    const bytes = new TextEncoder().encode(text);
    const chineseStart = bytes.findIndex((byte) => byte > 0x7f);
    const chunks = [bytes.slice(0, chineseStart + 1), bytes.slice(chineseStart + 1)];
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromChunks(chunks))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).resolves.toMatchObject({
      song: { title: "星尘邮局" }
    });
  });

  it("uses complete assistant output from response.completed when there are no deltas", async () => {
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(
        completedWithText(JSON.stringify(fictitiousSongCandidate), [
          { type: "reasoning", content: [{ type: "reasoning_text", text: "private" }] }
        ])
      )),
      log: vi.fn()
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).resolves.toMatchObject({
      song: { title: "星尘邮局" }
    });
  });

  it("prefers completed assistant output over accumulated deltas", async () => {
    const completedCandidate = structuredClone(fictitiousSongCandidate);
    completedCandidate.song.title = "完成事件版本";
    const stream = event("response.output_text.delta", {
      delta: JSON.stringify(fictitiousSongCandidate)
    }) + completedWithText(JSON.stringify(completedCandidate));
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(stream))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).resolves.toMatchObject({
      song: { title: "完成事件版本" }
    });
  });

  it("accepts a fully fenced JSON document", async () => {
    const fenced = `\n\`\`\`json\n${JSON.stringify(fictitiousSongCandidate)}\n\`\`\`\n`;
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(completedWithText(fenced)))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).resolves.toMatchObject({
      song: { title: "星尘邮局" }
    });
  });

  it("returns invalid_json without exposing invalid model text", async () => {
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(completedWithText("private invalid text")))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).rejects.toMatchObject({
      reason: "invalid_json",
      message: "LLM provider returned invalid output"
    });
  });

  it("returns no_output_text when completed has no assistant output_text", async () => {
    const stream = event("response.completed", {
      response: {
        status: "completed",
        output: [{
          type: "reasoning",
          status: "completed",
          content: [{ type: "reasoning_text", text: "must stay private" }]
        }]
      }
    });
    const log = vi.fn();
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(stream)),
      log
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).rejects.toMatchObject({
      reason: "no_output_text"
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("must stay private");
  });

  it.each([
    ["response.failed", "invalid_output"],
    ["response.incomplete", "invalid_output"]
  ])("rejects the %s terminal event", async (terminal, kind) => {
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(event(terminal)))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).rejects.toMatchObject({
      kind,
      reason: terminal === "response.failed" ? "response_failed" : "response_incomplete"
    });
  });

  it("rejects malformed semantic SSE", async () => {
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText("event: response.completed\ndata: {bad-json}\n\n"))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).rejects.toMatchObject({
      kind: "invalid_output",
      reason: "malformed_sse"
    });
  });

  it("enforces the 30-second idle timeout after valid events", async () => {
    const log = vi.fn();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      hangingResponse(init!.signal!, event("response.created"))
    );
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: fetchMock,
      timeoutMs: 1_000,
      idleTimeoutMs: 5,
      log
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" }))
      .rejects.toBeInstanceOf(LlmProviderTimeoutError);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "responses_generate",
      error: { name: "AbortError" }
    }));
  });

  it("enforces the 120-second total timeout independently of idle timeout", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      hangingResponse(init!.signal!)
    );
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: fetchMock,
      timeoutMs: 5,
      idleTimeoutMs: 1_000,
      log: vi.fn()
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" }))
      .rejects.toBeInstanceOf(LlmProviderTimeoutError);
  });

  it("preserves safe upstream metadata without retaining the raw body", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      error: {
        code: "insufficient_balance",
        type: "billing_error",
        message: "raw provider detail must not be retained"
      }
    }, { status: 402 }));
    const provider = new DeepSeekProvider("test-only-key", { fetch: fetchMock });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).rejects.toMatchObject({
      upstreamStatus: 402,
      providerErrorCode: "insufficient_balance",
      providerErrorType: "billing_error",
      message: "DeepSeek request failed"
    });
  });

  it("logs only the safe network error structure", async () => {
    const log = vi.fn();
    const networkError = Object.assign(new TypeError("secret network detail"), { code: "EHOSTUNREACH" });
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => { throw networkError; }),
      log
    });
    await expect(provider.generateSongCandidate({ title: "private user input" }))
      .rejects.toBeInstanceOf(LlmProviderError);
    expect(log).toHaveBeenCalledWith({
      event: "provider_fetch_error",
      endpoint: "responses_generate",
      elapsed_ms: expect.any(Number),
      error: { name: "TypeError", code: "EHOSTUNREACH" }
    });
    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).not.toContain("secret network detail");
    expect(serialized).not.toContain("private user input");
    expect(serialized).not.toContain("test-only-key");
  });
});
