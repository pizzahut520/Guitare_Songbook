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

