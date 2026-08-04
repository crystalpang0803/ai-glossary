/**
 * AI术语热度抓取脚本 v6.0 —— 从文章正文中发现"词库外的新术语"
 *
 * 核心理念(相比 v5 的根本改变):
 *   不再用一份写死的关键词清单去"套标题"。而是：
 *     1. 抓取各源近期文章，进入正文(arXiv RSS 自带完整摘要；量子位/DeepMind 等进文章页抓正文)
 *     2. 让 GLM 阅读正文，从中"发现"值得收录、且尚未入库的 AI 术语/新概念
 *     3. 用 glossary 去重(只保留新概念) → 按被多少篇文章/来源提及来排行
 *   固定清单彻底废弃；能发现什么词，取决于文章里真的在讨论什么。
 *
 * 兜底:
 *   - 无 GLM_API_KEY 或 GLM 连续失败 → 用正则从正文抽取候选词(弱兜底,仍来自正文而非清单)
 *   - 当天一无所获 → 沿用最近历史(降温),保证页面不空
 *   - 全程 try/catch + 各阶段硬超时;无论多差都 exit 0,绝不让 workflow 标红
 *
 * 用法: GLM_API_KEY=xxx node crawler/fetch-terms.js   (GLM_API_KEY 可省略,走正则兜底)
 */

const Parser = require('rss-parser');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sources = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));

// ---- glossary:用于"过滤已入库老词"和"复用已有解释" ----
let glossaryData = [];
try { glossaryData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'glossary.json'), 'utf8')); } catch { /* 无 */ }
const glossaryMap = new Map(glossaryData.map(t => [t.id, t]));
const glossaryIds = new Set(glossaryData.map(t => t.id));
const glossaryNames = new Set(glossaryData.map(t => (t.term_en || '').toLowerCase()).filter(Boolean));
const glossaryZh = new Set(glossaryData.map(t => (t.term_zh || '').toLowerCase()).filter(Boolean));
const glossaryAbbrs = new Set(glossaryData.map(t => (t.abbreviation || '').toLowerCase()).filter(Boolean));

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function isInGlossary(term_en, abbreviation, term_zh) {
  const id = slugify(term_en);
  const name = (term_en || '').toLowerCase();
  const zh = (term_zh || '').toLowerCase();
  const abbr = (abbreviation || '').toLowerCase();
  if (id && glossaryIds.has(id)) return true;
  if (name && glossaryNames.has(name)) return true;
  if (zh && glossaryZh.has(zh)) return true;
  if (abbr && abbr.length >= 2 && glossaryAbbrs.has(abbr)) return true;
  return false;
}

// ---- 配置 ----
const REQUEST_TIMEOUT = 15000;
const CONCURRENT_LIMIT = 5;
const MAX_ITEMS_PER_FEED = 40;
const HOURS_BACK = 96;
const BODY_FETCH_MAX = 24;                    // 最多进多少篇文章页抓正文
const BODY_PHASE_TIMEOUT_MS = 60 * 1000;      // 抓正文阶段硬超时
const GLM_MAX_ARTICLES = 40;                  // 送进 GLM 的文章上限(控成本)
const GLM_BATCH_ARTICLES = 4;                 // 每次 GLM 读几篇正文
const GLM_PHASE_BUDGET_MS = 180 * 1000;       // GLM 发现阶段总预算
const GLOBAL_TIMEOUT_MS = 8 * 60 * 1000;      // 全局兜底(远小于 workflow 的20分钟)
const TOP_N = 30;                             // 最终榜单保留条数
const BODY_MAX_CHARS = 1600;                  // 单篇送进 GLM 的正文截断长度

const GLM_API_KEY = process.env.GLM_API_KEY || '';
const GLM_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const GLM_MODEL = 'glm-4-flash';

const parser = new Parser({
  timeout: REQUEST_TIMEOUT,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
});

// ===== 工具 =====
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout])
    .catch(err => { console.log(`[Skip] ${label}: ${err.message}`); return null; })
    .finally(() => clearTimeout(timer));
}

