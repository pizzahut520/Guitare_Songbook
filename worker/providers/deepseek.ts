import { z } from "zod";
import { jsonrepair } from "jsonrepair";
import {
  SongCandidateOutputSchema,
  type SongQuery
} from "../../src/lib/song-candidate-schema";
import {
  LlmProviderError,
  LlmProviderInvalidOutputError,
  LlmProviderTimeoutError,
  type LlmProvider
} from "./llm-provider";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_TOKENS = 32_000;
const SAFE_FIELD = /^[a-zA-Z0-9_.:-]{1,100}$/;
// This schema is immutable. Building it once per isolate avoids repeating the
// deepest Zod traversal on every API request.
const SONG_CANDIDATE_JSON_SCHEMA = z.toJSONSchema(SongCandidateOutputSchema);

export interface SafeNetworkLog {
  event: "provider_fetch_error";
  endpoint: "models" | "responses_probe" | "responses_generate";
  elapsed_ms: number;
  error: { name: string; code?: string };
}

export interface SafeInvalidJsonLog {
  event: "provider_invalid_json";
  selected_source: "completed" | "done" | "delta";
  character_count: number;
  first_character_type: "object" | "array" | "fence" | "bom" | "other" | "empty";
  last_character_type: "object_end" | "array_end" | "quote" | "other" | "empty";
  json_error_category: "boundary_violation" | "parse_and_repair_failed";
  output_tokens?: number;
  reasoning_tokens?: number;
  response_completed: boolean;
  elapsed_ms: number;
}

export interface SafeNoOutputLog {
  event: "provider_no_output_text";
  response_final_status: "completed" | "missing";
  output_text_delta_events: number;
  output_text_done_events: number;
  content_part_done_events: number;
  output_item_done_events: number;
  output_item_message_events: number;
  output_item_web_search_events: number;
  output_item_reasoning_events: number;
  output_item_other_events: number;
  completed_response_message_items: number;
  completed_response_web_search_items: number;
  completed_response_reasoning_items: number;
  completed_response_other_items: number;
  unknown_semantic_events: number;
  delta_character_count: number;
  done_character_count: number;
  content_part_character_count: number;
  output_item_character_count: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  elapsed_ms: number;
}

export interface SafeIncompleteResponseLog {
  event: "provider_incomplete_response";
  terminal_event: "response.completed" | "response.incomplete";
  response_status: "incomplete" | "other";
  incomplete_reason: string;
  output_tokens?: number;
  reasoning_tokens?: number;
  elapsed_ms: number;
}

export interface SafeUpstreamResponseLog {
  event: "provider_upstream_response";
  endpoint: "responses_generate";
  http_status: number;
  error_code?: string;
  error_type?: string;
  elapsed_ms: number;
}

export type SafeProviderLog = SafeNetworkLog | SafeInvalidJsonLog | SafeNoOutputLog |
  SafeIncompleteResponseLog | SafeUpstreamResponseLog;

export interface DeepSeekProviderOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  log?: (record: SafeProviderLog) => void;
}

