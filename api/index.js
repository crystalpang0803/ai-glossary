// Vercel Serverless Function - 轻量独立 API 入口
// 不再引用 server.js（server.js 有 process.exit、jsdom 等会在 serverless 中崩溃）
// 只处理数据读写：有 DATABASE_URL 则用 Neon Postgres，否则返回 503

const { neon } = require('@neondatabase/serverless');

function toJsonStr(val) {
  if (!val) return '[]';
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

module.exports = async function handler(req, res) {
  // Vercel serverless-http 会把 Express 请求转为 this format
  // 但我们直接用原生 handler 更可靠
  const method = req.method;
  const url = new URL(req.url || req.path || '', 'https://ai-glossary-delta.vercel.app');
  const pathname = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') return res.status(200).end();

  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'API 不可用：未配置数据库。当前为纯静态部署，数据来自 /data/*.json 文件。' });
  }

  const sql = neon(process.env.DATABASE_URL);

  // 解析请求体（Vercel 原生 handler 不自动解析 JSON body）
  let body = req.body;
  if (!body && method !== 'GET' && method !== 'DELETE') {
    try {
      // Vercel 可能把 body 放在 req.read() 或需要手动读取
      if (typeof req.body === 'string') {
        body = JSON.parse(req.body);
      } else {
        // 尝试从 Vercel 的 body 缓冲区获取
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString();
        if (raw) body = JSON.parse(raw);
      }
    } catch (e) {
      // body 解析失败，保持 undefined
    }
  }

  // ===== 路由匹配 =====

  // GET /api/terms
  if (method === 'GET' && pathname === '/api/terms') {
    const status = url.searchParams.get('status') || 'all';
    try {
      const glossary = await sql`SELECT * FROM glossary ORDER BY term_en`;
      const hotTerms = await sql`SELECT * FROM hot_terms ORDER BY appear_count DESC, term_en`;
      if (status === 'official') {
        return res.json(glossary.map(r => ({ ...r, related: typeof r.related === 'string' ? JSON.parse(r.related) : r.related || [] })));
      }
      if (status === 'hot') {
        return res.json(hotTerms.map(r => ({ ...r, sources: typeof r.sources === 'string' ? JSON.parse(r.sources) : r.sources || [], source_urls: typeof r.source_urls === 'string' ? JSON.parse(r.source_urls) : r.source_urls || [], matched_articles: typeof r.matched_articles === 'string' ? JSON.parse(r.matched_articles) : r.matched_articles || [], related: typeof r.related === 'string' ? JSON.parse(r.related) : r.related || [] })));
      }
      return res.json([...hotTerms.map(r => ({ ...r, status: 'hot' })), ...glossary.map(r => ({ ...r, status: 'official' }))]);
    } catch (e) {
      return res.status(500).json({ error: '数据库错误: ' + e.message });
    }
  }

  // GET /api/hot-terms
  if (method === 'GET' && pathname === '/api/hot-terms') {
    try {
      const rows = await sql`SELECT * FROM hot_terms ORDER BY appear_count DESC, term_en`;
      return res.json(rows.map(r => ({ ...r, sources: typeof r.sources === 'string' ? JSON.parse(r.sources) : r.sources || [], source_urls: typeof r.source_urls === 'string' ? JSON.parse(r.source_urls) : r.source_urls || [], matched_articles: typeof r.matched_articles === 'string' ? JSON.parse(r.matched_articles) : r.matched_articles || [], related: typeof r.related === 'string' ? JSON.parse(r.related) : r.related || [] })));
    } catch (e) {
      return res.status(500).json({ error: '数据库错误: ' + e.message });
    }
  }

  // GET /api/stats
  if (method === 'GET' && pathname === '/api/stats') {
    try {
      const g = await sql`SELECT COUNT(*) as count FROM glossary`;
      const h = await sql`SELECT COUNT(*) as count FROM hot_terms`;
      return res.json({ total: parseInt(g[0].count), hotCount: parseInt(h[0].count), storage: 'postgres' });
    } catch (e) {
      return res.status(500).json({ error: '数据库错误: ' + e.message });
    }
  }

  // POST /api/hot-terms (提交新术语)
  if (method === 'POST' && pathname === '/api/hot-terms') {
    try {
      const term = body || {};
      if (!term.term_en || !term.term_zh) return res.status(400).json({ error: 'term_en 和 term_zh 为必填字段' });
      if (!term.id) term.id = term.term_en.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

      const inGlossary = await sql`SELECT id FROM glossary WHERE id = ${term.id}`;
      if (inGlossary.length > 0) return res.status(409).json({ error: '该术语已在正式词库中' });

      const existing = await sql`SELECT * FROM hot_terms WHERE id = ${term.id}`;
      if (existing.length > 0) {
        const newCount = (existing[0].appear_count || 1) + 1;
        const now = new Date().toISOString();
        await sql`UPDATE hot_terms SET appear_count = ${newCount}, last_appeared = ${now} WHERE id = ${term.id}`;
        return res.json({ ...existing[0], appear_count: newCount });
      }

      const now = new Date().toISOString();
      await sql`INSERT INTO hot_terms (id, term_en, term_zh, abbreviation, category, one_liner, definition, explanation, source, source_url, appear_count, first_appeared, last_appeared, status, related, date, sources, source_urls, matched_articles)
        VALUES (${term.id}, ${term.term_en}, ${term.term_zh}, ${term.abbreviation || ''}, ${term.category || 'AI概念'}, ${term.one_liner || ''}, ${term.definition || ''}, ${term.explanation || ''}, ${term.source || '用户提交'}, ${term.source_url || ''}, 1, ${now}, ${now}, 'hot', ${toJsonStr(term.related)}, ${term.date || now.split('T')[0]}, ${toJsonStr(term.sources)}, ${toJsonStr(term.source_urls)}, ${toJsonStr(term.matched_articles)})`;
      return res.status(201).json({ ...term, appear_count: 1, status: 'hot' });
    } catch (e) {
      return res.status(500).json({ error: '数据库错误: ' + e.message });
    }
  }

  // POST /api/hot-terms/batch (批量导入热门词汇)
  if (method === 'POST' && pathname === '/api/hot-terms/batch') {
    try {
      const terms = body;
      if (!Array.isArray(terms)) return res.status(400).json({ error: '需要数组格式的数据' });
      
      // 先清空旧数据
      await sql`DELETE FROM hot_terms`;
      
      let imported = 0;
      for (const term of terms) {
        if (!term.term_en || !term.term_zh) continue;
        if (!term.id) term.id = term.term_en.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const now = new Date().toISOString();
        await sql`INSERT INTO hot_terms (id, term_en, term_zh, abbreviation, category, one_liner, definition, explanation, source, source_url, appear_count, first_appeared, last_appeared, status, related, date, sources, source_urls, matched_articles)
          VALUES (${term.id}, ${term.term_en}, ${term.term_zh}, ${term.abbreviation || ''}, ${term.category || 'AI概念'}, ${term.one_liner || ''}, ${term.definition || ''}, ${term.explanation || ''}, ${term.source || ''}, ${term.source_url || ''}, ${term.appear_count || 1}, ${term.first_appeared || now}, ${term.last_appeared || now}, ${term.status || 'hot'}, ${toJsonStr(term.related)}, ${term.date || ''}, ${toJsonStr(term.sources)}, ${toJsonStr(term.source_urls)}, ${toJsonStr(term.matched_articles)})
          ON CONFLICT (id) DO NOTHING`;
        imported++;
      }
      return res.json({ success: true, imported, total: terms.length });
    } catch (e) {
      return res.status(500).json({ error: '批量导入失败: ' + e.message });
    }
  }

  // 未匹配的路由
  return res.status(404).json({ error: `未知 API 路径: ${pathname}` });
};