function fetchPage(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('too many redirects'));
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
        return fetchPage(new URL(res.headers.location, url).href, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Status ${res.statusCode}`)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// 粗略正文提取:去脚本/样式/导航,保留正文文本
function htmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  h = h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
  return h.replace(/\s+/g, ' ').trim();
}

// ===== 抓取:RSS + (薄正文的)进文章页 =====
function rssContent(item) {
  return (item['content:encoded'] || item.content || item.contentSnippet || item.summary || '').toString();
}

async function fetchFeed(feed) {
  const res = await withTimeout(parser.parseURL(feed.url), REQUEST_TIMEOUT, feed.name);
  if (!res || !res.items) { console.log(`[Feed Skip] ${feed.name}`); return []; }
  let items = res.items.slice(0, MAX_ITEMS_PER_FEED);
  if (!feed.always_recent) {
    const cutoff = Date.now() - HOURS_BACK * 3600 * 1000;
    items = items.filter(it => {
      const d = it.pubDate || it.isoDate;
      if (!d) return true;
      return new Date(d).getTime() >= cutoff;
    });
  }
  console.log(`[Feed OK] ${feed.name}: ${items.length} articles`);
  return items.map(it => {
    const content = rssContent(it).replace(/\s+/g, ' ').trim();
    return {
      title: (it.title || '').trim(),
      content,
      text: content,                         // 稍后薄正文会被文章页正文替换/补充
      link: it.link || '',
      source: feed.name,
      lang: feed.lang || 'en',
      rich: !!feed.content_rich && content.length >= 250
    };
  });
}

async function fetchAll() {
  const feeds = sources.feeds || [];
  const articles = [];
  for (let i = 0; i < feeds.length; i += CONCURRENT_LIMIT) {
    const batch = feeds.slice(i, i + CONCURRENT_LIMIT);
    const results = await Promise.all(batch.map(f => fetchFeed(f).catch(() => [])));
    results.forEach(r => articles.push(...r));
  }
  // 对"正文薄"的文章进文章页抓正文(有上限+并发+阶段超时)
  const needBody = articles.filter(a => a.link && (!a.rich) && (a.text || '').length < 250).slice(0, BODY_FETCH_MAX);
  if (needBody.length) {
    console.log(`\n--- 进文章页抓正文 (${needBody.length} 篇, 阶段超时 ${BODY_PHASE_TIMEOUT_MS / 1000}s) ---`);
    const phase = (async () => {
      for (let i = 0; i < needBody.length; i += CONCURRENT_LIMIT) {
        const batch = needBody.slice(i, i + CONCURRENT_LIMIT);
        await Promise.all(batch.map(async a => {
          const html = await withTimeout(fetchPage(a.link), REQUEST_TIMEOUT, `body:${a.source}`);
          if (html) {
            const body = htmlToText(html);
            if (body && body.length > (a.text || '').length) a.text = body.slice(0, 4000);
          }
        }));
      }
    })();
    await withTimeout(phase, BODY_PHASE_TIMEOUT_MS, 'Body phase');
  }
  // 只保留有实质文本的文章
  const usable = articles.filter(a => (a.text || '').length >= 40 || (a.title || '').length >= 8);
  console.log(`\n[Total] ${articles.length} 篇文章, 其中 ${usable.length} 篇有可用文本`);
  return usable;
}

// ===== GLM 调用(带超时,失败返回 null) =====
async function callGLM(prompt, maxTokens = 1600) {
  if (!GLM_API_KEY) return null;
  const body = JSON.stringify({ model: GLM_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: maxTokens });
  const raw = new Promise((resolve) => {
    const req = https.request(GLM_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GLM_API_KEY}` },
      timeout: 25000, agent: false
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data).choices?.[0]?.message?.content?.trim() || null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
  const r = await withTimeout(raw, 28000, 'GLM call');
  return (typeof r === 'string') ? r : null;
}

