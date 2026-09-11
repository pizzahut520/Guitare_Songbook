import { SongCandidateSchema, type SongCandidate } from "../lib/song-candidate-schema";
import {
  createManualLyricDraft,
  ManualLyricsParseError,
  parseAnnotatedLyrics,
  type ManualEditableCandidate,
  type ManualSongFields
} from "../lib/manual-lyric-draft";
import {
  findDuplicateSong,
  SongIndexSchema,
  type SongIndexEntry
} from "../lib/song-index";
import { createPublishGuard } from "../lib/publish-guard";
import {
  addLyricPhrase,
  addLyricBlock,
  addInstrumentBlock,
  applyCandidateSongEdit,
  combineLyricBlocksAsVariants,
  combineLyricBlockIdsAsVariants,
  compareLyricChordCompatibility,
  convertLyricsToVariants,
  deleteBlock,
  deleteLyricPhrase,
  expandRepeatBlock,
  markBlockAsRepeat,
  mergeLyricPhrases,
  mergeAdjacentLyricBlocks,
  moveLyricChord,
  moveBlock,
  removeLyricVariant,
  splitLyricBlock,
  splitLyricPhraseAt,
  splitVariantsIntoBlocks,
  swapLyricVariants,
  summarizeSongChanges,
  updateBlock,
  updateLyricVariantLabel,
  updateLyricPhrase,
  type EditableLyricBlock,
  type EditableSongBlock,
  type EditableSong
} from "../lib/candidate-editor";
import { renderSongPreview } from "../lib/song-preview";
import type { SongBlock } from "../lib/song-schema";

const form = document.querySelector<HTMLFormElement>("[data-generate-form]");
const manualForm = document.querySelector<HTMLFormElement>("[data-manual-form]");
const button = document.querySelector<HTMLButtonElement>("[data-generate-button]");
const manualButton = document.querySelector<HTMLButtonElement>("[data-manual-button]");
const status = document.querySelector<HTMLElement>("[data-generate-status]");
const manualStatus = document.querySelector<HTMLElement>("[data-manual-status]");
const manualLyrics = manualForm?.querySelector<HTMLTextAreaElement>('textarea[name="lyrics"]');
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
const editRoot = document.querySelector<HTMLElement>("[data-edit-root]");
const editSlug = editRoot?.dataset.songSlug;
const editDiff = document.querySelector<HTMLUListElement>("[data-edit-diff]");
const editDiffEmpty = document.querySelector<HTMLElement>("[data-edit-diff-empty]");
const cancelEdit = document.querySelector<HTMLAnchorElement>("[data-cancel-edit]");
const isEditMode = Boolean(editRoot && editSlug);
let publishGuard = createPublishGuard();

let currentCandidate: SongCandidate | undefined;
let draftCandidate: ManualEditableCandidate | undefined;
let currentDuplicate: SongIndexEntry | undefined;
let currentSongIndex: SongIndexEntry[] = [];
let githubConfigured = false;
let songIndexPromise: Promise<SongIndexEntry[]> | undefined;
let previewTranspose = 0;
let previewHarmonyMode: "degree" | "chord" = "degree";
let expectedSha: string | undefined;
let originalCandidate: SongCandidate | undefined;
let editDirty = false;
let isManualDraft = false;
let entryMode: "ai" | "manual" = "ai";
let variantCombine: { leftIndex: number; rightIndex?: number } | undefined;
let variantBulk: { phase: "left" | "right"; leftIds: string[]; rightIds: string[] } | undefined;

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

