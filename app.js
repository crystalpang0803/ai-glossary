// ===== AI Glossary App v4.0 =====
// 数据加载策略：API 优先（有后端时），JSON 文件降级（纯静态部署时）
let glossaryData = [];
let hotTermsData = [];
let filteredData = [];
let currentCategory = 'all';
let currentSearch = '';
let apiAvailable = false;
let todayHotRaw = [];          // 今日原始热门数据(API/json)
let currentHotData = [];       // 当前展示的榜单(随视图切换)
let currentHotView = 'today';  // today | 7d | 30d | date
let availableHotDates = [];    // 可回看的历史日期

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

// 通用数据加载：API 优先，静态 JSON 降级
async function fetchJSON(apiPath, staticPath) {
  try {
    const data = await apiGet(apiPath);
    apiAvailable = true;
    return data;
  } catch (e) {
    console.warn(`API ${apiPath} 不可用，降级到 ${staticPath}:`, e.message);
    const res = await fetch(staticPath);
    if (!res.ok) throw new Error(`加载 ${staticPath} 失败: ${res.status}`);
    return res.json();
  }
}

// ===== 加载数据 =====
async function loadGlossary() {
  let official = [];
  let hot = [];

  // API 优先，静态 JSON 降级（确保 Vercel/GitHub Pages 纯静态部署也能显示数据）
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

  // 更新提交按钮可见性
  const submitBtn = document.getElementById('navSubmitBtn');
  if (submitBtn) submitBtn.style.display = apiAvailable ? '' : 'none';

  glossaryData = official;
  todayHotRaw = hot || [];
  hotTermsData = prepareHot(todayHotRaw);   // 今日榜(也用于搜索/弹窗查找)
  currentHotData = hotTermsData;

  filteredData = [...glossaryData];
  const _glossaryCountEl = document.getElementById('glossaryCount');
  if (_glossaryCountEl) _glossaryCountEl.textContent = glossaryData.length;
  const _heroStat = document.getElementById('heroStatTotal');
  if (_heroStat) _heroStat.textContent = glossaryData.length;
  const _heroHot = document.getElementById('heroStatHot');
  if (_heroHot) _heroHot.textContent = hotTermsData.length;

  if (glossaryData.length === 0 && hotTermsData.length === 0) {
    document.getElementById('emptyState').classList.remove('hidden');
    return;
  }

  renderHotTerms();
  renderHeroHot();
  setupHotControls();
  setupScrollSpy();
  renderGlossary();
  renderAlphaNav();
  setupFilters();
  setupSearch();
  setupSubmit();
}

// ===== 渲染热门术语 =====
// 去重(排除已入库)+按频次排序
function prepareHot(arr) {
  const officialIds = new Set(glossaryData.map(t => t.id));
  const officialNames = new Set(glossaryData.map(t => (t.term_en || '').toLowerCase()));
  return (arr || [])
    .filter(t => t && t.term_en && !officialIds.has(t.id) && !officialNames.has((t.term_en || '').toLowerCase()))
    .sort((a, b) => (b.appear_count || 0) - (a.appear_count || 0));
}
function findHot(id) { return currentHotData.find(t => t.id === id) || hotTermsData.find(t => t.id === id); }

function rankFlagHtml(term) {
  if (term.is_new) return '<span class="hot-flag new">NEW</span>';
  if (typeof term.rank_change === 'number' && term.rank_change > 0) return `<span class="hot-flag up">▲${term.rank_change}</span>`;
  if (typeof term.rank_change === 'number' && term.rank_change < 0) return `<span class="hot-flag down">▼${Math.abs(term.rank_change)}</span>`;
  return '';
}

