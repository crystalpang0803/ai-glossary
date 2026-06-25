/**
 * AI术语热度抓取脚本 v5.0
 * 目标：无论外部环境(数据源/海外网络/GLM API)多差，每天都稳定写入 >=6 个
 *      “词库里没有的新概念”作为热门词汇，且任务永不因外部失败而报错(始终 exit 0)。
 *
 * 管线：
 *   1. 抓取 RSS + 网页(scrape) 文章标题，scrape 阶段有硬超时，绝不拖垮全局
 *   2. 【确定性主力】用 keywords.json 的 emerging_terms(+tracking_terms) 匹配标题
 *      → 对照 glossary 过滤掉已入库老词 → 按出现频次排行 → 这是“新概念”的可靠来源
 *   3. 【可选增强】有 GLM_API_KEY 且可用时，AI 额外发现新词 + 写通俗解读；
 *      全程 try/catch + 超时包裹，GLM 再怎么挂都不影响主流程
 *   4. 【兜底保证】最终若不足 6 个，从新兴词清单补足，确保排行榜 >=6 条
 *
 * 用法: GLM_API_KEY=xxx node crawler/fetch-terms.js   (GLM_API_KEY 可省略)
 */

const Parser = require('rss-parser');
const https = require('https');
const http = require('http');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sources = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));
const keywords = JSON.parse(fs.readFileSync(path.join(__dirname, 'keywords.json'), 'utf8'));

// 加载 glossary，用于：①过滤已入库老词 ②复用已有 explanation
let glossaryData = [];
try {
  glossaryData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'glossary.json'), 'utf8'));
} catch { /* 文件不存在 */ }
const glossaryMap = new Map(glossaryData.map(t => [t.id, t]));

// 已入库标识集合（id + 英文名 + 缩写，全部小写），用于判定“是否新概念”
const glossaryIds = new Set(glossaryData.map(t => t.id));
const glossaryNames = new Set(glossaryData.map(t => (t.term_en || '').toLowerCase()).filter(Boolean));
const glossaryAbbrs = new Set(glossaryData.map(t => (t.abbreviation || '').toLowerCase()).filter(Boolean));

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// 判定一个词是否已在词库（即“不是新概念”）
function isInGlossary(term_en, abbreviation) {
  const id = slugify(term_en);
  const name = (term_en || '').toLowerCase();
  const abbr = (abbreviation || '').toLowerCase();
  if (id && glossaryIds.has(id)) return true;
  if (name && glossaryNames.has(name)) return true;
  if (abbr && abbr.length >= 2 && glossaryAbbrs.has(abbr)) return true;
  return false;
}

const REQUEST_TIMEOUT = 15000;
const CONCURRENT_LIMIT = 5;
const MAX_ITEMS_PER_FEED = 50;
const HOURS_BACK = 72;                  // 放宽到72小时，缓解活源不足
const SCRAPE_PHASE_TIMEOUT_MS = 45 * 1000;  // scrape 阶段总超时，绝不拖垮全局
const GLM_PHASE_BUDGET_MS = 90 * 1000;      // GLM 发现+解读总预算
const GLOBAL_TIMEOUT_MS = 7 * 60 * 1000;    // 全局兜底超时（远小于 workflow 的20分钟）
const MIN_HOT_TERMS = 6;                    // 硬性要求：最终至少 6 个热门词

// 智谱API配置
const GLM_API_KEY = process.env.GLM_API_KEY || '';
const GLM_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const GLM_MODEL = 'glm-4-flash';

const parser = new Parser({ timeout: REQUEST_TIMEOUT });

// ===== HTTP请求工具 =====
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8'
      },
      timeout: REQUEST_TIMEOUT
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchPage(new URL(res.headers.location, url).href).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Status code ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout])
    .catch(err => { console.log(`[Skip] ${label}: ${err.message}`); return []; })
    .finally(() => clearTimeout(timer));
}