function renderCandidate(candidate: ManualEditableCandidate) {
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
    ...(candidate.sources.length ? candidate.sources : [{ title: "用户直接提供的文本", url: "", source_type: "other" as const }]).map((source) => {
      const item = document.createElement("li");
      if (!source.url) {
        item.textContent = source.title;
        return item;
      }
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

function renderEditDiff() {
  if (!isEditMode || !originalCandidate || !draftCandidate) return;
  const summary = summarizeSongChanges(originalCandidate.song, draftCandidate.song);
  const lines: string[] = [];
  if (summary.changedBlockIds.length) lines.push(`修改段落：${summary.changedBlockIds.join("、")}`);
  if (summary.repeatConversions) lines.push(`转换为 RepeatBlock：${summary.repeatConversions} 段`);
  if (summary.repeatExpansions) lines.push(`展开 RepeatBlock：${summary.repeatExpansions} 段`);
  if (summary.changedChords) lines.push(`和弦内容变化：${summary.changedChords} 处`);
  if (summary.movedChordPositions) lines.push(`和弦标注位置变化：${summary.movedChordPositions} 组`);
  if (summary.addedLyricPhrases) lines.push(`新增歌词分句：${summary.addedLyricPhrases}`);
  if (summary.removedLyricPhrases) lines.push(`删除歌词分句：${summary.removedLyricPhrases}`);
  if (summary.blockOrderChanged) lines.push("段落顺序已变化");
  if (summary.instrumentProgressionChanges) {
    lines.push(`Instrument progression 变化：${summary.instrumentProgressionChanges} 段`);
  }
  editDirty = lines.length > 0;
  if (editDiffEmpty) editDiffEmpty.hidden = editDirty;
  editDiff?.replaceChildren(...lines.map((line) => node("li", undefined, line)));
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

function lyricInput(value: string, blockIndex: number) {
  const input = node("textarea");
  input.rows = 1;
  input.value = value;
  input.dataset.editorField = "phrase-lyric";
  input.dataset.blockIndex = String(blockIndex);
  input.setAttribute("aria-label", "歌词");
  return input;
}

function isOrdinaryLyric(
  block: EditableSongBlock | undefined
): boolean {
  return Boolean(block && block.type === "lyric" && (block as EditableLyricBlock).lyrics &&
    !(block as EditableLyricBlock).lyric_sets);
}

function variantCompatibilityText(
  left: EditableSongBlock | undefined,
  right: EditableSongBlock | undefined
): string {
  if (!isOrdinaryLyric(left) || !isOrdinaryLyric(right)) return "只能选择普通歌词段。";
  const result = compareLyricChordCompatibility(left as EditableLyricBlock, right as EditableLyricBlock);
  if (result.compatible) return "和弦兼容；将保留 A 段的和弦原始空格。";
  if (result.reason === "phrase_count_mismatch") return "分句数量不一致，无法组成 A/B。";
  return `第 ${(result.phraseIndex ?? 0) + 1} 句和弦 token 不一致，无法组成 A/B。`;
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
      if (isOrdinaryLyric(block)) {
        const variantActions = node("div", "block-editor-footer variant-actions");
        variantActions.append(
          actionButton("＋ 添加 B 歌词", "add-variant", blockIndex),
          actionButton("与其他段落组成 A/B", "start-combine-variants", blockIndex)
        );
        if (variantCombine?.leftIndex === blockIndex) {
          variantActions.append(node("span", "variant-mode-note", "已选为歌词 A；请选择另一普通歌词段作为 B。"));
        } else if (variantCombine && variantCombine.rightIndex === undefined) {
          const select = actionButton("选择为 B", "select-combine-variant", blockIndex);
          select.disabled = variantCombine.leftIndex === blockIndex;
          variantActions.append(select);
        }
        card.append(variantActions);
      } else if (block.lyric_sets) {
        const labels = node("div", "variant-labels");
        block.lyric_sets.forEach((_set, lyricSetIndex) => {
          const label = textInput(
            block.variant_labels?.[lyricSetIndex] ?? `歌词 ${lyricSetIndex + 1}`,
            "variant-label",
            blockIndex
          );
          label.dataset.lyricSetIndex = String(lyricSetIndex);
          const labelField = fieldLabel(`歌词组 ${lyricSetIndex + 1} 标签`, label);
          const removeSet = actionButton(`删除歌词组 ${lyricSetIndex + 1}`, "remove-variant", blockIndex);
          removeSet.dataset.lyricSetIndex = String(lyricSetIndex);
          removeSet.disabled = block.lyric_sets!.length < 2;
          labelField.append(removeSet);
          labels.append(labelField);
        });
        card.append(labels);
        const variantActions = node("div", "block-editor-footer variant-actions");
        const swap = actionButton("交换 A/B", "swap-variants", blockIndex);
        swap.disabled = block.lyric_sets.length < 2;
        variantActions.append(swap, actionButton("拆成独立歌词块", "split-variants", blockIndex));
        card.append(variantActions);
      }
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
          const lyricsControl = lyricInput(row[phraseIndex] ?? "", blockIndex);
          lyricsControl.dataset.phraseIndex = String(phraseIndex);
          lyricsControl.dataset.lyricSetIndex = String(lyricSetIndex);
          const variant = block.variant_labels?.[lyricSetIndex];
          phrase.append(fieldLabel(variant ? `歌词 ${variant}` : rows.length > 1 ? `歌词组 ${lyricSetIndex + 1}` : "歌词", lyricsControl));
        });
        const more = node("details", "phrase-editor-more");
        more.append(node("summary", undefined, "更多操作"));
        const phraseActions = node("div", "phrase-editor-actions");
        const moveLeft = actionButton("和弦前移", "move-chord-left", blockIndex);
        moveLeft.dataset.phraseIndex = String(phraseIndex);
        moveLeft.disabled = phraseIndex === 0;
        const moveRight = actionButton("和弦后移", "move-chord-right", blockIndex);
        moveRight.dataset.phraseIndex = String(phraseIndex);
        moveRight.disabled = phraseIndex === block.chords.length - 1;
        const splitPhrase = actionButton("在歌词光标处插入变化点", "split-phrase-at-cursor", blockIndex);
        splitPhrase.dataset.phraseIndex = String(phraseIndex);
        splitPhrase.setAttribute("aria-label", `在分句 ${phraseIndex + 1} 的歌词光标处插入和弦变化点`);
        phraseActions.append(moveLeft, moveRight, splitPhrase);
        if (phraseIndex < block.chords.length - 1) {
          const mergePhrase = actionButton("删除下一变化点", "merge-phrase-next", blockIndex);
          mergePhrase.dataset.phraseIndex = String(phraseIndex);
          const compatible = block.chords[phraseIndex] === block.chords[phraseIndex + 1];
          mergePhrase.disabled = !compatible;
          if (!compatible) mergePhrase.title = "相邻分句包含不同和弦，无法无损合并";
          phraseActions.append(mergePhrase);
        }
        if (phraseIndex > 0) {
          const split = actionButton("从此处分段", "split-block", blockIndex);
          split.dataset.phraseIndex = String(phraseIndex);
          phraseActions.append(split);
        }
        const remove = actionButton("删除分句", "delete-phrase", blockIndex);
        remove.dataset.phraseIndex = String(phraseIndex);
        remove.disabled = block.chords.length <= 1;
        phraseActions.append(remove);
        more.append(phraseActions);
        phrase.append(more);
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
    if (variantBulk && isOrdinaryLyric(block)) {
      const selector = node("label", "variant-bulk-select");
      const checkbox = node("input");
      checkbox.type = "checkbox";
      checkbox.dataset.bulkVariantId = block.id;
      const selected = variantBulk.phase === "left" ? variantBulk.leftIds : variantBulk.rightIds;
      checkbox.checked = selected.includes(block.id);
      selector.append(checkbox, node("span", undefined, `选择为 ${variantBulk.phase === "left" ? "A" : "B"}`));
      heading.append(selector);
    }
    return card;
  });
  const bulkPanel = variantBulk ? node("section", "variant-bulk-panel") : undefined;
  if (bulkPanel && variantBulk) {
    const phaseName = variantBulk.phase === "left" ? "A" : "B";
    bulkPanel.append(node("strong", undefined, `整理为 A/B：选择歌词 ${phaseName}`));
    bulkPanel.append(node("p", undefined, "可选择不相邻段落；系统会按选择顺序配对，并保留 A 的和弦空格。"));
    if (variantBulk.phase === "right" && variantBulk.leftIds.length && variantBulk.leftIds.length === variantBulk.rightIds.length) {
      const previewList = node("ul", "variant-pair-preview");
      variantBulk.leftIds.forEach((leftId, pairIndex) => {
        const rightId = variantBulk!.rightIds[pairIndex];
        const left = song.blocks.find((block) => block.id === leftId);
        const right = song.blocks.find((block) => block.id === rightId);
        const item = node("li", undefined, `${leftId} ↔ ${rightId}：${variantCompatibilityText(left, right)}`);
        previewList.append(item);
      });
      bulkPanel.append(previewList);
    }
    const bulkActions = node("div", "block-editor-footer");
    if (variantBulk.phase === "left") {
      const next = actionButton("继续选择 B", "bulk-next", -1);
      next.disabled = variantBulk.leftIds.length === 0;
      bulkActions.append(next);
    } else {
      const back = actionButton("返回选择 A", "bulk-back", -1);
      const confirm = actionButton("确认整理为 A/B", "bulk-confirm", -1);
      const equalCount = variantBulk.leftIds.length > 0 && variantBulk.leftIds.length === variantBulk.rightIds.length;
      const compatible = equalCount && variantBulk.leftIds.every((leftId, pairIndex) => {
        const left = song.blocks.find((block) => block.id === leftId);
        const right = song.blocks.find((block) => block.id === variantBulk!.rightIds[pairIndex]);
        return isOrdinaryLyric(left) && isOrdinaryLyric(right) &&
          compareLyricChordCompatibility(left as never, right as never).compatible;
      });
      confirm.disabled = !compatible;
      bulkActions.append(back, confirm);
    }
    bulkActions.append(actionButton("取消整理", "bulk-cancel", -1));
    bulkPanel.append(bulkActions);
  }
  if (variantCombine?.rightIndex !== undefined) {
    const previewPanel = node("section", "variant-combine-preview");
    const left = song.blocks[variantCombine.leftIndex];
    const right = song.blocks[variantCombine.rightIndex];
    previewPanel.append(node("strong", undefined, "A/B 合并预览"));
    previewPanel.append(node("p", undefined, `${left?.id}（A） ↔ ${right?.id}（B）：${variantCompatibilityText(left, right)}`));
    if (isOrdinaryLyric(left) && isOrdinaryLyric(right)) {
      const leftLyric = left as EditableLyricBlock;
      const rightLyric = right as EditableLyricBlock;
      const rows = node("div", "variant-combine-rows");
      leftLyric.chords.forEach((chord, phraseIndex) => {
        const row = node("div", "variant-combine-row");
        row.append(
          node("code", undefined, chord),
          node("span", undefined, leftLyric.lyrics?.[phraseIndex] ?? ""),
          node("span", undefined, rightLyric.lyrics?.[phraseIndex] ?? "")
        );
        rows.append(row);
      });
      previewPanel.append(rows);
    }
    const actions = node("div", "block-editor-footer");
    const confirm = actionButton("确认组成 A/B", "confirm-combine-variants", variantCombine.leftIndex);
    confirm.disabled = !isOrdinaryLyric(left) || !isOrdinaryLyric(right) ||
      !compareLyricChordCompatibility(left as never, right as never).compatible;
    actions.append(confirm, actionButton("取消", "cancel-combine-variants", variantCombine.leftIndex));
    previewPanel.append(actions);
    blockEditor.replaceChildren(...(bulkPanel ? [bulkPanel] : []), previewPanel, ...cards);
    return;
  }
  blockEditor.replaceChildren(...(bulkPanel ? [bulkPanel] : []), ...cards);
}

