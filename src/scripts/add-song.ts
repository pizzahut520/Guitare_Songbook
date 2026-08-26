import { SongCandidateSchema, type SongCandidate } from "../lib/song-candidate-schema";
import {
  findDuplicateSong,
  SongIndexSchema,
  type SongIndexEntry
} from "../lib/song-index";
import { createPublishGuard } from "../lib/publish-guard";
import {
  addLyricPhrase,
  applyCandidateSongEdit,
  deleteBlock,
  deleteLyricPhrase,
  expandRepeatBlock,
  markBlockAsRepeat,
  mergeAdjacentLyricBlocks,
  moveBlock,
  splitLyricBlock,
  updateBlock,
  updateLyricPhrase,
  type EditableSong
} from "../lib/candidate-editor";
import { renderSongPreview } from "../lib/song-preview";
import type { SongBlock } from "../lib/song-schema";

const form = document.querySelector<HTMLFormElement>("[data-generate-form]");
const button = document.querySelector<HTMLButtonElement>("[data-generate-button]");
const status = document.querySelector<HTMLElement>("[data-generate-status]");
const candidatePanel = document.querySelector<HTMLElement>("[data-candidate]");
const duplicateNotice = document.querySelector<HTMLElement>("[data-duplicate]");
const duplicateLink = document.querySelector<HTMLAnchorElement>("[data-duplicate-link]");
const confirmation = document.querySelector<HTMLInputElement>("[data-publish-confirm]");
const publishButton = document.querySelector<HTMLButtonElement>("[data-publish-button]");
const publishConfig = document.querySelector<HTMLElement>("[data-publish-config]");
const publishResult = document.querySelector<HTMLElement>("[data-publish-result]");
const publishCommit = document.querySelector<HTMLAnchorElement>("[data-publish-commit]");
const blockEditor = document.querySelector<HTMLElement>("[data-block-editor]");
const editorErrors = document.querySelector<HTMLElement>("[data-editor-errors]");
const editorErrorList = document.querySelector<HTMLUListElement>("[data-editor-error-list]");
const preview = document.querySelector<HTMLElement>("[data-song-preview]");
const previewViewport = document.querySelector<HTMLElement>("[data-preview-viewport]");
const previewMode = document.querySelector<HTMLSelectElement>("[data-preview-mode]");
const previewTransposeValue = document.querySelector<HTMLElement>("[data-preview-transpose]");
let publishGuard = createPublishGuard();

let currentCandidate: SongCandidate | undefined;
let draftCandidate: SongCandidate | undefined;
let currentDuplicate: SongIndexEntry | undefined;
let currentSongIndex: SongIndexEntry[] = [];
let githubConfigured = false;
let songIndexPromise: Promise<SongIndexEntry[]> | undefined;
let previewTranspose = 0;
let previewHarmonyMode: "degree" | "chord" = "degree";

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

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function actionButton(label: string, action: string, index: number, ariaLabel = label) {
  const control = node("button", "editor-button", label);
  control.type = "button";
  control.dataset.editorAction = action;
  control.dataset.blockIndex = String(index);
  control.setAttribute("aria-label", ariaLabel);
  return control;
}

function fieldLabel(label: string, control: HTMLElement) {
  const wrapper = node("label", "editor-field");
  wrapper.append(node("span", undefined, label), control);
  return wrapper;
}

function textInput(value: string, field: string, blockIndex: number) {
  const input = node("input");
  input.type = "text";
  input.value = value;
  input.dataset.editorField = field;
  input.dataset.blockIndex = String(blockIndex);
  return input;
}

function selectInput(
  value: string,
  field: string,
  blockIndex: number,
  options: Array<[string, string]>
) {
  const select = node("select");
  select.dataset.editorField = field;
  select.dataset.blockIndex = String(blockIndex);
  options.forEach(([optionValue, label]) => {
    const option = node("option", undefined, label);
    option.value = optionValue;
    option.selected = optionValue === value;
    select.append(option);
  });
  return select;
}

function priorPlayableBlocks(song: EditableSong, blockIndex: number) {
  return song.blocks.slice(0, blockIndex).filter(
    (block): block is Extract<SongBlock, { type: "lyric" | "instrument" }> =>
      block.type === "lyric" || block.type === "instrument"
  );
}