// ===== RSS抓取 =====
async function fetchRSS(url, name) {
  try {
    const feed = await withTimeout(parser.parseURL(url), REQUEST_TIMEOUT, name);
    const items = (feed.items || []).slice(0, MAX_ITEMS_PER_FEED);
    const cutoff = Date.now() - HOURS_BACK * 60 * 60 * 1000;
    const recent = items.filter(item => {
      const d = item.pubDate || item.isoDate;
      if (!d) return true;
      return new Date(d).getTime() >= cutoff;
    });
    console.log(`[RSS OK] ${name}: ${recent.length}/${items.length} articles`);
    return recent.map(item => ({
      title: item.title || '',
      content: (item.contentSnippet || item.content || '').substring(0, 500),
      link: item.link || '',
      source: name
    }));
  } catch (err) {
    console.log(`[RSS Skip] ${name}: ${err.message}`);
    return [];
  }
}

// ===== 网页抓取 =====
async function fetchScrape(sourceConfig) {
  const { name, url } = sourceConfig;
  try {
    const html = await withTimeout(fetchPage(url), REQUEST_TIMEOUT, name);
    if (!html || typeof html !== 'string' || html.length < 100) {
      console.log(`[Scrape Skip] ${name}: empty or invalid response`);
      return [];
    }
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const titles = [];
    const selectors = ['h1 a', 'h2 a', 'h3 a', 'h4 a', '.post-title a', '.article-title a',
                       '.blog-title a', 'a[href*="/blog/"]', '.entry-title a'];
    for (const sel of selectors) {
      try {
        doc.querySelectorAll(sel).forEach(el => {
          const text = (el.textContent || '').trim();
          const href = el.getAttribute('href') || '';
          if (text.length > 5 && text.length < 200 && !titles.find(t => t.title === text)) {
            titles.push({ title: text, link: href });
          }
        });
      } catch (e) { /* selector may be invalid */ }
    }
    if (titles.length === 0) {
      doc.querySelectorAll('meta[property="og:title"], meta[name="description"]').forEach(el => {
        const content = el.getAttribute('content') || '';
        if (content.length > 5 && content.length < 200) titles.push({ title: content, link: '' });
      });
    }
    const uniqueTitles = titles.slice(0, 30);
    console.log(`[Scrape OK] ${name}: ${uniqueTitles.length} titles extracted`);
    return uniqueTitles.map(t => ({
      title: t.title,
      content: '',
      link: t.link.startsWith('http') ? t.link : (t.link ? new URL(t.link, url).href : ''),
      source: name
    }));
  } catch (err) {
    console.log(`[Scrape Skip] ${name}: ${err.message}`);
    return [];
  }
}

// ===== 并发抓取所有源 =====
async function fetchAll() {
  const articles = [];

  // RSS 源
  const rssSources = [...sources.rss.chinese, ...sources.rss.english];
  console.log(`\n--- RSS Sources (${rssSources.length}) ---`);
  for (let i = 0; i < rssSources.length; i += CONCURRENT_LIMIT) {
    const batch = rssSources.slice(i, i + CONCURRENT_LIMIT);
    const results = await Promise.all(batch.map(s => fetchRSS(s.url, s.name)));
    results.forEach(r => articles.push(...r));
  }

  // Scrape 源：整个阶段套一个硬超时，超时就用已抓到的部分，绝不卡死全局
  const scrapeSources = [...(sources.scrape?.chinese || []), ...(sources.scrape?.english || [])];
  console.log(`\n--- Scrape Sources (${scrapeSources.length}, 阶段超时 ${SCRAPE_PHASE_TIMEOUT_MS / 1000}s) ---`);
  const scraped = [];
  const scrapePhase = (async () => {
    for (let i = 0; i < scrapeSources.length; i += CONCURRENT_LIMIT) {
      const batch = scrapeSources.slice(i, i + CONCURRENT_LIMIT);
      const results = await Promise.all(batch.map(s => fetchScrape(s)));
      results.forEach(r => scraped.push(...r));
    }
  })();
  await withTimeout(scrapePhase, SCRAPE_PHASE_TIMEOUT_MS, 'Scrape phase');
  articles.push(...scraped);

  console.log(`\n[Total] Fetched ${articles.length} articles`);
  return articles;
}

