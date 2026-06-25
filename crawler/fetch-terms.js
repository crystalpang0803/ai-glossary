/**
 * AI术语热度抓取脚本 v4.0
 * 双模式抓取：RSS + 网页抓取（scrape）
 * AI发现新术语：智谱 GLM-4-Flash
 * 筛选条件：1.跟AI行业相关 2.是新词（不在词库中+近一周出现） 3.是有定义的术语/概念
 * 用法: GLM_API_KEY=xxx node crawler/fetch-terms.js
 */

const Parser = require('rss-parser');
const https = require('https');
const http = require('http');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sources = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));
const keywords = JSON.parse(fs.readFileSync(path.join(__dirname, 'keywords.json'), 'utf8'));

// 加载glossary数据，用于查找已有explanation
let glossaryData = [];
try {
  glossaryData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'glossary.json'), 'utf8'));
} catch { /* 文件不存在 */ }
const glossaryMap = new Map(glossaryData.map(t => [t.id, t]));

const REQUEST_TIMEOUT = 15000;
const CONCURRENT_LIMIT = 5;
const MAX_ITEMS_PER_FEED = 50;
const HOURS_BACK = 48;
const GLOBAL_TIMEOUT_MS = 10 * 60 * 1000; // 全局超时10分钟

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
      // 跟随重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
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
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))
  ]).catch(err => {
    console.log(`[Skip] ${label}: ${err.message}`);
    return [];
  });
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
    
    // 用JSDOM解析HTML
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    
    // 提取所有标题文字（更通用的方式）
    const titles = [];
    const selectors = ['h1 a', 'h2 a', 'h3 a', 'h4 a', '.post-title a', '.article-title a', 
                       '.blog-title a', 'a[href*="/blog/"]', '.entry-title a'];
    
    for (const sel of selectors) {
      try {
        const els = doc.querySelectorAll(sel);
        els.forEach(el => {
          const text = (el.textContent || '').trim();
          const href = el.getAttribute('href') || '';
          if (text.length > 5 && text.length < 200 && !titles.find(t => t.title === text)) {
            titles.push({ title: text, link: href });
          }
        });
      } catch (e) { /* selector may be invalid */ }
    }
    
    // 如果选择器没找到，回退到meta标签
    if (titles.length === 0) {
      // 尝试提取og:title等
      const metaTitles = doc.querySelectorAll('meta[property="og:title"], meta[name="description"]');
      metaTitles.forEach(el => {
        const content = el.getAttribute('content') || '';
        if (content.length > 5 && content.length < 200) {
          titles.push({ title: content, link: '' });
        }
      });
    }
    
    // 去重并限制数量
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

