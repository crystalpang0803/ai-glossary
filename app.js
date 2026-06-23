// ===== AI Glossary App v4.0 =====
// 数据加载策略：API 优先（有后端时），JSON 文件降级（纯静态部署时）
let glossaryData = [];
let hotTermsData = [];
let filteredData = [];
let currentCategory = 'all';
let currentSearch = '';
let apiAvailable = false;

// ===== API 工具 =====
const API_BASE = '/api';

async function apiGet(path) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `API Error: ${res.status}`);
  }
  return res.json();
}

// 通用 JSON 获取：先尝试 API，失败则 fetch 静态文件
async function fetchJSON(apiPath, staticPath) {
  try {
    const data = await apiGet(apiPath);
    apiAvailable = true;
    return data;
  } catch (e) {
    const res = await fetch(staticPath);
    if (!res.ok) throw new Error(`加载 ${staticPath} 失败: ${res.status}`);
    return res.json();
  }
}

// ===== 加载数据 =====
async function loadGlossary() {
  let official = [];
  let hot = [];

  // 独立加载，一个失败不影响另一个
  try {
    official = await fetchJSON('/terms?status=official', '/data/glossary.json');
  } catch (e) {
    console.warn('加载词库失败:', e.message);
  }

  try {
    hot = await fetchJSON('/hot-terms', '/data/hot-terms.json');
  } catch (e) {
    console.warn('加载热门术语失败:', e.message);
  }

  glossaryData = official;
  // 去重：排除词库中已有的术语（ID + 名称双重匹配）
  const officialIds = new Set(glossaryData.map(t => t.id));
  const officialNames = new Set(glossaryData.map(t => t.term_en.toLowerCase()));
  hotTermsData = hot.filter(t =>
    !officialIds.has(t.id) && !officialNames.has(t.term_en.toLowerCase())
  );

  filteredData = [...glossaryData];

  if (glossaryData.length === 0 && hotTermsData.length === 0) {
    document.getElementById('emptyState').classList.remove('hidden');
    return;
  }

  renderHotTerms();
  renderGlossary();
  renderAlphaNav();
  setupFilters();
  setupSearch();
  setupSubmit();
}

// ===== 渲染热门术语 =====
function renderHotTerms() {
  const section = document.getElementById('hotTermsSection');
  const divider = document.querySelector('.section-divider');
  const grid = document.getElementById('hotTermsGrid');
  const countEl = document.getElementById('hotCount');
  const dateEl = document.getElementById('hotDate');

  if (hotTermsData.length === 0) {
    section.style.display = 'none';
    divider.style.display = 'none';
    return;
  }

  section.style.display = '';
  divider.style.display = '';
  countEl.textContent = hotTermsData.length;

  // 显示日期
  if (hotTermsData[0]?.date) {
    dateEl.textContent = hotTermsData[0].date;
  }

  grid.innerHTML = hotTermsData.map(term => `
    <div class="hot-term-card" data-id="${term.id}" data-source="hot">
      <div class="hot-term-rank">#${term.rank}</div>
      <div class="hot-term-name">${term.term_en}</div>
      <div class="hot-term-zh">${term.term_zh}${term.abbreviation ? ' · ' + term.abbreviation : ''}</div>
      <div class="hot-term-explanation">${term.explanation || term.one_liner || ''}</div>
      <div class="hot-term-meta">
        <span class="hot-term-count">${term.appear_count}次提及</span>
        <span class="hot-term-sources">${(term.sources || []).slice(0, 3).join(' · ')}</span>
      </div>
    </div>
  `).join('');

  // 绑定点击
  grid.querySelectorAll('.hot-term-card').forEach(card => {
    card.addEventListener('click', () => {
      openTermModal(card.dataset.id, card.dataset.source);
    });
  });
}