function validationPaths(candidate: ManualEditableCandidate): string[] {
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
  variantCombine = undefined;
  // Bulk selection is keyed by block ID, so it remains safe if blocks move before confirmation.
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
  renderEditDiff();
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
      (isEditMode && (!expectedSha || !editDirty)) ||
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

async function readApiJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    if (response.status >= 500) {
      throw new Error("歌曲生成服务在边缘节点被中断，请稍后重试。\n错误码：provider_edge_error");
    }
    throw new Error("服务器返回了非 JSON 响应，请刷新页面后重试。\n错误码：invalid_server_response");
  }
  try {
    return await response.json();
  } catch {
    throw new Error("服务器返回的 JSON 不完整，请稍后重试。\n错误码：invalid_server_response");
  }
}

function formHasValues(target?: HTMLFormElement | null): boolean {
  if (!target) return false;
  return [...target.elements].some((element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value.trim() !== "" && element.value !== element.defaultValue;
    }
    if (element instanceof HTMLSelectElement) {
      return [...element.options].some((option) => option.selected !== option.defaultSelected);
    }
    return false;
  });
}

function clearCandidateWorkspace() {
  publishGuard = createPublishGuard();
  currentCandidate = undefined;
  draftCandidate = undefined;
  currentDuplicate = undefined;
  currentSongIndex = [];
  candidatePanel && (candidatePanel.hidden = true);
  blockEditor?.replaceChildren();
  preview?.replaceChildren();
  renderEditorValidation([]);
  showDuplicate(undefined);
  if (confirmation) confirmation.checked = false;
  if (publishResult) publishResult.hidden = true;
}

