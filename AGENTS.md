# Repository instructions

Guitare_Songbook uses Astro 7, TypeScript, pnpm, Cloudflare Workers/Wrangler, Vitest, and Pagefind.

## Working rules

- Before editing, inspect the current branch and working tree, then review the existing implementation and relevant tests.
- Make only task-related changes and preserve unrelated user changes.
- Never read or expose `.env` files, tokens, credentials, or secrets.
- Never call real DeepSeek APIs, GitHub write APIs, paid services, or production deployments during tests. Mock all external services in tests.
- Do not commit, push, create pull requests, merge, deploy, rewrite history, change remotes, or install or upgrade dependencies unless explicitly authorized or required by the task.
- Preserve `Song` and `SongCandidate` schema compatibility, `RepeatBlock` validation, and `lyric_sets` behavior.
- Published song pages and previews must reuse the shared song-sheet rendering path.
- Keep provider, rendering, editing, publishing, and deployment concerns separated.

## Verification

Run the relevant checks, including the full set when the task warrants it:

```sh
pnpm verify
pnpm build
pnpm exec wrangler deploy --dry-run
git status --short
```

A Wrangler dry-run is permitted. A real deployment is forbidden without explicit authorization.

## Reporting

Report changed files; tests and their results; any external API or secret access; and whether any commit, push, pull request, or deployment occurred.