// 选送进 GLM 的文章:工业/中文源优先,再用 arXiv 补足,保证多样性
function pickArticlesForGLM(articles) {
  const nonArxiv = articles.filter(a => !/arxiv/i.test(a.source));
  const arxiv = articles.filter(a => /arxiv/i.test(a.source));
  const picked = [...nonArxiv];
  for (const a of arxiv) { if (picked.length >= GLM_MAX_ARTICLES) break; picked.push(a); }
  return picked.slice(0, GLM_MAX_ARTICLES);
}

// ===== 核心:GLM 读正文,发现词库外新术语 =====
async function glmDiscover(articles, deadline) {
  if (!GLM_API_KEY) return [];
  const picked = pickArticlesForGLM(articles);
  if (!picked.length) return [];
  const glossaryList = glossaryData.map(t => t.term_en + (t.abbreviation ? `(${t.abbreviation})` : '')).join('、');

  const found = new Map();   // slug -> term对象
  let fails = 0;
  console.log(`\n--- GLM 读正文发现新术语 (${picked.length} 篇, 每批 ${GLM_BATCH_ARTICLES}) ---`);
  for (let i = 0; i < picked.length; i += GLM_BATCH_ARTICLES) {
    if (Date.now() > deadline) { console.log('[GLM] 预算用尽,停止发现'); break; }
    if (fails >= 3) { console.log('[GLM] 连续失败,停止发现'); break; }
    const batch = picked.slice(i, i + GLM_BATCH_ARTICLES);
    const corpus = batch.map((a, idx) => {
      const body = (a.text || a.content || '').slice(0, BODY_MAX_CHARS);
      return `【文章${idx + 1}·${a.source}】标题:${a.title}\n正文:${body}`;
    }).join('\n\n');

    const prompt = `你是AI术语编辑。下面是几篇AI领域文章的标题与正文。请通读正文,从中找出"值得收录进AI术语库的术语/概念",要求:
1. 必须是AI相关的技术、模型架构、算法、训练/推理方法、系统/工程、评测基准、对齐与安全等概念;
2. 必须能写出一句话定义(是"概念"而非泛泛而谈);
3. 优先挑正文里真正讨论、解释或提出的概念,而不仅是顺带提及的名字。
排除:公司名、产品名/型号名、人名、数据集/榜单的专有名、纯指标数字、无法定义的模糊说法。
排除:已在下列词库中的词(及其中英文别名):${glossaryList}

文章:
${corpus}

只输出JSON数组,每个元素含字段: term_en, term_zh(中文名), abbreviation(缩写,无则""), one_liner(一句话中文定义,20-45字), category(从"AI概念/AI技术/AI工程/AI应用/AI安全"里选一个)。没有合适的就输出 []。不要输出JSON以外的任何文字。`;

    const out = await callGLM(prompt, 1600);
    if (!out) { fails++; continue; }
    fails = 0;
    try {
      const m = out.match(/\[[\s\S]*\]/);
      const arr = JSON.parse(m ? m[0] : out);
      if (Array.isArray(arr)) {
        for (const t of arr) {
          if (!t || !t.term_en || !t.one_liner) continue;
          const term_en = String(t.term_en).trim();
          const abbr = String(t.abbreviation || '').trim();
          const term_zh = String(t.term_zh || '').trim();
          if (isInGlossary(term_en, abbr, term_zh)) continue;   // 只要新概念
          const id = slugify(term_en);
          if (!id || found.has(id)) continue;
          found.set(id, {
            id, term_en, term_zh, abbreviation: abbr,
            one_liner: String(t.one_liner).trim(),
            category: t.category || 'AI概念'
          });
        }
      }
    } catch (e) { console.log(`[GLM] 解析失败: ${e.message}`); }
  }
  console.log(`[GLM] 发现候选新术语 ${found.size} 个`);
  return [...found.values()];
}

