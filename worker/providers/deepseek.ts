import { z } from "zod";
import { SongCandidateOutputSchema, type SongQuery } from "../../src/lib/song-candidate-schema";
import { LlmProviderError, LlmProviderTimeoutError, type LlmProvider } from "./llm-provider";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_TOKENS = 8_000;
const SAFE_FIELD = /^[a-zA-Z0-9_.:-]{1,100}$/;

export interface SafeNetworkLog {
  event: "provider_fetch_error";
  endpoint: "models" | "responses_probe" | "responses_generate";
  elapsed_ms: number;
  error: { name: string; code?: string };
}

export interface DeepSeekProviderOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  log?: (record: SafeNetworkLog) => void;
}

interface ErrorPayload { error?: { code?: unknown; type?: unknown } }
interface UsagePayload { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown }
interface SemanticEvent {
  type?: unknown;
  delta?: unknown;
  response?: { usage?: UsagePayload; error?: ErrorPayload["error"] };
}

export interface DeepSeekStatus {
  status: "ok";
  reachable: true;
  authenticated: true;
  responses_model_available: boolean;
}

export interface DeepSeekResponsesProbe {
  status: "ok";
  responses_endpoint: true;
}

function defaultLog(record: SafeNetworkLog): void {
  console.error(JSON.stringify(record));
}

function logNetworkError(
  options: DeepSeekProviderOptions,
  endpoint: SafeNetworkLog["endpoint"],
  startedAt: number,
  error: unknown
): void {
  const name = error instanceof Error && SAFE_FIELD.test(error.name) ? error.name : "Error";
  const unsafeCode = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  const code = typeof unsafeCode === "string" && SAFE_FIELD.test(unsafeCode)
    ? unsafeCode
    : undefined;
  (options.log ?? defaultLog)({
    event: "provider_fetch_error",
    endpoint,
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    error: { name, ...(code ? { code } : {}) }
  });
}

async function safeErrorMetadata(response: Response) {
  try {
    const payload = (await response.json()) as ErrorPayload;
    return {
      code: typeof payload.error?.code === "string" && SAFE_FIELD.test(payload.error.code)
        ? payload.error.code : undefined,
      type: typeof payload.error?.type === "string" && SAFE_FIELD.test(payload.error.type)
        ? payload.error.type : undefined
    };
  } catch {
    return {};
  }
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

async function errorForResponse(response: Response): Promise<LlmProviderError> {
  const metadata = await safeErrorMetadata(response);
  return new LlmProviderError(
    "DeepSeek request failed",
    "upstream",
    response.status,
    metadata.code,
    metadata.type
  );
}

export async function checkDeepSeekStatus(
  apiKey: string,
  options: DeepSeekProviderOptions = {}
): Promise<DeepSeekStatus> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await (options.fetch ?? fetch)(`${DEEPSEEK_BASE_URL}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (!response.ok) throw await errorForResponse(response);
    let payload: { data?: Array<{ id?: unknown }> };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw new LlmProviderError("DeepSeek models response was invalid", "invalid_output");
    }
    const ids = Array.isArray(payload.data)
      ? payload.data.flatMap((model) => typeof model.id === "string" ? [model.id] : [])
      : [];
    return {
      status: "ok",
      reachable: true,
      authenticated: true,
      responses_model_available: ids.includes(DEEPSEEK_MODEL)
    };
  } catch (error) {
    if (error instanceof LlmProviderError) throw error;
    logNetworkError(options, "models", startedAt, error);
    if (isAbort(error, controller.signal)) throw new LlmProviderTimeoutError();
    throw new LlmProviderError("DeepSeek status request failed", "unreachable");
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeDeepSeekResponses(
  apiKey: string,
  options: DeepSeekProviderOptions = {}
): Promise<DeepSeekResponsesProbe> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await (options.fetch ?? fetch)(`${DEEPSEEK_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        input: "Reply with exactly OK",
        reasoning: { effort: "none" },
        max_output_tokens: 16,
        stream: false
      }),
      signal: controller.signal
    });
    if (!response.ok) throw await errorForResponse(response);
    return { status: "ok", responses_endpoint: true };
  } catch (error) {
    if (error instanceof LlmProviderError) throw error;
    logNetworkError(options, "responses_probe", startedAt, error);
    if (isAbort(error, controller.signal)) throw new LlmProviderTimeoutError();
    throw new LlmProviderError("DeepSeek probe request failed", "unreachable");
  } finally {
    clearTimeout(timeout);
  }
}

