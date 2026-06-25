# AI Glossary 爬虫 (v5.0)

每天自动从 AI 信息源抓取"词库里没有的当下新概念"，生成热门词汇排行榜。

## 工作流程

1. GitHub Actions 每天 UTC 0:00（北京时间 8:00）自动运行 `fetch-terms.js`
2. 抓取 RSS + 网页（arXiv、量子位、机器之心等，见 `sources.json`）
3. 用 `keywords.json` 的 `emerging_terms`（词库外新概念清单）匹配文章标题，
   对照 `data/glossary.json` 过滤掉已入库老词，按出现频次排行
4. 有 `GLM_API_KEY` 时，用智谱 GLM 额外发现新词并生成通俗解读（可选，失败不影响）
5. 兜底保证产出 ≥6 个新概念；无论外部环境多差脚本都以 exit 0 结束
6. 写入 `data/hot-terms.json`，并归档 `data/hot-history/<日期>.json`、
   生成 `data/hot-7d.json` / `data/hot-30d.json`（支撑前端"时间范围/日期回看"）
7. 同步到 Neon 数据库；由 workflow 统一提交数据文件（脚本本身不再 git push）

## 手动触发

仓库 Actions 页面 → "Daily Hot Terms Fetch" → "Run workflow"

## 文件说明

- `fetch-terms.js` — 主爬虫脚本（v5.0）
- `sources.json`   — RSS / 网页数据源配置
- `keywords.json`  — `emerging_terms`(新概念清单，热门词主要来源) + `tracking_terms`(核心老词)
- `../.github/workflows/daily-terms.yml` — Actions 定时与同步配置