interface ErrorPayload { error?: { code?: unknown; type?: unknown } }
interface UsagePayload {
  input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
  output_tokens_details?: { reasoning_tokens?: unknown };
}
interface SemanticEvent {
  type?: unknown;
  delta?: unknown;
  text?: unknown;
  output_index?: unknown;
  content_index?: unknown;
  incomplete_details?: { reason?: unknown };
  part?: {
    type?: unknown;
    text?: unknown;
    status?: unknown;
    incomplete_details?: { reason?: unknown };
  };
  item?: {
    type?: unknown;
    role?: unknown;
    status?: unknown;
    incomplete_details?: { reason?: unknown };
    content?: Array<{
      type?: unknown;
      text?: unknown;
      status?: unknown;
      incomplete_details?: { reason?: unknown };
    }>;
  };
  response?: {
    status?: unknown;
    incomplete_details?: { reason?: unknown };
    usage?: UsagePayload;
    error?: ErrorPayload["error"];
    output?: Array<{
      type?: unknown;
      role?: unknown;
      status?: unknown;
      incomplete_details?: { reason?: unknown };
      content?: Array<{
        type?: unknown;
        text?: unknown;
        status?: unknown;
        incomplete_details?: { reason?: unknown };
      }>;
    }>;
  };
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

function defaultLog(record: SafeProviderLog): void {
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
    "The first output character must be { and the last output character must be }; never add a preface or epilogue.",
    "You must use web_search at least once to identify the correct song and version before drafting the final JSON.",
    "Find and cross-check title, artist, credits, original key, playable degree key, capo, lyrics, chords, and section structure.",
    "Represent chords as scale degrees compatible with the existing song schema.",
    "Never use Roman numerals.",
    "Never put absolute chord names in degree fields.",
    "Use Arabic scale degrees only.",
    "Degree examples: G → 1; Gmaj7 → 1maj7; Bm7 → 3m7; E7 → 6(7); Ebmaj7 → ♭6maj7; Ab → ♭2; Dsus4 → 5sus4.",
    "Keep every lyric phrase count exactly aligned with its chord phrase count.",
    "Keep the JSON concise; do not repeat identical lyric sections. Use RepeatBlock for exact repetitions.",
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

function incompleteOutputError(reason: unknown): LlmProviderInvalidOutputError {
  if (reason === "max_output_tokens") {
    return new LlmProviderInvalidOutputError("response_truncated");
  }
  if (reason === "content_filter") {
    return new LlmProviderInvalidOutputError("response_filtered");
  }
  return new LlmProviderInvalidOutputError("response_incomplete");
}

function assistantTextFromCompleted(response: SemanticEvent["response"]): string | undefined {
  const assistant = [...(response?.output ?? [])]
    .reverse()
    .find((item) => item.type === "message" && item.role === "assistant");
  if (!assistant) return undefined;
  if (assistant.status === "failed") {
    throw new LlmProviderInvalidOutputError("response_failed");
  }
  if (assistant.status !== "completed") {
    throw incompleteOutputError(assistant.incomplete_details?.reason ?? response?.incomplete_details?.reason);
  }
  const outputParts = (assistant.content ?? []).filter((part) => part.type === "output_text");
  const incompletePart = outputParts.find((part) =>
    part.status !== undefined && part.status !== "completed"
  );
  if (incompletePart) {
    throw incompleteOutputError(
      incompletePart.incomplete_details?.reason ?? response?.incomplete_details?.reason
    );
  }
  const texts = outputParts.flatMap((part) => typeof part.text === "string" ? [part.text] : []);
  return texts.length > 0 ? texts.join("") : undefined;
}

async function readSemanticSse(
  response: Response,
  controller: AbortController,
  idleTimeoutMs: number,
  options: DeepSeekProviderOptions,
  startedAt: number
) {
  if (!response.body) {
    throw new LlmProviderInvalidOutputError("no_response_body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let doneText: string | undefined;
  const completedContentParts = new Map<string, string>();
  const completedOutputItems = new Map<number, string>();
  let completedText: string | undefined;
  let completed = false;
  let usage: ReturnType<typeof cleanUsage>;
  let diagnosticUsage: { output_tokens?: number; reasoning_tokens?: number } = {};
  const eventCounts = {
    outputTextDelta: 0,
    outputTextDone: 0,
    contentPartDone: 0,
    outputItemDone: 0,
    outputItemMessage: 0,
    outputItemWebSearch: 0,
    outputItemReasoning: 0,
    outputItemOther: 0,
    unknown: 0
  };
  const completedResponseItems = {
    message: 0,
    webSearch: 0,
    reasoning: 0,
    other: 0
  };
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
  };
  const logIncomplete = (
    terminalEvent: SafeIncompleteResponseLog["terminal_event"],
    status: SafeIncompleteResponseLog["response_status"],
    reason: unknown,
    eventUsage?: UsagePayload
  ) => {
    const safeReason = typeof reason === "string" && SAFE_FIELD.test(reason) ? reason : "unknown";
    const outputTokens = Number.isInteger(eventUsage?.output_tokens)
      ? eventUsage?.output_tokens as number : undefined;
    const reasoningTokens = Number.isInteger(eventUsage?.output_tokens_details?.reasoning_tokens)
      ? eventUsage?.output_tokens_details?.reasoning_tokens as number : undefined;
    (options.log ?? defaultLog)({
      event: "provider_incomplete_response",
      terminal_event: terminalEvent,
      response_status: status,
      incomplete_reason: safeReason,
      ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
      ...(reasoningTokens === undefined ? {} : { reasoning_tokens: reasoningTokens }),
      elapsed_ms: Math.max(0, Date.now() - startedAt)
    });
  };
  resetIdle();

  const consume = (frame: string) => {
    const lines = frame.split(/\r?\n/);
    const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines.filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      if (!completed) throw new LlmProviderInvalidOutputError("malformed_sse");
      return;
    }
    let event: SemanticEvent;
    try {
      event = JSON.parse(data) as SemanticEvent;
    } catch {
      throw new LlmProviderInvalidOutputError("malformed_sse");
    }
    if (typeof event.type !== "string" || (eventName && eventName !== event.type)) {
      throw new LlmProviderInvalidOutputError("malformed_sse");
    }
    resetIdle();
    switch (event.type) {
      case "response.output_text.delta":
        if (typeof event.delta !== "string") {
          throw new LlmProviderInvalidOutputError("malformed_sse");
        }
        eventCounts.outputTextDelta += 1;
        text += event.delta;
        break;
      case "response.output_text.done":
        if (typeof event.text !== "string") {
          throw new LlmProviderInvalidOutputError("malformed_sse");
        }
        eventCounts.outputTextDone += 1;
        doneText = event.text;
        break;
      case "response.content_part.done": {
        eventCounts.contentPartDone += 1;
        if (event.part?.type !== "output_text") break;
        if (event.part.status !== undefined && event.part.status !== "completed") {
          throw incompleteOutputError(event.part.incomplete_details?.reason);
        }
        if (typeof event.part.text !== "string") {
          throw new LlmProviderInvalidOutputError("malformed_sse");
        }
        const outputIndex = Number.isInteger(event.output_index) ? event.output_index as number : 0;
        const contentIndex = Number.isInteger(event.content_index) ? event.content_index as number : 0;
        completedContentParts.set(`${outputIndex}:${contentIndex}`, event.part.text);
        break;
      }
      case "response.output_item.done": {
        eventCounts.outputItemDone += 1;
        if (event.item?.type === "message") eventCounts.outputItemMessage += 1;
        else if (event.item?.type === "web_search_call") eventCounts.outputItemWebSearch += 1;
        else if (event.item?.type === "reasoning") eventCounts.outputItemReasoning += 1;
        else eventCounts.outputItemOther += 1;
        if (event.item?.type !== "message" || event.item.role !== "assistant") break;
        if (event.item.status !== "completed") {
          throw incompleteOutputError(event.item.incomplete_details?.reason);
        }
        const textParts = (event.item.content ?? []).filter((part) => part.type === "output_text");
        const incompletePart = textParts.find((part) =>
          part.status !== undefined && part.status !== "completed"
        );
        if (incompletePart) {
          throw incompleteOutputError(incompletePart.incomplete_details?.reason);
        }
        const itemText = textParts.flatMap((part) =>
          typeof part.text === "string" ? [part.text] : []
        ).join("");
        if (itemText) {
          const outputIndex = Number.isInteger(event.output_index) ? event.output_index as number : 0;
          completedOutputItems.set(outputIndex, itemText);
        }
        break;
      }
      case "response.completed":
        if (event.response?.status === "incomplete") {
          logIncomplete(
            "response.completed",
            "incomplete",
            event.response.incomplete_details?.reason ?? event.incomplete_details?.reason,
            event.response.usage
          );
          throw incompleteOutputError(
            event.response.incomplete_details?.reason ?? event.incomplete_details?.reason
          );
        }
        if (event.response?.status === "failed") {
          throw new LlmProviderInvalidOutputError("response_failed");
        }
        if (event.response?.status !== undefined && event.response.status !== "completed") {
          logIncomplete(
            "response.completed",
            "other",
            event.response.incomplete_details?.reason ?? event.incomplete_details?.reason,
            event.response.usage
          );
          throw incompleteOutputError(
            event.response.incomplete_details?.reason ?? event.incomplete_details?.reason
          );
        }
        completed = true;
        usage = cleanUsage(event.response?.usage);
        for (const item of event.response?.output ?? []) {
          if (item.type === "message") completedResponseItems.message += 1;
          else if (item.type === "web_search_call") completedResponseItems.webSearch += 1;
          else if (item.type === "reasoning") completedResponseItems.reasoning += 1;
          else completedResponseItems.other += 1;
        }
        diagnosticUsage = {
          output_tokens: Number.isInteger(event.response?.usage?.output_tokens)
            ? event.response?.usage?.output_tokens as number
            : undefined,
          reasoning_tokens: Number.isInteger(
            event.response?.usage?.output_tokens_details?.reasoning_tokens
          ) ? event.response?.usage?.output_tokens_details?.reasoning_tokens as number : undefined
        };
        completedText = assistantTextFromCompleted(event.response);
        break;
      case "response.incomplete":
        logIncomplete(
          "response.incomplete",
          "incomplete",
          event.response?.incomplete_details?.reason ?? event.incomplete_details?.reason,
          event.response?.usage
        );
        throw incompleteOutputError(
          event.response?.incomplete_details?.reason ?? event.incomplete_details?.reason
        );
      case "response.failed":
        throw new LlmProviderInvalidOutputError("response_failed");
      default:
        // Other valid semantic events, including reasoning, are deliberately discarded.
        eventCounts.unknown += 1;
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
  const contentPartText = [...completedContentParts.entries()]
    .sort(([left], [right]) => {
      const [leftOutput, leftContent] = left.split(":").map(Number);
      const [rightOutput, rightContent] = right.split(":").map(Number);
      return leftOutput - rightOutput || leftContent - rightContent;
    })
    .map(([, partText]) => partText).join("");
  const outputItemText = [...completedOutputItems.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, itemText]) => itemText).join("");
  const candidates = [
    ["completed", completedText],
    ["done", doneText],
    ["done", contentPartText],
    ["done", outputItemText],
    ["delta", text]
  ].flatMap(([source, candidate]) =>
    typeof candidate === "string" && candidate.trim()
      ? [{ source: source as "completed" | "done" | "delta", text: candidate }]
      : []
  );
  if (!completed || candidates.length === 0) {
    if (completed && candidates.length === 0) {
      (options.log ?? defaultLog)({
        event: "provider_no_output_text",
        response_final_status: completed ? "completed" : "missing",
        output_text_delta_events: eventCounts.outputTextDelta,
        output_text_done_events: eventCounts.outputTextDone,
        content_part_done_events: eventCounts.contentPartDone,
        output_item_done_events: eventCounts.outputItemDone,
        output_item_message_events: eventCounts.outputItemMessage,
        output_item_web_search_events: eventCounts.outputItemWebSearch,
        output_item_reasoning_events: eventCounts.outputItemReasoning,
        output_item_other_events: eventCounts.outputItemOther,
        completed_response_message_items: completedResponseItems.message,
        completed_response_web_search_items: completedResponseItems.webSearch,
        completed_response_reasoning_items: completedResponseItems.reasoning,
        completed_response_other_items: completedResponseItems.other,
        unknown_semantic_events: eventCounts.unknown,
        delta_character_count: text.length,
        done_character_count: doneText?.length ?? 0,
        content_part_character_count: contentPartText.length,
        output_item_character_count: outputItemText.length,
        ...(diagnosticUsage.output_tokens === undefined ? {} : {
          output_tokens: diagnosticUsage.output_tokens
        }),
        ...(diagnosticUsage.reasoning_tokens === undefined ? {} : {
          reasoning_tokens: diagnosticUsage.reasoning_tokens
        }),
        elapsed_ms: Math.max(0, Date.now() - startedAt)
      });
    }
    throw new LlmProviderInvalidOutputError("no_output_text");
  }
  return {
    candidates,
    usage,
    diagnosticUsage,
    completed
  };
}

function unwrapSingleJsonFence(text: string): string | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : undefined;
}

function repairBoundary(text: string): { document?: string; category?: "boundary_violation" } {
  let document = text.trim();
  const fenced = unwrapSingleJsonFence(document);
  if (document.startsWith("```") && fenced === undefined) return { category: "boundary_violation" };
  if (fenced !== undefined) document = fenced;
  if (document.startsWith("\uFEFF")) document = document.slice(1).trimStart();
  if (!document.startsWith("{") && !document.startsWith("[")) {
    return { category: "boundary_violation" };
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < document.length; index += 1) {
    const character = document[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0 && document.slice(index + 1).trim()) {
        return { category: "boundary_violation" };
      }
    }
  }
  return { document };
}