// ===== 兜底:正则从正文抽候选新词(无 GLM 或 GLM 全失败时) =====
function regexDiscover(articles) {
  const cand = new Map();  // slug -> {term_en, term_zh, abbreviation, one_liner, category}
  const AI_SUFFIX = /(Model|Models|Network|Networks|Attention|Transformer|Diffusion|Embedding|Encoder|Decoder|Reasoning|Agent|Agents|Alignment|Prompting|Retrieval|Quantization|Distillation|Routing|Sampling|Decoding|Adapter|Tokenizer|Benchmark|Architecture)$/;
  const STOP = /\b(We|Our|This|The|In|On|For|Of|To|With|As|It|Is|Are|And|Or|A|An|These|Those|By|From|Using|Based|Propose|Present|Show|Results?|Method|Paper|Abstract|Announce|Type)\b/i;
  // 动词/动名词/介词开头的通常是句子片段而非术语,丢弃
  const BAD_START = /^(Why|How|What|When|Analyzing|Localizing|Benchmarking|Evolving|Understanding|Exploring|Rethinking|Towards?|Improving|Scaling|Enhancing|Learning|Investigating|Revisiting|Leveraging|Bridging|Beyond|Toward|Making|Building|Designing|Introducing|Enabling|Unifying)\b/i;
  // 超泛词(等价于已入库概念),丢弃
  const GENERIC = new Set(['language models', 'large language models', 'neural networks', 'deep neural networks', 'machine learning', 'deep learning', 'artificial intelligence', 'foundation models', 'ai agents', 'language model']);
  const singular = s => s.toLowerCase().replace(/s\b/g, '').replace(/\s+/g, ' ').trim();
  const isGenericOrKnown = (en) => GENERIC.has(en.toLowerCase()) || GENERIC.has(singular(en)) || isInGlossary(en) || isInGlossary(singular(en));
  for (const a of articles) {
    const text = ((a.title || '') + '. ' + (a.text || a.content || '')).slice(0, 3000);
    // 英文(中文) 形式
    let m; const reEnZh = /([A-Z][A-Za-z0-9]+(?:[ -][A-Za-z0-9]+){0,3})\s*[（(]([一-龥]{2,20})[)）]/g;
    while ((m = reEnZh.exec(text))) {
      const en = m[1].trim(); const zh = m[2].trim();
      if (en.length < 3 || STOP.test(en) || BAD_START.test(en)) continue;
      const id = slugify(en);
      if (!id || cand.has(id) || isGenericOrKnown(en) || isInGlossary(en, '', zh)) continue;
      cand.set(id, { id, term_en: en, term_zh: zh, abbreviation: '', one_liner: '', category: 'AI概念' });
    }
    // 含AI后缀的大写多词短语
    const reCap = /\b([A-Z][a-zA-Z0-9]+(?:[ -][A-Z][a-zA-Z0-9]+){1,3})\b/g;
    while ((m = reCap.exec(text))) {
      const en = m[1].trim();
      if (!AI_SUFFIX.test(en) || STOP.test(en) || BAD_START.test(en) || en.length < 6 || en.length > 40) continue;
      const id = slugify(en);
      if (!id || cand.has(id) || isGenericOrKnown(en)) continue;
      cand.set(id, { id, term_en: en, term_zh: '', abbreviation: '', one_liner: '', category: 'AI概念' });
    }
  }
  console.log(`[Regex兜底] 从正文抽出候选 ${cand.size} 个`);
  return [...cand.values()];
}

