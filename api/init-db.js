// Vercel Serverless Function - 数据库初始化
// 首次部署后访问 /api/init-db 来创建表和导入初始数据
const { neon } = require('@neondatabase/serverless');

module.exports = async function handler(req, res) {
  // 只允许 POST 请求（防止误触发）
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '请使用 POST 请求来初始化数据库' });
  }

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: '未设置 DATABASE_URL 环境变量' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    console.log('[INIT-DB] 开始创建表...');

    // 创建正式词库表
    await sql`
      CREATE TABLE IF NOT EXISTS glossary (
        id VARCHAR(255) PRIMARY KEY,
        term_en VARCHAR(500) NOT NULL,
        term_zh VARCHAR(500) NOT NULL,
        abbreviation VARCHAR(100) DEFAULT '',
        category VARCHAR(100) DEFAULT 'AI概念',
        one_liner TEXT DEFAULT '',
        definition TEXT DEFAULT '',
        explanation TEXT DEFAULT '',
        source VARCHAR(500) DEFAULT '',
        source_url VARCHAR(1000) DEFAULT '',
        related JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    console.log('[INIT-DB] glossary 表创建成功');

    // 创建热点词汇表
    await sql`
      CREATE TABLE IF NOT EXISTS hot_terms (
        id VARCHAR(255) PRIMARY KEY,
        term_en VARCHAR(500) NOT NULL,
        term_zh VARCHAR(500) NOT NULL,
        abbreviation VARCHAR(100) DEFAULT '',
        category VARCHAR(100) DEFAULT 'AI概念',
        one_liner TEXT DEFAULT '',
        definition TEXT DEFAULT '',
        explanation TEXT DEFAULT '',
        source VARCHAR(500) DEFAULT '',
        source_url VARCHAR(1000) DEFAULT '',
        appear_count INTEGER DEFAULT 1,
        first_appeared TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_appeared TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(50) DEFAULT 'hot',
        related JSONB DEFAULT '[]',
        date VARCHAR(20) DEFAULT '',
        sources JSONB DEFAULT '[]',
        source_urls JSONB DEFAULT '[]',
        matched_articles JSONB DEFAULT '[]'
      )
    `;
    console.log('[INIT-DB] hot_terms 表创建成功');

    // 检查是否已有数据
    const glossaryCount = await sql`SELECT COUNT(*) as count FROM glossary`;
    const hotCount = await sql`SELECT COUNT(*) as count FROM hot_terms`;

    const gCount = parseInt(glossaryCount[0].count);
    const hCount = parseInt(hotCount[0].count);

    if (gCount > 0 || hCount > 0) {
      return res.status(200).json({
        success: true,
        message: '数据库表已存在',
        glossary_count: gCount,
        hot_terms_count: hCount
      });
    }

    // 如果表为空，从静态JSON文件导入初始数据
    console.log('[INIT-DB] 表为空，尝试从JSON文件导入数据...');
    
    try {
      const fs = require('fs');
      const path = require('path');
      const glossaryPath = path.join(process.cwd(), 'data', 'glossary.json');
      const hotTermsPath = path.join(process.cwd(), 'data', 'hot-terms.json');

      if (fs.existsSync(glossaryPath)) {
        const glossaryData = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));
        console.log(`[INIT-DB] 读取到 ${glossaryData.length} 条词库数据`);
        
        for (const term of glossaryData) {
          await sql`INSERT INTO glossary (id, term_en, term_zh, abbreviation, category, one_liner, definition, explanation, source, source_url, related, created_at, updated_at)
            VALUES (${term.id}, ${term.term_en}, ${term.term_zh}, ${term.abbreviation || ''}, ${term.category || 'AI概念'}, ${term.one_liner || ''}, ${term.definition || ''}, ${term.explanation || ''}, ${term.source || ''}, ${term.source_url || ''}, ${JSON.stringify(term.related || [])}, NOW(), NOW())
            ON CONFLICT (id) DO NOTHING`;
        }
        console.log(`[INIT-DB] 成功导入 ${glossaryData.length} 条词库数据`);
      }

      if (fs.existsSync(hotTermsPath)) {
        const hotData = JSON.parse(fs.readFileSync(hotTermsPath, 'utf8'));
        console.log(`[INIT-DB] 读取到 ${hotData.length} 条热点数据`);
        
        for (const term of hotData) {
          await sql`INSERT INTO hot_terms (id, term_en, term_zh, abbreviation, category, one_liner, definition, explanation, source, source_url, appear_count, first_appeared, last_appeared, status, related, date, sources, source_urls, matched_articles)
            VALUES (${term.id}, ${term.term_en}, ${term.term_zh}, ${term.abbreviation || ''}, ${term.category || 'AI概念'}, ${term.one_liner || ''}, ${term.definition || ''}, ${term.explanation || ''}, ${term.source || ''}, ${term.source_url || ''}, ${term.appear_count || 1}, ${term.first_appeared || NOW()}, ${term.last_appeared || NOW()}, 'hot', ${JSON.stringify(term.related || [])}, ${term.date || ''}, ${JSON.stringify(term.sources || [])}, ${JSON.stringify(term.source_urls || [])}, ${JSON.stringify(term.matched_articles || [])})
            ON CONFLICT (id) DO NOTHING`;
        }
        console.log(`[INIT-DB] 成功导入 ${hotData.length} 条热点数据`);
      }
    } catch (importErr) {
      console.error('[INIT-DB] 导入数据失败:', importErr.message);
      // 表已创建，只是数据没导入，不算失败
    }

    const finalGlossary = await sql`SELECT COUNT(*) as count FROM glossary`;
    const finalHot = await sql`SELECT COUNT(*) as count FROM hot_terms`;

    return res.status(200).json({
      success: true,
      message: '数据库初始化完成',
      glossary_count: parseInt(finalGlossary[0].count),
      hot_terms_count: parseInt(finalHot[0].count)
    });

  } catch (e) {
    console.error('[INIT-DB] 错误:', e.message);
    return res.status(500).json({ error: '数据库初始化失败: ' + e.message });
  }
};