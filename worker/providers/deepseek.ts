import { z } from "zod";
import {
  SongCandidateOutputSchema,
  type SongQuery
} from "../../src/lib/song-candidate-schema";
import {
  LlmProviderError,
  LlmProviderTimeoutError,
  type LlmProvider
} from "./llm-provider";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 12_000;

interface DeepSeekProviderOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface DeepSeekResponse {
  status?: string;
  output?: Array<{
    type?: string;
    status?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

function candidateInstructions(): string {
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

export class DeepSeekProvider implements LlmProvider {
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options: DeepSeekProviderOptions = {}
  ) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async generateSongCandidate(query: SongQuery): Promise<unknown> {
    const controller = new AbortController();
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
          instructions: candidateInstructions(),
          input: JSON.stringify(query),
          reasoning: { effort: "low" },
          max_output_tokens: MAX_OUTPUT_TOKENS,
          stream: false,
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

      if (!response.ok) {
        throw new LlmProviderError(`DeepSeek returned HTTP ${response.status}`);
      }

      let payload: DeepSeekResponse;
      try {
        payload = (await response.json()) as DeepSeekResponse;
      } catch {
        throw new LlmProviderError("DeepSeek returned invalid JSON", "invalid_output");
      }

      const finalMessage = [...(payload.output ?? [])]
        .reverse()
        .find(
          (item) =>
            item.type === "message" &&
            item.role === "assistant" &&
            item.status === "completed"
        );
      const structuredText = finalMessage?.content?.find(
        (part) => part.type === "output_text"
      )?.text;

      if (!structuredText) {
        throw new LlmProviderError("DeepSeek returned no final message", "invalid_output");
      }

      let candidate: unknown;
      try {
        candidate = JSON.parse(structuredText);
      } catch {
        throw new LlmProviderError("DeepSeek message was not valid JSON", "invalid_output");
      }

      const usage = payload.usage;
      return {
        ...(candidate as Record<string, unknown>),
        ...(usage &&
        Number.isInteger(usage.input_tokens) &&
        Number.isInteger(usage.output_tokens) &&
        Number.isInteger(usage.total_tokens)
          ? {
              usage: {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                total_tokens: usage.total_tokens
              }
            }
          : {})
      };
    } catch (error) {
      if (error instanceof LlmProviderError) throw error;
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new LlmProviderTimeoutError();
      }
      throw new LlmProviderError("DeepSeek request failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}