function renderBlockEditor(song: EditableSong) {
  if (!blockEditor) return;
  const cards = song.blocks.map((block, blockIndex) => {
    const card = node("article", "block-editor-card");
    card.dataset.blockType = block.type;
    const heading = node("header", "block-editor-card__header");
    const title = node("div");
    title.append(
      node("strong", undefined, block.type === "lyric" ? "歌词段" : block.type === "instrument"
        ? "器乐段" : block.type === "repeat" ? "重复段" : "和弦说明"),
      node("code", undefined, block.id)
    );
    const actions = node("div", "block-editor-card__actions");
    const up = actionButton("↑", "move-up", blockIndex, `上移 ${block.id}`);
    const down = actionButton("↓", "move-down", blockIndex, `下移 ${block.id}`);
    up.disabled = blockIndex === 0;
    down.disabled = blockIndex === song.blocks.length - 1;
    actions.append(up, down);
    if (block.type !== "theory_legend") actions.append(actionButton("删除", "delete-block", blockIndex));
    heading.append(title, actions);
    card.append(heading);

    const previous = priorPlayableBlocks(song, blockIndex);
    if (block.type !== "repeat" && block.type !== "theory_legend" && previous.length) {
      const repeatRow = node("div", "repeat-create-row");
      const target = selectInput(previous[previous.length - 1].id, "repeat-target-draft", blockIndex,
        previous.map((item) => [item.id, `${item.id} · ${item.type === "lyric" ? "歌词" : item.label}`]));
      repeatRow.append(fieldLabel("标记为此前段落的重复", target), actionButton("转换为重复", "mark-repeat", blockIndex));
      card.append(repeatRow);
    }

    if (block.type === "lyric") {
      const meta = node("div", "editor-meta-grid");
      meta.append(
        fieldLabel("结构类型", selectInput(block.section_role ?? "other", "section-role", blockIndex, [
          ["verse", "主歌"], ["pre_chorus", "预副歌"], ["chorus", "副歌"],
          ["bridge", "Bridge"], ["outro", "尾段"], ["other", "其他"]
        ])),
        fieldLabel("编辑器标签", textInput(block.section_label ?? "", "section-label", blockIndex)),
        fieldLabel("段落间距", selectInput(block.spacing, "spacing", blockIndex, [
          ["compact", "紧凑"], ["normal", "正常"], ["generous", "宽松"]
        ]))
      );
      card.append(meta);
      const phrases = node("div", "phrase-editor");
      block.chords.forEach((chord, phraseIndex) => {
        const phrase = node("fieldset", "phrase-editor-row");
        const legend = node("legend", undefined, `分句 ${phraseIndex + 1}`);
        phrase.append(legend);
        const chordInput = textInput(chord, "phrase-chord", blockIndex);
        chordInput.dataset.phraseIndex = String(phraseIndex);
        phrase.append(fieldLabel("级数和弦", chordInput));
        const rows = block.lyrics ? [block.lyrics] : block.lyric_sets ?? [];
        rows.forEach((row, lyricSetIndex) => {
          const lyricInput = textInput(row[phraseIndex] ?? "", "phrase-lyric", blockIndex);
          lyricInput.dataset.phraseIndex = String(phraseIndex);
          lyricInput.dataset.lyricSetIndex = String(lyricSetIndex);
          const variant = block.variant_labels?.[lyricSetIndex];
          phrase.append(fieldLabel(variant ? `歌词 ${variant}` : rows.length > 1 ? `歌词组 ${lyricSetIndex + 1}` : "歌词", lyricInput));
        });
        const phraseActions = node("div", "phrase-editor-actions");
        if (phraseIndex > 0) {
          const split = actionButton("从此处分段", "split-block", blockIndex);
          split.dataset.phraseIndex = String(phraseIndex);
          phraseActions.append(split);
        }
        const remove = actionButton("删除分句", "delete-phrase", blockIndex);
        remove.dataset.phraseIndex = String(phraseIndex);
        remove.disabled = block.chords.length <= 1;
        phraseActions.append(remove);
        phrase.append(phraseActions);
        phrases.append(phrase);
      });
      card.append(phrases);
      const lyricActions = node("div", "block-editor-footer");
      lyricActions.append(actionButton("＋ 添加和弦/歌词分句", "add-phrase", blockIndex));
      if (song.blocks[blockIndex + 1]?.type === "lyric") {
        lyricActions.append(actionButton("与下一歌词段合并", "merge-next", blockIndex));
      }
      card.append(lyricActions);
    } else if (block.type === "instrument") {
      const fields = node("div", "editor-meta-grid");
      fields.append(
        fieldLabel("标签", textInput(block.label, "instrument-label", blockIndex)),
        fieldLabel("级数进行", textInput(block.progression, "instrument-progression", blockIndex)),
        fieldLabel("重复标记", textInput(block.repeat ?? "", "instrument-repeat", blockIndex))
      );
      card.append(fields);
    } else if (block.type === "repeat") {
      const fields = node("div", "editor-meta-grid");
      const targets = previous.map((item) => [item.id, `${item.id} · ${item.type === "lyric" ? "歌词" : item.label}`] as [string, string]);
      fields.append(
        fieldLabel("重复目标", selectInput(block.ref, "repeat-ref", blockIndex, targets)),
        fieldLabel("次数", (() => {
          const input = node("input");
          input.type = "number";
          input.min = "1";
          input.max = "8";
          input.value = String(block.times);
          input.dataset.editorField = "repeat-times";
          input.dataset.blockIndex = String(blockIndex);
          return input;
        })()),
        fieldLabel("编辑器标签", textInput(block.section_label ?? "", "repeat-label", blockIndex))
      );
      card.append(fields, actionButton("展开为独立段落", "expand-repeat", blockIndex));
    } else {
      card.append(node("p", "readonly-note", "和弦结构说明在 Phase 2C 中只读。"));
    }
    return card;
  });
  blockEditor.replaceChildren(...cards);
}

