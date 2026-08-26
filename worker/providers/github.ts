import type { Song } from "../../src/lib/song-schema";

export type GitHubErrorCode =
  | "duplicate_song"
  | "github_auth_failed"
  | "github_conflict"
  | "github_rate_limited"
  | "github_upstream_error";

export type GitHubErrorReason =
  | "bad_credentials"
  | "user_agent_required"
  | "insufficient_permissions"
  | "repository_not_found"
  | "branch_protected"
  | "rate_limited"
  | "unknown_forbidden";

export class GitHubProviderError extends Error {
  constructor(readonly code: GitHubErrorCode, readonly reason?: GitHubErrorReason) {
    super(code);
    this.name = "GitHubProviderError";
  }
}

export interface GitHubPublishResult {
  commit_sha: string;
  commit_url: string;
  song_path: string;
  deployment_pending: true;
}

export interface GitHubRepositoryStatus {
  status: "ok";
  authenticated: true;
  repository_accessible: true;
  push_permission: boolean;
}

interface GitHubProviderOptions { fetch?: typeof fetch }

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function standardErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const payload = await response.json() as { message?: unknown };
    return typeof payload.message === "string" ? payload.message.toLocaleLowerCase("en-US") : undefined;
  } catch {
    return undefined;
  }
}

async function mappedError(response: Response): Promise<GitHubProviderError> {
  if (response.status === 401) {
    return new GitHubProviderError("github_auth_failed", "bad_credentials");
  }
  if (response.status === 403) {
    const message = await standardErrorMessage(response);
    if (response.headers.get("x-ratelimit-remaining") === "0" || message?.includes("rate limit")) {
      return new GitHubProviderError("github_rate_limited", "rate_limited");
    }
    if (message?.includes("user agent required")) {
      return new GitHubProviderError("github_auth_failed", "user_agent_required");
    }
    if (message?.includes("protected branch")) {
      return new GitHubProviderError("github_conflict", "branch_protected");
    }
    if (
      message?.includes("resource not accessible") ||
      message?.includes("must have push access") ||
      message?.includes("insufficient permission")
    ) {
      return new GitHubProviderError("github_auth_failed", "insufficient_permissions");
    }
    return new GitHubProviderError("github_auth_failed", "unknown_forbidden");
  }
  if (response.status === 409) return new GitHubProviderError("github_conflict");
  if (response.status === 422) return new GitHubProviderError("duplicate_song");
  if (response.status === 429) {
    return new GitHubProviderError("github_rate_limited", "rate_limited");
  }
  if (response.status === 404) {
    return new GitHubProviderError("github_auth_failed", "repository_not_found");
  }
  return new GitHubProviderError("github_upstream_error");
}

export class GitHubContentsProvider {
  private readonly fetchImplementation: typeof fetch;
  private readonly token: string;

  constructor(
    token: string,
    private readonly repository: string,
    private readonly branch: string,
    options: GitHubProviderOptions = {}
  ) {
    this.token = token.trim();
    this.fetchImplementation = options.fetch ?? fetch;
  }

  private standardHeaders() {
    return {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "Guitare-Songbook-Worker/1.0"
    };
  }

  async checkRepositoryStatus(): Promise<GitHubRepositoryStatus> {
    const [owner, repositoryName] = this.repository.split("/");
    if (!owner || !repositoryName || this.repository.split("/").length !== 2) {
      throw new GitHubProviderError("github_upstream_error");
    }
    const fetchImplementation = this.fetchImplementation;
    let response: Response;
    try {
      response = await fetchImplementation(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}`,
        { method: "GET", headers: this.standardHeaders() }
      );
    } catch {
      throw new GitHubProviderError("github_upstream_error");
    }
    if (!response.ok) throw await mappedError(response);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new GitHubProviderError("github_upstream_error");
    }
    const pushPermission = payload && typeof payload === "object" && "permissions" in payload
      ? (payload as { permissions?: { push?: unknown } }).permissions?.push
      : undefined;
    if (typeof pushPermission !== "boolean") {
      throw new GitHubProviderError("github_upstream_error");
    }
    return {
      status: "ok",
      authenticated: true,
      repository_accessible: true,
      push_permission: pushPermission
    };
  }

  async createSong(song: Song): Promise<GitHubPublishResult> {
    const [owner, repositoryName] = this.repository.split("/");
    if (!owner || !repositoryName || this.repository.split("/").length !== 2) {
      throw new GitHubProviderError("github_upstream_error");
    }
    const songPath = `src/content/songs/${song.slug}.json`;
    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/contents/${songPath}`;
    const headers = this.standardHeaders();
    const fetchImplementation = this.fetchImplementation;

    let existing: Response;
    try {
      existing = await fetchImplementation(`${apiUrl}?ref=${encodeURIComponent(this.branch)}`, {
        method: "GET",
        headers
      });
    } catch {
      throw new GitHubProviderError("github_upstream_error");
    }
    if (existing.ok) throw new GitHubProviderError("duplicate_song");
    if (existing.status !== 404) throw await mappedError(existing);

    let created: Response;
    try {
      created = await fetchImplementation(apiUrl, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `feat(songbook): add ${song.artist} - ${song.title}`,
          content: base64Utf8(`${JSON.stringify(song, null, 2)}\n`),
          branch: this.branch
        })
      });
    } catch {
      throw new GitHubProviderError("github_upstream_error");
    }
    if (created.status !== 201) throw await mappedError(created);

    let payload: unknown;
    try {
      payload = await created.json();
    } catch {
      throw new GitHubProviderError("github_upstream_error");
    }
    const commit = payload && typeof payload === "object" && "commit" in payload
      ? (payload as { commit?: { sha?: unknown; html_url?: unknown } }).commit
      : undefined;
    if (
      typeof commit?.sha !== "string" ||
      !/^[a-f0-9]{7,64}$/i.test(commit.sha) ||
      typeof commit.html_url !== "string" ||
      !commit.html_url.startsWith("https://github.com/")
    ) {
      throw new GitHubProviderError("github_upstream_error");
    }
    return {
      commit_sha: commit.sha,
      commit_url: commit.html_url,
      song_path: songPath,
      deployment_pending: true
    };
  }
}