// ===== 渲染词库 =====
function renderGlossary() {
  const grid = document.getElementById('glossaryGrid');
  const empty = document.getElementById('emptyState');

  if (filteredData.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  grid.innerHTML = filteredData.map(term => `
    <div class="glossary-card" data-id="${term.id}" data-source="official" data-category="${term.category || ''}">
      <div class="card-category">${term.category || ''}</div>
      <div class="card-term">${term.term_en}</div>
      <div class="card-zh">${term.term_zh}${term.abbreviation ? ' · ' + term.abbreviation : ''}</div>
      <div class="card-oneliner">${term.one_liner || ''}</div>
    </div>
  `).join('');

  // 绑定点击
  grid.querySelectorAll('.glossary-card').forEach(card => {
    card.addEventListener('click', () => {
      openTermModal(card.dataset.id, card.dataset.source);
    });
  });
}

// ===== 字母导航 =====
function renderAlphaNav() {
  const nav = document.getElementById('alphaNav');
  const activeLetters = new Set(glossaryData.map(t => t.term_en[0].toUpperCase()));

  nav.innerHTML = [...activeLetters].sort().map(letter =>
    `<span class="alpha-link" data-letter="${letter}">${letter}</span>`
  ).join('');

  nav.querySelectorAll('.alpha-link').forEach(link => {
    link.addEventListener('click', () => {
      const letter = link.dataset.letter;
      filteredData = glossaryData.filter(t => t.term_en[0].toUpperCase() === letter);
      currentCategory = 'all';
      updateFilterChips();
      renderGlossary();
      document.getElementById('filterInfo').textContent = `字母 ${letter} · ${filteredData.length} 条`;
      document.querySelector('.grid-container').scrollIntoView({ behavior: 'smooth' });
    });
  });
}

// ===== 分类过滤 =====
function setupFilters() {
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      currentCategory = chip.dataset.category;
      updateFilterChips();
      applyFilters();
    });
  });
}

function updateFilterChips() {
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.category === currentCategory);
  });
}

function applyFilters() {
  filteredData = glossaryData.filter(term => {
    const matchCategory = currentCategory === 'all' || term.category === currentCategory;
    const matchSearch = !currentSearch ||
      term.term_en.toLowerCase().includes(currentSearch) ||
      term.term_zh.includes(currentSearch) ||
      (term.abbreviation || '').toLowerCase().includes(currentSearch) ||
      (term.one_liner || '').includes(currentSearch);
    return matchCategory && matchSearch;
  });

  renderGlossary();
  const filterInfo = document.getElementById('filterInfo');
  if (currentCategory === 'all' && !currentSearch) {
    filterInfo.textContent = `显示全部 · ${glossaryData.length} 条`;
  } else {
    filterInfo.textContent = `${filteredData.length} 条结果`;
  }
}

// ===== 搜索 =====
function setupSearch() {
  const input = document.getElementById('searchInput');
  const suggestions = document.getElementById('searchSuggestions');

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 1) {
      suggestions.classList.add('hidden');
      currentSearch = '';
      applyFilters();
      return;
    }

    const allTerms = [...hotTermsData.map(t => ({...t, _source: 'hot'})), ...glossaryData.map(t => ({...t, _source: 'official'}))];
    const matches = allTerms.filter(t =>
      t.term_en.toLowerCase().includes(q) ||
      t.term_zh.includes(q) ||
      (t.abbreviation || '').toLowerCase().includes(q)
    ).slice(0, 8);

    if (matches.length > 0) {
      suggestions.innerHTML = matches.map(t => `
        <div class="suggestion-item" data-id="${t.id}" data-source="${t._source}">
          <span class="suggestion-term">${t.term_en}</span>
          <span class="suggestion-zh">${t.term_zh}${t.abbreviation ? ' · ' + t.abbreviation : ''}</span>
        </div>
      `).join('');
      suggestions.classList.remove('hidden');

      suggestions.querySelectorAll('.suggestion-item').forEach(item => {
        item.addEventListener('click', () => {
          openTermModal(item.dataset.id, item.dataset.source);
          input.value = '';
          suggestions.classList.add('hidden');
        });
      });
    } else {
      suggestions.classList.add('hidden');
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = input.value.trim();
      if (q) {
        currentSearch = q.toLowerCase();
        applyFilters();
        suggestions.classList.add('hidden');
        document.querySelector('.grid-container').scrollIntoView({ behavior: 'smooth' });
      }
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrapper')) {
      suggestions.classList.add('hidden');
    }
  });
}

