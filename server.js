// ===== AI Glossary Server v3.0 =====
// 数据存储：Vercel部署用Neon Postgres，本地运行用JSON文件
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

// ===== 中间件 =====
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// 请求日志
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url} path=${req.path}`);
  next();
});

// ===== 数据层：自动检测使用数据库还是JSON文件 =====
let useDatabase = false;
let sql = null;

try {
  const { neon } = require('@neondatabase/serverless');
  if (process.env.DATABASE_URL) {
    sql = neon(process.env.DATABASE_URL);
    useDatabase = true;
    console.log('[DB] 使用 Neon Postgres 数据库');
  } else {
    console.log('[DB] 未设置 DATABASE_URL，使用本地 JSON 文件');
  }
} catch (e) {
  console.log('[DB] @neondatabase/serverless 未安装，使用本地 JSON 文件');
}

// ===== JSON 文件工具（本地运行降级） =====
const DATA_DIR = path.join(__dirname, 'data');
const GLOSSARY_FILE = path.join(DATA_DIR, 'glossary.json');
const HOT_TERMS_FILE = path.join(DATA_DIR, 'hot-terms.json');

function readJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) { return null; }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// 初始化JSON文件（本地运行时）
if (!useDatabase) {
  if (!fs.existsSync(GLOSSARY_FILE)) {
    console.error('[ERROR] data/glossary.json not found at:', GLOSSARY_FILE);
    // Vercel serverless 环境下不能 process.exit，但本地运行可以
    if (require.main === module) process.exit(1);
  }
  if (!fs.existsSync(HOT_TERMS_FILE)) {
    writeJSON(HOT_TERMS_FILE, []);
    console.log('[INIT] Created data/hot-terms.json');
  }
}

// ===== 通用数据操作 =====
async function getGlossary() {
  if (!useDatabase) return readJSON(GLOSSARY_FILE) || [];
  const rows = await sql`SELECT * FROM glossary ORDER BY term_en`;
  return rows.map(r => ({
    id: r.id, term_en: r.term_en, term_zh: r.term_zh,
    abbreviation: r.abbreviation || '', category: r.category || 'AI概念',
    one_liner: r.one_liner || '', definition: r.definition || '',
    explanation: r.explanation || '', source: r.source || '',
    source_url: r.source_url || '',
    related: r.related ? (typeof r.related === 'string' ? JSON.parse(r.related) : r.related) : [],
    sources: r.sources ? (typeof r.sources === 'string' ? JSON.parse(r.sources) : r.sources) : [],
    source_urls: r.source_urls ? (typeof r.source_urls === 'string' ? JSON.parse(r.source_urls) : r.source_urls) : [],
    matched_articles: r.matched_articles ? (typeof r.matched_articles === 'string' ? JSON.parse(r.matched_articles) : r.matched_articles) : [],
    date: r.date || '',
    created_at: r.created_at || '', updated_at: r.updated_at || ''
  }));
}

async function getHotTerms() {
  if (!useDatabase) return readJSON(HOT_TERMS_FILE) || [];
  const rows = await sql`SELECT * FROM hot_terms ORDER BY appear_count DESC, term_en`;
  return rows.map(r => ({
    id: r.id, term_en: r.term_en, term_zh: r.term_zh,
    abbreviation: r.abbreviation || '', category: r.category || 'AI概念',
    one_liner: r.one_liner || '', definition: r.definition || '',
    explanation: r.explanation || '', source: r.source || '',
    source_url: r.source_url || '',
    appear_count: r.appear_count || 1,
    date: r.date || '',
    sources: r.sources ? (typeof r.sources === 'string' ? JSON.parse(r.sources) : r.sources) : [],
    source_urls: r.source_urls ? (typeof r.source_urls === 'string' ? JSON.parse(r.source_urls) : r.source_urls) : [],
    matched_articles: r.matched_articles ? (typeof r.matched_articles === 'string' ? JSON.parse(r.matched_articles) : r.matched_articles) : [],
    related: r.related ? (typeof r.related === 'string' ? JSON.parse(r.related) : r.related) : [],
    status: r.status || 'hot',
    first_appeared: r.first_appeared || '',
    last_appeared: r.last_appeared || ''
  }));
}

async function findGlossaryTerm(id) {
  if (!useDatabase) {
    const glossary = readJSON(GLOSSARY_FILE) || [];
    return glossary.find(t => t.id === id);
  }
  const rows = await sql`SELECT * FROM glossary WHERE id = ${id}`;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id, term_en: r.term_en, term_zh: r.term_zh,
    abbreviation: r.abbreviation || '', category: r.category || 'AI概念',
    one_liner: r.one_liner || '', definition: r.definition || '',
    explanation: r.explanation || '', source: r.source || '',
    source_url: r.source_url || '',
    related: r.related ? (typeof r.related === 'string' ? JSON.parse(r.related) : r.related) : [],
    sources: r.sources ? (typeof r.sources === 'string' ? JSON.parse(r.sources) : r.sources) : [],
    source_urls: r.source_urls ? (typeof r.source_urls === 'string' ? JSON.parse(r.source_urls) : r.source_urls) : [],
    matched_articles: r.matched_articles ? (typeof r.matched_articles === 'string' ? JSON.parse(r.matched_articles) : r.matched_articles) : [],
    date: r.date || ''
  };
}

async function findHotTerm(id) {
  if (!useDatabase) {
    const hotTerms = readJSON(HOT_TERMS_FILE) || [];
    return hotTerms.find(t => t.id === id);
  }
  const rows = await sql`SELECT * FROM hot_terms WHERE id = ${id}`;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id, term_en: r.term_en, term_zh: r.term_zh,
    abbreviation: r.abbreviation || '', category: r.category || 'AI概念',
    one_liner: r.one_liner || '', definition: r.definition || '',
    explanation: r.explanation || '', source: r.source || '',
    source_url: r.source_url || '',
    appear_count: r.appear_count || 1,
    sources: r.sources ? (typeof r.sources === 'string' ? JSON.parse(r.sources) : r.sources) : [],
    source_urls: r.source_urls ? (typeof r.source_urls === 'string' ? JSON.parse(r.source_urls) : r.source_urls) : [],
    matched_articles: r.matched_articles ? (typeof r.matched_articles === 'string' ? JSON.parse(r.matched_articles) : r.matched_articles) : [],
    related: r.related ? (typeof r.related === 'string' ? JSON.parse(r.related) : r.related) : [],
    status: r.status || 'hot',
    first_appeared: r.first_appeared || '',
    last_appeared: r.last_appeared || ''
  };
}

function toJsonStr(val) {
  if (!val) return '[]';
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

// ===== API: 正式词库 =====

// 获取所有术语
app.get('/api/terms', async (req, res) => {
  try {
    const glossary = await getGlossary();
    const hotTerms = await getHotTerms();
    const status = req.query.status || 'all';
    if (status === 'official') return res.json(glossary);
    if (status === 'hot') return res.json(hotTerms);
    const officialWithStatus = glossary.map(t => ({ ...t, status: 'official' }));
    const hotWithStatus = hotTerms.map(t => ({ ...t, status: t.status || 'hot' }));
    return res.json([...hotWithStatus, ...officialWithStatus]);
  } catch (e) {
    console.error('[API] GET /terms error:', e.message);
    res.status(500).json({ error: '数据库错误: ' + e.message });
  }
});

// 获取单个术语
app.get('/api/terms/:id', async (req, res) => {
  try {
    const term = await findGlossaryTerm(req.params.id) || await findHotTerm(req.params.id);
    if (!term) return res.status(404).json({ error: '术语不存在' });
    res.json(term);
  } catch (e) {
    res.status(500).json({ error: '数据库错误: ' + e.message });
  }
});

// 添加术语到正式词库
app.post('/api/terms', async (req, res) => {
  try {
    const term = req.body;
    if (!term.term_en || !term.term_zh) return res.status(400).json({ error: 'term_en 和 term_zh 为必填字段' });
    if (!term.id) term.id = term.term_en.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    if (useDatabase) {
      const existing = await sql`SELECT id FROM glossary WHERE id = ${term.id}`;
      if (existing.length > 0) return res.status(409).json({ error: '术语ID已存在' });
      const now = new Date().toISOString();
      await sql`INSERT INTO glossary (id, term_en, term_zh, abbreviation, category, one_liner, definition, explanation, source, source_url, related, sources, source_urls, matched_articles, date, created_at, updated_at)
        VALUES (${term.id}, ${term.term_en}, ${term.term_zh}, ${term.abbreviation || ''}, ${term.category || 'AI概念'}, ${term.one_liner || ''}, ${term.definition || ''}, ${term.explanation || ''}, ${term.source || '用户添加'}, ${term.source_url || ''}, ${toJsonStr(term.related)}, ${toJsonStr(term.sources)}, ${toJsonStr(term.source_urls)}, ${toJsonStr(term.matched_articles)}, ${term.date || now.split('T')[0]}, ${now}, ${now})`;
      console.log(`[API] 添加术语到DB: ${term.term_en}`);
      res.status(201).json(term);
    } else {
      const glossary = readJSON(GLOSSARY_FILE) || [];
      if (glossary.find(t => t.id === term.id)) return res.status(409).json({ error: '术语ID已存在' });
      term.category = term.category || 'AI概念';
      term.one_liner = term.one_liner || '';
      term.definition = term.definition || '';
      term.explanation = term.explanation || '';
      term.source = term.source || '用户添加';
      term.source_url = term.source_url || '';
      term.related = term.related || [];
      term.created_at = new Date().toISOString();
      term.updated_at = new Date().toISOString();
      glossary.push(term);
      writeJSON(GLOSSARY_FILE, glossary);
      console.log(`[API] 添加术语: ${term.term_en}`);
      res.status(201).json(term);
    }
  } catch (e) {
    console.error('[API] POST /terms error:', e.message);
    res.status(500).json({ error: '数据库错误: ' + e.message });
  }
});

// 更新术语
app.put('/api/terms/:id', async (req, res) => {
  try {
    const updates = req.body;
    delete updates.id;
    if (useDatabase) {
      const existing = await sql`SELECT id FROM glossary WHERE id = ${req.params.id}`;
      if (existing.length === 0) return res.status(404).json({ error: '术语不存在' });
      const now = new Date().toISOString();
      await sql`UPDATE glossary SET
        term_en = ${updates.term_en || ''}, term_zh = ${updates.term_zh || ''},
        abbreviation = ${updates.abbreviation || ''}, category = ${updates.category || 'AI概念'},
        one_liner = ${updates.one_liner || ''}, definition = ${updates.definition || ''},
        explanation = ${updates.explanation || ''}, source = ${updates.source || ''},
        source_url = ${updates.source_url || ''}, related = ${toJsonStr(updates.related)},
        updated_at = ${now}
        WHERE id = ${req.params.id}`;
      const updated = await findGlossaryTerm(req.params.id);
      console.log(`[API] 更新术语: ${req.params.id}`);
      res.json(updated);
    } else {
      const glossary = readJSON(GLOSSARY_FILE) || [];
      const idx = glossary.findIndex(t => t.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: '术语不存在' });
      updates.updated_at = new Date().toISOString();
      glossary[idx] = { ...glossary[idx], ...updates };
      writeJSON(GLOSSARY_FILE, glossary);
      res.json(glossary[idx]);
    }
  } catch (e) {
    res.status(500).json({ error: '数据库错误: ' + e.message });
  }
});

// 删除术语
app.delete('/api/terms/:id', async (req, res) => {
  try {
    if (useDatabase) {
      const existing = await sql`SELECT id FROM glossary WHERE id = ${req.params.id}`;
      if (existing.length === 0) return res.status(404).json({ error: '术语不存在' });
      await sql`DELETE FROM glossary WHERE id = ${req.params.id}`;
      console.log(`[API] 删除术语: ${req.params.id}`);
      res.json({ success: true });
    } else {
      let glossary = readJSON(GLOSSARY_FILE) || [];
      const idx = glossary.findIndex(t => t.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: '术语不存在' });
      const removed = glossary.splice(idx, 1)[0];
      writeJSON(GLOSSARY_FILE, glossary);
      res.json({ success: true, removed });
    }
  } catch (e) {
    res.status(500).json({ error: '数据库错误: ' + e.message });
  }
});

// ===== API: 热点词汇 =====

app.get('/api/hot-terms', async (req, res) => {
  try {
    res.json(await getHotTerms());
  } catch (e) {
    res.status(500).json({ error: '数据库错误: ' + e.message });
  }
});

app.post('/api/hot-terms', async (req, res) => {
  try {
    const term = req.body;
    if (!term.term_en || !term.term_zh) return res.status(400).json({ error: 'term_en 和 term_zh 为必填字段' });
    if (!term.id) term.id = term.term_en.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    if (useDatabase) {
      // 检查是否已在正式词库
      const inGlossary = await sql`SELECT id FROM glossary WHERE id = ${term.id}`;
      if (inGlossary.length > 0) return res.status(409).json({ error: '该术语已在正式词库中' });
      // 检查是否已是热点
      const existing = await sql`SELECT * FROM hot_terms WHERE id = ${term.id}`;
      if (existing.length > 0) {
        const now = new Date().toISOString();
        const newCount = (existing[0].appear_count || 1) + 1;
        await sql`UPDATE hot_terms SET appear_count = ${newCount}, last_appeared = ${now} WHERE id = ${term.id}`;
        const updated = await findHotTerm(term.id);
        console.log(`[HOT] 热点词汇再次出现: ${term.term_en}, count=${newCount}`);
        return res.json(updated);
      }
      // 新热点词汇
      const now = new Date().toISOString();
      await sql`INSERT INTO hot_terms (id, term_en, term_zh, abbreviation, category, one_liner, definition, explanation, source, source_url, appear_count, first_appeared, last_appeared, status, related, date, sources, source_urls, matched_articles)
        VALUES (${term.id}, ${term.term_en}, ${term.term_zh}, ${term.abbreviation || ''}, ${term.category || 'AI概念'}, ${term.one_liner || ''}, ${term.definition || ''}, ${term.explanation || ''}, ${term.source || '热点发现'}, ${term.source_url || ''}, 1, ${now}, ${now}, 'hot', ${toJsonStr(term.related)}, ${term.date || now.split('T')[0]}, ${toJsonStr(term.sources)}, ${toJsonStr(term.source_urls)}, ${toJsonStr(term.matched_articles)})`;
      console.log(`[HOT] 新热点词汇到DB: ${term.term_en}`);
      res.status(201).json(await findHotTerm(term.id));
    } else {
      const hotTerms = readJSON(HOT_TERMS_FILE) || [];
      const glossary = readJSON(GLOSSARY_FILE) || [];
      if (glossary.find(t => t.id === term.id)) return res.status(409).json({ error: '该术语已在正式词库中' });
      const existingIdx = hotTerms.findIndex(t => t.id === term.id);
      if (existingIdx !== -1) {
        hotTerms[existingIdx].appear_count = (hotTerms[existingIdx].appear_count || 1) + 1;
        hotTerms[existingIdx].last_appeared = new Date().toISOString();
        writeJSON(HOT_TERMS_FILE, hotTerms);
        return res.json(hotTerms[existingIdx]);
      }
      term.status = 'hot';
      term.appear_count = 1;
      term.first_appeared = new Date().toISOString();
      term.last_appeared = new Date().toISOString();
      term.category = term.category || 'AI概念';
      term.one_liner = term.one_liner || '';
      term.definition = term.definition || '';
      term.explanation = term.explanation || '';
      term.source = term.source || '热点发现';
      term.source_url = term.source_url || '';
      term.related = term.related || [];
      hotTerms.push(term);
      writeJSON(HOT_TERMS_FILE, hotTerms);
      console.log(`[HOT] 新热点词汇: ${term.term_en}`);
      res.status(201).json(term);
    }
  } catch (e) {
    console.error('[API] POST /hot-terms error:', e.message);
    res.status(500).json({ error: '数据库错误: ' + e.message });
  }
});

// 沉淀热点词汇到正式词库
app.post('/api/hot-terms/:id/promote', async (req, res) => {
  try {
    if (useDatabase) {
      const hotTerm = await findHotTerm(req.params.id);
      if (!hotTerm) return res.status(404).json({ error: '热点词汇不存在' });
      const inGlossary = await sql`SELECT id FROM glossary WHERE id = ${req.params.id}`;
      if (inGlossary.length > 0) return res.status(409).json({ error: '该术语已在正式词库中' });
      const now = new Date().toISOString();
      await sql`INSERT INTO glossary (id, term_en, term_zh, abbreviation, category, one_liner, definition, explanation, source, source_url, related, sources, source_urls, matched_articles, date, created_at, updated_at)
        VALUES (${hotTerm.id}, ${hotTerm.term_en}, ${hotTerm.term_zh}, ${hotTerm.abbreviation || ''}, ${hotTerm.category || 'AI概念'}, ${hotTerm.one_liner || ''}, ${hotTerm.definition || ''}, ${hotTerm.explanation || ''}, ${hotTerm.source || ''}, ${hotTerm.source_url || ''}, ${toJsonStr(hotTerm.related)}, ${toJsonStr(hotTerm.sources)}, ${toJsonStr(hotTerm.source_urls)}, ${toJsonStr(hotTerm.matched_articles)}, ${hotTerm.date || now.split('T')[0]}, ${now}, ${now})`;
      await sql`DELETE FROM hot_terms WHERE id = ${req.params.id}`;
      console.log(`[PROMOTE] 沉淀: ${hotTerm.term_en} → 正式词库`);
      res.json({ success: true, promoted: hotTerm });
    } else {
      const hotTerms = readJSON(HOT_TERMS_FILE) || [];
      const glossary = readJSON(GLOSSARY_FILE) || [];
      const idx = hotTerms.findIndex(t => t.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: '热点词汇不存在' });
      const term = hotTerms[idx];
      delete term.status; delete term.appear_count; delete term.first_appeared; delete term.last_appeared;
      term.created_at = term.created_at || new Date().toISOString();
      term.updated_at = new Date().toISOString();
      glossary.push(term);
      writeJSON(GLOSSARY_FILE, glossary);
      hotTerms.splice(idx, 1);
      writeJSON(HOT_TERMS_FILE, hotTerms);
      res.json({ success: true, promoted: term });
    }
  } catch (e) {
    res.status(500).json({ error: '数据库错误: ' + e.message });
  }
});

// 删除热点词汇
app.delete('/api/hot-terms/:id', async (req, res) => {
  try {
    if (useDatabase) {
      const existing = await sql`SELECT id FROM hot_terms WHERE id = ${req.params.id}`;
      if (existing.length === 0) return res.status(404).json({ error: '热点词汇不存在' });
      await sql`DELETE FROM hot_terms WHERE id = ${req.params.id}`;
      console.log(`[HOT] 删除热点词汇: ${req.params.id}`);
      res.json({ success: true });
    } else {
      let hotTerms = readJSON(HOT_TERMS_FILE) || [];
      const idx = hotTerms.findIndex(t => t.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: '热点词汇不存在' });
      const removed = hotTerms.splice(idx, 1)[0];
      writeJSON(HOT_TERMS_FILE, hotTerms);
      res.json({ success: true, removed });
    }
  } catch (e) {
    res.status(500).json({ error: '数据库错误: ' + e.message });
  }
});

// ===== API: 自动沉淀 =====
app.post('/api/auto-promote', async (req, res) => {
  try {
    const hotTerms = await getHotTerms();
    const now = new Date();
    const promoted = [];
    const removed = [];

    for (const term of hotTerms) {
      const firstDate = new Date(term.first_appeared);
      const lastDate = new Date(term.last_appeared);
      const daysSinceFirst = (now - firstDate) / (1000 * 60 * 60 * 24);
      const daysSinceLast = (now - lastDate) / (1000 * 60 * 60 * 24);

      // 规则1: 7天内出现3次 → 立即沉淀
      if (daysSinceFirst <= 7 && (term.appear_count || 0) >= 3) {
        if (useDatabase) {
          const dbNow = new Date().toISOString();
          await sql`INSERT INTO glossary (id, term_en, term_zh, abbreviation, category, one_liner, definition, explanation, source, source_url, related, sources, source_urls, matched_articles, date, created_at, updated_at)
            VALUES (${term.id}, ${term.term_en}, ${term.term_zh}, ${term.abbreviation || ''}, ${term.category || 'AI概念'}, ${term.one_liner || ''}, ${term.definition || ''}, ${term.explanation || ''}, ${term.source || ''}, ${term.source_url || ''}, ${toJsonStr(term.related)}, ${toJsonStr(term.sources)}, ${toJsonStr(term.source_urls)}, ${toJsonStr(term.matched_articles)}, ${term.date || dbNow.split('T')[0]}, ${dbNow}, ${dbNow})
            ON CONFLICT (id) DO NOTHING`;
          await sql`DELETE FROM hot_terms WHERE id = ${term.id}`;
        }
        promoted.push(term);
        continue;
      }
      // 规则2: 30天未再出现 → 自动删除
      if (daysSinceFirst >= 30 && daysSinceLast >= 14) {
        if (useDatabase) { await sql`DELETE FROM hot_terms WHERE id = ${term.id}`; }
        removed.push(term);
        continue;
      }
      // 规则3: 30天仍在出现 → 自动沉淀
      if (daysSinceFirst >= 30 && daysSinceLast < 14) {
        if (useDatabase) {
          const dbNow = new Date().toISOString();
          await sql`INSERT INTO glossary (id, term_en, term_zh, abbreviation, category, one_liner, definition, explanation, source, source_url, related, sources, source_urls, matched_articles, date, created_at, updated_at)
            VALUES (${term.id}, ${term.term_en}, ${term.term_zh}, ${term.abbreviation || ''}, ${term.category || 'AI概念'}, ${term.one_liner || ''}, ${term.definition || ''}, ${term.explanation || ''}, ${term.source || ''}, ${term.source_url || ''}, ${toJsonStr(term.related)}, ${toJsonStr(term.sources)}, ${toJsonStr(term.source_urls)}, ${toJsonStr(term.matched_articles)}, ${term.date || dbNow.split('T')[0]}, ${dbNow}, ${dbNow})
            ON CONFLICT (id) DO NOTHING`;
          await sql`DELETE FROM hot_terms WHERE id = ${term.id}`;
        }
        promoted.push(term);
        continue;
      }
    }

    if (!useDatabase && (promoted.length > 0 || removed.length > 0)) {
      const glossary = readJSON(GLOSSARY_FILE) || [];
      let remainingHot = readJSON(HOT_TERMS_FILE) || [];
      promoted.forEach(t => { delete t.status; delete t.appear_count; delete t.first_appeared; delete t.last_appeared; t.created_at = t.created_at || now.toISOString(); t.updated_at = now.toISOString(); glossary.push(t); });
      const promotedIds = new Set(promoted.map(t => t.id));
      const removedIds = new Set(removed.map(t => t.id));
      remainingHot = remainingHot.filter(t => !promotedIds.has(t.id) && !removedIds.has(t.id));
      writeJSON(GLOSSARY_FILE, glossary);
      writeJSON(HOT_TERMS_FILE, remainingHot);
    }

    res.json({ promoted: promoted.length, removed: removed.length, details: { promoted, removed } });
  } catch (e) {
    res.status(500).json({ error: '数据库错误: ' + e.message });
  }
});

// ===== API: 统计信息 =====
app.get('/api/stats', async (req, res) => {
  try {
    const glossary = await getGlossary();
    const hotTerms = await getHotTerms();
    const categories = {};
    glossary.forEach(t => { categories[t.category] = (categories[t.category] || 0) + 1; });
    res.json({ total: glossary.length, hotCount: hotTerms.length, categories, storage: useDatabase ? 'postgres' : 'json' });
  } catch (e) {
    res.status(500).json({ error: '数据库错误: ' + e.message });
  }
});

// ===== API: 新增词汇(用户提交, 独立于热点; 不会被每日同步清空) =====
const SUBMITTED_FILE = path.join(DATA_DIR, 'submitted-terms.json');
async function ensureSubmittedTable() {
  if (!useDatabase) return;
  await sql`CREATE TABLE IF NOT EXISTS submitted_terms (
    id VARCHAR(255) PRIMARY KEY, term_en VARCHAR(500) NOT NULL, term_zh VARCHAR(500) NOT NULL,
    abbreviation VARCHAR(100) DEFAULT '', category VARCHAR(100) DEFAULT 'AI概念',
    one_liner TEXT DEFAULT '', definition TEXT DEFAULT '', explanation TEXT DEFAULT '',
    source VARCHAR(500) DEFAULT '', source_url VARCHAR(1000) DEFAULT '', related JSONB DEFAULT '[]',
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, status VARCHAR(50) DEFAULT 'pending')`;
}

app.get('/api/submitted-terms', async (req, res) => {
  try {
    if (useDatabase) {
      await ensureSubmittedTable();
      const rows = await sql`SELECT * FROM submitted_terms ORDER BY submitted_at DESC`;
      return res.json(rows.map(r => ({ ...r, related: r.related ? (typeof r.related === 'string' ? JSON.parse(r.related) : r.related) : [] })));
    }
    return res.json(readJSON(SUBMITTED_FILE) || []);
  } catch (e) { res.status(500).json({ error: '数据库错误: ' + e.message }); }
});

app.post('/api/submitted-terms', async (req, res) => {
  try {
    const term = req.body;
    if (!term.term_en || !term.term_zh) return res.status(400).json({ error: 'term_en 和 term_zh 为必填字段' });
    if (!term.id) term.id = term.term_en.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    term.status = 'pending';
    term.submitted_at = new Date().toISOString();
    term.source = term.source || '用户提交';
    if (useDatabase) {
      await ensureSubmittedTable();
      const inGloss = await sql`SELECT id FROM glossary WHERE id = ${term.id}`;
      if (inGloss.length > 0) return res.status(409).json({ error: '该术语已在正式词库中' });
      await sql`INSERT INTO submitted_terms (id, term_en, term_zh, abbreviation, category, one_liner, definition, explanation, source, source_url, related, submitted_at, status)
        VALUES (${term.id}, ${term.term_en}, ${term.term_zh}, ${term.abbreviation || ''}, ${term.category || 'AI概念'}, ${term.one_liner || ''}, ${term.definition || ''}, ${term.explanation || ''}, ${term.source}, ${term.source_url || ''}, ${toJsonStr(term.related)}, ${term.submitted_at}, 'pending')
        ON CONFLICT (id) DO UPDATE SET term_zh = EXCLUDED.term_zh, one_liner = EXCLUDED.one_liner, submitted_at = EXCLUDED.submitted_at`;
      return res.status(201).json(term);
    } else {
      const glossary = readJSON(GLOSSARY_FILE) || [];
      if (glossary.find(t => t.id === term.id)) return res.status(409).json({ error: '该术语已在正式词库中' });
      const list = readJSON(SUBMITTED_FILE) || [];
      const idx = list.findIndex(t => t.id === term.id);
      term.related = term.related || [];
      if (idx >= 0) list[idx] = { ...list[idx], ...term }; else list.push(term);
      writeJSON(SUBMITTED_FILE, list);
      return res.status(201).json(term);
    }
  } catch (e) { res.status(500).json({ error: '提交失败: ' + e.message }); }
});

app.put('/api/submitted-terms/:id', async (req, res) => {
  try {
    const u = req.body; delete u.id;
    if (useDatabase) {
      await ensureSubmittedTable();
      await sql`UPDATE submitted_terms SET term_en = ${u.term_en || ''}, term_zh = ${u.term_zh || ''}, abbreviation = ${u.abbreviation || ''}, category = ${u.category || 'AI概念'}, one_liner = ${u.one_liner || ''}, definition = ${u.definition || ''}, explanation = ${u.explanation || ''}, source = ${u.source || ''}, source_url = ${u.source_url || ''}, related = ${toJsonStr(u.related)} WHERE id = ${req.params.id}`;
      return res.json({ id: req.params.id, ...u });
    } else {
      const list = readJSON(SUBMITTED_FILE) || [];
      const idx = list.findIndex(t => t.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: '新增词汇不存在' });
      list[idx] = { ...list[idx], ...u };
      writeJSON(SUBMITTED_FILE, list);
      return res.json(list[idx]);
    }
  } catch (e) { res.status(500).json({ error: '更新失败: ' + e.message }); }
});

app.post('/api/submitted-terms/:id/promote', async (req, res) => {
  try {
    if (useDatabase) {
      await ensureSubmittedTable();
      const rows = await sql`SELECT * FROM submitted_terms WHERE id = ${req.params.id}`;
      if (rows.length === 0) return res.status(404).json({ error: '新增词汇不存在' });
      const t = rows[0];
      const exists = await sql`SELECT id FROM glossary WHERE id = ${req.params.id}`;
      if (exists.length === 0) {
        const now = new Date().toISOString();
        await sql`INSERT INTO glossary (id, term_en, term_zh, abbreviation, category, one_liner, definition, explanation, source, source_url, related, date, created_at, updated_at)
          VALUES (${t.id}, ${t.term_en}, ${t.term_zh}, ${t.abbreviation || ''}, ${t.category || 'AI概念'}, ${t.one_liner || ''}, ${t.definition || ''}, ${t.explanation || ''}, ${t.source || ''}, ${t.source_url || ''}, ${toJsonStr(t.related)}, ${now.split('T')[0]}, ${now}, ${now})`;
      }
      await sql`DELETE FROM submitted_terms WHERE id = ${req.params.id}`;
      return res.json({ promoted: { id: t.id, term_en: t.term_en, term_zh: t.term_zh } });
    } else {
      const list = readJSON(SUBMITTED_FILE) || [];
      const idx = list.findIndex(t => t.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: '新增词汇不存在' });
      const t = list[idx];
      const glossary = readJSON(GLOSSARY_FILE) || [];
      if (!glossary.find(g => g.id === t.id)) {
        delete t.status; delete t.submitted_at;
        t.created_at = new Date().toISOString(); t.updated_at = t.created_at;
        glossary.push(t); writeJSON(GLOSSARY_FILE, glossary);
      }
      list.splice(idx, 1); writeJSON(SUBMITTED_FILE, list);
      return res.json({ promoted: t });
    }
  } catch (e) { res.status(500).json({ error: '审核通过失败: ' + e.message }); }
});

app.delete('/api/submitted-terms/:id', async (req, res) => {
  try {
    if (useDatabase) {
      await ensureSubmittedTable();
      await sql`DELETE FROM submitted_terms WHERE id = ${req.params.id}`;
      return res.json({ success: true });
    } else {
      let list = readJSON(SUBMITTED_FILE) || [];
      list = list.filter(t => t.id !== req.params.id);
      writeJSON(SUBMITTED_FILE, list);
      return res.json({ success: true });
    }
  } catch (e) { res.status(500).json({ error: '删除失败: ' + e.message }); }
});

// ===== 旧链接重定向 =====
app.get('/admin-inline.html', (req, res) => res.redirect('/admin.html'));

// ===== 静态文件服务 =====
app.use(express.static(__dirname));

app.get('/data/:file', (req, res, next) => {
  const file = req.params.file;
  if (file === 'glossary.json' || file === 'hot-terms.json') {
    const filePath = path.join(DATA_DIR, file);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);
    return res.status(404).json({ error: '数据文件不存在' });
  }
  res.status(404).json({ error: '直接访问数据文件已禁用' });
});

// ===== 启动服务器 =====
if (require.main === module) {
  app.listen(PORT, HOST, async () => {
    const glossary = await getGlossary();
    const hotTerms = await getHotTerms();
    console.log(``);
    console.log(`  ╔══════════════════════════════════════╗`);
    console.log(`  ║   AI Glossary Server v3.0            ║`);
    console.log(`  ╠══════════════════════════════════════╣`);
    console.log(`  ║   http://${HOST}:${PORT}              ║`);
    console.log(`  ║   存储: ${useDatabase ? 'Neon Postgres' : '本地 JSON'}${' '.repeat(24 - (useDatabase ? 12 : 8))}║`);
    console.log(`  ║   正式词汇: ${glossary.length.toString().padEnd(24)}║`);
    console.log(`  ║   热点词汇: ${hotTerms.length.toString().padEnd(24)}║`);
    console.log(`  ╚══════════════════════════════════════╝`);
    console.log(``);
  });
}

module.exports = app;