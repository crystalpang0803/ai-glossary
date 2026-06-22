#!/usr/bin/env node
/**
 * AI Glossary Crawler v2.0
 * 每天自动爬取AI新闻源，提取新术语候选词
 * 按跨源出现频次筛选热度，输出 hot-terms.json（10-20条）
 * 由 GitHub Actions 每日定时运行
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ===== 术语提取规则 =====

// 英文术语 + 中文翻译，如 "Diffusion Model（扩散模型）"
const PATTERN_EN_ZH = /([A-Z][a-zA-Z\s]{2,40}(?:Model|Network|Learning|Attention|Encoding|Decoding|Transformer|Diffusion|Token|Embedding|Generation|Reasoning|Agent|Training|Inference|Tuning|Alignment|Prompting|Retrieval|Compression|Quantization|Distillation|Fusion|Routing|MoE|Mixture))\s*[（(]([^)）]{2,20})[)）]/g;

// 大写缩写 + 中文翻译，如 "RAG（检索增强生成）"
const PATTERN_ABBR_ZH = /\b([A-Z]{2,6})\s*[（(]([^)）]{2,20})[)）]/g;

// "XX是一种/是指/指的是" 定义模式
const PATTERN_ZH_DEF = /[""「]?([^\s""「」]{2,15})[」""]?(?:是一种|是指|指的是|被称为|也称作|又称为|即)\s*([^。，；！？\n]{5,60})/g;

// arXiv标题中的术语
const PATTERN_ARXIV_TERM = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;

// 英文定义模式 "XXX is a/an ..."
const PATTERN_EN_DEF = /\b([A-Z][a-zA-Z]{2,30}(?:Model|Network|Learning|Attention|Transformer|Diffusion|Token|Embedding|Agent|Inference|Tuning|Alignment|Prompting|Retrieval|Reasoning|Generation|Compression|Quantization|Distillation))\b[^.]{0,20}(?:is a|is an|refers to|means|denotes)\s*([^.]{10,80})/gi;

// 术语词典类网站的术语条目
const PATTERN_GLOSSARY_TERM = /<(?:dt|h[2-4]|strong|b)>([^<]{2,60})<\/(?:dt|h[2-4]|strong|b)>(?:\s*(?:<[^>]*>)*\s*)*(?:<(?:dd|p|span)>([^<]{5,200})<\/(?:dd|p|span)>)/gi;

// 术语分类映射
const CATEGORY_MAP = {
  'model': '模型架构', 'network': '模型架构', 'transformer': '模型架构',
  'diffusion': '模型架构', 'attention': '模型架构', 'moe': '模型架构',
  'encoder': '模型架构', 'decoder': '模型架构', 'embedding': '模型架构',
  'learning': '训练优化', 'training': '训练优化', 'tuning': '训练优化',
  'optimization': '训练优化', 'alignment': '训练优化', 'distillation': '训练优化',
  'quantization': '训练优化', 'inference': '推理部署', 'compression': '推理部署',
  'deployment': '推理部署', 'serving': '推理部署',
  'prompt': '提示工程', 'reasoning': '提示工程', 'retrieval': '提示工程',
  'rag': '提示工程', 'agent': '应用场景', 'generation': '应用场景',
  'chat': '应用场景', 'tool': '应用场景',
  'token': '基础概念', 'encoding': '基础概念', 'decoding': '基础概念',
  'routing': '基础概念', 'fusion': '基础概念'
};

// ===== 提取器函数（必须在 SOURCES 之前定义） =====

function extractFromHuggingFace(html) {
  const terms = [];
  let match;
  PATTERN_EN_ZH.lastIndex = 0;
  while ((match = PATTERN_EN_ZH.exec(html)) !== null) {
    terms.push({ term_en: match[1].trim(), term_zh: match[2].trim() });
  }
  PATTERN_ABBR_ZH.lastIndex = 0;
  while ((match = PATTERN_ABBR_ZH.exec(html)) !== null) {
    const abbr = match[1].trim();
    if (abbr.length >= 2 && abbr.length <= 6 && /^[A-Z]+$/.test(abbr)) {
      terms.push({ term_en: '', term_zh: match[2].trim(), abbreviation: abbr });
    }
  }
  PATTERN_ZH_DEF.lastIndex = 0;
  while ((match = PATTERN_ZH_DEF.exec(html)) !== null) {
    terms.push({ term_en: '', term_zh: match[1].trim(), one_liner: match[2].trim() });
  }
  return terms;
}

function extractFromArxiv(xml) {
  const terms = [];
  const titles = xml.match(/<title>([^<]+)<\/title>/g) || [];
  titles.forEach(t => {
    const content = t.replace(/<\/?title>/g, '');
    let match;
    PATTERN_ARXIV_TERM.lastIndex = 0;
    while ((match = PATTERN_ARXIV_TERM.exec(content)) !== null) {
      const term = match[1].trim();
      if (term.length > 5 && term.length < 50 && !isCommonPhrase(term)) {
        terms.push({ term_en: term });
      }
    }
  });
  return terms;
}

function isCommonPhrase(term) {
  const phrases = ['We Propose', 'In This', 'Our Method', 'Based On', 'For The', 'Of The',
    'State Of', 'The Art', 'In Order', 'As Well', 'It Is', 'To The', 'With A',
    'Is A', 'Can Be', 'Such As', 'New York', 'United States', 'Conference On'];
  return phrases.some(p => term.includes(p));
}

function extractFromZhSite(html) {
  const terms = [];
  let match;
  PATTERN_EN_ZH.lastIndex = 0;
  while ((match = PATTERN_EN_ZH.exec(html)) !== null) {
    terms.push({ term_en: match[1].trim(), term_zh: match[2].trim() });
  }
  PATTERN_ABBR_ZH.lastIndex = 0;
  while ((match = PATTERN_ABBR_ZH.exec(html)) !== null) {
    const abbr = match[1].trim();
    if (abbr.length >= 2 && abbr.length <= 6 && /^[A-Z]+$/.test(abbr)) {
      terms.push({ term_en: '', term_zh: match[2].trim(), abbreviation: abbr });
    }
  }
  PATTERN_ZH_DEF.lastIndex = 0;
  while ((match = PATTERN_ZH_DEF.exec(html)) !== null) {
    const zh = match[1].trim();
    if (zh.length >= 2) {
      terms.push({ term_en: '', term_zh: zh, one_liner: match[2].trim() });
    }
  }
  return terms;
}

function extractFromEnSite(html) {
  const terms = [];
  let match;
  PATTERN_EN_ZH.lastIndex = 0;
  while ((match = PATTERN_EN_ZH.exec(html)) !== null) {
    terms.push({ term_en: match[1].trim(), term_zh: match[2].trim() });
  }
  PATTERN_EN_DEF.lastIndex = 0;
  while ((match = PATTERN_EN_DEF.exec(html)) !== null) {
    terms.push({ term_en: match[1].trim(), one_liner: match[2].trim() });
  }
  PATTERN_ABBR_ZH.lastIndex = 0;
  while ((match = PATTERN_ABBR_ZH.exec(html)) !== null) {
    const abbr = match[1].trim();
    if (abbr.length >= 2 && abbr.length <= 6 && /^[A-Z]+$/.test(abbr)) {
      terms.push({ term_en: '', term_zh: match[2].trim(), abbreviation: abbr });
    }
  }
  return terms;
}

function extractFromGlossarySite(html) {
  const terms = [];
  let match;
  PATTERN_GLOSSARY_TERM.lastIndex = 0;
  while ((match = PATTERN_GLOSSARY_TERM.exec(html)) !== null) {
    const termName = match[1].trim();
    const definition = match[2].trim();
    if (termName.length >= 2 && termName.length < 60 && !/^\d+$/.test(termName)) {
      if (/^[A-Z]/.test(termName)) {
        terms.push({ term_en: termName, one_liner: definition });
      } else {
        terms.push({ term_zh: termName, one_liner: definition });
      }
    }
  }
  PATTERN_EN_ZH.lastIndex = 0;
  while ((match = PATTERN_EN_ZH.exec(html)) !== null) {
    terms.push({ term_en: match[1].trim(), term_zh: match[2].trim() });
  }
  PATTERN_EN_DEF.lastIndex = 0;
  while ((match = PATTERN_EN_DEF.exec(html)) !== null) {
    terms.push({ term_en: match[1].trim(), one_liner: match[2].trim() });
  }
  PATTERN_ABBR_ZH.lastIndex = 0;
  while ((match = PATTERN_ABBR_ZH.exec(html)) !== null) {
    const abbr = match[1].trim();
    if (abbr.length >= 2 && abbr.length <= 6 && /^[A-Z]+$/.test(abbr)) {
      terms.push({ term_en: '', term_zh: match[2].trim(), abbreviation: abbr });
    }
  }
  return terms;
}

// ===== 配置：AI新闻源（用户名单 18个） =====
const SOURCES = [
  // ---- 中文源 ----
  { name: '机器之心', url: 'https://www.jiqizhixin.com/', type: 'html', lang: 'zh', extract: extractFromZhSite },
  { name: '量子位', url: 'https://www.qbitai.com/', type: 'html', lang: 'zh', extract: extractFromZhSite },
  { name: 'Hugging Face 中文社区', url: 'https://huggingface.co/blog', type: 'html', lang: 'zh', extract: extractFromHuggingFace },
  { name: '术语在线', url: 'https://www.termonline.cn/', type: 'html', lang: 'zh', extract: extractFromGlossarySite },
  { name: '北京智源人工智能研究院', url: 'https://www.baai.ac.cn/', type: 'html', lang: 'zh', extract: extractFromZhSite },
  { name: 'InfoQ 中文站', url: 'https://www.infoq.cn/', type: 'html', lang: 'zh', extract: extractFromZhSite },
  { name: '飞桨 PaddlePaddle', url: 'https://www.paddlepaddle.org.cn/', type: 'html', lang: 'zh', extract: extractFromZhSite },
  // ---- 英文源 ----
  { name: 'NVIDIA Technical Blog', url: 'https://developer.nvidia.com/blog/', type: 'html', lang: 'en', extract: extractFromEnSite },
  { name: 'Gartner IT Glossary', url: 'https://www.gartner.com/en/information-technology/glossary', type: 'html', lang: 'en', extract: extractFromGlossarySite },
  { name: 'arXiv AI (cs.AI)', url: 'https://rss.arxiv.org/rss/cs.AI', type: 'xml', lang: 'en', extract: extractFromArxiv },
  { name: 'Google AI Glossary', url: 'https://ai.google/glossary/', type: 'html', lang: 'en', extract: extractFromGlossarySite },
  { name: 'OpenAI Blog', url: 'https://openai.com/blog', type: 'html', lang: 'en', extract: extractFromEnSite },
  { name: 'DeepMind Blog', url: 'https://deepmind.google/blog/', type: 'html', lang: 'en', extract: extractFromEnSite },
  { name: 'Meta AI Blog', url: 'https://ai.meta.com/blog/', type: 'html', lang: 'en', extract: extractFromEnSite },
  { name: 'Papers with Code', url: 'https://paperswithcode.com/', type: 'html', lang: 'en', extract: extractFromEnSite },
  { name: 'Hugging Face', url: 'https://huggingface.co/blog', type: 'html', lang: 'en', extract: extractFromEnSite },
  { name: 'NVIDIA Deep Learning Glossary', url: 'https://developer.nvidia.com/glossary/', type: 'html', lang: 'en', extract: extractFromGlossarySite },
  { name: 'InfoQ', url: 'https://www.infoq.com/', type: 'html', lang: 'en', extract: extractFromEnSite }
];

// ===== 已有术语库（用于去重） =====
let existingTerms = [];
try {
  const glossaryPath = path.join(__dirname, '..', 'data', 'glossary.json');
  const data = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));
  existingTerms = data.map(t => ({
    id: t.id,
    term_en: (t.term_en || '').toLowerCase(),
    term_zh: t.term_zh || '',
    abbreviation: (t.abbreviation || '').toLowerCase()
  }));
} catch (e) {
  console.log('Warning: Could not load glossary.json for dedup');
}

let previousPending = [];
try {
  previousPending = JSON.parse(fs.readFileSync(path.join(__dirname, 'pending-terms.json'), 'utf8'));
} catch (e) {}

let previousHotTerms = [];
try {
  previousHotTerms = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hot-terms.json'), 'utf8'));
} catch (e) {}

// ===== 工具函数 =====
function fetchUrl(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout }, (res) => {
      let data = '';
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
      }
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function guessCategory(term) {
  const lower = term.toLowerCase();
  for (const [keyword, category] of Object.entries(CATEGORY_MAP)) {
    if (lower.includes(keyword)) return category;
  }
  return 'AI概念';
}

function generateId(termEn) {
  return termEn.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function isDuplicate(termEn, termZh, abbr) {
  const enLower = termEn.toLowerCase();
  const abbrLower = (abbr || '').toLowerCase();
  return existingTerms.some(t =>
    t.term_en === enLower || t.abbreviation === abbrLower ||
    (termZh && t.term_zh === termZh)
  ) || previousPending.some(t =>
    t.term_en.toLowerCase() === enLower ||
    (t.abbreviation && t.abbreviation.toLowerCase() === abbrLower)
  );
}

// 垃圾词过滤：排除明显不是术语的内容
function isJunkTerm(term) {
  const en = (term.term_en || '').trim();
  const zh = (term.term_zh || '').trim();
  const abbr = (term.abbreviation || '').trim();
  // 常见非术语缩写黑名单
  const JUNK_ABBR = new Set(['URL', 'API', 'HTTP', 'HTML', 'CSS', 'JSON', 'XML', 'SQL',
    'USB', 'CPU', 'GPU', 'RAM', 'ROM', 'SDK', 'IDE', 'AWS', 'GCP', 'SSE', 'RSS',
    'FAQ', 'CEO', 'PDF', 'PNG', 'JPG', 'SVG', 'CSS', 'DOM', 'VPN', 'SSH']);
  if (abbr && JUNK_ABBR.has(abbr)) return true;
  // 中文看起来像代码/URL片段
  if (zh && /^[a-zA-Z]/.test(zh) && !/[\u4e00-\u9fff]/.test(zh)) return true;
  // 英文太短且无缩写
  if (en && en.length < 3 && !abbr) return true;
  // 没有中文也没有英文也没有有意义的缩写
  if (!en && !zh && (!abbr || abbr.length < 2)) return true;
  return false;
}

// ===== 主流程 =====
async function main() {
  console.log('🤖 AI Glossary Crawler v2.0 - ' + new Date().toISOString());
  console.log(`📚 Existing terms: ${existingTerms.length}`);
  console.log(`📋 Previous pending: ${previousPending.length}`);
  console.log(`🔥 Previous hot terms: ${previousHotTerms.length}`);

  const allCandidates = [];
  const termSources = new Map();

  for (const source of SOURCES) {
    try {
      console.log(`\n🔍 Fetching: ${source.name} (${source.url})`);
      const content = await fetchUrl(source.url);
      console.log(`   Got ${content.length} bytes`);

      const terms = source.extract(content);
      console.log(`   Extracted ${terms.length} candidates`);

      terms.forEach(t => {
        t.source = source.name;
        t.found_at = new Date().toISOString().split('T')[0];
        const key = ((t.term_en || '') + (t.term_zh || '') + (t.abbreviation || '')).toLowerCase();
        if (!termSources.has(key)) termSources.set(key, new Set());
        termSources.get(key).add(source.name);
      });
      allCandidates.push(...terms);
    } catch (e) {
      console.log(`   ❌ Error: ${e.message}`);
    }
  }

  // 去重和过滤
  const seen = new Set();
  const uniqueTerms = [];
  for (const term of allCandidates) {
    const en = (term.term_en || '').trim();
    const zh = (term.term_zh || '').trim();
    const abbr = (term.abbreviation || '').trim();
    if (!en && !zh) continue;
    if (isJunkTerm(term)) continue;
    if (isDuplicate(en, zh, abbr)) continue;
    const key = (en + zh + abbr).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const id = generateId(en || abbr || zh);
    const sourcesSet = termSources.get(key) || new Set([term.source]);
    uniqueTerms.push({
      id, term_en: en, term_zh: zh, abbreviation: abbr,
      category: guessCategory(en || abbr || ''),
      one_liner: term.one_liner || '', definition: '',
      source: term.source || '', source_url: '',
      explanation: '', related: [], status: 'pending',
      submitted_at: new Date().toISOString(), auto_crawled: true,
      appear_count: sourcesSet.size,
      first_appeared: term.found_at || new Date().toISOString().split('T')[0],
      sources: [...sourcesSet]
    });
  }

  console.log(`\n✅ New unique candidates: ${uniqueTerms.length}`);

  // 合并候选
  const oldKeep = previousPending.filter(t => !uniqueTerms.some(n => n.id === t.id));
  const finalPending = [...uniqueTerms, ...oldKeep].slice(0, 100);
  fs.writeFileSync(path.join(__dirname, 'pending-terms.json'), JSON.stringify(finalPending, null, 2), 'utf8');
  console.log(`📝 Written pending-terms.json (${finalPending.length} terms)`);

  // ===== 热度筛选：生成 hot-terms.json =====
  const allForHot = [...finalPending];
  for (const prev of previousHotTerms) {
    const existing = allForHot.find(t => t.id === prev.id);
    if (existing) {
      const merged = new Set([...(prev.sources || [prev.source]), ...(existing.sources || [existing.source])]);
      existing.appear_count = merged.size;
      existing.sources = [...merged];
    } else if (!isDuplicate(prev.term_en, prev.term_zh, prev.abbreviation)) {
      allForHot.push(prev);
    }
  }

  const hotCandidates = allForHot
    .filter(t => (t.appear_count || 1) >= 2)
    .sort((a, b) => (b.appear_count || 1) - (a.appear_count || 1))
    .slice(0, 20);

  const hotTerms = hotCandidates.map(t => ({
    id: t.id, term_en: t.term_en || '', term_zh: t.term_zh || '',
    abbreviation: t.abbreviation || '', category: t.category || 'AI概念',
    one_liner: t.one_liner || '', definition: t.definition || '',
    source: t.sources ? t.sources.join(', ') : (t.source || ''),
    source_url: t.source_url || '', explanation: t.explanation || '',
    related: t.related || [], appear_count: t.appear_count || 1,
    first_appeared: t.first_appeared || t.found_at || new Date().toISOString().split('T')[0],
    status: 'hot', submitted_at: t.submitted_at || new Date().toISOString(), auto_crawled: true
  }));

  fs.writeFileSync(path.join(__dirname, '..', 'data', 'hot-terms.json'), JSON.stringify(hotTerms, null, 2), 'utf8');
  console.log(`🔥 Written hot-terms.json (${hotTerms.length} hot terms)`);

  const summary = {
    last_updated: new Date().toISOString(),
    total_pending: finalPending.length, hot_terms: hotTerms.length,
    new_today: uniqueTerms.length, sources_checked: SOURCES.length,
    top_hot: hotTerms.slice(0, 5).map(t => `${t.term_en || t.term_zh} (${t.appear_count}次)`)
  };
  fs.writeFileSync(path.join(__dirname, 'crawl-summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log(`\n📊 Pending: ${finalPending.length} | Hot: ${hotTerms.length}`);
  console.log(`   Top: ${summary.top_hot.join(', ')}`);
  console.log('\n🎉 Done!');
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });