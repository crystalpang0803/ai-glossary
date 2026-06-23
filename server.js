// ===== AI Glossary Server =====
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

// 请求日志（Vercel 调试用）
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url} path=${req.path}`);
  next();
});

// ===== 数据文件路径 =====
const DATA_DIR = path.join(__dirname, 'data');
const GLOSSARY_FILE = path.join(DATA_DIR, 'glossary.json');
const HOT_TERMS_FILE = path.join(DATA_DIR, 'hot-terms.json');

// ===== 数据读写工具 =====
function readJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ===== 初始化数据文件 =====
// 如果 data/glossary.json 不存在，记录错误但不退出（Vercel 兼容）
if (!fs.existsSync(GLOSSARY_FILE)) {
  console.error('[ERROR] data/glossary.json not found!');
  if (require.main === module) process.exit(1); // 本地运行时退出
}

// 初始化 hot-terms.json（热点词汇）
if (!fs.existsSync(HOT_TERMS_FILE)) {
  writeJSON(HOT_TERMS_FILE, []);
  console.log('[INIT] Created data/hot-terms.json');
}

// ===== API: 正式词库 =====

// 获取所有术语（支持 ?status=official|hot|all）
app.get('/api/terms', (req, res) => {
  const glossary = readJSON(GLOSSARY_FILE) || [];
  const hotTerms = readJSON(HOT_TERMS_FILE) || [];
  const status = req.query.status || 'all';

  if (status === 'official') {
    return res.json(glossary);
  }
  if (status === 'hot') {
    return res.json(hotTerms);
  }
  // all: 合并返回，热点词汇带 status 标记
  const officialWithStatus = glossary.map(t => ({ ...t, status: 'official' }));
  const hotWithStatus = hotTerms.map(t => ({ ...t, status: t.status || 'hot' }));
  return res.json([...hotWithStatus, ...officialWithStatus]);
});

// 获取单个术语
app.get('/api/terms/:id', (req, res) => {
  const glossary = readJSON(GLOSSARY_FILE) || [];
  const hotTerms = readJSON(HOT_TERMS_FILE) || [];
  const term = glossary.find(t => t.id === req.params.id) || hotTerms.find(t => t.id === req.params.id);
  if (!term) return res.status(404).json({ error: '术语不存在' });
  res.json(term);
});

// 添加术语到正式词库
app.post('/api/terms', (req, res) => {
  const glossary = readJSON(GLOSSARY_FILE) || [];
  const term = req.body;

  // 验证必填字段
  if (!term.term_en || !term.term_zh) {
    return res.status(400).json({ error: 'term_en 和 term_zh 为必填字段' });
  }

  // 生成 ID（如果没有提供）
  if (!term.id) {
    term.id = term.term_en.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  // 检查是否已存在
  if (glossary.find(t => t.id === term.id)) {
    return res.status(409).json({ error: '术语ID已存在' });
  }

  // 设置默认值
  term.category = term.category || 'AI概念';
  term.one_liner = term.one_liner || '';
  term.definition = term.definition || '';
  term.explanation = term.explanation || '';
  term.source = term.source || '用户添加';
  term.source_url = term.source_url || '';
  term.related = term.related || [];
  term.created_at = term.created_at || new Date().toISOString();
  term.updated_at = new Date().toISOString();

  glossary.push(term);
  writeJSON(GLOSSARY_FILE, glossary);
  console.log(`[API] 添加术语: ${term.term_en} (${term.id})`);
  res.status(201).json(term);
});

// 更新术语
app.put('/api/terms/:id', (req, res) => {
  const glossary = readJSON(GLOSSARY_FILE) || [];
  const idx = glossary.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '术语不存在' });

  const updates = req.body;
  delete updates.id; // 不允许修改 ID
  updates.updated_at = new Date().toISOString();

  glossary[idx] = { ...glossary[idx], ...updates };
  writeJSON(GLOSSARY_FILE, glossary);
  console.log(`[API] 更新术语: ${req.params.id}`);
  res.json(glossary[idx]);
});

// 删除术语
app.delete('/api/terms/:id', (req, res) => {
  let glossary = readJSON(GLOSSARY_FILE) || [];
  const idx = glossary.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '术语不存在' });

  const removed = glossary.splice(idx, 1)[0];
  writeJSON(GLOSSARY_FILE, glossary);
  console.log(`[API] 删除术语: ${req.params.id}`);
  res.json({ success: true, removed });
});

// ===== API: 热点词汇 =====

// 获取热点词汇
app.get('/api/hot-terms', (req, res) => {
  const hotTerms = readJSON(HOT_TERMS_FILE) || [];
  res.json(hotTerms);
});

// 添加热点词汇
app.post('/api/hot-terms', (req, res) => {
  const hotTerms = readJSON(HOT_TERMS_FILE) || [];
  const glossary = readJSON(GLOSSARY_FILE) || [];
  const term = req.body;

  if (!term.term_en || !term.term_zh) {
    return res.status(400).json({ error: 'term_en 和 term_zh 为必填字段' });
  }

  // 生成 ID
  if (!term.id) {
    term.id = term.term_en.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  // 检查是否已在正式词库
  if (glossary.find(t => t.id === term.id)) {
    return res.status(409).json({ error: '该术语已在正式词库中' });
  }

  // 检查是否已是热点词汇
  const existingIdx = hotTerms.findIndex(t => t.id === term.id);
  if (existingIdx !== -1) {
    // 已存在：更新出现次数和最近出现时间
    hotTerms[existingIdx].appear_count = (hotTerms[existingIdx].appear_count || 1) + 1;
    hotTerms[existingIdx].last_appeared = new Date().toISOString();
    writeJSON(HOT_TERMS_FILE, hotTerms);
    console.log(`[HOT] 热点词汇再次出现: ${term.term_en}, count=${hotTerms[existingIdx].appear_count}`);
    return res.json(hotTerms[existingIdx]);
  }

  // 新热点词汇
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
});

// 沉淀热点词汇到正式词库
app.post('/api/hot-terms/:id/promote', (req, res) => {
  const hotTerms = readJSON(HOT_TERMS_FILE) || [];
  const glossary = readJSON(GLOSSARY_FILE) || [];

  const idx = hotTerms.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '热点词汇不存在' });

  const term = hotTerms[idx];
  // 移除热点标记字段
  delete term.status;
  delete term.appear_count;
  delete term.first_appeared;
  delete term.last_appeared;
  term.created_at = term.created_at || new Date().toISOString();
  term.updated_at = new Date().toISOString();

  // 添加到正式词库
  glossary.push(term);
  writeJSON(GLOSSARY_FILE, glossary);

  // 从热点词库移除
  hotTerms.splice(idx, 1);
  writeJSON(HOT_TERMS_FILE, hotTerms);

  console.log(`[PROMOTE] 沉淀: ${term.term_en} → 正式词库`);
  res.json({ success: true, promoted: term });
});

// 删除热点词汇
app.delete('/api/hot-terms/:id', (req, res) => {
  let hotTerms = readJSON(HOT_TERMS_FILE) || [];
  const idx = hotTerms.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '热点词汇不存在' });

  const removed = hotTerms.splice(idx, 1)[0];
  writeJSON(HOT_TERMS_FILE, hotTerms);
  console.log(`[HOT] 删除热点词汇: ${req.params.id}`);
  res.json({ success: true, removed });
});

// ===== API: 自动沉淀 =====
// 规则：
// 1. 出现 >= 3次 且 首次出现 <= 7天内 → 立即沉淀
// 2. 首次出现 >= 30天 且 最后出现 >= 14天 → 自动删除（已不热）
// 3. 首次出现 >= 30天 且 最后出现 < 14天 → 自动沉淀（持续热门）
app.post('/api/auto-promote', (req, res) => {
  const hotTerms = readJSON(HOT_TERMS_FILE) || [];
  const glossary = readJSON(GLOSSARY_FILE) || [];
  const now = new Date();
  const promoted = [];
  const removed = [];

  const remaining = hotTerms.filter(term => {
    const firstDate = new Date(term.first_appeared);
    const lastDate = new Date(term.last_appeared);
    const daysSinceFirst = (now - firstDate) / (1000 * 60 * 60 * 24);
    const daysSinceLast = (now - lastDate) / (1000 * 60 * 60 * 24);

    // 规则1: 7天内出现3次 → 立即沉淀
    if (daysSinceFirst <= 7 && (term.appear_count || 0) >= 3) {
      delete term.status;
      delete term.appear_count;
      delete term.first_appeared;
      delete term.last_appeared;
      term.created_at = term.created_at || now.toISOString();
      term.updated_at = now.toISOString();
      glossary.push(term);
      promoted.push(term);
      console.log(`[AUTO-PROMOTE] 规则1(7天3次): ${term.term_en}`);
      return false; // 从热点移除
    }

    // 规则2: 30天未再出现 → 自动删除
    if (daysSinceFirst >= 30 && daysSinceLast >= 14) {
      removed.push(term);
      console.log(`[AUTO-PROMOTE] 规则2(已过时删除): ${term.term_en}`);
      return false;
    }

    // 规则3: 30天仍在出现 → 自动沉淀
    if (daysSinceFirst >= 30 && daysSinceLast < 14) {
      delete term.status;
      delete term.appear_count;
      delete term.first_appeared;
      delete term.last_appeared;
      term.created_at = term.created_at || now.toISOString();
      term.updated_at = now.toISOString();
      glossary.push(term);
      promoted.push(term);
      console.log(`[AUTO-PROMOTE] 规则3(持续热门): ${term.term_en}`);
      return false;
    }

    return true; // 保留
  });

  if (promoted.length > 0 || removed.length > 0) {
    writeJSON(GLOSSARY_FILE, glossary);
    writeJSON(HOT_TERMS_FILE, remaining);
  }

  res.json({
    promoted: promoted.length,
    removed: removed.length,
    details: { promoted, removed }
  });
});

// ===== API: 统计信息 =====
app.get('/api/stats', (req, res) => {
  const glossary = readJSON(GLOSSARY_FILE) || [];
  const hotTerms = readJSON(HOT_TERMS_FILE) || [];
  const categories = {};
  glossary.forEach(t => {
    categories[t.category] = (categories[t.category] || 0) + 1;
  });
  res.json({
    total: glossary.length,
    hotCount: hotTerms.length,
    categories
  });
});

// ===== 提交新术语（用户端） =====
app.post('/api/submit', (req, res) => {
  const term = req.body;
  if (!term.term_en || !term.term_zh) {
    return res.status(400).json({ error: 'term_en 和 term_zh 为必填字段' });
  }

  // 生成 ID
  if (!term.id) {
    term.id = term.term_en.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  term.status = 'hot'; // 用户提交的先进入热点词汇
  term.appear_count = 1;
  term.first_appeared = new Date().toISOString();
  term.last_appeared = new Date().toISOString();
  term.category = term.category || 'AI概念';
  term.one_liner = term.one_liner || term.description || '';
  term.definition = term.definition || '';
  term.explanation = term.explanation || '';
  term.source = term.source || '用户提交';
  term.source_url = term.source_url || '';
  term.related = term.related || [];

  const hotTerms = readJSON(HOT_TERMS_FILE) || [];
  const glossary = readJSON(GLOSSARY_FILE) || [];

  // 已在正式词库？
  if (glossary.find(t => t.id === term.id)) {
    return res.status(409).json({ error: '该术语已在正式词库中' });
  }

  // 已在热点词库？
  const existingIdx = hotTerms.findIndex(t => t.id === term.id);
  if (existingIdx !== -1) {
    hotTerms[existingIdx].appear_count = (hotTerms[existingIdx].appear_count || 1) + 1;
    hotTerms[existingIdx].last_appeared = new Date().toISOString();
    writeJSON(HOT_TERMS_FILE, hotTerms);
    return res.json({ message: '术语已存在，已更新热度', term: hotTerms[existingIdx] });
  }

  hotTerms.push(term);
  writeJSON(HOT_TERMS_FILE, hotTerms);
  console.log(`[SUBMIT] 用户提交: ${term.term_en} → 热点词汇`);
  res.status(201).json({ message: '术语已提交到热点词汇区', term });
});

// ===== 旧链接重定向 =====
app.get('/admin-inline.html', (req, res) => res.redirect('/admin.html'));

// ===== 静态文件服务 =====
// 必须放在 API 路由之后
app.use(express.static(__dirname));

// 禁止通过静态服务直接访问 /data/ 目录下的 JSON 文件（使用 API 代替）
// 但允许前端降级访问（当 API 不可用时，前端直接 fetch data/*.json）
app.get('/data/:file', (req, res, next) => {
  const file = req.params.file;
  if (file === 'glossary.json' || file === 'hot-terms.json') {
    // 允许前端降级读取数据文件
    const filePath = path.join(DATA_DIR, file);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
    return res.status(404).json({ error: '数据文件不存在' });
  }
  // 其他 data 目录文件不允许访问
  res.status(404).json({ error: '直接访问数据文件已禁用，请使用 /api/terms' });
});

// ===== 启动服务器 =====
// 兼容 Vercel Serverless: 本地运行时才 listen，Vercel 环境导出 app
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    const glossary = readJSON(GLOSSARY_FILE) || [];
    const hotTerms = readJSON(HOT_TERMS_FILE) || [];
    console.log(``);
    console.log(`  ╔══════════════════════════════════════╗`);
    console.log(`  ║   AI Glossary Server v2.0            ║`);
    console.log(`  ╠══════════════════════════════════════╣`);
    console.log(`  ║   http://${HOST}:${PORT}              ║`);
    console.log(`  ║   正式词汇: ${glossary.length.toString().padEnd(24)}║`);
    console.log(`  ║   热点词汇: ${hotTerms.length.toString().padEnd(24)}║`);
    console.log(`  ╚══════════════════════════════════════╝`);
    console.log(``);
  });
}

// 导出给 Vercel Serverless Functions
module.exports = app;