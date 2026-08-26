import type { SongQuery } from "../../src/lib/song-candidate-schema";

export interface LlmProvider {
  generateSongCandidate(query: SongQuery): Promise<unknown>;
}

export type InvalidOutputReason =
  | "no_response_body"
  | "malformed_sse"
  | "response_incomplete"
  | "response_failed"
  | "no_output_text"
  | "invalid_json"
  | "candidate_schema_failed";

export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "upstream" | "invalid_output" | "unreachable" = "upstream",
    readonly upstreamStatus?: number,
    readonly providerErrorCode?: string,
    readonly providerErrorType?: string
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}

export class LlmProviderTimeoutError extends Error {
  constructor() {
    super("LLM provider timed out");
    this.name = "LlmProviderTimeoutError";
  }
}

export class LlmProviderInvalidOutputError extends LlmProviderError {
  constructor(readonly reason: InvalidOutputReason) {
    super("LLM provider returned invalid output", "invalid_output");
    this.name = "LlmProviderInvalidOutputError";
  }
}
