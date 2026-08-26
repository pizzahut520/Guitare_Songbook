import type { SongQuery } from "../../src/lib/song-candidate-schema";

export interface LlmProvider {
  generateSongCandidate(query: SongQuery): Promise<unknown>;
}

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