// ===== 统计:候选词在多少篇文章/来源被提及 → appear_count/sources =====
function scoreCandidates(cands, articles) {
  const scored = [];
  for (const c of cands) {
    const en = (c.term_en || '').toLowerCase();
    const zh = (c.term_zh || '').toLowerCase();
    const abbr = (c.abbreviation || '').toLowerCase();
    const abbrRe = abbr.length >= 2 ? new RegExp(`(^|[^a-z0-9])${abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`) : null;
    const sources = new Set(); const urls = []; const matched = [];
    let count = 0;
    for (const a of articles) {
      const hay = ((a.title || '') + ' ' + (a.text || a.content || '')).toLowerCase();
      let hit = false;
      if (en && en.length >= 3 && hay.includes(en)) hit = true;
      else if (zh && zh.length >= 2 && hay.includes(zh)) hit = true;
      else if (abbrRe && abbrRe.test(hay)) hit = true;
      if (hit) {
        count++;
        if (a.source) sources.add(a.source);
        if (a.link && urls.length < 5 && !urls.includes(a.link)) urls.push(a.link);
        if (matched.length < 3) matched.push({ title: a.title, link: a.link, source: a.source });
      }
    }
    scored.push({ ...c, appear_count: Math.max(1, count), sources: [...sources], source_urls: urls, matched_articles: matched });
  }
  // 排行:被提及次数 > 来源数 > 有中文名优先
  scored.sort((a, b) => (b.appear_count - a.appear_count) || (b.sources.length - a.sources.length) || ((b.term_zh ? 1 : 0) - (a.term_zh ? 1 : 0)));
  return scored;
}

// ===== GLM 生成通俗解读(可选;无则用 one_liner 兜底) =====
async function generateExplanations(terms, deadline) {
  for (const t of terms) { if (!t.explanation) t.explanation = t.one_liner || ''; }
  if (!GLM_API_KEY) return terms;
  console.log(`\n--- GLM 生成通俗解读 ---`);
  let fails = 0;
  for (const t of terms) {
    if (Date.now() > deadline) { console.log('[GLM解读] 预算用尽,其余用兜底'); break; }
    if (fails >= 3) { console.log('[GLM解读] 连续失败,其余用兜底'); break; }
    const titles = (t.matched_articles || []).slice(0, 3).map(a => a.title).join('；');
    const prompt = `用通俗易懂的中文,为下面这个AI术语写1-2句解读(不超过55字,让外行也能懂):
术语:${t.term_en}（${t.term_zh}${t.abbreviation ? '/' + t.abbreviation : ''}）
已知定义:${t.one_liner || '无'}
近期相关文章:${titles || '无'}
只输出解读文字。`;
    const ex = await callGLM(prompt, 200);
    if (ex) { fails = 0; t.explanation = ex; } else { fails++; }
  }
  return terms;
}

// ===== 历史沿用(避免空榜);list-free:任何仍非入库的旧词都可降温保留 =====
function mergeWithExisting(newTerms, today) {
  const file = path.join(ROOT, 'data', 'hot-terms.json');
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 无 */ }
  const newIds = new Set(newTerms.map(t => t.id));
  const kept = existing
    .filter(t => t.date !== today && !newIds.has(t.id) && !isInGlossary(t.term_en, t.abbreviation, t.term_zh))
    .map(t => ({ ...t, appear_count: Math.max(1, (t.appear_count || 1) - 1), status: (t.appear_count || 1) <= 1 ? 'cold' : 'warm' }))
    .filter(t => t.status !== 'cold');
  return [...newTerms, ...kept];
}

// ===== 历史归档 / 排名变化 / 7·30天累计(与前端"时间范围/日期回看"配套) =====
function readJSONsafe(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } }

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