// ===== 关键词/新兴词匹配（确定性主力） =====
// 把 emerging_terms 和 tracking_terms 合并匹配；emerging 优先级更高
function buildWatchList() {
  // 只用 emerging_terms 作为热门词来源：它们都是“词库外的当下新概念”。
  // tracking_terms 是核心老词/泛词(如 Training/GAN)，不作为热门词展示，避免霸榜。
  return (keywords.emerging_terms || []).map(t => ({ ...t, _tier: 0 }));
}

// 针对单个词构建匹配判断
function makeMatcher(term) {
  const phrases = [];          // 用 includes 匹配的长短语
  const boundaryTokens = [];   // 用单词边界匹配的短缩写
  const push = (s, isAbbr) => {
    const v = (s || '').trim().toLowerCase();
    if (!v) return;
    if (isAbbr) { if (v.length >= 2) boundaryTokens.push(v); }
    else if (v.length >= 3) phrases.push(v);
  };
  push(term.en, false);
  push(term.zh, false);
  (term.aliases || []).forEach(a => push(a, false));
  push(term.abbr, true);

  const boundaryRegexes = boundaryTokens.map(tok => {
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`);
  });

  return (text) => {
    for (const p of phrases) if (text.includes(p)) return true;
    for (const re of boundaryRegexes) if (re.test(text)) return true;
    return false;
  };
}

function matchWatchList(articles) {
  const watch = buildWatchList();
  const hits = watch.map(term => ({
    term,
    matcher: makeMatcher(term),
    count: 0, sources: [], source_urls: [], matched_articles: []
  }));

  for (const article of articles) {
    const text = ((article.title || '') + ' ' + (article.content || '')).toLowerCase();
    for (const h of hits) {
      if (h.matcher(text)) {
        h.count++;
        if (article.source && !h.sources.includes(article.source)) h.sources.push(article.source);
        if (article.link && !h.source_urls.includes(article.link)) h.source_urls.push(article.link);
        if (h.matched_articles.length < 3) {
          h.matched_articles.push({ title: article.title, link: article.link, source: article.source });
        }
      }
    }
  }
  return hits;
}

// ===== AI发现新术语（可选增强，失败不影响主流程） =====
async function aiDiscoverNewTerms(articles, deadline) {
  if (!GLM_API_KEY) return [];
  const allTitles = [];
  const seen = new Set();
  for (const a of articles) {
    const title = (a.title || '').trim();
    if (title && title.length > 5 && !seen.has(title)) {
      seen.add(title);
      allTitles.push({ title, source: a.source || '', link: a.link || '' });
    }
  }
  if (allTitles.length === 0) return [];

  const glossaryList = glossaryData.map(t => t.term_en + (t.abbreviation ? `(${t.abbreviation})` : '')).join('、');
  const BATCH_SIZE = 60;
  const discovered = [];
  let consecutiveFailures = 0;

  console.log(`\n--- [可选] AI发现新术语 (${allTitles.length} titles) ---`);
  for (let i = 0; i < allTitles.length; i += BATCH_SIZE) {
    if (Date.now() > deadline) { console.log('[AI Discover] 预算用尽，停止'); break; }
    if (consecutiveFailures >= 3) { console.log('[AI Discover] 连续失败，放弃AI发现'); break; }

    const batch = allTitles.slice(i, i + BATCH_SIZE);
    const titleList = batch.map((a, idx) => `${i + idx + 1}. [${a.source}] ${a.title}`).join('\n');
    const prompt = `以下是近期AI领域的新闻/论文标题，请提取满足全部条件的术语：
1. 跟AI行业相关（算法、模型架构、训练/推理方法、部署工程、评测、对齐安全、AI硬件等）
2. 是新词（不在以下已有词库中，且近期才出现或才被广泛讨论）
3. 是有定义的术语/概念——能写出一句话解释它

排除：产品名、公司名、人名、纯数字指标、无法定义的模糊词、已有词库中词的同义别名。

已有词库：${glossaryList}

标题：
${titleList}

输出JSON数组，每个元素含 term_en, term_zh, abbreviation(无则空串), one_liner(清晰的一句话定义), category(AI概念/AI技术/AI工程/AI应用/AI安全)。
没有符合条件的就输出 []。只输出JSON。`;

    const result = await callGLM(prompt, 1500);
    if (!result) { consecutiveFailures++; continue; }
    consecutiveFailures = 0;
    try {
      const m = result.match(/\[[\s\S]*\]/);
      const terms = JSON.parse(m ? m[0] : result);
      if (Array.isArray(terms)) {
        for (const term of terms) {
          if (!term.term_en || !term.one_liner) continue;
          if (isInGlossary(term.term_en, term.abbreviation)) continue;  // 只要新概念
          const matched = batch.filter(a => {
            const t = (a.title || '').toLowerCase();
            const en = (term.term_en || '').toLowerCase();
            return en && t.includes(en);
          });
          discovered.push({
            term_en: term.term_en.trim(),
            term_zh: (term.term_zh || '').trim(),
            abbreviation: (term.abbreviation || '').trim(),
            one_liner: term.one_liner.trim(),
            category: term.category || 'AI概念',
            appear_count: Math.max(1, matched.length),
            sources: [...new Set(matched.map(a => a.source).filter(Boolean))],
            source_urls: matched.slice(0, 5).map(a => a.link).filter(Boolean),
            matched_articles: matched.slice(0, 3).map(a => ({ title: a.title, link: a.link, source: a.source })),
            explanation: ''
          });
        }
      }
    } catch (e) {
      console.log(`[AI Discover] parse error: ${e.message}`);
    }
  }
  console.log(`[AI Discover] 额外发现 ${discovered.length} 个新词`);
  return discovered;
}

// ===== GLM 调用（带超时，失败返回 null） =====
async function callGLM(prompt, maxTokens = 200) {
  if (!GLM_API_KEY) return null;
  const body = JSON.stringify({
    model: GLM_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: maxTokens
  });
  const rawPromise = new Promise((resolve) => {
    const req = https.request(GLM_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GLM_API_KEY}` },
      timeout: 10000,
      agent: false
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data).choices?.[0]?.message?.content?.trim() || null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
  const r = await withTimeout(rawPromise, 20000, 'GLM API call');
  return Array.isArray(r) ? null : r;   // withTimeout 超时返回 []，归一化为 null
}