document.querySelectorAll<HTMLButtonElement>("[data-entry-mode]").forEach((control) => {
  control.addEventListener("click", () => {
    const next = control.dataset.entryMode === "manual" ? "manual" : "ai";
    if (next === entryMode) return;
    const currentForm = entryMode === "ai" ? form : manualForm;
    const destinationForm = next === "ai" ? form : manualForm;
    if ((draftCandidate || formHasValues(currentForm) || formHasValues(destinationForm)) && !window.confirm(
      "切换添加方式会清除当前尚未进入曲库的候选；已填写的表单内容会保留。是否继续？"
    )) return;
    clearCandidateWorkspace();
    entryMode = next;
    document.querySelectorAll<HTMLElement>("[data-mode-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.modePanel !== entryMode;
    });
    document.querySelectorAll<HTMLButtonElement>("[data-entry-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button === control));
    });
  });
});

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
  clearCandidateWorkspace();
  isManualDraft = false;

  try {
    const response = await fetch("/api/songs/generate", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, ...(artist ? { artist } : {}) })
    });
    const payload = await readApiJson(response);
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

manualForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!manualButton || !manualStatus) return;
  const data = new FormData(manualForm);
  const value = (name: string) => String(data.get(name) ?? "").trim();
  const fields: ManualSongFields = {
    title: value("title"), artist: value("artist"), slug: value("slug"),
    lyricsCredit: value("lyrics_credit"), musicCredit: value("music_credit"),
    originalKey: value("original_key"), degreeKey: value("degree_key"),
    capo: Number(data.get("capo")), language: value("language"),
    tags: value("tags").split(",").map((tag) => tag.trim()).filter(Boolean),
    ...(value("source_reference") ? { sourceReference: value("source_reference") } : {}),
    copyrightStatus: value("copyright_status") as ManualSongFields["copyrightStatus"]
  };
  if (!manualForm.reportValidity()) return;
  manualButton.disabled = true;
  try {
    const lyrics = String(data.get("lyrics") ?? "");
    const parsedLyrics = parseAnnotatedLyrics(lyrics);
    const draft = createManualLyricDraft(fields, lyrics);
    clearCandidateWorkspace();
    isManualDraft = true;
    draftCandidate = draft;
    currentSongIndex = await loadSongIndex();
    currentDuplicate = findDuplicateSong(currentSongIndex, draft.song);
    renderCandidate(draft);
    renderBlockEditor(draft.song);
    renderPreview(draft.song);
    renderEditorValidation(validationPaths(draft));
    showDuplicate(currentDuplicate);
    manualStatus.className = "add-status is-success";
    const summary = parsedLyrics.summary;
    manualStatus.textContent = `已解析：主歌 ${summary.verse} 行，副歌 ${summary.chorus} 行，Bridge ${summary.bridge} 行，A/B 配对 ${summary.variantPairs} 组，普通歌词块 ${summary.ordinaryBlocks} 个。请补全每个级数和弦后再确认提交。`;
  } catch (error) {
    manualStatus.className = "add-status is-error";
    if (error instanceof ManualLyricsParseError) {
      const details = error.details;
      manualStatus.textContent = `解析失败：${details.code}（第 ${details.line} 行${details.section_role ? `，${details.section_role}` : ""}${details.group ? `，${details.group}` : ""}）。`;
    } else manualStatus.textContent = "无法建立手动歌词草稿，请检查填写内容。";
  } finally {
    manualButton.disabled = false;
    updatePublishState();
  }
});

