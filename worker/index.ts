import {
  SongCandidateSchema,
  SongQuerySchema,
  type SongQuery
} from "../src/lib/song-candidate-schema";
import { DeepSeekProvider } from "./providers/deepseek";
import {
  LlmProviderError,
  LlmProviderTimeoutError,
  type LlmProvider
} from "./providers/llm-provider";
import {
  verifyAccess,
  type AccessEnv,
  type AccessVerifier
} from "./security/access";

const MAX_REQUEST_BODY_BYTES = 2_048;

export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env extends AccessEnv {
  ASSETS: Fetcher;
  DEEPSEEK_API_KEY?: string;
}

export interface WorkerContext {
  access?: unknown;
}

interface WorkerDependencies {
  createProvider(apiKey: string): LlmProvider;
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

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0].trim() === "application/json";
}

function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

async function readLimitedBody(request: Request): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
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
    if (byteLength > MAX_REQUEST_BODY_BYTES) {
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
      return errorResponse(502, "invalid_provider_output", "生成结果未通过数据校验");
    }
    return jsonResponse(candidate.data);
  } catch (error) {
    if (error instanceof LlmProviderTimeoutError) {
      return errorResponse(504, "provider_timeout", "歌曲生成服务响应超时");
    }
    if (error instanceof LlmProviderError) {
      return errorResponse(502, "provider_error", "歌曲生成服务返回错误");
    }
    return errorResponse(502, "provider_error", "歌曲生成服务暂时不可用");
  }
}

export function createWorker(
  dependencies: WorkerDependencies = {
    createProvider: (apiKey) => new DeepSeekProvider(apiKey),
    verifyAccess
  }
) {
  return {
    async fetch(request: Request, env: Env, _ctx: WorkerContext = {}): Promise<Response> {
      const { pathname } = new URL(request.url);

      if (!pathname.startsWith("/api/")) {
        return env.ASSETS.fetch(request);
      }

      const access = await dependencies.verifyAccess(request, env);
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
          deepseek_configured: Boolean(env.DEEPSEEK_API_KEY)
        });
      }

      if (pathname === "/api/songs/generate") {
        if (request.method !== "POST") {
          return errorResponse(400, "invalid_request", "该接口只接受 POST");
        }
        return generateSong(request, env, dependencies);
      }

      return jsonResponse({ status: "not_implemented" }, 501);
    }
  };
}

export default createWorker();