function validationPaths(candidate: SongCandidate): string[] {
  const parsed = SongCandidateSchema.safeParse(candidate);
  return parsed.success
    ? []
    : parsed.error.issues.slice(0, 10).map((issue) => issue.path.map(String).join(".") || "(root)");
}

function renderEditorValidation(paths: string[]) {
  if (editorErrors) editorErrors.hidden = paths.length === 0;
  editorErrorList?.replaceChildren(...paths.map((path) => node("li", undefined, path)));
}

function renderPreview(song: EditableSong) {
  if (!preview) return;
  renderSongPreview(preview, song, { mode: previewHarmonyMode, transpose: previewTranspose });
  if (previewTransposeValue) {
    const sign = previewTranspose > 0 ? "+" : "";
    previewTransposeValue.textContent = `移调 ${sign}${previewTranspose}`;
  }
}

function applySongEdit(song: EditableSong, rerenderEditor = true) {
  if (!draftCandidate || publishGuard.locked) return;
  const edited = applyCandidateSongEdit(
    { candidate: draftCandidate, confirmed: Boolean(confirmation?.checked), duplicate: currentDuplicate },
    song,
    currentSongIndex
  );
  draftCandidate = edited.candidate;
  currentDuplicate = edited.duplicate;
  if (confirmation) confirmation.checked = false;
  const parsed = SongCandidateSchema.safeParse(draftCandidate);
  currentCandidate = parsed.success ? parsed.data : undefined;
  renderEditorValidation(validationPaths(draftCandidate));
  showDuplicate(currentDuplicate);
  renderCandidate(draftCandidate);
  if (rerenderEditor) renderBlockEditor(song);
  renderPreview(song);
  updatePublishState();
}

function loadSongIndex(): Promise<SongIndexEntry[]> {
  songIndexPromise ??= fetch("/song-index.json", { credentials: "same-origin" })
    .then(async (response) => {
      if (!response.ok) throw new Error("无法读取曲库索引");
      const parsed = SongIndexSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("曲库索引格式无效");
      return parsed.data;
    });
  return songIndexPromise;
}

function updatePublishState() {
  if (blockEditor) {
    blockEditor.inert = publishGuard.locked;
    blockEditor.setAttribute("aria-busy", String(publishGuard.locked));
  }
  if (confirmation) confirmation.disabled = !currentCandidate || Boolean(currentDuplicate) || publishGuard.locked;
  if (publishButton) {
    publishButton.disabled =
      !currentCandidate ||
      Boolean(currentDuplicate) ||
      !confirmation?.checked ||
      !githubConfigured ||
      publishGuard.locked;
  }
}

function showDuplicate(duplicate?: SongIndexEntry) {
  currentDuplicate = duplicate;
  if (duplicateNotice) duplicateNotice.hidden = !duplicate;
  if (duplicate && duplicateLink) {
    duplicateLink.href = duplicate.url;
    duplicateLink.textContent = `打开《${duplicate.title}》`;
  }
  if (confirmation) confirmation.checked = false;
  updatePublishState();
}