document.querySelectorAll<HTMLButtonElement>("[data-manual-marker]").forEach((control) => {
  control.addEventListener("click", () => {
    if (!manualLyrics) return;
    const marker = control.dataset.manualMarker ?? "";
    const start = manualLyrics.selectionStart ?? manualLyrics.value.length;
    const end = manualLyrics.selectionEnd ?? start;
    if (start !== end && !window.confirm("插入标记将替换当前选中文本；是否继续？")) return;
    const prefix = start > 0 && manualLyrics.value[start - 1] !== "\n" ? "\n" : "";
    const suffix = end < manualLyrics.value.length && manualLyrics.value[end] !== "\n" ? "\n" : "";
    manualLyrics.setRangeText(`${prefix}${marker}${suffix}`, start, end, "end");
    manualLyrics.focus();
  });
});

blockEditor?.addEventListener("input", (event) => {
  if (!draftCandidate || !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) return;
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
    } else if (field === "variant-label") {
      song = updateLyricVariantLabel(song, blockIndex, lyricSetIndex, input.value);
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
  if (!draftCandidate) return;
  if (event.target instanceof HTMLInputElement && event.target.dataset.bulkVariantId && variantBulk) {
    const id = event.target.dataset.bulkVariantId;
    const selected = variantBulk.phase === "left" ? variantBulk.leftIds : variantBulk.rightIds;
    const other = variantBulk.phase === "left" ? variantBulk.rightIds : variantBulk.leftIds;
    if (event.target.checked && !other.includes(id) && !selected.includes(id)) selected.push(id);
    if (!event.target.checked) selected.splice(selected.indexOf(id), 1);
    renderBlockEditor(draftCandidate.song);
    return;
  }
  if (!(event.target instanceof HTMLSelectElement)) return;
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
  const lyricSetIndex = Number(target.dataset.lyricSetIndex ?? 1);
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
      try {
        song = markBlockAsRepeat(song, blockIndex, selector.value);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "repeat_content_mismatch") throw error;
        const replace = window.confirm(
          "当前段落与重复来源内容不同。转换会以来源段落覆盖当前内容；是否确认继续？"
        );
        if (!replace) throw new Error("内容不同，已保留为独立段落");
        song = markBlockAsRepeat(song, blockIndex, selector.value, true);
      }
    } else if (action === "split-phrase-at-cursor") {
      const row = target.closest(".phrase-editor-row");
      const lyric = row?.querySelector<HTMLTextAreaElement>('[data-editor-field="phrase-lyric"]');
      const position = lyric?.selectionStart;
      if (position === null || position === undefined) throw new Error("请先把光标放在歌词拆分位置");
      song = splitLyricPhraseAt(song, blockIndex, phraseIndex, position);
    } else if (action === "merge-phrase-next") {
      song = mergeLyricPhrases(song, blockIndex, phraseIndex);
    } else if (action === "move-chord-left") {
      song = moveLyricChord(song, blockIndex, phraseIndex, -1);
    } else if (action === "move-chord-right") {
      song = moveLyricChord(song, blockIndex, phraseIndex, 1);
    } else if (action === "add-variant") {
      song = convertLyricsToVariants(song, blockIndex);
    } else if (action === "swap-variants") {
      song = swapLyricVariants(song, blockIndex);
    } else if (action === "remove-variant") {
      const block = song.blocks[blockIndex];
      if (block?.type !== "lyric" || !block.lyric_sets?.[lyricSetIndex]) throw new Error("lyric_variants_required");
      const hasContent = block.lyric_sets[lyricSetIndex].some((line) => line.length > 0);
      if (hasContent && !window.confirm("删除歌词组会丢弃其内容；是否确认继续？")) return;
      song = removeLyricVariant(song, blockIndex, lyricSetIndex);
    } else if (action === "split-variants") {
      const block = song.blocks[blockIndex];
      if (block?.type !== "lyric" || !block.lyric_sets) throw new Error("lyric_variants_required");
      const hasContent = block.lyric_sets.slice(1).some((set) => set.some((line) => line.length > 0));
      if (hasContent && !window.confirm("这会把 A/B 拆成独立歌词段，不会丢失歌词；是否确认继续？")) return;
      song = splitVariantsIntoBlocks(song, blockIndex);
    } else if (action === "start-combine-variants") {
      variantCombine = { leftIndex: blockIndex };
      renderBlockEditor(song);
      return;
    } else if (action === "select-combine-variant") {
      if (!variantCombine) return;
      variantCombine.rightIndex = blockIndex;
      renderBlockEditor(song);
      return;
    } else if (action === "cancel-combine-variants") {
      variantCombine = undefined;
      renderBlockEditor(song);
      return;
    } else if (action === "confirm-combine-variants") {
      if (variantCombine?.rightIndex === undefined) return;
      song = combineLyricBlocksAsVariants(song, variantCombine.leftIndex, variantCombine.rightIndex);
      variantCombine = undefined;
    } else if (action === "bulk-next") {
      if (!variantBulk?.leftIds.length) return;
      variantBulk.phase = "right";
      renderBlockEditor(song);
      return;
    } else if (action === "bulk-back") {
      if (!variantBulk) return;
      variantBulk.phase = "left";
      renderBlockEditor(song);
      return;
    } else if (action === "bulk-cancel") {
      variantBulk = undefined;
      renderBlockEditor(song);
      return;
    } else if (action === "bulk-confirm") {
      if (!variantBulk) return;
      song = combineLyricBlockIdsAsVariants(song, variantBulk.leftIds, variantBulk.rightIds);
      variantBulk = undefined;
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

document.querySelectorAll<HTMLButtonElement>("[data-editor-global-action]").forEach((control) => {
  control.addEventListener("click", () => {
    if (!draftCandidate || publishGuard.locked) return;
    const action = control.dataset.editorGlobalAction;
    if (action === "organize-variants") {
      variantCombine = undefined;
      variantBulk = variantBulk ? undefined : { phase: "left", leftIds: [], rightIds: [] };
      renderBlockEditor(draftCandidate.song);
      return;
    }
    const lastPlayableIndex = Math.max(0, draftCandidate.song.blocks.findLastIndex(
      (block) => block.type !== "theory_legend"
    ));
    const song = action === "add-lyric-block"
      ? addLyricBlock(draftCandidate.song, lastPlayableIndex, isManualDraft ? "" : "1")
      : addInstrumentBlock(draftCandidate.song, lastPlayableIndex);
    applySongEdit(song);
  });
});

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
    const response = await fetch(isEditMode ? "/api/songs/update" : "/api/songs/publish", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(isEditMode
        ? { candidate: currentCandidate, song_id: editSlug, expected_sha: expectedSha, confirmed: true }
        : { candidate: currentCandidate, confirmed: true })
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
    publishButton.textContent = isEditMode ? "更新已提交" : "已提交";
    if (publishCommit) publishCommit.href = payload.commit_url;
    if (publishResult) publishResult.hidden = false;
    if (status) {
      status.className = "add-status is-success";
      status.textContent = isEditMode
        ? "曲谱更新已提交，正在等待自动部署。"
        : "歌曲已提交，正在等待自动部署。";
    }
  } catch (error) {
    publishGuard.fail();
    publishButton.textContent = isEditMode ? "更新现有歌曲" : "加入曲库";
    if (status) {
      status.className = "add-status is-error";
      status.textContent = error instanceof Error ? error.message : "提交失败，请稍后再试。";
    }
  } finally {
    updatePublishState();
  }
});