// ===== AI发现新术语 =====
async function aiDiscoverNewTerms(articles) {
  if (!GLM_API_KEY) {
    console.log('[AI Discover] No GLM_API_KEY, falling back to keyword matching');
    return null; // 返回null表示需要fallback
  }

  // 构建已有词库列表（用于去重）
  const glossaryList = glossaryData.map(t => {
    const parts = [t.term_en];
    if (t.abbreviation) parts.push(`(${t.abbreviation})`);
    return parts.join(' ');
  }).join('、');

  // 收集所有文章标题，去重
  const allTitles = [];
  const seenTitles = new Set();
  for (const article of articles) {
    const title = (article.title || '').trim();
    if (title && title.length > 5 && !seenTitles.has(title)) {
      seenTitles.add(title);
      allTitles.push({ title, source: article.source || '', link: article.link || '' });
    }
  }

  if (allTitles.length === 0) {
    console.log('[AI Discover] No articles to analyze');
    return [];
  }

  console.log(`\n--- AI发现新术语 (${allTitles.length} unique titles) ---`);

  // 分批处理：每批最多30个标题
  const BATCH_SIZE = 30;
  const allDiscovered = [];

  for (let i = 0; i < allTitles.length; i += BATCH_SIZE) {
    const batch = allTitles.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allTitles.length / BATCH_SIZE);

    const titleList = batch.map((a, idx) => `${i + idx + 1}. [${a.source}] ${a.title}`).join('\n');

    const prompt = `以下是近一周AI领域的新闻标题，请从中提取满足以下条件的术语：

1. 跟AI行业相关（算法、模型架构、训练方法、推理技术、部署工程、评测基准、对齐安全、AI硬件、AI工具等）
2. 是新词（不在以下已有词库中，且是近一周才出现或才开始被广泛讨论的概念）
3. 是有定义的术语或概念——必须能写出一句话解释它的含义

排除以下类型：
- 纯产品名（如Cursor、Devin、Claude Code）
- 纯公司名或组织名
- 纯数字指标或评测分数
- 无法定义的模糊词或泛指词
- 已在词库中的词的同义别名

已有词库（${glossaryData.length}条）：${glossaryList}

标题：
${titleList}

输出JSON数组，每个元素包含：
- term_en: 英文术语名
- term_zh: 中文翻译
- abbreviation: 缩写（无则为空字符串）
- one_liner: 一句话定义（清晰解释该术语的含义）
- category: 分类（AI概念/AI技术/AI工程/AI应用/AI安全）

如果没有找到符合条件的新术语，输出空数组 []
只输出JSON，不要输出任何其他内容。`;

    console.log(`[AI Discover] Batch ${batchNum}/${totalBatches} (${batch.length} titles)...`);
    
    const result = await callGLM(prompt, 1500);
    
    if (result) {
      try {
        // 提取JSON部分（可能被markdown代码块包裹）
        let jsonStr = result;
        const jsonMatch = result.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        }
        
        const terms = JSON.parse(jsonStr);
        if (Array.isArray(terms)) {
          for (const term of terms) {
            if (term.term_en && term.one_liner) {
              // 记录来源信息
              const matchedArticles = batch.filter(a => {
                const t = (a.title || '').toLowerCase();
                const en = (term.term_en || '').toLowerCase();
                const abbr = (term.abbreviation || '').toLowerCase();
                return t.includes(en) || (abbr && abbr.length >= 2 && t.includes(abbr));
              }).map(a => ({ title: a.title, link: a.link, source: a.source }));

              const matchedSources = [...new Set(matchedArticles.map(a => a.source).filter(Boolean))];

              allDiscovered.push({
                term_en: term.term_en.trim(),
                term_zh: term.term_zh?.trim() || '',
                abbreviation: term.abbreviation?.trim() || '',
                one_liner: term.one_liner.trim(),
                category: term.category || 'AI概念',
                appear_count: Math.max(1, matchedArticles.length),
                sources: matchedSources,
                source_urls: matchedArticles.slice(0, 5).map(a => a.link).filter(Boolean),
                matched_articles: matchedArticles.slice(0, 3),
                explanation: ''
              });
            }
          }
          console.log(`[AI Discover] Batch ${batchNum}: found ${terms.length} terms`);
        }
      } catch (e) {
        console.log(`[AI Discover] Batch ${batchNum}: parse error - ${e.message}`);
        console.log(`[AI Discover] Raw response: ${result.substring(0, 200)}`);
      }
    }

    // 避免速率限制
    if (i + BATCH_SIZE < allTitles.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // 第二轮：验证每个术语是否确实是"有定义的术语"（最多验证20个，避免耗时过长）
  if (allDiscovered.length > 0) {
    const toVerify = allDiscovered.slice(0, 20);
    console.log(`\n[AI Verify] Verifying ${toVerify.length}/${allDiscovered.length} discovered terms...`);
    const verified = [];
    
    for (const term of toVerify) {
      const verifyPrompt = `判断以下词汇是否是一个"有明确定义的AI术语或概念"：

词汇：${term.term_en}（${term.term_zh}）
定义：${term.one_liner}

判断标准：
- 是术语/概念/方法/架构/协议/技术 → 是
- 是产品名/公司名/人名/项目名/模糊词 → 否

只输出"是"或"否"。`;

      const answer = await callGLM(verifyPrompt, 10);
      if (answer && answer.includes('是') && !answer.includes('否')) {
        verified.push(term);
        console.log(`[AI Verify] ✓ ${term.term_en}`);
      } else {
        console.log(`[AI Verify] ✗ ${term.term_en} (not a defined term)`);
      }
      
      await new Promise(r => setTimeout(r, 500));
    }
    
    console.log(`[AI Verify] ${verified.length}/${allDiscovered.length} terms verified`);
    return verified;
  }

  return allDiscovered;
}

