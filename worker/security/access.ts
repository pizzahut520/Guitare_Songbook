import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AccessEnv {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  ACCESS_ALLOWED_EMAIL?: string;
}

export type AccessVerificationResult =
  | { ok: true; email: string }
  | {
      ok: false;
      status: 401 | 403 | 503;
      code:
        | "access_not_configured"
        | "access_required"
        | "invalid_access_token"
        | "access_denied";
      message: string;
    };

interface AccessVerifierOptions {
  createKeySet?: (url: URL) => JWTVerifyGetKey;
}

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function normalizedTeamDomain(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return null;
    }
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function productionKeySet(url: URL): JWTVerifyGetKey {
  const cacheKey = url.href;
  const cached = remoteKeySets.get(cacheKey);
  if (cached) return cached;
  const keySet = createRemoteJWKSet(url);
  remoteKeySets.set(cacheKey, keySet);
  return keySet;
}

export function createAccessVerifier(options: AccessVerifierOptions = {}) {
  const createKeySet = options.createKeySet ?? productionKeySet;

  return async function verifyAccess(
    request: Request,
    env: AccessEnv
  ): Promise<AccessVerificationResult> {
    const teamDomain = env.CF_ACCESS_TEAM_DOMAIN
      ? normalizedTeamDomain(env.CF_ACCESS_TEAM_DOMAIN.trim())
      : null;
    const audience = env.CF_ACCESS_AUD?.trim();
    const allowedEmail = env.ACCESS_ALLOWED_EMAIL?.trim();

    if (!teamDomain || !audience || !allowedEmail) {
      return {
        ok: false,
        status: 503,
        code: "access_not_configured",
        message: "Access 身份验证尚未配置"
      };
    }

    const token = request.headers.get("cf-access-jwt-assertion");
    if (!token) {
      return {
        ok: false,
        status: 401,
        code: "access_required",
        message: "需要 Cloudflare Access 身份验证"
      };
    }

    let email: string;
    try {
      const jwksUrl = new URL(`${teamDomain}/cdn-cgi/access/certs`);
      const { payload } = await jwtVerify(token, createKeySet(jwksUrl), {
        algorithms: ["RS256"],
        issuer: teamDomain,
        audience,
        requiredClaims: ["exp", "email"]
      });
      if (typeof payload.email !== "string" || !payload.email.trim()) {
        throw new Error("Email claim is missing");
      }
      email = payload.email.trim();
    } catch {
      return {
        ok: false,
        status: 401,
        code: "invalid_access_token",
        message: "Access 身份令牌无效"
      };
    }

    if (email.toLocaleLowerCase("en-US") !== allowedEmail.toLocaleLowerCase("en-US")) {
      return {
        ok: false,
        status: 403,
        code: "access_denied",
        message: "当前账号无权访问此接口"
      };
    }

    return { ok: true, email };
  };
}

export type AccessVerifier = ReturnType<typeof createAccessVerifier>;

export const verifyAccess = createAccessVerifier();