// ===== AI生成通俗解读（可选增强；无 explanation 的用 one_liner 兜底） =====
async function generateExplanations(hotTerms, deadline) {
  // 先用 glossary 已有解释或 one_liner 兜底，保证每条都有 explanation
  for (const term of hotTerms) {
    if (term.explanation) continue;
    const g = glossaryMap.get(term.id);
    term.explanation = (g && g.explanation) ? g.explanation : (term.one_liner || '');
  }
  if (!GLM_API_KEY) return hotTerms;

  console.log(`\n--- [可选] AI生成通俗解读 ---`);
  let consecutiveFails = 0;
  for (const term of hotTerms) {
    if (Date.now() > deadline) { console.log('[AI Explanation] 预算用尽，其余用兜底'); break; }
    if (consecutiveFails >= 3) { console.log('[AI Explanation] 连续失败，其余用兜底'); break; }
    if (glossaryMap.get(term.id)?.explanation) continue;  // 词库已有

    const titles = (term.matched_articles || []).slice(0, 3).map(a => a.title).join('；');
    const prompt = `请用通俗易懂的语言，为以下AI术语写一句简短解读（1-2句话，不超过50字，让普通人也能看懂）：
术语：${term.term_en}（${term.term_zh}${term.abbreviation ? '/' + term.abbreviation : ''}）
一句话描述：${term.one_liner || '无'}
近期相关标题：${titles || '无'}
只输出解读文字。`;
    const explanation = await callGLM(prompt);
    if (explanation) { consecutiveFails = 0; term.explanation = explanation; console.log(`[AI OK] ${term.term_en}`); }
    else { consecutiveFails++; }
  }
  return hotTerms;
}

