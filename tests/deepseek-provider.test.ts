import { describe, expect, it, vi } from "vitest";
import { DeepSeekProvider } from "../worker/providers/deepseek";
import { LlmProviderError } from "../worker/providers/llm-provider";
import { fictitiousSongCandidate } from "./fixtures/fictitious-song-candidate";

describe("DeepSeek provider with mocked fetch", () => {
  it("uses Responses API, forced web search, JSON Schema, and only the final message", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        status: "completed",
        output: [
          {
            type: "reasoning",
            status: "completed",
            content: [{ type: "reasoning_text", text: "must never reach browser" }]
          },
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: JSON.stringify(fictitiousSongCandidate) }
            ]
          }
        ],
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
      })
    );
    const provider = new DeepSeekProvider("test-only-key", { fetch: fetchMock });
    const result = await provider.generateSongCandidate(fictitiousSongCandidate.query);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(url).toBe("https://api.deepseek.com/responses");
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      stream: false,
      tools: [{ type: "web_search" }],
      tool_choice: { type: "web_search" },
      text: { format: { type: "json_schema", name: "song_candidate" } }
    });
    expect(JSON.stringify(result)).not.toContain("must never reach browser");
    expect(result).toMatchObject({
      song: { title: "星尘邮局" },
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
    });
  });

  it("rejects invalid JSON in the final message", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "{not-json" }]
          }
        ]
      })
    );
    const provider = new DeepSeekProvider("test-only-key", { fetch: fetchMock });

    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).rejects.toBeInstanceOf(
      LlmProviderError
    );
  });

  it("preserves only safe upstream status and standard error metadata", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "insufficient_balance",
            type: "billing_error",
            message: "raw provider detail must not be retained"
          }
        },
        { status: 402 }
      )
    );
    const provider = new DeepSeekProvider("test-only-key", { fetch: fetchMock });

    await expect(provider.generateSongCandidate({ title: "星尘邮局" })).rejects.toMatchObject({
      upstreamStatus: 402,
      providerErrorCode: "insufficient_balance",
      providerErrorType: "billing_error",
      message: "DeepSeek generation request failed"
    });
  });
});