async function refreshGitHubConfiguration() {
  try {
    const response = await fetch("/api/health", { credentials: "same-origin" });
    const payload = await response.json() as { github_configured?: unknown };
    githubConfigured = response.ok && payload.github_configured === true;
  } catch {
    githubConfigured = false;
  }
  if (publishConfig) {
    publishConfig.textContent = githubConfigured
      ? "GitHub 写入已配置。确认无误后可以提交。"
      : "GitHub 写入尚未配置，加入曲库暂不可用。";
  }
  updatePublishState();
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
  publishGuard = createPublishGuard();
  currentCandidate = undefined;
  draftCandidate = undefined;
  currentSongIndex = [];
  blockEditor?.replaceChildren();
  preview?.replaceChildren();
  renderEditorValidation([]);
  showDuplicate(undefined);
  if (confirmation) confirmation.checked = false;
  if (publishResult) publishResult.hidden = true;

  try {
    const response = await fetch("/api/songs/generate", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, ...(artist ? { artist } : {}) })
    });
    const payload: unknown = await response.json();
    if (!response.ok) throw new Error(errorMessage(response.status, payload));
    const candidate = SongCandidateSchema.safeParse(payload);
    if (!candidate.success) throw new Error("候选未通过浏览器端数据校验。\n错误码：invalid_candidate");
    currentCandidate = candidate.data;
    draftCandidate = candidate.data;
    renderCandidate(candidate.data);
    currentSongIndex = await loadSongIndex();
    const duplicate = findDuplicateSong(currentSongIndex, candidate.data.song);
    showDuplicate(duplicate);
    renderBlockEditor(candidate.data.song);
    renderPreview(candidate.data.song);
    renderEditorValidation([]);
    status.className = "add-status is-success";
    status.textContent = duplicate
      ? "候选已生成，但歌曲已存在，不能重复加入。"
      : "候选已生成。请重点核对版本、歌词分句、和弦与来源。";
  } catch (error) {
    status.className = "add-status is-error";
    status.textContent = error instanceof Error ? error.message : "生成失败，请稍后再试。";
  } finally {
    button.disabled = false;
    button.textContent = "查找并生成";
  }
});

blockEditor?.addEventListener("input", (event) => {
  if (!draftCandidate || !(event.target instanceof HTMLInputElement)) return;
  const input = event.target;
  const field = input.dataset.editorField;
  const blockIndex = Number(input.dataset.blockIndex);
  const phraseIndex = Number(input.dataset.phraseIndex);
  const lyricSetIndex = Number(input.dataset.lyricSetIndex ?? 0);
  try {
    let song = draftCandidate.song;
    if (field === "phrase-chord") {
      song = updateLyricPhrase(song, blockIndex, phraseIndex, "chord", input.value);
    } else if (field === "phrase-lyric") {
      song = updateLyricPhrase(song, blockIndex, phraseIndex, "lyric", input.value, lyricSetIndex);
    } else {
      song = updateBlock(song, blockIndex, (block) => {
        if (field === "section-label" && block.type === "lyric") {
          block.section_label = input.value || undefined;
        } else if (field === "instrument-label" && block.type === "instrument") {
          block.label = input.value;
        } else if (field === "instrument-progression" && block.type === "instrument") {
          block.progression = input.value;
        } else if (field === "instrument-repeat" && block.type === "instrument") {
          block.repeat = input.value || undefined;
        } else if (field === "repeat-label" && block.type === "repeat") {
          block.section_label = input.value || undefined;
        } else if (field === "repeat-times" && block.type === "repeat") {
          block.times = Number(input.value);
        }
      });
    }
    applySongEdit(song, false);
  } catch {
    // Structural buttons and Schema validation provide the user-facing error state.
  }
});

blockEditor?.addEventListener("change", (event) => {
  if (!draftCandidate || !(event.target instanceof HTMLSelectElement)) return;
  const select = event.target;
  const field = select.dataset.editorField;
  const blockIndex = Number(select.dataset.blockIndex);
  if (!field || field === "repeat-target-draft") return;
  const song = updateBlock(draftCandidate.song, blockIndex, (block) => {
    if (field === "section-role" && block.type === "lyric") {
      block.section_role = select.value as typeof block.section_role;
    } else if (field === "spacing" && block.type === "lyric") {
      block.spacing = select.value as typeof block.spacing;
    } else if (field === "repeat-ref" && block.type === "repeat") {
      block.ref = select.value;
    }
  });
  applySongEdit(song);
});

