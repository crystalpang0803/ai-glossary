// ===== AI Glossary App v3.0 =====
// 数据加载策略：API 优先（有后端时），JSON 文件降级（纯静态部署时）
let glossaryData = [];
let hotTermsData = [];
let filteredData = [];
let currentCategory = 'all';
let currentSearch = '';
let apiAvailable = false; // 标记后端 API 是否可用

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
    // API 不可用，降级到静态文件
    const res = await fetch(staticPath);
    if (!res.ok) throw new Error(`加载 ${staticPath} 失败: ${res.status}`);
    return res.json();
  }
}

// ===== 加载数据 =====
async function loadGlossary() {
  // 独立加载，一个失败不影响另一个
  let official = [];
  let hot = [];

  try {
    official = await fetchJSON('/terms?status=official', 'data/glossary.json') || [];
  } catch (e) {
    console.error('加载正式词库失败:', e);
  }

  try {
    hot = await fetchJSON('/hot-terms', 'data/hot-terms.json') || [];
  } catch (e) {
    console.error('加载热点词汇失败:', e);
  }

  glossaryData = official;
  hotTermsData = hot;

  // 过滤已沉淀的热点词（按ID + 名称双重匹配去重）
  const officialIds = new Set(glossaryData.map(t => t.id));
  const officialNames = new Set(glossaryData.map(t => t.term_en.toLowerCase()));
  hotTermsData = hotTermsData.filter(t =>
    !officialIds.has(t.id) && !officialNames.has(t.term_en.toLowerCase())
  );

  filteredData = [...glossaryData];

  if (glossaryData.length === 0 && hotTermsData.length === 0) {
    document.getElementById('glossaryGrid').innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--color-text-muted);">
        <p style="font-size:1.1rem;margin-bottom:8px;">数据加载失败</p>
        <p style="font-size:0.85rem;">请刷新页面重试，或检查网络连接</p>
      </div>`;
    return;
  }

  initApp();
}

// ===== 初始化 =====
function initApp() {
  renderHotTerms();
  updateStats();
  renderAlphaNav();
  renderGrid();
  bindEvents();
}

// ===== 热点词汇渲染（榜单列表形式） =====
function renderHotTerms() {
  const list = document.getElementById('hotTermsGrid');
  const countEl = document.getElementById('hotCount');
  const section = document.getElementById('hotTermsSection');
  const dateEl = document.getElementById('hotDate');

  // 排序 + 过滤词库已有术语
  const sorted = [...hotTermsData].sort((a, b) => (b.appear_count || 1) - (a.appear_count || 1));
  const officialIds = new Set(glossaryData.map(t => t.id));
  const officialNames = new Set(glossaryData.map(t => t.term_en.toLowerCase()));
  const filteredHot = sorted.filter(t =>
    !officialIds.has(t.id) && !officialNames.has(t.term_en.toLowerCase())
  );

  // 无热门词汇时隐藏排行榜和分隔线
  const divider = document.querySelector('.section-divider');
  if (filteredHot.length === 0) {
    section.style.display = 'none';
    if (divider) divider.style.display = 'none';
    return;
  }

  section.style.display = '';
  if (divider) divider.style.display = '';
  countEl.textContent = filteredHot.length;
  const topDate = filteredHot[0]?.date;
  if (topDate && dateEl) dateEl.textContent = topDate;

  list.innerHTML = filteredHot.map((term, idx) => {
    const daysSince = term.first_appeared
      ? Math.floor((Date.now() - new Date(term.first_appeared)) / (1000 * 60 * 60 * 24))
      : 0;
    const isNew = daysSince <= 3;
    const rank = idx + 1;
    const sources = (term.sources || []).slice(0, 3).join('、');
    const oneliner = term.one_liner || term.description || '';
    return `
      <div class="hot-term-row${isNew ? ' hot-new' : ''}" data-id="${term.id}" data-source="hot">
        <span class="hot-rank">${rank}</span>
        <div class="hot-row-main">
          <div class="hot-row-title-line">
            <span class="hot-row-en">${term.term_en}</span>
            ${term.abbreviation ? `<span class="hot-row-abbr">${term.abbreviation}</span>` : ''}
            ${isNew ? '<span class="hot-badge">NEW</span>' : ''}
          </div>
          ${oneliner ? `<div class="hot-row-oneliner">${oneliner}</div>` : ''}
          <div class="hot-row-zh">${term.term_zh}${sources ? ` · 来源: ${sources}${(term.sources || []).length > 3 ? ' 等' : ''}` : ''}</div>
        </div>
        <div class="hot-row-meta">
          <span class="hot-row-count">${term.appear_count || 1}次</span>
          <span class="hot-row-category">${term.category || ''}</span>
        </div>
      </div>`;
  }).join('');
}

// ===== 搜索 =====
function handleSearch(query) {
  currentSearch = query.toLowerCase().trim();
  applyFilters();
  renderGrid();
  updateStats();
  toggleEmptyState();
  updateSuggestions(query);
}

function updateSuggestions(query) {
  const container = document.getElementById('searchSuggestions');
  if (!query.trim()) {
    container.classList.add('hidden');
    return;
  }
  const q = query.toLowerCase().trim();
  // 搜索正式词库 + 热点词汇
  const allTerms = [...hotTermsData.map(t => ({...t, _source: 'hot'})), ...glossaryData.map(t => ({...t, _source: 'official'}))];
  const matches = allTerms.filter(t =>
    t.term_en.toLowerCase().includes(q) ||
    t.term_zh.includes(q) ||
    (t.abbreviation && t.abbreviation.toLowerCase().includes(q))
  ).slice(0, 6);

  if (matches.length === 0) {
    container.classList.add('hidden');
    return;
  }

  container.innerHTML = matches.map(t => `
    <div class="suggestion-item" data-id="${t.id}" data-source="${t._source}">
      <span class="term-name">${highlightMatch(t.term_en, q)}</span>
      <span class="term-zh">${t.term_zh}${t.abbreviation ? ' · ' + t.abbreviation : ''}${t._source === 'hot' ? ' 🔥' : ''}</span>
    </div>
  `).join('');
  container.classList.remove('hidden');
}

function highlightMatch(text, query) {
  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return text;
  return text.slice(0, idx) + '<mark style="background:rgba(99,102,241,0.15);color:inherit;padding:0 1px;border-radius:2px;">' + text.slice(idx, idx + query.length) + '</mark>' + text.slice(idx + query.length);
}

// ===== 筛选 =====
function applyFilters() {
  filteredData = glossaryData.filter(term => {
    const matchCategory = currentCategory === 'all' || term.category === currentCategory;
    const matchSearch = !currentSearch ||
      term.term_en.toLowerCase().includes(currentSearch) ||
      term.term_zh.includes(currentSearch) ||
      (term.abbreviation && term.abbreviation.toLowerCase().includes(currentSearch)) ||
      term.one_liner.includes(currentSearch) ||
      term.definition.toLowerCase().includes(currentSearch);
    return matchCategory && matchSearch;
  });
}

// ===== 渲染 =====
function renderGrid() {
  const grid = document.getElementById('glossaryGrid');
  if (filteredData.length === 0) {
    grid.innerHTML = '';
    return;
  }

  // 按首字母分组
  const grouped = {};
  filteredData.forEach(term => {
    const letter = term.term_en[0].toUpperCase();
    if (!grouped[letter]) grouped[letter] = [];
    grouped[letter].push(term);
  });

  const sortedLetters = Object.keys(grouped).sort();
  let html = '';

  sortedLetters.forEach(letter => {
    html += `<div class="letter-section" id="section-${letter}"><span class="letter-heading">${letter}</span></div>`;
    grouped[letter].sort((a, b) => a.term_en.localeCompare(b.term_en)).forEach(term => {
      html += renderCard(term);
    });
  });

  grid.innerHTML = html;
}

function renderCard(term) {
  return `
    <div class="term-card" data-id="${term.id}" data-source="official">
      <div class="card-header">
        <span class="card-title">${term.term_en}</span>
        ${term.abbreviation ? `<span class="card-abbr">${term.abbreviation}</span>` : ''}
      </div>
      <div class="card-zh">${term.term_zh}</div>
      <div class="card-desc">${term.one_liner}</div>
      <div class="card-category">${term.category}</div>
    </div>
  `;
}

function renderAlphaNav() {
  const nav = document.getElementById('alphaNav');
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const activeLetters = new Set(glossaryData.map(t => t.term_en[0].toUpperCase()));

  nav.innerHTML = letters.map(l => {
    const isActive = activeLetters.has(l);
    return `<button class="alpha-btn ${isActive ? '' : 'disabled'}" data-letter="${l}" ${!isActive ? 'disabled' : ''}>${l}</button>`;
  }).join('');
}

// ===== 弹窗 =====
function openTermModal(termId, source) {
  // 先在热点词汇中找，再在正式词库中找
  const term = source === 'hot'
    ? hotTermsData.find(t => t.id === termId)
    : glossaryData.find(t => t.id === termId);
  if (!term) {
    // fallback: 两边都找
    const found = hotTermsData.find(t => t.id === termId) || glossaryData.find(t => t.id === termId);
    if (!found) return;
    return openTermModal(termId, found.status === 'hot' ? 'hot' : 'official');
  }

  document.getElementById('modalCategory').textContent = term.category + (source === 'hot' ? ' · 热点' : '');
  document.getElementById('modalTitle').textContent = term.term_en;
  document.getElementById('modalSubtitle').textContent = `${term.term_zh}${term.abbreviation ? ' · ' + term.abbreviation : ''}`;
  document.getElementById('modalOneliner').textContent = term.one_liner || term.description || '';
  // 权威定义：热门术语用 one_liner 兜底
  document.getElementById('modalDefinition').textContent = term.definition || term.one_liner || '暂无权威定义';

  // 来源链接：支持正式词库的 source_url 和热门术语的 matched_articles
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

  // 通俗解读：热门术语生成描述性解读
  const hotExplanation = source === 'hot' && !term.explanation
    ? `${term.one_liner || ''}近期在${(term.sources || []).slice(0, 2).join('、')}等媒体中频繁出现，说明该领域正在快速发展。`
    : null;
  document.getElementById('modalExplanation').textContent = term.explanation || hotExplanation || '暂无通俗解读';

  // 渲染关联术语
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

function closeTermModal() {
  document.getElementById('termModal').classList.add('hidden');
  document.body.style.overflow = '';
}

// ===== 统计 =====
function updateStats() {
  const termCountEl = document.getElementById('termCount');
  if (termCountEl) termCountEl.textContent = `${filteredData.length} 术语`;
  const filterInfo = document.getElementById('filterInfo');
  if (currentSearch) {
    filterInfo.textContent = `搜索 "${currentSearch}" · ${filteredData.length} 条结果`;
  } else if (currentCategory !== 'all') {
    filterInfo.textContent = `${currentCategory} · ${filteredData.length} 条`;
  } else {
    filterInfo.textContent = `显示全部 · ${glossaryData.length} 条`;
  }
}

function toggleEmptyState() {
  const empty = document.getElementById('emptyState');
  const grid = document.getElementById('glossaryGrid');
  if (filteredData.length === 0) {
    empty.classList.remove('hidden');
    grid.style.display = 'none';
  } else {
    empty.classList.add('hidden');
    grid.style.display = '';
  }
}

// ===== Toast =====
function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ===== 事件绑定 =====
function bindEvents() {
  // 搜索
  const searchInput = document.getElementById('searchInput');
  let debounceTimer;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => handleSearch(e.target.value), 150);
  });

  // ESC清空搜索
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      handleSearch('');
      searchInput.blur();
    }
  });

  // 点击建议
  document.getElementById('searchSuggestions').addEventListener('click', (e) => {
    const item = e.target.closest('.suggestion-item');
    if (item) {
      openTermModal(item.dataset.id, item.dataset.source);
      document.getElementById('searchSuggestions').classList.add('hidden');
    }
  });

  // 点击外部关闭建议
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrapper')) {
      document.getElementById('searchSuggestions').classList.add('hidden');
    }
  });

  // 筛选按钮
  document.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentCategory = btn.dataset.category;
      applyFilters();
      renderGrid();
      updateStats();
      toggleEmptyState();
    });
  });

  // 字母导航
  document.getElementById('alphaNav').addEventListener('click', (e) => {
    const btn = e.target.closest('.alpha-btn');
    if (!btn || btn.disabled) return;
    const letter = btn.dataset.letter;
    const section = document.getElementById(`section-${letter}`);
    if (section) {
      const offset = 130;
      const top = section.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  });

  // 热点词汇行点击
  document.getElementById('hotTermsGrid').addEventListener('click', (e) => {
    const row = e.target.closest('.hot-term-row');
    if (row) openTermModal(row.dataset.id, 'hot');
  });

  // 正式词库卡片点击
  document.getElementById('glossaryGrid').addEventListener('click', (e) => {
    const card = e.target.closest('.term-card');
    if (card) openTermModal(card.dataset.id, card.dataset.source || 'official');
  });

  // 关联术语点击
  document.getElementById('modalRelated').addEventListener('click', (e) => {
    const tag = e.target.closest('.related-tag');
    if (tag) {
      closeTermModal();
      setTimeout(() => openTermModal(tag.dataset.id, tag.dataset.source || 'official'), 280);
    }
  });

  // 关闭弹窗
  document.getElementById('modalClose').addEventListener('click', closeTermModal);
  document.getElementById('termModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeTermModal();
  });

  // 提交弹窗
  const submitModal = document.getElementById('submitModal');
  const openSubmitModal = () => {
    submitModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  };
  document.getElementById('submitTermBtn')?.addEventListener('click', openSubmitModal);
  document.getElementById('navSubmitBtn')?.addEventListener('click', openSubmitModal);
  document.getElementById('submitModalClose').addEventListener('click', () => {
    submitModal.classList.add('hidden');
    document.body.style.overflow = '';
  });
  submitModal.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      submitModal.classList.add('hidden');
      document.body.style.overflow = '';
    }
  });

  // 提交表单 → 调用后端 API（需要后端支持）
  document.getElementById('submitForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const term = {
      term_en: document.getElementById('newTermEn').value,
      term_zh: document.getElementById('newTermZh').value,
      abbreviation: document.getElementById('newTermAbbr').value,
      description: document.getElementById('newTermDesc').value,
      source_url: document.getElementById('newTermSource').value
    };

    if (!apiAvailable) {
      showToast('提交功能需要后端服务支持，当前为静态模式');
      return;
    }

    try {
      await apiPost('/submit', term);
      document.getElementById('submitForm').reset();
      submitModal.classList.add('hidden');
      document.body.style.overflow = '';
      showToast('术语已提交到热点词汇区');
      // 重新加载数据
      await loadGlossary();
    } catch (err) {
      showToast(err.message || '提交失败');
    }
  });

  // 全局ESC关闭弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeTermModal();
      submitModal.classList.add('hidden');
      document.body.style.overflow = '';
    }
  });
}

// 启动
document.addEventListener('DOMContentLoaded', loadGlossary);