// ===== 合并历史数据 =====
function mergeWithExisting(newTerms) {
  const hotTermsFile = path.join(ROOT, 'data', 'hot-terms.json');
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(hotTermsFile, 'utf8')); } catch { /* 无 */ }

  const today = new Date().toISOString().split('T')[0];
  const oldTerms = existing.filter(t => t.date !== today);
  const newIds = new Set(newTerms.map(t => t.id));
  // 只保留“仍属于当前新兴词清单”的历史词，让旧版关键词era的泛词(如Training/GAN)自然老化退出
  const emergingIds = new Set((keywords.emerging_terms || []).map(t => slugify(t.en)));

  // 老词降温：必须仍是新概念(在emerging清单内)、不在新榜、不在词库
  const kept = oldTerms
    .filter(t => !newIds.has(t.id) && !isInGlossary(t.term_en, t.abbreviation) && emergingIds.has(t.id))
    .map(t => ({
      ...t,
      appear_count: Math.max(1, (t.appear_count || 1) - 1),
      status: (t.appear_count || 1) <= 1 ? 'cold' : 'warm'
    }))
    .filter(t => t.status !== 'cold');

  return [...newTerms, ...kept];
}

// ===== 把匹配命中转成输出条目 =====
function hitToEntry(h, idx, today) {
  const t = h.term;
  return {
    id: slugify(t.en),
    rank: idx + 1,
    term_en: t.en,
    term_zh: t.zh || '',
    abbreviation: t.abbr || '',
    category: t.category || 'AI概念',
    one_liner: t.one_liner || '',
    appear_count: Math.max(1, h.count),
    sources: h.sources || [],
    source_urls: (h.source_urls || []).slice(0, 5),
    matched_articles: h.matched_articles || [],
    date: today,
    status: 'hot',
    explanation: ''
  };
}

// ===== 历史归档 / 排名变化 / 区间累计 =====
function readJSONsafe(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } }

// 对比最近一次归档，标注 rank_change(正=上升) 与 is_new
function annotateRankChanges(selected, today) {
  const histDir = path.join(ROOT, 'data', 'hot-history');
  const prevRanks = new Map();
  try {
    const idx = readJSONsafe(path.join(histDir, 'index.json'), []) || [];
    const prevDates = idx.filter(d => d < today).sort();
    if (prevDates.length) {
      const prev = readJSONsafe(path.join(histDir, prevDates[prevDates.length - 1] + '.json'), []) || [];
      prev.forEach(t => prevRanks.set(t.id, t.rank));
    }
  } catch { /* 无历史 */ }
  selected.forEach(t => {
    if (prevRanks.has(t.id)) { t.rank_change = prevRanks.get(t.id) - t.rank; t.is_new = false; }
    else { t.rank_change = null; t.is_new = true; }
  });
}