function writeHistoryAndAggregates(selected, today) {
  const dataDir = path.join(ROOT, 'data');
  const histDir = path.join(dataDir, 'hot-history');
  fs.mkdirSync(histDir, { recursive: true });
  fs.writeFileSync(path.join(histDir, today + '.json'), JSON.stringify(selected, null, 2), 'utf8');
  const dates = fs.readdirSync(histDir).filter(fn => /^\d{4}-\d{2}-\d{2}\.json$/.test(fn)).map(fn => fn.slice(0, 10)).sort();
  fs.writeFileSync(path.join(histDir, 'index.json'), JSON.stringify(dates, null, 2), 'utf8');
  for (const win of [7, 30]) {
    const cutoff = new Date(Date.now() - (win - 1) * 86400000).toISOString().split('T')[0];
    const useDates = dates.filter(d => d >= cutoff);
    const agg = new Map();
    for (const d of useDates) {
      const snap = readJSONsafe(path.join(histDir, d + '.json'), []) || [];
      for (const t of snap) {
        const e = agg.get(t.id) || { id: t.id, appear_count: 0, days: 0 };
        e.appear_count += (t.appear_count || 0); e.days += 1;
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
  console.log(`[History] 归档 ${today}.json;7d/30d 累计榜已更新(共 ${dates.length} 天历史)`);
}

// ===== 主流程 =====
async function main() {
  const startedAt = Date.now();
  const today = new Date().toISOString().split('T')[0];
  console.log('=== AI术语热度抓取 v6.0（从正文发现新术语）===');
  console.log(`时间: ${new Date().toISOString()} | 窗口: ${HOURS_BACK}h | GLM: ${GLM_API_KEY ? '启用' : '未配置(走正则兜底)'}\n`);

  // 1. 抓取 + 进正文
  let articles = [];
  try { articles = await fetchAll(); } catch (e) { console.log('[fetchAll] 异常:', e.message); }

  // 2. 发现候选新术语:GLM 读正文为主,正则兜底
  let cands = [];
  try {
    cands = await glmDiscover(articles, startedAt + GLM_PHASE_BUDGET_MS);
  } catch (e) { console.log('[GLM发现] 异常(忽略):', e.message); }
  if (cands.length === 0) {
    console.log('[发现] GLM 无产出,启用正则兜底');
    cands = regexDiscover(articles);
  }

  // 3. 计分排行 + 取 TOP_N
  const scored = scoreCandidates(cands, articles).slice(0, TOP_N);

  // 4. 组装条目
  const nowIso = new Date().toISOString();
  const selected = scored.map((c, i) => ({
    id: c.id, rank: i + 1, term_en: c.term_en, term_zh: c.term_zh, abbreviation: c.abbreviation,
    category: c.category || 'AI概念', one_liner: c.one_liner || '', appear_count: c.appear_count,
    sources: c.sources || [], source_urls: c.source_urls || [], matched_articles: c.matched_articles || [],
    date: today, status: 'hot', explanation: '', first_appeared: nowIso, last_appeared: nowIso
  }));

  // 5. 排名变化/新词标注(对比最近一次归档)
  annotateRankChanges(selected, today);

  // 6. 通俗解读(GLM 可选,兜底 one_liner)
  try { await generateExplanations(selected, startedAt + GLOBAL_TIMEOUT_MS - 30000); } catch (e) { console.log('[解读] 异常(忽略):', e.message); }

  console.log(`\n--- 今日发现的新术语 (${selected.length}) ---`);
  selected.forEach((t, i) => console.log(`  ${i + 1}. ${t.term_en} (${t.term_zh}) - ${t.appear_count}篇 - ${t.one_liner}`));

  // 7. 历史沿用避免空榜 + 写出
  const merged = mergeWithExisting(selected, today);
  merged.forEach(t => { if (!t.explanation) t.explanation = t.one_liner || ''; });
  fs.writeFileSync(path.join(ROOT, 'data', 'hot-terms.json'), JSON.stringify(merged, null, 2), 'utf8');
  console.log(`\n[Done] 写入 ${merged.length} 条到 data/hot-terms.json (本次新榜 ${selected.length} 条)`);

  // 8. 归档 + 累计榜
  try { writeHistoryAndAggregates(selected, today); } catch (e) { console.log('[History] 跳过: ' + e.message); }
  console.log('[Done] 数据已写入本地;提交与推送由 workflow 步骤负责');
}

module.exports = { slugify, isInGlossary, htmlToText, regexDiscover, scoreCandidates, mergeWithExisting, annotateRankChanges, writeHistoryAndAggregates, glmDiscover, generateExplanations };

if (require.main === module) {
  const globalTimer = setTimeout(() => { console.error('[Global Timeout] 超预算,退出(0)'); process.exit(0); }, GLOBAL_TIMEOUT_MS);
  globalTimer.unref();
  main().then(() => { clearTimeout(globalTimer); process.exit(0); })
        .catch(err => { console.error('[Fatal but tolerated]', err && err.message); clearTimeout(globalTimer); process.exit(0); });
}
