import type { Song } from "../../src/lib/song-schema";

export type GitHubErrorCode =
  | "duplicate_song"
  | "github_auth_failed"
  | "github_conflict"
  | "github_rate_limited"
  | "github_upstream_error";

export class GitHubProviderError extends Error {
  constructor(readonly code: GitHubErrorCode) {
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

interface GitHubProviderOptions { fetch?: typeof fetch }

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function mappedError(response: Response): GitHubProviderError {
  if (response.status === 401) return new GitHubProviderError("github_auth_failed");
  if (response.status === 403) {
    return new GitHubProviderError(
      response.headers.get("x-ratelimit-remaining") === "0"
        ? "github_rate_limited"
        : "github_auth_failed"
    );
  }
  if (response.status === 409) return new GitHubProviderError("github_conflict");
  if (response.status === 422) return new GitHubProviderError("duplicate_song");
  if (response.status === 429) return new GitHubProviderError("github_rate_limited");
  return new GitHubProviderError("github_upstream_error");
}

export class GitHubContentsProvider {
  private readonly fetchImplementation: typeof fetch;

  constructor(
    private readonly token: string,
    private readonly repository: string,
    private readonly branch: string,
    options: GitHubProviderOptions = {}
  ) {
    this.fetchImplementation = options.fetch ?? fetch;
  }

  async createSong(song: Song): Promise<GitHubPublishResult> {
    const [owner, repositoryName] = this.repository.split("/");
    if (!owner || !repositoryName || this.repository.split("/").length !== 2) {
      throw new GitHubProviderError("github_upstream_error");
    }
    const songPath = `src/content/songs/${song.slug}.json`;
    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/contents/${songPath}`;
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.token}`,
      "x-github-api-version": "2026-03-10"
    };
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
    if (existing.status !== 404) throw mappedError(existing);

    let created: Response;
    try {
      created = await fetchImplementation(apiUrl, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          message: `feat(songbook): add ${song.artist} - ${song.title}`,
          content: base64Utf8(`${JSON.stringify(song, null, 2)}\n`),
          branch: this.branch
        })
      });
    } catch {
      throw new GitHubProviderError("github_upstream_error");
    }
    if (created.status !== 201) throw mappedError(created);

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