// 写当日快照 + 日期索引 + 7/30天累计榜
function writeHistoryAndAggregates(selected, today) {
  const dataDir = path.join(ROOT, 'data');
  const histDir = path.join(dataDir, 'hot-history');
  fs.mkdirSync(histDir, { recursive: true });
  fs.writeFileSync(path.join(histDir, today + '.json'), JSON.stringify(selected, null, 2), 'utf8');

  const dates = fs.readdirSync(histDir)
    .filter(fn => /^\d{4}-\d{2}-\d{2}\.json$/.test(fn))
    .map(fn => fn.slice(0, 10)).sort();
  fs.writeFileSync(path.join(histDir, 'index.json'), JSON.stringify(dates, null, 2), 'utf8');

  for (const win of [7, 30]) {
    const cutoff = new Date(Date.now() - (win - 1) * 86400000).toISOString().split('T')[0];
    const useDates = dates.filter(d => d >= cutoff);
    const agg = new Map();
    for (const d of useDates) {
      const snap = readJSONsafe(path.join(histDir, d + '.json'), []) || [];
      for (const t of snap) {
        const e = agg.get(t.id) || { id: t.id, appear_count: 0, days: 0 };
        e.appear_count += (t.appear_count || 0);
        e.days += 1;
        e.term_en = t.term_en; e.term_zh = t.term_zh; e.abbreviation = t.abbreviation || '';
        e.category = t.category || 'AI概念'; e.one_liner = t.one_liner || '';
        e.explanation = t.explanation || t.one_liner || '';
        e.sources = t.sources || []; e.source_urls = t.source_urls || []; e.matched_articles = t.matched_articles || [];
        agg.set(t.id, e);
      }
    }
    const ranked = [...agg.values()].sort((a, b) => b.appear_count - a.appear_count);
    ranked.forEach((t, i) => { t.rank = i + 1; t.status = 'hot'; });
    fs.writeFileSync(path.join(dataDir, win === 7 ? 'hot-7d.json' : 'hot-30d.json'), JSON.stringify(ranked, null, 2), 'utf8');
  }
  console.log(`[History] 归档 ${today}.json；7d/30d 累计榜已更新（共 ${dates.length} 天历史）`);
}