function repairedCandidate(text: string): unknown {
  const boundary = repairBoundary(text);
  if (!boundary.document) throw new Error(boundary.category);
  return JSON.parse(jsonrepair(boundary.document));
}

function parseCandidateJson(text: string): { value: unknown; repaired: boolean } {
  const trimmed = text.trim().replace(/^\uFEFF/, "");
  const directDocument = unwrapSingleJsonFence(trimmed) ?? trimmed;
  try {
    return { value: JSON.parse(directDocument), repaired: false };
  } catch {
    try {
      return { value: repairedCandidate(text), repaired: true };
    } catch {
      throw new LlmProviderInvalidOutputError("invalid_json");
    }
  }
}

function characterTypes(text: string): Pick<SafeInvalidJsonLog,
  "first_character_type" | "last_character_type"> {
  const trimmed = text.trim();
  const first = trimmed[0];
  const last = trimmed.at(-1);
  return {
    first_character_type: !first ? "empty" : first === "\uFEFF" ? "bom" :
      first === "{" ? "object" : first === "[" ? "array" :
        trimmed.startsWith("```") ? "fence" : "other",
    last_character_type: !last ? "empty" : last === "}" ? "object_end" :
      last === "]" ? "array_end" : last === '"' ? "quote" : "other"
  };
}