function instructions(): string {
  return [
    "Return JSON only and conform exactly to the supplied JSON Schema.",
    "Use web search to identify the correct song and version before drafting.",
    "Find and cross-check title, artist, credits, original key, playable degree key, capo, lyrics, chords, and section structure.",
    "Represent chords as scale degrees compatible with the existing song schema.",
    "Keep every lyric phrase count exactly aligned with its chord phrase count.",
    "Set song.source.type to web_search and song.copyright_status to private_reference.",
    "Cite useful web pages in sources; record ambiguity in warnings and uncertain_fields.",
    "Do not include markdown, analysis, reasoning, or token usage in the JSON."
  ].join(" ");
}

function cleanUsage(payload?: UsagePayload) {
  return payload && Number.isInteger(payload.input_tokens) &&
    Number.isInteger(payload.output_tokens) && Number.isInteger(payload.total_tokens)
    ? {
        input_tokens: payload.input_tokens as number,
        output_tokens: payload.output_tokens as number,
        total_tokens: payload.total_tokens as number
      }
    : undefined;
}

async function readSemanticSse(
  response: Response,
  controller: AbortController,
  idleTimeoutMs: number
) {
  if (!response.body) {
    throw new LlmProviderError("DeepSeek returned no response stream", "invalid_output");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let completed = false;
  let usage: ReturnType<typeof cleanUsage>;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
  };
  resetIdle();

  const consume = (frame: string) => {
    const lines = frame.split(/\r?\n/);
    const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines.filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      if (!completed) throw new LlmProviderError("DeepSeek stream ended early", "invalid_output");
      return;
    }
    let event: SemanticEvent;
    try {
      event = JSON.parse(data) as SemanticEvent;
    } catch {
      throw new LlmProviderError("DeepSeek returned malformed SSE", "invalid_output");
    }
    if (typeof event.type !== "string" || (eventName && eventName !== event.type)) {
      throw new LlmProviderError("DeepSeek returned malformed SSE", "invalid_output");
    }
    resetIdle();
    switch (event.type) {
      case "response.output_text.delta":
        if (typeof event.delta !== "string") {
          throw new LlmProviderError("DeepSeek returned malformed text delta", "invalid_output");
        }
        text += event.delta;
        break;
      case "response.completed":
        completed = true;
        usage = cleanUsage(event.response?.usage);
        break;
      case "response.incomplete":
        throw new LlmProviderError("DeepSeek response was incomplete", "invalid_output");
      case "response.failed":
        throw new LlmProviderError(
          "DeepSeek response failed",
          "upstream",
          undefined,
          typeof event.response?.error?.code === "string" &&
            SAFE_FIELD.test(event.response.error.code)
            ? event.response.error.code
            : undefined,
          typeof event.response?.error?.type === "string" &&
            SAFE_FIELD.test(event.response.error.type)
            ? event.response.error.type
            : undefined
        );
      default:
        // Other valid semantic events, including reasoning, are deliberately discarded.
        break;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.search(/\r?\n\r?\n/);
      while (separator >= 0) {
        const delimiter = buffer.slice(separator).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
        consume(buffer.slice(0, separator));
        buffer = buffer.slice(separator + delimiter.length);
        separator = buffer.search(/\r?\n\r?\n/);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    reader.releaseLock();
  }
  if (!completed || !text) {
    throw new LlmProviderError("DeepSeek stream did not complete", "invalid_output");
  }
  return { text, usage };
}

export class DeepSeekProvider implements LlmProvider {
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(private readonly apiKey: string, private readonly options: DeepSeekProviderOptions = {}) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  async generateSongCandidate(query: SongQuery): Promise<unknown> {
    const controller = new AbortController();
    const startedAt = Date.now();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(`${DEEPSEEK_BASE_URL}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          instructions: instructions(),
          input: JSON.stringify(query),
          reasoning: { effort: "low" },
          max_output_tokens: MAX_OUTPUT_TOKENS,
          stream: true,
          tools: [{ type: "web_search" }],
          tool_choice: { type: "web_search" },
          text: {
            format: {
              type: "json_schema",
              name: "song_candidate",
              schema: z.toJSONSchema(SongCandidateOutputSchema)
            }
          }
        }),
        signal: controller.signal
      });
      if (!response.ok) throw await errorForResponse(response);
      const streamed = await readSemanticSse(response, controller, this.idleTimeoutMs);
      let candidate: unknown;
      try {
        candidate = JSON.parse(streamed.text);
      } catch {
        throw new LlmProviderError("DeepSeek message was not valid JSON", "invalid_output");
      }
      return {
        ...(candidate as Record<string, unknown>),
        ...(streamed.usage ? { usage: streamed.usage } : {})
      };
    } catch (error) {
      if (error instanceof LlmProviderError) throw error;
      logNetworkError(this.options, "responses_generate", startedAt, error);
      if (isAbort(error, controller.signal)) throw new LlmProviderTimeoutError();
      throw new LlmProviderError("DeepSeek request failed", "unreachable");
    } finally {
      clearTimeout(timeout);
    }
  }
}