// ===== 主流程 =====
async function main() {
  const startedAt = Date.now();
  const today = new Date().toISOString().split('T')[0];

  console.log('=== AI术语热度抓取 v5.0 ===');
  console.log(`时间: ${new Date().toISOString()} | 窗口: 最近${HOURS_BACK}小时 | 目标: >=${MIN_HOT_TERMS}个新概念\n`);

  // 1. 抓取（即使全部失败，articles=[] 也不会让脚本崩）
  let articles = [];
  try { articles = await fetchAll(); } catch (e) { console.log('[fetchAll] 异常:', e.message); }

  // 2. 确定性主力：新兴词匹配 → 过滤已入库 → 排行
  const hits = matchWatchList(articles);
  const matchedNew = hits
    .filter(h => h.count >= 1 && !isInGlossary(h.term.en, h.term.abbr))
    .sort((a, b) => (a.term._tier - b.term._tier) || (b.count - a.count));  // emerging优先，再按频次
  console.log(`\n[Match] 命中且为新概念的词: ${matchedNew.length} 个`);

  const selected = [];
  const selectedIds = new Set();
  const pushEntry = (entry) => {
    if (selectedIds.has(entry.id)) return;
    selectedIds.add(entry.id);
    selected.push(entry);
  };
  matchedNew.slice(0, 40).forEach((h, i) => pushEntry(hitToEntry(h, i, today)));

  // 3. 可选增强：GLM 额外发现新词（有预算、失败不影响）
  if (GLM_API_KEY) {
    try {
      const deadline = startedAt + GLM_PHASE_BUDGET_MS;
      const discovered = await aiDiscoverNewTerms(articles, deadline);
      discovered.forEach((d) => {
        const id = slugify(d.term_en);
        if (selectedIds.has(id) || isInGlossary(d.term_en, d.abbreviation)) return;
        selectedIds.add(id);
        selected.push({
          id, rank: selected.length + 1, term_en: d.term_en, term_zh: d.term_zh,
          abbreviation: d.abbreviation, category: d.category, one_liner: d.one_liner,
          appear_count: d.appear_count || 1, sources: d.sources, source_urls: d.source_urls,
          matched_articles: d.matched_articles, date: today, status: 'hot', explanation: d.explanation || ''
        });
      });
    } catch (e) { console.log('[AI Discover] 异常(忽略):', e.message); }
  }

  // 4. 兜底保证 >=6：从新兴词清单补足（取未选中、非已入库的，按清单顺序）
  if (selected.length < MIN_HOT_TERMS) {
    console.log(`\n[兜底] 当前 ${selected.length} 个，不足 ${MIN_HOT_TERMS}，从新兴词清单补足`);
    for (const t of (keywords.emerging_terms || [])) {
      if (selected.length >= MIN_HOT_TERMS) break;
      const id = slugify(t.en);
      if (selectedIds.has(id) || isInGlossary(t.en, t.abbr)) continue;
      selectedIds.add(id);
      selected.push({
        id, rank: selected.length + 1, term_en: t.en, term_zh: t.zh || '', abbreviation: t.abbr || '',
        category: t.category || 'AI概念', one_liner: t.one_liner || '', appear_count: 1,
        sources: [], source_urls: [], matched_articles: [], date: today, status: 'hot', explanation: ''
      });
    }
  }

  // 重新编号 + 补充时间字段(供DB同步/自动沉淀使用)
  const nowIso = new Date().toISOString();
  selected.forEach((t, i) => {
    t.rank = i + 1;
    t.first_appeared = t.first_appeared || nowIso;
    t.last_appeared = nowIso;
  });

  // 标注排名变化 / 新词（对比最近一次归档）
  annotateRankChanges(selected, today);

  // 5. 可选增强：补充通俗解读（无 GLM 时用 one_liner 兜底）
  try {
    await generateExplanations(selected, startedAt + GLOBAL_TIMEOUT_MS - 30000);
  } catch (e) { console.log('[AI Explanation] 异常(忽略):', e.message); }

  console.log(`\n--- 今日热门词汇 (${selected.length}) ---`);
  selected.forEach((t, i) => console.log(`  ${i + 1}. ${t.term_en} (${t.term_zh}) - ${t.appear_count}次 - ${t.one_liner}`));

  // 6. 合并历史并写入
  const merged = mergeWithExisting(selected);
  merged.forEach(t => { if (!t.explanation) t.explanation = t.one_liner || ''; });
  const outFile = path.join(ROOT, 'data', 'hot-terms.json');
  fs.writeFileSync(outFile, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`\n[Done] 写入 ${merged.length} 条到 data/hot-terms.json (本次新榜 ${selected.length} 条)`);

  // 每日归档 + 7/30天累计榜（支撑前端"时间范围切换 / 日期回看"）
  try { writeHistoryAndAggregates(selected, today); } catch (e) { console.log('[History] 跳过: ' + e.message); }

  // 7. git 提交+推送（仅在有变化时；失败不影响）
  try {
    execSync('git config user.name "github-actions[bot]"');
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"');
    execSync('git add data/hot-terms.json data/hot-7d.json data/hot-30d.json data/hot-history');
    let hasChanges = false;
    try { execSync('git diff --cached --quiet'); } catch { hasChanges = true; }
    if (hasChanges) {
      execSync(`git commit -m "chore: update hot terms ${today}"`);
      execSync('git push');
      console.log('[Git] Pushed to remote');
    } else {
      console.log('[Git] No changes to push');
    }
  } catch (gitErr) {
    console.log(`[Git] ${gitErr.message}`);
  }
}

// 导出供测试使用
module.exports = { matchWatchList, buildWatchList, isInGlossary, hitToEntry, mergeWithExisting, slugify, annotateRankChanges, writeHistoryAndAggregates };

if (require.main === module) {
  // 全局兜底超时：到点也以 exit 0 退出（绝不让 workflow 标红）
  const globalTimer = setTimeout(() => {
    console.error('[Global Timeout] 超过预算，退出(0)');
    process.exit(0);
  }, GLOBAL_TIMEOUT_MS);
  globalTimer.unref();

  main()
    .then(() => { clearTimeout(globalTimer); process.exit(0); })
    .catch(err => {
      console.error('[Fatal but tolerated]', err && err.message);
      clearTimeout(globalTimer);
      process.exit(0);
    });
}
