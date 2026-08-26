import {
  SongCandidateSchema,
  SongQuerySchema,
  type SongQuery
} from "../src/lib/song-candidate-schema";
import { findDuplicateSong, SongIndexSchema } from "../src/lib/song-index";
import { z } from "zod";
import {
  checkDeepSeekStatus,
  DeepSeekProvider,
  probeDeepSeekResponses,
  type DeepSeekResponsesProbe,
  type DeepSeekStatus
} from "./providers/deepseek";
import {
  LlmProviderError,
  LlmProviderInvalidOutputError,
  LlmProviderTimeoutError,
  type LlmProvider
} from "./providers/llm-provider";
import {
  verifyAccess,
  type AccessEnv,
  type AccessVerifier
} from "./security/access";
import {
  GitHubContentsProvider,
  GitHubProviderError,
  type GitHubPublishResult,
  type GitHubRepositoryStatus
} from "./providers/github";

const MAX_REQUEST_BODY_BYTES = 2_048;
const MAX_PUBLISH_BODY_BYTES = 262_144;
const DEFAULT_GITHUB_REPOSITORY = "pizzahut520/Guitare_Songbook";
const DEFAULT_GITHUB_BRANCH = "main";

export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env extends AccessEnv {
  ASSETS: Fetcher;
  DEEPSEEK_API_KEY?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_BRANCH?: string;
}

export interface WorkerContext {
  access?: unknown;
}

interface WorkerDependencies {
  createProvider(apiKey: string): LlmProvider;
  checkProviderStatus(apiKey: string): Promise<DeepSeekStatus>;
  probeResponses(apiKey: string): Promise<DeepSeekResponsesProbe>;
  createGitHubProvider(token: string, repository: string, branch: string): {
    createSong(song: z.infer<typeof SongCandidateSchema>["song"]): Promise<GitHubPublishResult>;
    checkRepositoryStatus(): Promise<GitHubRepositoryStatus>;
  };
  verifyAccess: AccessVerifier;
}

class RequestBodyTooLargeError extends Error {}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

interface SafeIssue { path: string; code: string }
interface SafeExistingSong { title: string; artist: string; url: string }

function errorResponse(
  status: number,
  code: string,
  message: string,
  details: { reason?: string; issues?: SafeIssue[]; existing_song?: SafeExistingSong } = {}
): Response {
  return jsonResponse({ error: { code, message, ...details } }, status);
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0].trim() === "application/json";
}

function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

async function readLimitedBody(
  request: Request,
  maximumBytes = MAX_REQUEST_BODY_BYTES
): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

const PublishRequestSchema = z.object({
  candidate: SongCandidateSchema,
  confirmed: z.literal(true)
}).strict();

async function publishSong(
  request: Request,
  env: Env,
  dependencies: WorkerDependencies
): Promise<Response> {
  const githubToken = env.GITHUB_TOKEN?.trim();
  if (!githubToken) {
    return errorResponse(503, "github_not_configured", "GitHub 写入尚未配置");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readLimitedBody(request, MAX_PUBLISH_BODY_BYTES));
  } catch {
    return errorResponse(400, "invalid_candidate", "候选内容无效");
  }
  const parsed = PublishRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(400, "invalid_candidate", "候选内容无效");
  }

  let indexPayload: unknown;
  try {
    const indexRequest = new Request(new URL("/song-index.json", request.url));
    const indexResponse = await env.ASSETS.fetch(indexRequest);
    if (!indexResponse.ok) throw new Error("index unavailable");
    indexPayload = await indexResponse.json();
  } catch {
    return errorResponse(502, "github_upstream_error", "无法检查现有曲库");
  }
  const index = SongIndexSchema.safeParse(indexPayload);
  if (!index.success) {
    return errorResponse(502, "github_upstream_error", "无法检查现有曲库");
  }
  const duplicate = findDuplicateSong(index.data, parsed.data.candidate.song);
  if (duplicate) {
    return errorResponse(409, "duplicate_song", "歌曲已存在", {
      existing_song: {
        title: duplicate.title,
        artist: duplicate.artist,
        url: duplicate.url
      }
    });
  }

  const repository = env.GITHUB_REPOSITORY?.trim() || DEFAULT_GITHUB_REPOSITORY;
  const branch = env.GITHUB_BRANCH?.trim() || DEFAULT_GITHUB_BRANCH;
  try {
    const provider = dependencies.createGitHubProvider(githubToken, repository, branch);
    return jsonResponse(await provider.createSong(parsed.data.candidate.song), 201);
  } catch (error) {
    if (!(error instanceof GitHubProviderError)) {
      return errorResponse(502, "github_upstream_error", "GitHub 写入失败");
    }
    return githubErrorResponse(error);
  }
}