blockEditor?.addEventListener("click", (event) => {
  if (!draftCandidate) return;
  const target = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("[data-editor-action]")
    : null;
  if (!target) return;
  const action = target.dataset.editorAction;
  const blockIndex = Number(target.dataset.blockIndex);
  const phraseIndex = Number(target.dataset.phraseIndex);
  try {
    let song = draftCandidate.song;
    if (action === "move-up") song = moveBlock(song, blockIndex, -1);
    else if (action === "move-down") song = moveBlock(song, blockIndex, 1);
    else if (action === "delete-block") song = deleteBlock(song, blockIndex);
    else if (action === "add-phrase") song = addLyricPhrase(song, blockIndex);
    else if (action === "delete-phrase") song = deleteLyricPhrase(song, blockIndex, phraseIndex);
    else if (action === "split-block") song = splitLyricBlock(song, blockIndex, phraseIndex);
    else if (action === "merge-next") song = mergeAdjacentLyricBlocks(song, blockIndex);
    else if (action === "expand-repeat") song = expandRepeatBlock(song, blockIndex);
    else if (action === "mark-repeat") {
      const selector = target.closest(".block-editor-card")?.querySelector<HTMLSelectElement>(
        '[data-editor-field="repeat-target-draft"]'
      );
      if (!selector) throw new Error("invalid_repeat_ref");
      song = markBlockAsRepeat(song, blockIndex, selector.value);
    } else return;
    applySongEdit(song);
  } catch (error) {
    if (status) {
      status.className = "add-status is-error";
      status.textContent = error instanceof Error ? `编辑失败：${error.message}` : "编辑失败";
    }
  }
});

previewMode?.addEventListener("change", () => {
  previewHarmonyMode = previewMode.value === "chord" ? "chord" : "degree";
  if (draftCandidate) renderPreview(draftCandidate.song);
});

document.querySelector("[data-preview-transpose-down]")?.addEventListener("click", () => {
  previewTranspose = Math.max(-6, previewTranspose - 1);
  if (draftCandidate) renderPreview(draftCandidate.song);
});

document.querySelector("[data-preview-transpose-up]")?.addEventListener("click", () => {
  previewTranspose = Math.min(6, previewTranspose + 1);
  if (draftCandidate) renderPreview(draftCandidate.song);
});

document.querySelectorAll<HTMLButtonElement>("[data-preview-width]").forEach((control) => {
  control.addEventListener("click", () => {
    const width = control.dataset.previewWidth ?? "desktop";
    previewViewport?.classList.remove("is-phone", "is-tablet", "is-desktop");
    previewViewport?.classList.add(`is-${width}`);
    document.querySelectorAll<HTMLButtonElement>("[data-preview-width]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button === control));
    });
  });
});

confirmation?.addEventListener("change", updatePublishState);

publishButton?.addEventListener("click", async () => {
  if (!currentCandidate || currentDuplicate || !confirmation?.checked || !githubConfigured) return;
  if (!publishGuard.begin()) return;
  updatePublishState();
  publishButton.textContent = "正在提交…";
  if (status) {
    status.className = "add-status is-loading";
    status.textContent = "正在安全提交歌曲 JSON 到 GitHub…";
  }

  try {
    const response = await fetch("/api/songs/publish", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidate: currentCandidate, confirmed: true })
    });
    const payload = await response.json() as {
      commit_url?: unknown;
      error?: { message?: unknown; code?: unknown };
    };
    if (!response.ok) throw new Error(errorMessage(response.status, payload));
    if (typeof payload.commit_url !== "string" || !payload.commit_url.startsWith("https://github.com/")) {
      throw new Error("GitHub 返回结果无效。\n错误码：github_upstream_error");
    }
    publishGuard.succeed();
    publishButton.textContent = "已提交";
    if (publishCommit) publishCommit.href = payload.commit_url;
    if (publishResult) publishResult.hidden = false;
    if (status) {
      status.className = "add-status is-success";
      status.textContent = "歌曲已提交，正在等待自动部署。";
    }
  } catch (error) {
    publishGuard.fail();
    publishButton.textContent = "加入曲库";
    if (status) {
      status.className = "add-status is-error";
      status.textContent = error instanceof Error ? error.message : "提交失败，请稍后再试。";
    }
  } finally {
    updatePublishState();
  }
});

void refreshGitHubConfiguration();