void refreshGitHubConfiguration();

async function initializePublishedEdit() {
  if (!isEditMode || !editSlug || !status) return;
  try {
    const response = await fetch(`/api/songs/${encodeURIComponent(editSlug)}/edit`, {
      credentials: "same-origin"
    });
    const payload = await readApiJson(response) as { candidate?: unknown; expected_sha?: unknown };
    if (!response.ok) throw new Error(errorMessage(response.status, payload));
    const candidate = SongCandidateSchema.safeParse(payload.candidate);
    if (!candidate.success || typeof payload.expected_sha !== "string" ||
      !/^[a-f0-9]{7,64}$/i.test(payload.expected_sha)) {
      throw new Error("当前歌曲版本无效。\n错误码：invalid_candidate");
    }
    expectedSha = payload.expected_sha;
    originalCandidate = structuredClone(candidate.data);
    draftCandidate = candidate.data;
    currentCandidate = candidate.data;
    isManualDraft = false;
    renderCandidate(candidate.data);
    currentSongIndex = (await loadSongIndex()).filter((entry) => entry.slug !== editSlug);
    showDuplicate(findDuplicateSong(currentSongIndex, candidate.data.song));
    renderBlockEditor(candidate.data.song);
    renderPreview(candidate.data.song);
    renderEditorValidation([]);
    renderEditDiff();
    status.className = "add-status is-success";
    status.textContent = "已载入当前 GitHub 文件版本。修改后请检查差异并重新确认。";
  } catch (error) {
    status.className = "add-status is-error";
    status.textContent = error instanceof Error ? error.message : "无法载入当前歌曲版本。";
  }
}

cancelEdit?.addEventListener("click", (event) => {
  if (editDirty && !window.confirm("存在未保存修改，确定取消编辑吗？")) event.preventDefault();
});

window.addEventListener("beforeunload", (event) => {
  if (!editDirty || publishGuard.locked) return;
  event.preventDefault();
  event.returnValue = "";
});

void initializePublishedEdit();