function renderHeroHot() {
  const el = document.getElementById('heroHotList');
  if (!el) return;
  const top = hotTermsData.slice(0, 5);
  if (top.length === 0) { el.innerHTML = '<div style="padding:8px 0;color:var(--color-text-muted);font-size:0.85rem;">暂无数据</div>'; return; }
  el.innerHTML = top.map((t, i) => `
    <div class="hero-hot-item" data-id="${t.id}">
      <span class="hero-hot-rank${i < 3 ? ' top' : ''}">${i + 1}</span>
      <span class="hero-hot-en">${t.term_en}</span>
      <span class="hero-hot-zh">${t.term_zh || ''}</span>
    </div>`).join('');
  el.querySelectorAll('.hero-hot-item').forEach(it => {
    it.addEventListener('click', () => openTermModal(it.dataset.id, 'hot'));
  });
}

function renderHotTerms() {
  const section = document.getElementById('hotTermsSection');
  const grid = document.getElementById('hotTermsGrid');
  const countEl = document.getElementById('hotCount');
  const dateEl = document.getElementById('hotDate');
  section.style.display = '';
  const data = currentHotData;
  if (countEl) countEl.textContent = data.length;
  if (dateEl) dateEl.textContent = (currentHotView === 'today' && data[0] && data[0].date) ? data[0].date : '';

  if (data.length === 0) {
    grid.innerHTML = '<div style="text-align:center;padding:24px;color:var(--color-text-muted);font-size:0.9rem;">该范围暂无热门词汇</div>';
    return;
  }

  grid.innerHTML = data.map((term, i) => `
    <div class="hot-term-row" data-id="${term.id}" data-source="hot">
      <div class="hot-rank">${i + 1}</div>
      <div class="hot-row-main">
        <div class="hot-row-title-line">
          <span class="hot-row-en">${term.term_en}</span>
          ${term.abbreviation ? `<span class="hot-row-abbr">${term.abbreviation}</span>` : ''}
          ${rankFlagHtml(term)}
        </div>
        <span class="hot-row-zh">${term.term_zh || ''}</span>
        ${term.explanation || term.one_liner ? `<span class="hot-row-oneliner">${term.explanation || term.one_liner}</span>` : ''}
      </div>
      <div class="hot-row-meta">
        <span class="hot-row-count">${term.appear_count} 次</span>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.hot-term-row').forEach(card => {
    card.addEventListener('click', () => openTermModal(card.dataset.id, card.dataset.source));
  });
}

async function loadHotJSON(p) {
  try { const r = await fetch(p); if (r.ok) return await r.json(); } catch (e) {}
  return null;
}

async function setupHotControls() {
  try {
    const r = await fetch('/data/hot-history/index.json');
    if (r.ok) availableHotDates = await r.json();
  } catch (e) { availableHotDates = []; }

  document.querySelectorAll('.range-tab').forEach(tab => {
    tab.addEventListener('click', () => selectHotView(tab.dataset.range));
  });
  const picker = document.getElementById('hotDatePicker');
  if (picker && availableHotDates.length) {
    picker.min = availableHotDates[0];
    picker.max = availableHotDates[availableHotDates.length - 1];
  }
  if (picker) picker.addEventListener('change', () => { if (picker.value) selectHotView('date', picker.value); });
}

async function selectHotView(view, date) {
  currentHotView = (view === 'date') ? 'date' : view;
  document.querySelectorAll('.range-tab').forEach(t => t.classList.toggle('active', view !== 'date' && t.dataset.range === view));
  const picker = document.getElementById('hotDatePicker');

  let data = null, fellBack = false;
  if (view === 'today') { data = todayHotRaw; if (picker) picker.value = ''; }
  else if (view === '7d') { data = await loadHotJSON('/data/hot-7d.json'); if (picker) picker.value = ''; }
  else if (view === '30d') { data = await loadHotJSON('/data/hot-30d.json'); if (picker) picker.value = ''; }
  else if (view === 'date') { data = await loadHotJSON('/data/hot-history/' + date + '.json'); }

  if (!data) { data = todayHotRaw; fellBack = true; }
  currentHotData = prepareHot(data);
  renderHotTerms();
  if (fellBack) {
    const grid = document.getElementById('hotTermsGrid');
    if (grid) grid.insertAdjacentHTML('afterbegin', '<div style="padding:10px 16px;font-size:0.78rem;color:var(--color-text-muted);background:var(--color-bg-alt);border-bottom:1px solid var(--color-border);">该时间范围的数据尚未积累，暂以今日榜单代替</div>');
  }
}

// 滚动高亮顶栏导航
function setupScrollSpy() {
  const links = document.querySelectorAll('.nav-link');
  if (!links.length || !('IntersectionObserver' in window)) return;
  const map = {};
  links.forEach(a => { const id = a.getAttribute('href').slice(1); if (id) map[id] = a; });
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        links.forEach(a => a.classList.remove('active'));
        if (map[e.target.id]) map[e.target.id].classList.add('active');
      }
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  Object.keys(map).forEach(id => { const el = document.getElementById(id); if (el) obs.observe(el); });
}

// ===== 渲染词库 =====
function letterOf(term) {
  const c = (term.term_en || '#')[0].toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}

function renderGlossary() {
  const grid = document.getElementById('glossaryGrid');
  const empty = document.getElementById('emptyState');

  if (filteredData.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  // 按首字母 A-Z 分组（非字母归到 #，排在最后）
  const sorted = [...filteredData].sort((a, b) =>
    (a.term_en || '').localeCompare(b.term_en || '', 'en', { sensitivity: 'base' }));
  const groups = {};
  const order = [];
  for (const t of sorted) {
    const L = letterOf(t);
    if (!groups[L]) { groups[L] = []; order.push(L); }
    groups[L].push(t);
  }
  order.sort((a, b) => (a === '#') - (b === '#') || a.localeCompare(b));

  const cardHtml = term => `
    <div class="term-card" data-id="${term.id}" data-source="official" data-category="${term.category || ''}">
      <span class="card-cat" data-cat="${term.category || ''}">${term.category || ''}</span>
      <h3 class="card-title">${term.term_en}</h3>
      <div class="card-zh">${term.term_zh}${term.abbreviation ? `<span class="card-abbr">${term.abbreviation}</span>` : ''}</div>
      <div class="card-desc">${term.one_liner || ''}</div>
    </div>`;

  grid.innerHTML = order.map(L =>
    `<div class="letter-section" id="letter-${L}"><span class="letter-heading">${L}</span></div>` +
    groups[L].map(cardHtml).join('')
  ).join('');

  grid.querySelectorAll('.term-card').forEach(card => {
    card.addEventListener('click', () => {
      openTermModal(card.dataset.id, card.dataset.source);
    });
  });
}

// ===== 字母导航 =====
function renderAlphaNav() {
  const nav = document.getElementById('alphaNav');
  const activeLetters = new Set(glossaryData.map(t => letterOf(t)));

  nav.innerHTML = [...activeLetters]
    .sort((a, b) => (a === '#') - (b === '#') || a.localeCompare(b))
    .map(letter => `<span class="alpha-btn" data-letter="${letter}">${letter}</span>`)
    .join('');

  nav.querySelectorAll('.alpha-btn').forEach(link => {
    link.addEventListener('click', () => {
      const letter = link.dataset.letter;
      const target = document.getElementById('letter-' + letter);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
          <span class="term-name">${t.term_en}</span>
          <span class="term-zh">${t.term_zh}${t.abbreviation ? ' · ' + t.abbreviation : ''}</span>
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
    ? findHot(termId)
    : glossaryData.find(t => t.id === termId);
  if (!term) {
    const found = findHot(termId) || glossaryData.find(t => t.id === termId);
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
  const allTerms = [...currentHotData, ...hotTermsData, ...glossaryData];
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
      category: document.getElementById('newTermCategory').value,
      one_liner: document.getElementById('newTermOneliner').value.trim(),
      definition: document.getElementById('newTermDef').value.trim(),
      explanation: document.getElementById('newTermExplanation').value.trim(),
      source: document.getElementById('newTermSource').value.trim() || '用户提交',
      source_url: document.getElementById('newTermSourceUrl').value.trim(),
      id: document.getElementById('newTermEn').value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      date: new Date().toISOString().split('T')[0]
    };

    try {
      if (apiAvailable) {
        await apiPost('/submitted-terms', term);
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