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

  it("uses deterministic streaming Responses API settings and calls fetch once", async () => {
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
      max_output_tokens: 32000,
      reasoning: { effort: "none" },
      temperature: 0,
      tools: [{ type: "web_search" }],
      tool_choice: { type: "web_search" },
      text: { format: { type: "json_schema", name: "song_candidate" } }
    });
    expect(body.instructions).toContain("Never use Roman numerals.");
    expect(body.instructions).toContain("Never put absolute chord names in degree fields.");
    expect(body.instructions).toContain("Use Arabic scale degrees only.");
    expect(body.instructions).toContain(
      "Keep the JSON concise; do not repeat identical lyric sections. Use RepeatBlock for exact repetitions."
    );
    expect(result).toMatchObject({
      song: { title: "星尘邮局" },
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
    });
    expect(JSON.stringify(result)).not.toContain("private reasoning");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private reasoning");
    expect(fetchMock).toHaveBeenCalledOnce();
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

  it("joins every output_text part in the last completed assistant message", async () => {
    const json = JSON.stringify(fictitiousSongCandidate);
    const midpoint = Math.floor(json.length / 2);
    const stream = event("response.completed", {
      response: {
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: json.slice(0, midpoint) },
            { type: "reasoning_text", text: "private reasoning" },
            { type: "output_text", text: json.slice(midpoint) }
          ]
        }]
      }
    });
    const log = vi.fn();
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(stream)),
      log
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).resolves.toMatchObject({
      song: { title: "星尘邮局" }
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private reasoning");
  });

  it("uses complete JSON from response.output_text.done", async () => {
    const stream = event("response.output_text.done", {
      text: JSON.stringify(fictitiousSongCandidate)
    }) + event("response.completed", { response: { status: "completed" } });
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(stream))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).resolves.toMatchObject({
      song: { title: "星尘邮局" }
    });
  });

  it("falls back to valid deltas when completed assistant JSON is invalid", async () => {
    const stream = event("response.output_text.delta", {
      delta: JSON.stringify(fictitiousSongCandidate)
    }) + completedWithText("not json");
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(stream))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).resolves.toMatchObject({
      song: { title: "星尘邮局" }
    });
  });

  it("selects the last completed assistant message", async () => {
    const last = structuredClone(fictitiousSongCandidate);
    last.song.title = "最后版本";
    const stream = event("response.completed", {
      response: {
        status: "completed",
        output: [
          {
            type: "message", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: JSON.stringify(fictitiousSongCandidate) }]
          },
          {
            type: "message", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: JSON.stringify(last) }]
          }
        ]
      }
    });
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(stream))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).resolves.toMatchObject({
      song: { title: "最后版本" }
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

  it("accepts a UTF-8 BOM before an otherwise valid JSON document", async () => {
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(
        completedWithText(`\uFEFF${JSON.stringify(fictitiousSongCandidate)}`)
      ))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).resolves.toMatchObject({
      song: { title: "星尘邮局" }
    });
  });

  it("repairs trailing commas without changing candidate fields", async () => {
    const broken = JSON.stringify(fictitiousSongCandidate).replace(/}$/, ",}");
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(completedWithText(broken)))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).resolves.toEqual(
      fictitiousSongCandidate
    );
  });

  it("repairs an unescaped newline inside a JSON string", async () => {
    const broken = JSON.stringify(fictitiousSongCandidate)
      .replace("虚构句子一 虚构句子二", "虚构句子一\n虚构句子二");
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(completedWithText(broken)))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).resolves.toMatchObject({
      song: { blocks: [{ lyrics: ["虚构句子一\n虚构句子二"] }] }
    });
  });

  it("repairs safely missing terminal JSON brackets", async () => {
    const broken = JSON.stringify(fictitiousSongCandidate).slice(0, -2);
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(completedWithText(broken)))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).resolves.toMatchObject({
      song: { title: "星尘邮局" }
    });
  });

  it("rejects repairable JSON when required business fields were truncated", async () => {
    const broken = JSON.stringify({ query: fictitiousSongCandidate.query }).slice(0, -1);
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(completedWithText(broken)))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).rejects.toMatchObject({
      reason: "candidate_schema_failed"
    });
  });

  it("rejects repaired JSON that does not satisfy the candidate schema", async () => {
    const invalid = structuredClone(fictitiousSongCandidate) as Record<string, unknown>;
    delete invalid.sources;
    const broken = `${JSON.stringify(invalid).slice(0, -1)},}`;
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(completedWithText(broken)))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).rejects.toMatchObject({
      reason: "candidate_schema_failed"
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

  it.each([
    `Here is the result:\n${JSON.stringify(fictitiousSongCandidate)}`,
    `${JSON.stringify(fictitiousSongCandidate)}\nThat is the result.`
  ])("rejects explanatory text mixed with otherwise valid JSON", async (mixed) => {
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(completedWithText(mixed)))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).rejects.toMatchObject({
      reason: "invalid_json"
    });
  });

  it("returns invalid_json only after completed, done, and delta candidates all fail", async () => {
    const log = vi.fn();
    const stream = event("response.output_text.delta", { delta: "mock-secret-lyric delta" }) +
      event("response.output_text.done", { text: "mock-secret-lyric done" }) +
      completedWithText("mock-secret-lyric completed");
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(stream)),
      log
    });
    let caught: unknown;
    try {
      await provider.generateSongCandidate({ title: "private title" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ reason: "invalid_json" });
    expect(JSON.stringify(caught)).not.toContain("mock-secret-lyric");
    expect(JSON.stringify(log.mock.calls)).not.toContain("mock-secret-lyric");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "provider_invalid_json",
      selected_source: "completed",
      character_count: expect.any(Number),
      first_character_type: "other",
      last_character_type: "other",
      json_error_category: "boundary_violation",
      response_completed: true,
      elapsed_ms: expect.any(Number)
    }));
    const serializedLog = JSON.stringify(log.mock.calls);
    expect(serializedLog).not.toContain("test-only-key");
    expect(serializedLog).not.toContain("private title");
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

  it.each([
    ["max_output_tokens", "response_truncated"],
    ["content_filter", "response_filtered"]
  ])("classifies response.incomplete reason %s", async (incompleteReason, reason) => {
    const stream = event("response.incomplete", {
      response: { status: "incomplete", incomplete_details: { reason: incompleteReason } }
    });
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(stream))
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).rejects.toMatchObject({
      reason
    });
  });

  it("classifies an incomplete assistant message before JSON parsing", async () => {
    const stream = event("response.completed", {
      response: {
        status: "completed",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{
          type: "message",
          role: "assistant",
          status: "incomplete",
          content: [{ type: "output_text", text: "mock-secret-lyric" }]
        }]
      }
    });
    const log = vi.fn();
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(stream)),
      log
    });
    let caught: unknown;
    try {
      await provider.generateSongCandidate({ title: "星尘邮局" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ reason: "response_truncated" });
    expect(JSON.stringify(caught)).not.toContain("mock-secret-lyric");
    expect(JSON.stringify(log.mock.calls)).not.toContain("mock-secret-lyric");
  });

  it("classifies an incomplete output_text content item before JSON parsing", async () => {
    const stream = event("response.completed", {
      response: {
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{
            type: "output_text",
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
            text: "mock-secret-lyric"
          }]
        }]
      }
    });
    const provider = new DeepSeekProvider("test-only-key", {
      fetch: vi.fn(async () => responseFromText(stream)),
      log: vi.fn()
    });
    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).rejects.toMatchObject({
      reason: "response_filtered"
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
