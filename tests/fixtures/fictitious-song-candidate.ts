export const fictitiousSongCandidate = {
  query: { title: "星尘邮局", artist: "虚构乐队" },
  matched_song: {
    title: "星尘邮局",
    artist: "虚构乐队",
    version: "练习室版本",
    confidence: 0.88
  },
  song: {
    schema_version: 1,
    slug: "xugou-yuedui-xingchen-youju",
    title: "星尘邮局",
    artist: "虚构乐队",
    credits: { lyrics: "虚构作者", music: "虚构作者" },
    original_key: "C",
    degree_key: "C",
    capo: 0,
    language: "zh-CN",
    tags: ["测试", "虚构歌曲"],
    source: { type: "web_search", reference: "仅供自动测试使用的虚构来源" },
    copyright_status: "private_reference",
    blocks: [
      {
        id: "verse-01",
        type: "lyric",
        chords: ["1   5"],
        lyrics: ["虚构句子一 虚构句子二"],
        spacing: "normal"
      }
    ]
  },
  sources: [
    {
      title: "虚构歌曲资料页",
      url: "https://example.com/fictitious-song",
      source_type: "reference"
    }
  ],
  warnings: ["这是自动测试使用的虚构歌曲"],
  uncertain_fields: ["原调"]
};
