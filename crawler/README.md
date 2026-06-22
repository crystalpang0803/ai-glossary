# AI Glossary Crawler

每天自动爬取AI新闻源，提取新术语候选词。

## 工作流程

1. GitHub Actions 每天北京时间 9:00 自动运行
2. 爬取 HuggingFace Blog、机器之心、arXiv 等新闻源
3. 用规则提取候选术语（英中对照、缩写等）
4. 生成 `pending-terms.json`
5. 你的术语库后台自动拉取候选词到"待审核"列表

## 手动触发

在仓库的 Actions 页面，点击 "Daily AI Term Crawler" → "Run workflow"

## 文件说明

- `crawler.js` — 爬虫脚本
- `pending-terms.json` — 候选术语（自动生成）
- `crawl-summary.json` — 爬取摘要（自动生成）
- `.github/workflows/crawl.yml` — Actions 定时配置