# Guitare Songbook

一个以结构化 JSON 为唯一内容源的私人吉他歌谱库。它使用 Astro 构建为可安装的 PWA，同一首谱可在手机、平板、电脑和 A4 打印版之间共用。

当前黄金样本：陈绮贞《旅行的意义》。

## 已实现

- 响应式歌曲目录与即时搜索
- 可取消的本地星标；星标歌曲置顶，其余按曲名字符排序
- 级数和弦在歌词上方的统一版式
- 共享和声的多组歌词
- 前奏、间奏、尾奏和和弦结构说明
- 级数谱 / 实际和弦名切换
- ±6 半音移调
- 字号、纸张/白色/深色主题、全屏、屏幕常亮
- PWA 安装与离线缓存
- A4 打印样式
- Zod 内容校验、Vitest 单元测试、Pagefind 构建索引
- GitHub Actions CI，以及可开关的 Cloudflare Workers CD
- Phase 2C 发布前结构化编辑器与正式谱面实时预览
- Phase 2D 已发布曲谱安全编辑、差异确认与 GitHub SHA 冲突保护

## 本地开发

要求 Node.js 22 或更高版本，以及 pnpm 11。

```bash
pnpm install
pnpm dev
```

完整验证：

```bash
pnpm verify
```

## 添加歌曲

每首歌是 `src/content/songs/` 下的独立 JSON 文件。提交后 CI 会校验每个和弦分句是否都有对应的歌词分句，再生成页面和搜索索引。

批量文本导入：

```bash
pnpm songs:import "待填充 TXT 文件夹" --staging tmp/song-import
```

导入器将空模板标为 `abandoned`，将只有歌词的文件标为 `needs_chords`，并把具备调性、和弦行和对应歌词行的文件标为 `chorded`。默认只生成临时检查报告；确认词曲、调性等元数据后，增加 `--write-songs` 才会把可验证歌曲写入正式内容目录。

文本谱推荐保持“和弦行在上、对应歌词行在下”的格式。导入时会把实际和弦转换为级数谱、压缩同一连续段落内完全重复的歌词块，并保留间奏之后重新出现的歌曲结构。

只有确认两段歌词共用同一套和弦时，才用 `A:`、`B:` 明确标记。导入器会将它们紧凑地叠放在同一和弦行下，不会自动猜测其他段落：

```text
C   Gm
A: 看沉默的电话 它什么都不说
B: 看你紧闭的嘴唇 它什么都不说
```

对现有曲库可先生成候选审核表：

```bash
pnpm songs:review-variants
```

结果以 Excel 可直接识别的 UTF-8 BOM 编码写入 `tmp/song-variant-review.csv`。在 `decision` 列填写 `merge` 或 `keep`，审核后运行 `pnpm songs:review-variants --apply` 写回歌曲；黄金样本《旅行的意义》不会进入批处理候选。

MVP 的后续阶段会在应用里加入“粘贴歌词/和弦谱或上传图片、PDF → AI 生成 → 预览确认 → 自动提交”的入口。底层仍使用同一份 JSON Schema。

### Phase 2C：审核、编辑与预览

通过 Cloudflare Access 登录后打开 `/add/`。候选生成完成后，可以在浏览器内存中调整曲式结构、歌词与和弦分句、段落顺序、间距和器乐段，并可将后续段落保存为对此前段落的 `repeat` 引用。编辑器支持明确的上移、下移、拆分、合并和展开按钮，不使用拖拽。

右侧预览复用正式歌曲页的渲染模型、级数转和弦逻辑和谱面 CSS，可切换级数/实际和弦、移调以及手机、平板、桌面/A4 宽度。每次修改都会重新执行 `SongCandidateSchema`、阿拉伯数字级数校验和重复歌曲检测，并自动取消此前的人工确认；只有候选合法、不重复、GitHub 写入已配置且重新确认后才能发布。

编辑和预览不会再次调用 AI，不会把草稿歌词写入 localStorage、URL、日志或数据库。刷新页面会丢弃尚未发布的草稿；多用户和 D1 持久化留待 Phase 3A。

### Phase 2D：编辑已发布曲谱

通过 Cloudflare Access 登录后，在任一正式歌曲页选择“编辑曲谱”，进入 `/song/<slug>/edit/`。编辑页复用 Phase 2C 的结构编辑器与正式谱面预览，可调整段落类型、标签、间距、和弦/歌词分句、`lyric_sets`、器乐段、段落顺序和 `RepeatBlock`。歌词输入框可在光标处拆分分句；相邻和弦相同才允许无损合并，和弦也可以通过明确按钮前后移动。

保存前会显示本地差异摘要并要求重新确认。服务器根据固定 slug 读取 GitHub 当前文件 SHA，只允许写回原 `src/content/songs/<slug>.json`；如果远端在编辑期间发生变化，会返回冲突而不会覆盖。新增歌曲仍使用 `/api/songs/publish`，现有歌曲更新独立使用 `/api/songs/update`。编辑只在浏览器内存中进行，不调用 DeepSeek，不把 GitHub Token 交给浏览器，也不会自动重试写入。

## Cloudflare 部署

仓库变量：

```text
CLOUDFLARE_ENABLED=true
```

仓库 Secrets：

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
```

变量未开启时，CI 仍会执行，部署步骤会安全跳过。

## 内容与版权

歌曲 JSON 带有 `source` 和 `copyright_status`。完整歌词只应由用户提供、属于公版，或已获得授权。当前曲库按私人参考用途设计，正式部署时应由 Cloudflare Access 限制到授权邮箱。

