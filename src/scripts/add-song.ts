import type { SongCandidate } from "../lib/song-candidate-schema";

const form = document.querySelector<HTMLFormElement>("[data-generate-form]");
const button = document.querySelector<HTMLButtonElement>("[data-generate-button]");
const status = document.querySelector<HTMLElement>("[data-generate-status]");
const candidatePanel = document.querySelector<HTMLElement>("[data-candidate]");

function setText(selector: string, value: string | number) {
  const element = document.querySelector<HTMLElement>(selector);
  if (element) element.textContent = String(value);
}

function renderList(selector: string, values: string[], emptyText: string) {
  const list = document.querySelector<HTMLUListElement>(selector);
  if (!list) return;
  list.replaceChildren(
    ...(values.length ? values : [emptyText]).map((value) => {
      const item = document.createElement("li");
      item.textContent = value;
      return item;
    })
  );
}

function renderCandidate(candidate: SongCandidate) {
  setText("[data-candidate-title]", candidate.matched_song.title);
  setText("[data-candidate-artist]", candidate.matched_song.artist);
  setText(
    "[data-candidate-confidence]",
    `匹配度 ${Math.round(candidate.matched_song.confidence * 100)}%`
  );
  setText("[data-candidate-key]", candidate.song.original_key);
  setText("[data-candidate-degree-key]", candidate.song.degree_key);
  setText("[data-candidate-capo]", candidate.song.capo);
  setText(
    "[data-candidate-version]",
    candidate.matched_song.version ?? candidate.matched_song.edition ?? "未注明"
  );

  const sources = document.querySelector<HTMLUListElement>("[data-candidate-sources]");
  sources?.replaceChildren(
    ...candidate.sources.map((source) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      link.textContent = `${source.title} · ${source.source_type}`;
      item.append(link);
      return item;
    })
  );
  renderList("[data-candidate-warnings]", candidate.warnings, "没有额外警告");
  renderList("[data-candidate-uncertain]", candidate.uncertain_fields, "没有标记字段");
  setText("[data-candidate-json]", JSON.stringify(candidate, null, 2));
  if (candidatePanel) candidatePanel.hidden = false;
}

function errorMessage(httpStatus: number, payload: unknown): string {
  const serverError =
    typeof payload === "object" && payload !== null && "error" in payload
      ? (payload as {
          error?: {
            code?: unknown;
            message?: unknown;
            reason?: unknown;
            issues?: unknown;
          };
        }).error
      : undefined;
  if (serverError && typeof serverError.message === "string") {
    const lines = [serverError.message];
    if (typeof serverError.code === "string") lines.push(`错误码：${serverError.code}`);
    if (typeof serverError.reason === "string") lines.push(`原因：${serverError.reason}`);
    if (Array.isArray(serverError.issues)) {
      const paths = serverError.issues.flatMap((issue) =>
        issue && typeof issue === "object" && "path" in issue &&
        typeof (issue as { path?: unknown }).path === "string"
          ? [(issue as { path: string }).path || "(root)"]
          : []
      );
      if (paths.length) lines.push(`无效字段：${paths.join("、")}`);
    }
    return lines.join("\n");
  }
  if (httpStatus === 401) return "Access 登录已失效，请刷新页面重新登录。";
  if (httpStatus === 503) return "歌曲生成服务尚未配置。";
  if (httpStatus === 504) return "搜索超时，请稍后再试。";
  return "生成失败，请检查输入后重试。";
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const title = String(data.get("title") ?? "").trim();
  const artist = String(data.get("artist") ?? "").trim();
  if (!title || !button || !status) return;

  button.disabled = true;
  button.textContent = "正在搜索并生成…";
  status.className = "add-status is-loading";
  status.textContent = "正在核对歌曲版本、来源与和弦结构，可能需要几十秒。";
  if (candidatePanel) candidatePanel.hidden = true;

  try {
    const response = await fetch("/api/songs/generate", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, ...(artist ? { artist } : {}) })
    });
    const payload: unknown = await response.json();
    if (!response.ok) throw new Error(errorMessage(response.status, payload));
    renderCandidate(payload as SongCandidate);
    status.className = "add-status is-success";
    status.textContent = "候选已生成。请重点核对版本、歌词分句、和弦与来源。";
  } catch (error) {
    status.className = "add-status is-error";
    status.textContent = error instanceof Error ? error.message : "生成失败，请稍后再试。";
  } finally {
    button.disabled = false;
    button.textContent = "查找并生成";
  }
});
