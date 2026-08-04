# 术语爬虫 (v6.0)

**核心理念:从文章正文中"发现"词库外的新术语——不再用写死的关键词清单套标题。**

## 工作方式

1. GitHub Actions 每天 UTC 0:00(北京时间 8:00)自动运行 `fetch-terms.js`。
2. 从 `sources.json` 的活源抓取近期文章:
   - **arXiv AI/CL/CV/LG**:RSS 自带完整论文摘要,直接作为"正文"挖词;
   - **量子位 / DeepMind**:RSS 正文薄,爬虫会进文章页抓正文(有上限/并发/阶段超时)。
3. **GLM 读正文发现新词(主力)**:把文章正文分批喂给智谱 GLM-4-Flash,让它读完挑出"值得收录、且尚未入库"的 AI 术语(含中文名、缩写、一句话定义、分类)。
4. 用 `data/glossary.json` 去重,只保留新概念;再扫描全部文章统计每个词被多少篇/几个来源提及 → 排行。
5. 生成通俗解读(GLM,可选)、标注排名变化 ▲▼ 与 NEW、归档当日快照并更新 7/30 天累计榜。
6. 写入 `data/hot-terms.json`;workflow 再统一同步数据库并提交推送。

## 兜底(保证永不失败、页面不空)

- 无 `GLM_API_KEY` 或 GLM 连续失败 → 用正则从**正文**抽候选词(弱兜底,仍来自正文而非清单)。
- 当天一无所获 → 沿用最近历史(降温),避免空榜。
- 全程 try/catch + 各阶段硬超时;无论外部多差,脚本始终 `exit 0`。

## 文件

- `fetch-terms.js` — 主爬虫(v6.0)。可 `require` 复用其纯函数(见文件末 `module.exports`)。
- `sources.json` — 数据源;`content_rich=true` 表示 RSS 自带完整正文,`false` 表示需进文章页抓正文。`_legacy_rss.dead` 记录已失效的旧源。

## 本地运行

```bash
# 走正则兜底(无需 key)
node crawler/fetch-terms.js
# 启用 GLM 发现(推荐,质量更高)
GLM_API_KEY=你的key node crawler/fetch-terms.js
```

## 调整

- 想加/换数据源 → 改 `sources.json` 的 `feeds`(标好 `content_rich` / `always_recent`)。
- 想让某个词不再被当作"新词" → 把它加进 `data/glossary.json`,之后会被自动过滤。
- 发现质量/条数不理想 → 调 `fetch-terms.js` 顶部常量(`GLM_MAX_ARTICLES` / `GLM_BATCH_ARTICLES` / `TOP_N` / `BODY_FETCH_MAX` 等)。
