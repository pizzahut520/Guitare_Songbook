import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JSONWebKeySet
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createAccessVerifier, type AccessEnv } from "../worker/security/access";

const teamDomain = "https://songbook-test.cloudflareaccess.com";
const audience = "test-audience-tag";
const allowedEmail = "owner@example.com";
const accessEnv: AccessEnv = {
  CF_ACCESS_TEAM_DOMAIN: teamDomain,
  CF_ACCESS_AUD: audience,
  ACCESS_ALLOWED_EMAIL: allowedEmail
};

let privateKey: CryptoKey;
let verifyAccess: ReturnType<typeof createAccessVerifier>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = "local-test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const localKeySet = createLocalJWKSet({ keys: [publicJwk] } as JSONWebKeySet);
  verifyAccess = createAccessVerifier({
    createKeySet: (url) => {
      expect(url.href).toBe(`${teamDomain}/cdn-cgi/access/certs`);
      return localKeySet;
    }
  });
});

async function signAccessToken(
  claims: {
    issuer?: string;
    audience?: string;
    email?: string;
    expiration?: number;
  } = {}
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: claims.email ?? allowedEmail })
    .setProtectedHeader({ alg: "RS256", kid: "local-test-key" })
    .setIssuer(claims.issuer ?? teamDomain)
    .setAudience(claims.audience ?? audience)
    .setIssuedAt(now)
    .setExpirationTime(claims.expiration ?? now + 300)
    .sign(privateKey);
}

function requestWithToken(token?: string) {
  return new Request("https://songbook.example/api/health", {
    headers: token ? { "Cf-Access-Jwt-Assertion": token } : undefined
  });
}

describe("Cloudflare Access JWT verification", () => {
  it("accepts a valid RS256 token and compares email case-insensitively", async () => {
    const token = await signAccessToken({ email: "OWNER@EXAMPLE.COM" });
    await expect(verifyAccess(requestWithToken(token), accessEnv)).resolves.toEqual({
      ok: true,
      email: "OWNER@EXAMPLE.COM"
    });
  });

  it("returns 503 when Access configuration is missing", async () => {
    await expect(verifyAccess(requestWithToken("not-used"), {})).resolves.toMatchObject({
      ok: false,
      status: 503,
      code: "access_not_configured"
    });
  });

  it("returns 401 when the JWT header is missing", async () => {
    await expect(verifyAccess(requestWithToken(), accessEnv)).resolves.toMatchObject({
      ok: false,
      status: 401,
      code: "access_required"
    });
  });

  it("rejects the wrong issuer", async () => {
    const token = await signAccessToken({ issuer: "https://wrong.cloudflareaccess.com" });
    await expect(verifyAccess(requestWithToken(token), accessEnv)).resolves.toMatchObject({
      ok: false,
      status: 401,
      code: "invalid_access_token"
    });
  });

  it("rejects the wrong audience", async () => {
    const token = await signAccessToken({ audience: "wrong-audience" });
    await expect(verifyAccess(requestWithToken(token), accessEnv)).resolves.toMatchObject({
      ok: false,
      status: 401,
      code: "invalid_access_token"
    });
  });

  it("rejects an expired token", async () => {
    const token = await signAccessToken({ expiration: Math.floor(Date.now() / 1000) - 10 });
    await expect(verifyAccess(requestWithToken(token), accessEnv)).resolves.toMatchObject({
      ok: false,
      status: 401,
      code: "invalid_access_token"
    });
  });

  it("rejects an authenticated but unapproved email", async () => {
    const token = await signAccessToken({ email: "someone-else@example.com" });
    await expect(verifyAccess(requestWithToken(token), accessEnv)).resolves.toMatchObject({
      ok: false,
      status: 403,
      code: "access_denied"
    });
  });
});
