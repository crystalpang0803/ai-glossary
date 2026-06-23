/**
 * AI术语热度抓取脚本 v3.0
 * 双模式抓取：RSS + 网页抓取（scrape）
 * AI生成通俗解读：智谱 GLM-4-Flash
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

// ===== AI生成通俗解读 =====
async function callGLM(prompt) {
  if (!GLM_API_KEY) {
    console.log('[AI] No GLM_API_KEY set, skipping AI generation');
    return null;
  }
  
  const body = JSON.stringify({
    model: GLM_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 200
  });
  
  return new Promise((resolve, reject) => {
    const req = https.request(GLM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GLM_API_KEY}`
      },
      timeout: 30000
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
  console.log('=== AI术语热度抓取 v3.0 ===');
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`时间窗口: 最近${HOURS_BACK}小时\n`);

  const articles = await fetchAll();
  const ranked = matchKeywords(articles);
  console.log(`\n[Match] ${ranked.length} terms matched (>1次)`);

  const newTerms = generateOutput(ranked);
  console.log(`[Rank] Top ${newTerms.length} terms`);

  // AI生成通俗解读
  await generateExplanations(newTerms);

  if (newTerms.length > 0) {
    console.log('\n--- 今日热门 Top 10 ---');
    newTerms.slice(0, 10).forEach(t => {
      console.log(`  ${t.rank}. ${t.term_en} (${t.term_zh}) - ${t.appear_count}次 [${t.sources.join(', ')}]`);
    });
  } else {
    console.log('\n--- 无热门术语（48hr内匹配次数均<=1）---');
  }

  const merged = mergeWithExisting(newTerms);
  const outFile = path.join(ROOT, 'data', 'hot-terms.json');
  fs.writeFileSync(outFile, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`\n[Done] Written ${merged.length} terms to data/hot-terms.json`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});