function githubErrorResponse(error: GitHubProviderError): Response {
  const status = error.code === "duplicate_song" || error.code === "github_conflict"
    ? 409
    : error.code === "github_rate_limited"
      ? 429
      : 502;
  const message = error.code === "duplicate_song"
    ? "歌曲已存在"
    : error.code === "github_auth_failed"
      ? "GitHub 身份验证失败"
      : error.code === "github_conflict"
        ? "GitHub 写入发生冲突"
        : error.code === "github_rate_limited"
          ? "GitHub API 请求受限"
          : "GitHub 写入失败";
  return errorResponse(status, error.code, message, {
    ...(error.reason ? { reason: error.reason } : {})
  });
}

async function githubStatus(env: Env, dependencies: WorkerDependencies): Promise<Response> {
  const githubToken = env.GITHUB_TOKEN?.trim();
  if (!githubToken) {
    return errorResponse(503, "github_not_configured", "GitHub 写入尚未配置");
  }
  try {
    const provider = dependencies.createGitHubProvider(
      githubToken,
      DEFAULT_GITHUB_REPOSITORY,
      DEFAULT_GITHUB_BRANCH
    );
    return jsonResponse(await provider.checkRepositoryStatus());
  } catch (error) {
    if (error instanceof GitHubProviderError) return githubErrorResponse(error);
    return errorResponse(502, "github_upstream_error", "GitHub 状态检查失败");
  }
}

async function parseSongQuery(request: Request): Promise<SongQuery | Response> {
  let rawBody: string;
  try {
    rawBody = await readLimitedBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return errorResponse(400, "invalid_request", "请求内容过大");
    }
    return errorResponse(400, "invalid_request", "无法读取请求内容");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return errorResponse(400, "invalid_request", "请求必须是有效 JSON");
  }

  const parsed = SongQuerySchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "歌名或歌手格式不正确");
  }
  return parsed.data;
}

async function generateSong(
  request: Request,
  env: Env,
  dependencies: WorkerDependencies
): Promise<Response> {
  const query = await parseSongQuery(request);
  if (query instanceof Response) return query;

  if (!env.DEEPSEEK_API_KEY) {
    return errorResponse(503, "provider_unavailable", "歌曲生成服务尚未配置");
  }

  try {
    const provider = dependencies.createProvider(env.DEEPSEEK_API_KEY);
    const generated = await provider.generateSongCandidate(query);
    const candidate = SongCandidateSchema.safeParse(generated);
    if (!candidate.success) {
      const issues = candidate.error.issues.slice(0, 10).map((issue) => ({
        path: issue.path.map(String).join("."),
        code: issue.code
      }));
      return errorResponse(502, "invalid_provider_output", "生成结果未通过数据校验", {
        reason: "candidate_schema_failed",
        issues
      });
    }
    return jsonResponse(candidate.data);
  } catch (error) {
    if (error instanceof LlmProviderTimeoutError) {
      return errorResponse(504, "provider_timeout", "歌曲生成服务响应超时");
    }
    if (error instanceof LlmProviderError) {
      return providerErrorResponse(error);
    }
    return errorResponse(502, "provider_error", "歌曲生成服务暂时不可用");
  }
}

function providerErrorResponse(error: LlmProviderError): Response {
  if (error instanceof LlmProviderInvalidOutputError) {
    return errorResponse(502, "invalid_provider_output", "歌曲生成服务返回了无效结果", {
      reason: error.reason
    });
  }
  if (error.kind === "invalid_output") {
    return errorResponse(502, "invalid_provider_output", "歌曲生成服务返回了无效结果");
  }
  if (error.kind === "unreachable") {
    return errorResponse(502, "provider_unreachable", "无法连接歌曲生成服务");
  }
  switch (error.upstreamStatus) {
    case 401:
      return errorResponse(502, "provider_auth_failed", "歌曲生成服务身份验证失败");
    case 402:
      return errorResponse(502, "provider_billing_failed", "歌曲生成服务账户余额或计费异常");
    case 403:
      return errorResponse(502, "provider_forbidden", "歌曲生成服务拒绝了请求");
    case 429:
      return errorResponse(429, "provider_rate_limited", "歌曲生成服务请求过于频繁");
    default:
      return errorResponse(502, "provider_upstream_error", "歌曲生成服务暂时不可用");
  }
}