// ===== AI生成通俗解读 =====
async function callGLM(prompt, maxTokens = 200) {
  if (!GLM_API_KEY) {
    console.log('[AI] No GLM_API_KEY set, skipping AI generation');
    return null;
  }
  
  const body = JSON.stringify({
    model: GLM_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: maxTokens
  });
  
  return new Promise((resolve, reject) => {
    const req = https.request(GLM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GLM_API_KEY}`
      },
      timeout: 30000,
      agent: false  // 避免agent池化导致连接不释放
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content?.trim() || null;
          resolve(content);
        } catch {
          console.log(`[AI Error] Parse failed: ${data.substring(0, 200)}`);
          resolve(null);
        }
      });
    });
    req.on('error', (err) => {
      console.log(`[AI Error] Request failed: ${err.message}`);
      resolve(null);
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function generateExplanations(hotTerms) {
  if (!GLM_API_KEY || hotTerms.length === 0) return hotTerms;
  
  console.log(`\n--- AI生成通俗解读 (${hotTerms.length} terms) ---`);
  
  for (const term of hotTerms) {
    // 检查glossary中是否已有explanation
    const glossaryEntry = glossaryMap.get(term.id);
    if (glossaryEntry?.explanation) {
      term.explanation = glossaryEntry.explanation;
      console.log(`[AI Skip] ${term.term_en}: 已有glossary解释`);
      continue;
    }
    
    // 构建AI prompt
    const articleTitles = (term.matched_articles || [])
      .slice(0, 3)
      .map(a => a.title)
      .join('；');
    
    const prompt = `请用通俗易懂的语言，为以下AI术语写一句简短的解读（1-2句话，不超过50字，让普通人也能看懂，不要用专业术语）：

术语：${term.term_en}（${term.term_zh}${term.abbreviation ? '/' + term.abbreviation : ''}）
一句话描述：${term.one_liner || '无'}
近期相关文章标题：${articleTitles || '无'}

只输出解读文字，不要输出任何其他内容。`;
    
    const explanation = await callGLM(prompt);
    if (explanation) {
      term.explanation = explanation;
      console.log(`[AI OK] ${term.term_en}: ${explanation}`);
    } else {
      console.log(`[AI Fail] ${term.term_en}: AI生成失败，保留one_liner`);
      term.explanation = term.one_liner || '';
    }
    
    // 避免速率限制，每次请求间隔1秒
    await new Promise(r => setTimeout(r, 1000));
  }
  
  return hotTerms;
}

// ===== 并发抓取所有源 =====
async function fetchAll() {
  const articles = [];
  
  // RSS源
  const rssSources = [
    ...sources.rss.chinese,
    ...sources.rss.english
  ];
  console.log(`\n--- RSS Sources (${rssSources.length}) ---`);
  for (let i = 0; i < rssSources.length; i += CONCURRENT_LIMIT) {
    const batch = rssSources.slice(i, i + CONCURRENT_LIMIT);
    const results = await Promise.all(batch.map(s => fetchRSS(s.url, s.name)));
    results.forEach(r => articles.push(...r));
  }
  
  // Scrape源
  const scrapeSources = [
    ...(sources.scrape?.chinese || []),
    ...(sources.scrape?.english || [])
  ];
  console.log(`\n--- Scrape Sources (${scrapeSources.length}) ---`);
  for (let i = 0; i < scrapeSources.length; i += CONCURRENT_LIMIT) {
    const batch = scrapeSources.slice(i, i + CONCURRENT_LIMIT);
    const results = await Promise.all(batch.map(s => fetchScrape(s)));
    results.forEach(r => articles.push(...r));
  }
  
  console.log(`\n[Total] Fetched ${articles.length} articles from ${rssSources.length + scrapeSources.length} sources`);
  return articles;
}

// ===== 关键词匹配 =====
function matchKeywords(articles) {
  const termHits = {};

  keywords.tracking_terms.forEach(term => {
    termHits[term.en] = {
      en: term.en, zh: term.zh, abbr: term.abbr,
      one_liner: term.one_liner || '', category: term.category || '',
      count: 0, sources: [], source_urls: [], matched_articles: []
    };
  });

  articles.forEach(article => {
    const text = (article.title + ' ' + article.content).toLowerCase();

    keywords.tracking_terms.forEach(term => {
      const patterns = [term.en.toLowerCase()];
      if (term.zh) patterns.push(term.zh.toLowerCase());
      if (term.abbr && term.abbr.length >= 2) patterns.push(term.abbr.toLowerCase());

      let matched = false;
      for (const p of patterns) {
        if (text.includes(p)) { matched = true; break; }
      }

      if (matched) {
        termHits[term.en].count++;
        if (!termHits[term.en].sources.includes(article.source)) {
          termHits[term.en].sources.push(article.source);
        }
        if (article.link && !termHits[term.en].source_urls.includes(article.link)) {
          termHits[term.en].source_urls.push(article.link);
        }
        if (termHits[term.en].matched_articles.length < 3) {
          termHits[term.en].matched_articles.push({
            title: article.title,
            link: article.link,
            source: article.source
          });
        }
      }
    });
  });

  return Object.values(termHits)
    .filter(t => t.count > 1)
    .sort((a, b) => b.count - a.count);
}

// ===== 生成输出 =====
function generateOutput(rankedTerms) {
  const today = new Date().toISOString().split('T')[0];
  const topN = rankedTerms.slice(0, 50);

  const hotTerms = topN.map((term, idx) => ({
    id: term.en.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
    rank: idx + 1,
    term_en: term.en,
    term_zh: term.zh,
    abbreviation: term.abbr || '',
    category: term.category || '',
    one_liner: term.one_liner || '',
    appear_count: term.count,
    sources: term.sources,
    source_urls: term.source_urls.slice(0, 5),
    matched_articles: term.matched_articles,
    date: today,
    status: 'hot'
  }));

  return hotTerms;
}

// ===== 合并历史数据 =====
function mergeWithExisting(newTerms) {
  const hotTermsFile = path.join(ROOT, 'data', 'hot-terms.json');
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(hotTermsFile, 'utf8'));
  } catch { /* 文件不存在或为空 */ }

  const today = new Date().toISOString().split('T')[0];
  const oldTerms = existing.filter(t => t.date !== today);
  const newIds = new Set(newTerms.map(t => t.id));

  const kept = oldTerms.filter(t => !newIds.has(t.id)).map(t => ({
    ...t,
    appear_count: Math.max(1, (t.appear_count || 1) - 1),
    status: (t.appear_count || 1) <= 1 ? 'cold' : 'warm'
  }));

  const merged = [...newTerms, ...kept.filter(t => t.status !== 'cold')];
  return merged;
}

// ===== 主流程 =====
async function main() {
  // 全局超时保护
  const globalTimer = setTimeout(() => {
    console.error('[Global Timeout] Script exceeded 10 minutes, forcing exit');
    process.exit(2);
  }, GLOBAL_TIMEOUT_MS);

  console.log('=== AI术语热度抓取 v4.0 ===');
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`时间窗口: 最近${HOURS_BACK}小时\n`);

  const articles = await fetchAll();
  let newTerms = [];

  // 优先使用AI发现新术语
  const discovered = await aiDiscoverNewTerms(articles);

  if (discovered && discovered.length > 0) {
    // AI发现模式：直接用AI结果
    const today = new Date().toISOString().split('T')[0];
    newTerms = discovered.map((term, idx) => ({
      id: term.term_en.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      rank: idx + 1,
      term_en: term.term_en,
      term_zh: term.term_zh,
      abbreviation: term.abbreviation,
      category: term.category,
      one_liner: term.one_liner,
      appear_count: term.appear_count || 1,
      sources: term.sources || [],
      source_urls: term.source_urls || [],
      matched_articles: term.matched_articles || [],
      date: today,
      status: 'hot',
      explanation: term.explanation || ''
    }));
    console.log(`\n[AI Discover] ${newTerms.length} new terms found`);
  } else if (discovered === null) {
    // Fallback：无GLM_API_KEY时使用关键词匹配
    console.log('\n[Fallback] Using keyword matching (no GLM_API_KEY)');
    const ranked = matchKeywords(articles);
    console.log(`[Match] ${ranked.length} terms matched (>1次)`);
    newTerms = generateOutput(ranked);
    console.log(`[Rank] Top ${newTerms.length} terms`);
  } else {
    console.log('\n[AI Discover] No new terms found');
  }

  // AI生成通俗解读（对没有explanation的词补充）
  await generateExplanations(newTerms);

  if (newTerms.length > 0) {
    console.log('\n--- 今日新发现术语 ---');
    newTerms.forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.term_en} (${t.term_zh}) - ${t.one_liner}`);
    });
  } else {
    console.log('\n--- 无新术语发现 ---');
  }

  const merged = mergeWithExisting(newTerms);
  const outFile = path.join(ROOT, 'data', 'hot-terms.json');
  fs.writeFileSync(outFile, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`\n[Done] Written ${merged.length} terms to data/hot-terms.json`);

  clearTimeout(globalTimer);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});