// ===== 词条详情弹窗 =====
function openTermModal(termId, source) {
  const term = source === 'hot'
    ? hotTermsData.find(t => t.id === termId)
    : glossaryData.find(t => t.id === termId);
  if (!term) {
    const found = hotTermsData.find(t => t.id === termId) || glossaryData.find(t => t.id === termId);
    if (!found) return;
    return openTermModal(termId, found.status === 'hot' ? 'hot' : 'official');
  }

  document.getElementById('modalCategory').textContent = term.category + (source === 'hot' ? ' · 热点' : '');
  document.getElementById('modalTitle').textContent = term.term_en;
  document.getElementById('modalSubtitle').textContent = `${term.term_zh}${term.abbreviation ? ' · ' + term.abbreviation : ''}`;
  document.getElementById('modalOneliner').textContent = term.one_liner || term.description || '';
  document.getElementById('modalDefinition').textContent = term.definition || term.one_liner || '暂无权威定义';

  // 来源链接
  const sourceLinksContainer = document.getElementById('modalSourceLinks');
  let linksHtml = '';
  if (term.source_url) {
    linksHtml += `<a href="${term.source_url}" target="_blank" class="source-link">${term.source || '来源'} →</a>`;
  }
  if (term.matched_articles && term.matched_articles.length > 0) {
    term.matched_articles.forEach(article => {
      if (article.link) {
        linksHtml += `<a href="${article.link}" target="_blank" class="source-link">${article.source}: ${article.title.substring(0, 40)}${article.title.length > 40 ? '...' : ''} →</a>`;
      }
    });
  } else if (term.source_urls && term.source_urls.length > 0) {
    term.source_urls.slice(0, 3).forEach(url => {
      linksHtml += `<a href="${url}" target="_blank" class="source-link">相关报道 →</a>`;
    });
  }
  sourceLinksContainer.innerHTML = linksHtml;

  // 通俗解读：使用AI生成的explanation，不再用模板拼接
  document.getElementById('modalExplanation').textContent = term.explanation || '暂无通俗解读';

  // 相关术语
  const allTerms = [...hotTermsData, ...glossaryData];
  const relatedContainer = document.getElementById('modalRelated');
  if (term.related && term.related.length > 0) {
    relatedContainer.innerHTML = term.related.map(relId => {
      const relTerm = allTerms.find(t => t.id === relId);
      if (relTerm) {
        return `<span class="related-tag" data-id="${relId}" data-source="${relTerm.status === 'hot' ? 'hot' : 'official'}">${relTerm.term_en}</span>`;
      }
      return `<span class="related-tag" data-id="${relId}">${relId}</span>`;
    }).join('');
  } else {
    relatedContainer.innerHTML = '<span style="color: var(--color-text-muted); font-size: 0.85rem;">暂无关联术语</span>';
  }

  document.getElementById('termModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('termModal').classList.add('hidden');
  document.body.style.overflow = '';
}

// ===== 提交新术语 =====
function setupSubmit() {
  const submitBtn = document.getElementById('navSubmitBtn');
  const submitTermBtn = document.getElementById('submitTermBtn');

  const openSubmit = () => {
    document.getElementById('submitModal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  };

  submitBtn?.addEventListener('click', openSubmit);
  submitTermBtn?.addEventListener('click', openSubmit);

  document.getElementById('submitModalClose')?.addEventListener('click', () => {
    document.getElementById('submitModal').classList.add('hidden');
    document.body.style.overflow = '';
  });

  document.getElementById('submitForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const term = {
      term_en: document.getElementById('newTermEn').value.trim(),
      term_zh: document.getElementById('newTermZh').value.trim(),
      abbreviation: document.getElementById('newTermAbbr').value.trim(),
      one_liner: document.getElementById('newTermDesc').value.trim(),
      source_url: document.getElementById('newTermSource').value.trim(),
      category: 'AI应用',
      status: 'hot',
      id: document.getElementById('newTermEn').value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      date: new Date().toISOString().split('T')[0]
    };

    try {
      if (apiAvailable) {
        await apiPost('/hot-terms', term);
      }
      // 刷新数据
      await loadGlossary();
      document.getElementById('submitModal').classList.add('hidden');
      document.body.style.overflow = '';
      e.target.reset();
    } catch (err) {
      alert('提交失败: ' + err.message);
    }
  });
}

// ===== 事件绑定 =====
document.getElementById('modalClose')?.addEventListener('click', closeModal);

document.getElementById('termModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'termModal') closeModal();
});

// 关联术语点击
document.addEventListener('click', (e) => {
  const tag = e.target.closest('.related-tag');
  if (tag?.dataset.id) {
    openTermModal(tag.dataset.id, tag.dataset.source || 'official');
  }
});

// ESC 关闭弹窗
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
    document.getElementById('submitModal')?.classList.add('hidden');
    document.body.style.overflow = '';
  }
});

// ===== 启动 =====
document.addEventListener('DOMContentLoaded', loadGlossary);