async function deepSeekStatus(env: Env, dependencies: WorkerDependencies): Promise<Response> {
  if (!env.DEEPSEEK_API_KEY) {
    return errorResponse(503, "provider_unavailable", "歌曲生成服务尚未配置");
  }
  try {
    return jsonResponse(await dependencies.checkProviderStatus(env.DEEPSEEK_API_KEY));
  } catch (error) {
    if (error instanceof LlmProviderTimeoutError) {
      return errorResponse(504, "provider_timeout", "歌曲生成服务响应超时");
    }
    if (error instanceof LlmProviderError) return providerErrorResponse(error);
    return errorResponse(502, "provider_unreachable", "无法连接歌曲生成服务");
  }
}

async function deepSeekResponsesProbe(
  env: Env,
  dependencies: WorkerDependencies
): Promise<Response> {
  if (!env.DEEPSEEK_API_KEY) {
    return errorResponse(503, "provider_unavailable", "歌曲生成服务尚未配置");
  }
  try {
    return jsonResponse(await dependencies.probeResponses(env.DEEPSEEK_API_KEY));
  } catch (error) {
    if (error instanceof LlmProviderTimeoutError) {
      return errorResponse(504, "provider_timeout", "歌曲生成服务响应超时");
    }
    if (error instanceof LlmProviderError) return providerErrorResponse(error);
    return errorResponse(502, "provider_unreachable", "无法连接歌曲生成服务");
  }
}

export function createWorker(
  dependencies: Partial<WorkerDependencies> = {}
) {
  const workerDependencies: WorkerDependencies = {
    createProvider: (apiKey) => new DeepSeekProvider(apiKey),
    checkProviderStatus: (apiKey) => checkDeepSeekStatus(apiKey),
    probeResponses: (apiKey) => probeDeepSeekResponses(apiKey),
    createGitHubProvider: (token, repository, branch) =>
      new GitHubContentsProvider(token, repository, branch),
    verifyAccess,
    ...dependencies
  };
  return {
    async fetch(request: Request, env: Env, _ctx: WorkerContext = {}): Promise<Response> {
      const { pathname } = new URL(request.url);

      if (!pathname.startsWith("/api/")) {
        return env.ASSETS.fetch(request);
      }

      const access = await workerDependencies.verifyAccess(request, env);
      if (!access.ok) {
        return errorResponse(access.status, access.code, access.message);
      }

      if (request.method === "POST") {
        if (!hasSameOrigin(request)) {
          return errorResponse(403, "invalid_origin", "拒绝跨站请求");
        }
        if (!isJsonRequest(request)) {
          return errorResponse(400, "invalid_content_type", "只接受 application/json");
        }
      }

      if (request.method === "GET" && pathname === "/api/health") {
        return jsonResponse({
          status: "ok",
          deepseek_configured: Boolean(env.DEEPSEEK_API_KEY),
          github_configured: Boolean(env.GITHUB_TOKEN?.trim())
        });
      }

      if (pathname === "/api/deepseek/status") {
        if (request.method !== "GET") {
          return errorResponse(400, "invalid_request", "该接口只接受 GET");
        }
        return deepSeekStatus(env, workerDependencies);
      }

      if (pathname === "/api/deepseek/responses-probe") {
        if (request.method !== "GET") {
          return errorResponse(400, "invalid_request", "该接口只接受 GET");
        }
        return deepSeekResponsesProbe(env, workerDependencies);
      }

      if (pathname === "/api/github/status") {
        if (request.method !== "GET") {
          return errorResponse(400, "invalid_request", "该接口只接受 GET");
        }
        return githubStatus(env, workerDependencies);
      }

      if (pathname === "/api/songs/generate") {
        if (request.method !== "POST") {
          return errorResponse(400, "invalid_request", "该接口只接受 POST");
        }
        return generateSong(request, env, workerDependencies);
      }

      if (pathname === "/api/songs/publish") {
        if (request.method !== "POST") {
          return errorResponse(400, "invalid_request", "该接口只接受 POST");
        }
        return publishSong(request, env, workerDependencies);
      }

      return jsonResponse({ status: "not_implemented" }, 501);
    }
  };
}

export default createWorker();