function validateRepairedCandidate(value: unknown): unknown {
  const output = SongCandidateOutputSchema.safeParse(value);
  if (!output.success) {
    throw new LlmProviderInvalidOutputError("candidate_schema_failed");
  }
  return output.data;
}

function parseCandidateCandidates(
  candidates: Array<{ source: "completed" | "done" | "delta"; text: string }>,
  options: DeepSeekProviderOptions,
  startedAt: number,
  diagnostics: { output_tokens?: number; reasoning_tokens?: number; response_completed: boolean }
): unknown {
  for (const candidate of candidates) {
    try {
      const parsed = parseCandidateJson(candidate.text);
      return parsed.repaired ? validateRepairedCandidate(parsed.value) : parsed.value;
    } catch (error) {
      if (!(error instanceof LlmProviderInvalidOutputError) || error.reason !== "invalid_json") {
        throw error;
      }
      const boundary = repairBoundary(candidate.text);
      (options.log ?? defaultLog)({
        event: "provider_invalid_json",
        selected_source: candidate.source,
        character_count: candidate.text.length,
        ...characterTypes(candidate.text),
        json_error_category: boundary.document ? "parse_and_repair_failed" : "boundary_violation",
        ...(diagnostics.output_tokens === undefined ? {} : { output_tokens: diagnostics.output_tokens }),
        ...(diagnostics.reasoning_tokens === undefined ? {} : {
          reasoning_tokens: diagnostics.reasoning_tokens
        }),
        response_completed: diagnostics.response_completed,
        elapsed_ms: Math.max(0, Date.now() - startedAt)
      });
    }
  }
  throw new LlmProviderInvalidOutputError("invalid_json");
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
      // Cloudflare's native fetch is a host function and must not receive this provider
      // instance as its receiver. Detach it before invocation.
      const fetchImplementation = this.fetchImplementation;
      const response = await fetchImplementation(`${DEEPSEEK_BASE_URL}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          instructions: instructions(),
          input: JSON.stringify(query),
          reasoning: { effort: "none" },
          temperature: 0,
          max_output_tokens: MAX_OUTPUT_TOKENS,
          stream: true,
          tools: [{ type: "web_search" }],
          // A specific hosted-tool choice caused DeepSeek to emit only web_search_call
          // items and no final assistant message. Auto still exposes the required tool
          // while allowing the model to transition from search to structured output.
          tool_choice: "auto",
          text: {
            format: {
              type: "json_schema",
              name: "song_candidate",
              schema: SONG_CANDIDATE_JSON_SCHEMA,
              strict: true
            }
          }
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        const upstreamError = await errorForResponse(response);
        (this.options.log ?? defaultLog)({
          event: "provider_upstream_response",
          endpoint: "responses_generate",
          http_status: response.status,
          ...(upstreamError.providerErrorCode ? {
            error_code: upstreamError.providerErrorCode
          } : {}),
          ...(upstreamError.providerErrorType ? {
            error_type: upstreamError.providerErrorType
          } : {}),
          elapsed_ms: Math.max(0, Date.now() - startedAt)
        });
        throw upstreamError;
      }
      const streamed = await readSemanticSse(
        response,
        controller,
        this.idleTimeoutMs,
        this.options,
        startedAt
      );
      const candidate = parseCandidateCandidates(
        streamed.candidates,
        this.options,
        startedAt,
        { ...streamed.diagnosticUsage, response_completed: streamed.completed }
      );
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
