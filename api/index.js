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

  // GET /api/hot-terms (排除已入库词)
  if (method === 'GET' && pathname === '/api/hot-terms') {
    try {
      const rows = await sql`SELECT * FROM hot_terms ORDER BY appear_count DESC, term_en`;
      // 获取已入库词的ID和英文名，用于去重
      const glossaryIds = await sql`SELECT id, term_en FROM glossary`;
      const officialIdSet = new Set(glossaryIds.map(r => r.id));
      const officialNameSet = new Set(glossaryIds.map(r => r.term_en.toLowerCase()));
      const filtered = rows.filter(r => !officialIdSet.has(r.id) && !officialNameSet.has(r.term_en.toLowerCase()));
      return res.json(filtered.map(r => ({ ...r, sources: typeof r.sources === 'string' ? JSON.parse(r.sources) : r.sources || [], source_urls: typeof r.source_urls === 'string' ? JSON.parse(r.source_urls) : r.source_urls || [], matched_articles: typeof r.matched_articles === 'string' ? JSON.parse(r.matched_articles) : r.matched_articles || [], related: typeof r.related === 'string' ? JSON.parse(r.related) : r.related || [] })));
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

  // POST /api/hot-terms/:id/promote (沉淀到词库)
  const promoteMatch = pathname.match(/^\/api\/hot-terms\/([^/]+)\/promote$/);
  if (method === 'POST' && promoteMatch) {
    try {
      const id = promoteMatch[1];
      const rows = await sql`SELECT * FROM hot_terms WHERE id = ${id}`;
      if (rows.length === 0) return res.status(404).json({ error: '热点词汇不存在' });
      const term = rows[0];
      // 检查是否已在词库
      const existing = await sql`SELECT id FROM glossary WHERE id = ${id}`;
      if (existing.length > 0) {
        // 已在词库，从hot_terms中删除即可
        await sql`DELETE FROM hot_terms WHERE id = ${id}`;
        return res.json({ promoted: { id, term_en: term.term_en, term_zh: term.term_zh }, message: '该术语已在词库中，已从热点词汇移除' });
      }
      // 插入到glossary
      const now = new Date().toISOString();
      await sql`INSERT INTO glossary (id, term_en, term_zh, abbreviation, category, one_liner, definition, explanation, source, source_url, related, date, sources, source_urls, matched_articles)
        VALUES (${term.id}, ${term.term_en}, ${term.term_zh}, ${term.abbreviation || ''}, ${term.category || 'AI概念'}, ${term.one_liner || ''}, ${term.definition || ''}, ${term.explanation || ''}, ${term.source || ''}, ${term.source_url || ''}, ${toJsonStr(term.related)}, ${term.date || now.split('T')[0]}, ${toJsonStr(term.sources)}, ${toJsonStr(term.source_urls)}, ${toJsonStr(term.matched_articles)})`;
      // 从hot_terms中删除
      await sql`DELETE FROM hot_terms WHERE id = ${id}`;
      const promoted = { ...term, related: typeof term.related === 'string' ? JSON.parse(term.related) : term.related || [], sources: typeof term.sources === 'string' ? JSON.parse(term.sources) : term.sources || [], source_urls: typeof term.source_urls === 'string' ? JSON.parse(term.source_urls) : term.source_urls || [], matched_articles: typeof term.matched_articles === 'string' ? JSON.parse(term.matched_articles) : term.matched_articles || [] };
      return res.json({ promoted });
    } catch (e) {
      return res.status(500).json({ error: '沉淀失败: ' + e.message });
    }
  }

  // POST /api/auto-promote (自动沉淀)
  if (method === 'POST' && pathname === '/api/auto-promote') {
    try {
      let promoted = 0, removed = 0;
      const hotRows = await sql`SELECT * FROM hot_terms`;
      for (const term of hotRows) {
        const daysSinceLast = term.last_appeared ? (Date.now() - new Date(term.last_appeared).getTime()) / 86400000 : 999;
        if (term.appear_count >= 3 && daysSinceLast <= 30) {
          // 沉淀到词库
          const existing = await sql`SELECT id FROM glossary WHERE id = ${term.id}`;
          if (existing.length === 0) {
            const now = new Date().toISOString();
            await sql`INSERT INTO glossary (id, term_en, term_zh, abbreviation, category, one_liner, definition, explanation, source, source_url, related, date, sources, source_urls, matched_articles)
              VALUES (${term.id}, ${term.term_en}, ${term.term_zh}, ${term.abbreviation || ''}, ${term.category || 'AI概念'}, ${term.one_liner || ''}, ${term.definition || ''}, ${term.explanation || ''}, ${term.source || ''}, ${term.source_url || ''}, ${toJsonStr(term.related)}, ${term.date || now.split('T')[0]}, ${toJsonStr(term.sources)}, ${toJsonStr(term.source_urls)}, ${toJsonStr(term.matched_articles)})`;
          }
          await sql`DELETE FROM hot_terms WHERE id = ${term.id}`;
          promoted++;
        } else if (daysSinceLast > 30) {
          await sql`DELETE FROM hot_terms WHERE id = ${term.id}`;
          removed++;
        }
      }
      return res.json({ promoted, removed });
    } catch (e) {
      return res.status(500).json({ error: '自动沉淀失败: ' + e.message });
    }
  }

  // PUT /api/terms/:id (更新词库术语)
  const putTermsMatch = pathname.match(/^\/api\/terms\/([^/]+)$/);
  if (method === 'PUT' && putTermsMatch) {
    try {
      const id = putTermsMatch[1];
      const updates = body || {};
      const existing = await sql`SELECT id FROM glossary WHERE id = ${id}`;
      if (existing.length === 0) return res.status(404).json({ error: '术语不存在' });
      await sql`UPDATE glossary SET
        term_en = ${updates.term_en || ''}, term_zh = ${updates.term_zh || ''},
        abbreviation = ${updates.abbreviation || ''}, category = ${updates.category || 'AI概念'},
        one_liner = ${updates.one_liner || ''}, definition = ${updates.definition || ''},
        explanation = ${updates.explanation || ''}, source = ${updates.source || ''},
        source_url = ${updates.source_url || ''}, related = ${toJsonStr(updates.related)}
        WHERE id = ${id}`;
      return res.json({ id, ...updates });
    } catch (e) {
      return res.status(500).json({ error: '更新失败: ' + e.message });
    }
  }

  // POST /api/terms (添加术语到词库)
  if (method === 'POST' && pathname === '/api/terms') {
    try {
      const term = body || {};
      if (!term.id) term.id = term.term_en ? term.term_en.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') : '';
      if (!term.term_en) return res.status(400).json({ error: 'term_en 为必填字段' });
      const existing = await sql`SELECT id FROM glossary WHERE id = ${term.id}`;
      if (existing.length > 0) return res.status(409).json({ error: '该术语ID已存在' });
      const now = new Date().toISOString();
      await sql`INSERT INTO glossary (id, term_en, term_zh, abbreviation, category, one_liner, definition, explanation, source, source_url, related, date, sources, source_urls, matched_articles)
        VALUES (${term.id}, ${term.term_en}, ${term.term_zh || ''}, ${term.abbreviation || ''}, ${term.category || 'AI概念'}, ${term.one_liner || ''}, ${term.definition || ''}, ${term.explanation || ''}, ${term.source || ''}, ${term.source_url || ''}, ${toJsonStr(term.related)}, ${term.date || now.split('T')[0]}, ${toJsonStr(term.sources)}, ${toJsonStr(term.source_urls)}, ${toJsonStr(term.matched_articles)})`;
      return res.status(201).json({ ...term, status: 'official' });
    } catch (e) {
      return res.status(500).json({ error: '添加失败: ' + e.message });
    }
  }

  // DELETE /api/terms/:id (删除词库术语)
  const deleteTermsMatch = pathname.match(/^\/api\/terms\/([^/]+)$/);
  if (method === 'DELETE' && deleteTermsMatch) {
    try {
      const id = deleteTermsMatch[1];
      const existing = await sql`SELECT id FROM glossary WHERE id = ${id}`;
      if (existing.length === 0) return res.status(404).json({ error: '术语不存在' });
      await sql`DELETE FROM glossary WHERE id = ${id}`;
      return res.json({ deleted: id });
    } catch (e) {
      return res.status(500).json({ error: '删除失败: ' + e.message });
    }
  }

  // DELETE /api/hot-terms/:id (删除热点词汇)
  const deleteHotMatch = pathname.match(/^\/api\/hot-terms\/([^/]+)$/);
  if (method === 'DELETE' && deleteHotMatch) {
    try {
      const id = deleteHotMatch[1];
      await sql`DELETE FROM hot_terms WHERE id = ${id}`;
      return res.json({ deleted: id });
    } catch (e) {
      return res.status(500).json({ error: '删除失败: ' + e.message });
    }
  }

  // 未匹配的路由
  return res.status(404).json({ error: `未知 API 路径: ${pathname}` });
};