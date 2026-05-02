/**
 * Genuine Image Audit — Vision-verified review surface for genuine product images.
 * Backed by /api/admin/image-audit/{stats,list,refetch,verify-with-vision,bulk-refetch,bulk-quarantine}.
 * Lets the admin scan flagged images at a glance, drill into reasons, and approve / refetch / quarantine in bulk.
 */
import { AdminAuth, FilterState, AdminAPI, icon, esc } from '../app.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';
import { Drawer } from '../components/drawer.js';

const PAGE_SIZE = 50;
const BULK_REFETCH_MAX = 50;
const BULK_QUARANTINE_MAX = 200;

const VERDICTS = [
  { key: 'verified_box',     label: 'Verified box',     tone: 'good' },
  { key: 'verified_product', label: 'Verified product', tone: 'good' },
  { key: 'unverifiable',     label: 'Unverifiable',     tone: 'warn' },
  { key: 'not_checked',      label: 'Not checked',      tone: 'warn' },
  { key: 'wrong_product',    label: 'Wrong product',    tone: 'bad'  },
  { key: 'watermarked',      label: 'Watermarked',      tone: 'bad'  },
];
const VERDICT_LABEL = Object.fromEntries(VERDICTS.map(v => [v.key, v.label]));
const VERDICT_TONE  = Object.fromEntries(VERDICTS.map(v => [v.key, v.tone]));

const STATUS_OPTIONS = [
  { key: 'pending',       label: 'Pending review' },
  { key: 'checked_clean', label: 'Checked clean'  },
  { key: 'replaced',      label: 'Replaced'       },
];

let _container = null;
let _state = {
  page: 1,
  search: '',
  source: 'genuine',
  pack: 'singles_only',
  excludeRibbons: true,
  missingOnly: false,
  externalOnly: false,
  verdict: '',
  status: '',
  brand: '',
  sort: 'name_asc',
};
let _brands = [];
let _products = [];
let _stats = null;
let _pagination = { total: 0, page: 1, limit: PAGE_SIZE };
let _selected = new Set();
let _loadToken = 0;

// ---- Utilities ----

function formatVerdict(v) {
  if (!v) return 'Not checked';
  return VERDICT_LABEL[v] || v.replace(/_/g, ' ');
}

function formatScore(s) {
  if (s === null || s === undefined) return '—';
  const n = Number(s);
  if (Number.isNaN(n)) return '—';
  return `${Math.round(n * 100)}%`;
}

function formatRelTime(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
}

function humanReason(token) {
  // Map common verifier tokens to friendly text; fall through for unknown ones.
  const map = {
    filename_tokens_match: 'Filename matches SKU',
    edge_density_clean: 'Clean edges (no UI overlay)',
    vision_retail_box: 'Vision detected retail box',
    vision_product_only: 'Vision detected product photo',
    vision_watermarked: 'Vision detected watermark',
    vision_wrong_product: 'Vision rejected — wrong product',
    vision_skipped_non_genuine: 'Vision skipped (compatible product)',
    url_blocked_domain: 'URL on block-list',
    edge_density_high: 'Image looks like a UI screenshot',
  };
  if (map[token]) return map[token];
  return token.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function openImageLightbox(url, alt = '') {
  if (!url) return;
  document.querySelector('.admin-image-lightbox')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'admin-image-lightbox';
  overlay.innerHTML = `
    <button class="admin-image-lightbox__close" aria-label="Close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
    <img class="admin-image-lightbox__img" src="${esc(url)}" alt="${esc(alt)}">
  `;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.admin-image-lightbox__close')) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

// ---- Toolbar / KPIs ----

function buildToolbar() {
  let brandOpts = '<option value="">All brands</option>';
  for (const b of _brands) {
    const name = typeof b === 'string' ? b : b.name || b.brand || String(b);
    const val = (typeof b === 'object' && b.id) ? b.id : name;
    const sel = String(val) === String(_state.brand) ? ' selected' : '';
    brandOpts += `<option value="${esc(val)}"${sel}>${esc(name)}</option>`;
  }

  const sel = (cur, val) => cur === val ? ' selected' : '';
  let verdictOpts = '<option value="">All verdicts</option>';
  for (const v of VERDICTS) verdictOpts += `<option value="${esc(v.key)}"${sel(_state.verdict, v.key)}>${esc(v.label)}</option>`;
  let statusOpts = '<option value="">All statuses</option>';
  for (const s of STATUS_OPTIONS) statusOpts += `<option value="${esc(s.key)}"${sel(_state.status, s.key)}>${esc(s.label)}</option>`;

  return `
    <div class="admin-toolbar gia-toolbar">
      <div class="admin-search" style="min-width:200px">
        <span class="admin-search__icon">${icon('search', 14, 14)}</span>
        <input type="search" placeholder="Search SKU or name…" id="gia-search" value="${esc(_state.search)}">
      </div>
      <select class="admin-select" id="gia-source" title="Product source">
        <option value="genuine"${sel(_state.source, 'genuine')}>Genuine</option>
        <option value="compatible"${sel(_state.source, 'compatible')}>Compatible</option>
        <option value="all"${sel(_state.source, 'all')}>All sources</option>
      </select>
      <select class="admin-select" id="gia-brand">${brandOpts}</select>
      <select class="admin-select" id="gia-verdict">${verdictOpts}</select>
      <select class="admin-select" id="gia-status">${statusOpts}</select>
      <select class="admin-select" id="gia-sort" title="Sort">
        <option value="name_asc"${sel(_state.sort, 'name_asc')}>Name A→Z</option>
        <option value="name_desc"${sel(_state.sort, 'name_desc')}>Name Z→A</option>
        <option value="sales_desc"${sel(_state.sort, 'sales_desc')}>Most sold</option>
        <option value="sales_asc"${sel(_state.sort, 'sales_asc')}>Least sold</option>
        <option value="checked_recent"${sel(_state.sort, 'checked_recent')}>Recently checked</option>
        <option value="checked_oldest"${sel(_state.sort, 'checked_oldest')}>Oldest checked</option>
      </select>
      <label class="gia-pill${_state.missingOnly ? ' gia-pill--on' : ''}">
        <input type="checkbox" id="gia-missing" ${_state.missingOnly ? 'checked' : ''}>
        <span>Missing image only</span>
      </label>
      <label class="gia-pill${_state.excludeRibbons ? ' gia-pill--on' : ''}">
        <input type="checkbox" id="gia-ribbons" ${_state.excludeRibbons ? 'checked' : ''}>
        <span>Exclude ribbons</span>
      </label>
      <span style="flex:1 1 auto"></span>
      <span class="admin-text-muted" id="gia-count" style="font-size:13px;white-space:nowrap"></span>
    </div>
  `;
}

function buildKpis() {
  const s = _stats || {};
  const v = s.vision || {};
  const verified = (v.verified_box || 0) + (v.verified_product || 0);
  const bad = (v.watermarked || 0) + (v.wrong_product || 0);
  const total = s.total_with_image ?? 0;
  const missing = s.total_missing_image ?? 0;
  const pending = s.pending_review ?? 0;
  const card = (label, value, tone, sub = '') => `
    <button class="gia-kpi gia-kpi--${tone}" data-kpi="${label.toLowerCase().replace(/\s+/g, '-')}">
      <span class="gia-kpi__value">${esc(Number(value).toLocaleString('en-NZ'))}</span>
      <span class="gia-kpi__label">${esc(label)}</span>
      ${sub ? `<span class="gia-kpi__sub">${esc(sub)}</span>` : ''}
    </button>
  `;
  return `
    <div class="gia-kpis">
      ${card('With image', total, 'neutral', missing ? `${missing.toLocaleString('en-NZ')} missing` : '')}
      ${card('Pending review', pending, 'warn')}
      ${card('Bad', bad, 'bad', `${v.watermarked || 0} watermarked · ${v.wrong_product || 0} wrong`)}
      ${card('Verified', verified, 'good', `${v.verified_box || 0} box · ${v.verified_product || 0} product`)}
    </div>
  `;
}

function buildBulkBar() {
  const n = _selected.size;
  return `
    <div class="gia-bulk${n ? ' gia-bulk--active' : ''}" id="gia-bulk">
      <label class="gia-checkbox">
        <input type="checkbox" id="gia-select-all">
        <span>Select all on page</span>
      </label>
      <span class="gia-bulk__count">${n} selected</span>
      <span style="flex:1 1 auto"></span>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-bulk="verify" ${n ? '' : 'disabled'}>🔍 Verify with Vision</button>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-bulk="refetch" ${n ? '' : 'disabled'}>↻ Refetch (max ${BULK_REFETCH_MAX})</button>
      <button class="admin-btn admin-btn--danger admin-btn--sm" data-bulk="quarantine" ${n ? '' : 'disabled'}>✗ Quarantine</button>
    </div>
  `;
}

// ---- Card / Grid rendering ----

function renderVerdictBadge(v) {
  const tone = VERDICT_TONE[v] || 'warn';
  const label = formatVerdict(v);
  return `<span class="gia-verdict gia-verdict--${tone}">${esc(label)}</span>`;
}

function renderCard(p) {
  const isSelected = _selected.has(p.id);
  const verdict = p.image_vision_verdict;
  const reasons = Array.isArray(p.image_vision_reasons) ? p.image_vision_reasons : [];
  const topReason = reasons.length ? humanReason(reasons[0]) : '';
  const status = p.image_audit_status;
  const sales = Number(p.units_sold || 0);
  const brand = p.brand || '';
  const imgUrl = p.image_url_resolved || '';
  const missing = !imgUrl;

  return `
    <article class="gia-card${isSelected ? ' gia-card--selected' : ''}${missing ? ' gia-card--missing' : ''}" data-product-id="${esc(p.id)}">
      <label class="gia-card__select" title="Select" data-action="ignore-click">
        <input type="checkbox" data-action="toggle-select" ${isSelected ? 'checked' : ''}>
      </label>
      <div class="gia-card__thumb" data-action="open-drawer">
        ${missing
          ? `<div class="gia-card__placeholder">${icon('image', 36, 36)}<span>No image</span></div>`
          : `<img src="${esc(imgUrl)}" alt="${esc(p.name || '')}" loading="lazy">`
        }
        <div class="gia-card__badges">
          ${renderVerdictBadge(verdict)}
          ${status === 'replaced' ? '<span class="gia-status gia-status--replaced">REPLACED</span>' : ''}
          ${status === 'checked_clean' ? '<span class="gia-status gia-status--clean">CLEAN</span>' : ''}
        </div>
      </div>
      <div class="gia-card__meta">
        <div class="gia-card__sku">${esc(p.sku || '')}</div>
        <div class="gia-card__name" title="${esc(p.name || '')}">${esc(p.name || '—')}</div>
        <div class="gia-card__row">
          ${brand ? `<span class="gia-pill-badge">${esc(brand)}</span>` : ''}
          <span class="gia-sales">${sales.toLocaleString('en-NZ')} sold</span>
        </div>
        ${topReason ? `<div class="gia-card__reason" title="${esc(reasons.map(humanReason).join(' • '))}">${esc(topReason)}</div>` : ''}
      </div>
      <div class="gia-card__actions">
        <button class="gia-icon-btn" data-action="mark-verified" title="Mark verified">✓</button>
        <button class="gia-icon-btn" data-action="reverify" title="Re-verify with Vision">🔍</button>
        <button class="gia-icon-btn" data-action="refetch" title="Refetch image">↻</button>
        <button class="gia-icon-btn" data-action="search-google" title="Search Google">🌐</button>
        <button class="gia-icon-btn gia-icon-btn--danger" data-action="quarantine" title="Quarantine">✗</button>
      </div>
    </article>
  `;
}

function renderGrid() {
  const grid = document.getElementById('gia-grid');
  if (!grid) return;
  if (!_products.length) {
    grid.innerHTML = `
      <div class="gia-empty">
        <div class="gia-empty__emoji">🎉</div>
        <div class="gia-empty__title">All clean</div>
        <div class="gia-empty__text">No images need review for these filters.</div>
      </div>
    `;
    return;
  }
  grid.innerHTML = _products.map(renderCard).join('');
}

function renderCount() {
  const el = document.getElementById('gia-count');
  if (!el) return;
  const total = _pagination?.total ?? 0;
  el.textContent = total ? `${total.toLocaleString('en-NZ')} product${total === 1 ? '' : 's'}` : '';
}

function renderPagination() {
  const wrap = document.getElementById('gia-pagination');
  if (!wrap) return;
  const total = _pagination?.total || 0;
  const limit = _pagination?.limit || PAGE_SIZE;
  const page = _pagination?.page || _state.page;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (totalPages <= 1) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = `
    <button class="admin-btn admin-btn--ghost admin-btn--sm" data-page="prev" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
    <span class="gia-pagination__info">Page ${page} of ${totalPages}</span>
    <button class="admin-btn admin-btn--ghost admin-btn--sm" data-page="next" ${page >= totalPages ? 'disabled' : ''}>Next →</button>
  `;
}

function renderBulkBar() {
  const wrap = document.getElementById('gia-bulk-wrap');
  if (!wrap) return;
  wrap.innerHTML = buildBulkBar();
  bindBulkBarEvents();
}

function renderKpis() {
  const wrap = document.getElementById('gia-kpis-wrap');
  if (!wrap) return;
  wrap.innerHTML = buildKpis();
}

// ---- Data loading ----

function buildFilters() {
  return {
    source: _state.source,
    pack: _state.pack,
    exclude_ribbons: _state.excludeRibbons,
    missing_only: _state.missingOnly,
    external_only: _state.externalOnly && !_state.missingOnly,
    verdict: _state.verdict,
    status: _state.status,
    brand: _state.brand,
    search: _state.search,
    sort: _state.sort,
  };
}

async function loadStats() {
  const stats = await AdminAPI.getImageAuditStats({
    source: _state.source !== 'all' ? _state.source : undefined,
    pack: _state.pack,
    exclude_ribbons: _state.excludeRibbons,
    brand: _state.brand || undefined,
  });
  _stats = stats || null;
  renderKpis();
}

async function loadList() {
  const grid = document.getElementById('gia-grid');
  if (!grid) return;
  const token = ++_loadToken;
  grid.innerHTML = `<div class="gia-loading"><div class="admin-loading__spinner"></div></div>`;

  const filters = buildFilters();
  // /list accepts source filter directly (the API supports 'all' too)
  const data = await AdminAPI.getImageAuditList(filters, _state.page, PAGE_SIZE);
  if (!_container || token !== _loadToken) return;

  const products = data?.products || [];
  const pagination = data?.pagination || { total: products.length, page: _state.page, limit: PAGE_SIZE };

  _products = products;
  _pagination = pagination;

  // Drop selections that aren't on the visible page anymore (so the bulk bar count matches)
  const visibleIds = new Set(products.map(p => p.id));
  for (const id of [..._selected]) if (!visibleIds.has(id)) _selected.delete(id);

  renderGrid();
  renderCount();
  renderPagination();
  renderBulkBar();
}

async function reload({ resetPage = false } = {}) {
  if (resetPage) _state.page = 1;
  await Promise.all([loadStats(), loadList()]);
}

// ---- Event bindings ----

function bindToolbarEvents() {
  const c = _container;
  if (!c) return;

  let searchTimer;
  c.querySelector('#gia-search')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value.trim();
    searchTimer = setTimeout(() => { _state.search = v; reload({ resetPage: true }); }, 300);
  });

  const onChange = (id, key, transform = (v) => v) => {
    c.querySelector(id)?.addEventListener('change', (e) => {
      _state[key] = transform(e.target.value);
      reload({ resetPage: true });
    });
  };
  onChange('#gia-source', 'source');
  onChange('#gia-brand',  'brand');
  onChange('#gia-verdict','verdict');
  onChange('#gia-status', 'status');
  onChange('#gia-sort',   'sort');

  c.querySelector('#gia-missing')?.addEventListener('change', (e) => {
    _state.missingOnly = !!e.target.checked;
    reload({ resetPage: true });
  });
  c.querySelector('#gia-ribbons')?.addEventListener('change', (e) => {
    _state.excludeRibbons = !!e.target.checked;
    reload({ resetPage: true });
  });

  c.querySelector('#gia-pagination')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (!btn || btn.disabled) return;
    const total = _pagination?.total || 0;
    const limit = _pagination?.limit || PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    if (btn.dataset.page === 'prev') _state.page = Math.max(1, _state.page - 1);
    if (btn.dataset.page === 'next') _state.page = Math.min(totalPages, _state.page + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    loadList();
  });
}

function bindBulkBarEvents() {
  const wrap = document.getElementById('gia-bulk');
  if (!wrap) return;

  wrap.querySelector('#gia-select-all')?.addEventListener('change', (e) => {
    if (e.target.checked) {
      for (const p of _products) _selected.add(p.id);
    } else {
      _selected.clear();
    }
    // Re-render the grid checkboxes + bulk bar
    document.querySelectorAll('.gia-card').forEach(card => {
      const id = card.dataset.productId;
      const cb = card.querySelector('[data-action="toggle-select"]');
      if (cb) cb.checked = _selected.has(id);
      card.classList.toggle('gia-card--selected', _selected.has(id));
    });
    renderBulkBar();
  });

  wrap.querySelectorAll('[data-bulk]').forEach(btn => {
    btn.addEventListener('click', () => handleBulkAction(btn.dataset.bulk));
  });
}

function bindGridEvents() {
  const grid = document.getElementById('gia-grid');
  if (!grid) return;

  grid.addEventListener('click', async (e) => {
    const card = e.target.closest('.gia-card');
    if (!card) return;
    const productId = card.dataset.productId;

    // Checkbox toggle
    const selectCb = e.target.closest('[data-action="toggle-select"]');
    if (selectCb) {
      e.stopPropagation();
      if (selectCb.checked) _selected.add(productId);
      else _selected.delete(productId);
      card.classList.toggle('gia-card--selected', selectCb.checked);
      renderBulkBar();
      return;
    }

    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'ignore-click') return;

    const product = _products.find(p => p.id === productId);
    if (!product) return;

    if (action === 'open-drawer') return openProductDrawer(product);
    if (action === 'mark-verified') return markVerified(product, card);
    if (action === 'reverify')      return reverifyOne(product, card);
    if (action === 'refetch')       return refetchOne(product, card);
    if (action === 'quarantine')    return quarantineOne(product, card);
    if (action === 'search-google') return openGoogleSearch(product);
  });
}

// ---- Single-row actions ----

async function markVerified(product, cardEl) {
  cardEl.classList.add('gia-card--busy');
  try {
    await AdminAPI.setImageAuditStatus(product.id, 'checked_clean');
    Toast.success(`${product.sku} marked verified`);
    product.image_audit_status = 'checked_clean';
    cardEl.outerHTML = renderCard(product);
    loadStats();
  } catch (err) {
    Toast.error(err.message || 'Could not mark verified');
  } finally {
    document.querySelector(`.gia-card[data-product-id="${CSS.escape(product.id)}"]`)?.classList.remove('gia-card--busy');
  }
}

async function reverifyOne(product, cardEl) {
  cardEl.classList.add('gia-card--busy');
  Toast.info(`Re-verifying ${product.sku}…`);
  try {
    const result = await AdminAPI.verifyImageWithVision(product.id, true);
    if (result) {
      product.image_vision_verdict = result.verdict;
      product.image_vision_score = result.score;
      product.image_vision_reasons = result.reasons || [];
      product.image_vision_checked_at = result.image_vision_checked_at;
      cardEl.outerHTML = renderCard(product);
      Toast.success(`${product.sku}: ${formatVerdict(result.verdict)}`);
      loadStats();
    }
  } catch (err) {
    if (err.code === 'RATE_LIMITED') {
      Toast.error('Too many vision requests. Please slow down.');
    } else {
      Toast.error(err.message || 'Verification failed');
    }
  } finally {
    document.querySelector(`.gia-card[data-product-id="${CSS.escape(product.id)}"]`)?.classList.remove('gia-card--busy');
  }
}

async function refetchOne(product, cardEl) {
  if (product.pack_type && product.pack_type !== 'single') {
    Toast.info('Packs are auto-generated — refetch the singles instead.');
    return;
  }
  cardEl.classList.add('gia-card--busy');
  const toast = Toast.info(`Refetching ${product.sku}… (5–15s)`);
  try {
    const result = await AdminAPI.refetchImage(product.id, { useVision: true, directApply: false });
    toast?.remove?.();
    if (!result || result.ok === false) {
      const reason = result?.reason || 'no candidates accepted';
      Toast.error(`${product.sku}: ${reason}`);
      return;
    }
    Toast.success(`${product.sku}: staged for review (${formatVerdict(result.verdict)})`);
    // Don't update image_url locally — the change is in Pending Changes until approved.
    product.image_audit_status = 'pending';
    cardEl.outerHTML = renderCard(product);
    loadStats();
  } catch (err) {
    toast?.remove?.();
    if (err.code === 'RATE_LIMITED') {
      Toast.error('Too many refetch requests. Please slow down.');
    } else {
      Toast.error(err.message || 'Refetch failed');
    }
  } finally {
    document.querySelector(`.gia-card[data-product-id="${CSS.escape(product.id)}"]`)?.classList.remove('gia-card--busy');
  }
}

function quarantineOne(product, cardEl) {
  Modal.confirm({
    title: 'Quarantine image?',
    message: `Clear ${product.sku}'s image and archive the URL? You can restore it later from Pending Changes.`,
    confirmLabel: 'Quarantine',
    confirmClass: 'admin-btn--danger',
    onConfirm: async () => {
      try {
        await AdminAPI.bulkQuarantineImages([product.id]);
        Toast.success(`${product.sku} quarantined`);
        cardEl.style.transition = 'opacity .2s, transform .2s';
        cardEl.style.opacity = '0';
        cardEl.style.transform = 'scale(0.96)';
        setTimeout(() => {
          _products = _products.filter(p => p.id !== product.id);
          _selected.delete(product.id);
          if (_pagination) _pagination.total = Math.max(0, (_pagination.total || 1) - 1);
          renderGrid();
          renderCount();
          renderBulkBar();
          loadStats();
        }, 200);
      } catch (err) {
        Toast.error(err.message || 'Quarantine failed');
      }
    },
  });
}

async function openGoogleSearch(product) {
  // The backend endpoint requires admin auth, so we can't `window.open` it directly
  // (a popup tab won't carry our Bearer token). Resolve it via authenticated fetch first.
  // It either redirects to Google (response.url is final) or returns { ok, data: { url } }.
  const apiUrl = AdminAPI.imageAuditSearchUrl(product.id);
  try {
    const token = window.Auth?.session?.access_token;
    const resp = await fetch(apiUrl, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      redirect: 'follow',
    });
    let target = resp.url && resp.url !== apiUrl ? resp.url : null;
    if (!target) {
      const json = await resp.json().catch(() => null);
      target = json?.data?.url || json?.url || null;
    }
    if (!target) {
      // Fallback: build a Google image-search query from SKU + name
      const q = `${product.sku || ''} ${product.name || ''}`.trim();
      target = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
    }
    window.open(target, '_blank', 'noopener');
  } catch (e) {
    const q = `${product.sku || ''} ${product.name || ''}`.trim();
    window.open(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`, '_blank', 'noopener');
  }
}

// ---- Drawer (card detail) ----

function openProductDrawer(product) {
  const verdict = product.image_vision_verdict;
  const reasons = Array.isArray(product.image_vision_reasons) ? product.image_vision_reasons : [];
  const score = product.image_vision_score;
  const checkedAt = product.image_vision_checked_at;
  const cur = product.image_url_resolved || '';
  const legacy = product.legacy_image_url_resolved || '';

  const reasonsHtml = reasons.length
    ? reasons.map(r => `<li>${esc(humanReason(r))} <code class="gia-reason-token">${esc(r)}</code></li>`).join('')
    : '<li class="admin-text-muted">No reasons recorded.</li>';

  const body = `
    <div class="gia-drawer">
      <div class="gia-drawer__head">
        <div class="gia-drawer__sku">${esc(product.sku || '')}</div>
        <div class="gia-drawer__name">${esc(product.name || '—')}</div>
        <div class="gia-drawer__row">
          ${product.brand ? `<span class="gia-pill-badge">${esc(product.brand)}</span>` : ''}
          ${renderVerdictBadge(verdict)}
          <span class="admin-text-muted">Confidence: <strong>${esc(formatScore(score))}</strong></span>
        </div>
        <div class="gia-drawer__row admin-text-muted">
          Last checked: ${esc(formatRelTime(checkedAt))}
          ${product.image_audit_status ? ` &middot; status: <strong>${esc(product.image_audit_status)}</strong>` : ''}
        </div>
      </div>

      <div class="gia-drawer__compare">
        <div class="gia-drawer__col">
          <div class="gia-drawer__col-label">Current</div>
          ${cur
            ? `<img src="${esc(cur)}" alt="${esc(product.name || '')}" class="gia-drawer__img" data-big="${esc(cur)}">`
            : `<div class="gia-drawer__placeholder">No image</div>`}
        </div>
        <div class="gia-drawer__col">
          <div class="gia-drawer__col-label">Legacy</div>
          ${legacy
            ? `<img src="${esc(legacy)}" alt="legacy" class="gia-drawer__img" data-big="${esc(legacy)}">`
            : `<div class="gia-drawer__placeholder">No prior image</div>`}
        </div>
      </div>

      <div class="gia-drawer__section">
        <h4>Vision reasons</h4>
        <ul class="gia-drawer__reasons">${reasonsHtml}</ul>
      </div>

      <div class="gia-drawer__section">
        <h4>Stats</h4>
        <dl class="gia-drawer__dl">
          <dt>Source</dt><dd>${esc(product.source || '—')}</dd>
          <dt>Type</dt><dd>${esc(product.product_type || '—')}</dd>
          <dt>Pack</dt><dd>${esc(product.pack_type || '—')}</dd>
          <dt>MPN</dt><dd>${esc(product.mpn || '—')}</dd>
          <dt>Sales</dt><dd>${esc(Number(product.units_sold || 0).toLocaleString('en-NZ'))}</dd>
        </dl>
      </div>
    </div>
  `;

  const footer = `
    <button class="admin-btn admin-btn--ghost" data-drawer-action="search-google">🌐 Google search</button>
    <button class="admin-btn admin-btn--ghost" data-drawer-action="reverify">🔍 Re-verify</button>
    <button class="admin-btn admin-btn--ghost" data-drawer-action="refetch">↻ Refetch</button>
    <button class="admin-btn admin-btn--danger" data-drawer-action="quarantine">✗ Quarantine</button>
    <button class="admin-btn admin-btn--primary" data-drawer-action="mark-verified">✓ Mark verified</button>
  `;

  const ref = Drawer.open({ title: 'Image audit detail', body, footer, width: '720px' });
  if (!ref) return;

  ref.body.addEventListener('click', (e) => {
    const img = e.target.closest('img[data-big]');
    if (img) openImageLightbox(img.dataset.big || img.src, product.name || '');
  });

  ref.footer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-drawer-action]');
    if (!btn) return;
    const cardEl = document.querySelector(`.gia-card[data-product-id="${CSS.escape(product.id)}"]`);
    const a = btn.dataset.drawerAction;
    if (a === 'search-google')   { openGoogleSearch(product); return; }
    if (!cardEl) { Toast.error('Card no longer in view'); return; }
    if (a === 'mark-verified')   { ref.close(); markVerified(product, cardEl); }
    else if (a === 'reverify')   { ref.close(); reverifyOne(product, cardEl); }
    else if (a === 'refetch')    { ref.close(); refetchOne(product, cardEl); }
    else if (a === 'quarantine') { ref.close(); quarantineOne(product, cardEl); }
  });
}

// ---- Bulk actions ----

async function handleBulkAction(kind) {
  const ids = [..._selected];
  if (!ids.length) return;

  if (kind === 'verify') {
    return bulkVerifyWithVision(ids);
  }
  if (kind === 'refetch') {
    if (ids.length > BULK_REFETCH_MAX) {
      Toast.error(`Max ${BULK_REFETCH_MAX} per batch — currently selected: ${ids.length}`);
      return;
    }
    return bulkRefetch(ids);
  }
  if (kind === 'quarantine') {
    if (ids.length > BULK_QUARANTINE_MAX) {
      Toast.error(`Max ${BULK_QUARANTINE_MAX} per batch — currently selected: ${ids.length}`);
      return;
    }
    return bulkQuarantine(ids);
  }
}

async function bulkVerifyWithVision(ids) {
  Modal.confirm({
    title: `Re-verify ${ids.length} image${ids.length === 1 ? '' : 's'}?`,
    message: `This calls Claude Vision once per product (rate-limited to 10/min). Continue?`,
    confirmLabel: 'Re-verify',
    confirmClass: 'admin-btn--primary',
    onConfirm: async () => {
      let ok = 0, fail = 0;
      for (const id of ids) {
        try {
          await AdminAPI.verifyImageWithVision(id, true);
          ok++;
        } catch (err) {
          fail++;
          if (err.code === 'RATE_LIMITED') {
            Toast.error(`Stopped early — rate limited after ${ok} verifications.`);
            break;
          }
        }
      }
      Toast.success(`Verified ${ok}${fail ? ` · ${fail} failed` : ''}`);
      _selected.clear();
      reload();
    },
  });
}

async function bulkRefetch(ids) {
  Modal.confirm({
    title: `Refetch ${ids.length} image${ids.length === 1 ? '' : 's'}?`,
    message: `Searches Bing, runs Vision on each candidate, and stages accepted replacements to Pending Changes. May take ${Math.ceil(ids.length * 8 / 60)}–${Math.ceil(ids.length * 15 / 60)} min.`,
    confirmLabel: 'Refetch all',
    confirmClass: 'admin-btn--primary',
    onConfirm: async () => {
      const t = Toast.info(`Refetching ${ids.length} images… this may take a while.`, 0);
      try {
        const result = await AdminAPI.bulkRefetchImages(ids, { useVision: true, directApply: false });
        t?.remove?.();
        if (!result) {
          Toast.error('Refetch returned no result');
          return;
        }
        const total = result.total ?? ids.length;
        const ok = result.succeeded ?? 0;
        const failed = result.failed ?? 0;
        const stoppedEarly = (result.results || []).some(r => !r.id && r.note);
        let msg = `${ok} staged · ${failed} failed`;
        if (stoppedEarly) msg += ' · stopped early (rate limited)';
        if (ok) Toast.success(`✅ ${msg} (of ${total})`);
        else    Toast.error(`❌ ${msg} (of ${total})`);
        _selected.clear();
        reload();
      } catch (err) {
        t?.remove?.();
        if (err.code === 'RATE_LIMITED') {
          Toast.error('Rate limited by Bing. Wait a minute and try again.');
        } else {
          Toast.error(err.message || 'Bulk refetch failed');
        }
      }
    },
  });
}

async function bulkQuarantine(ids) {
  Modal.confirm({
    title: `Quarantine ${ids.length} image${ids.length === 1 ? '' : 's'}?`,
    message: `Clears the image_url and archives it to legacy_image_url. Sets audit status to "pending".`,
    confirmLabel: 'Quarantine',
    confirmClass: 'admin-btn--danger',
    onConfirm: async () => {
      try {
        const result = await AdminAPI.bulkQuarantineImages(ids);
        const n = result?.quarantined ?? ids.length;
        Toast.success(`Quarantined ${n} image${n === 1 ? '' : 's'}`);
        _selected.clear();
        reload();
      } catch (err) {
        Toast.error(err.message || 'Quarantine failed');
      }
    },
  });
}

// ---- Page lifecycle ----

async function render() {
  if (!_brands.length) {
    const brandsData = await AdminAPI.getBrands();
    if (!_container) return;
    _brands = (brandsData && Array.isArray(brandsData)) ? brandsData : [];
  }

  _container.innerHTML = `
    <div class="admin-page-header gia-page-header">
      <div class="gia-page-header__top">
        <div>
          <h1 class="gia-page-header__title">Genuine Image Audit</h1>
          <p class="gia-page-header__sub">Vision-verified review of every active genuine product image. Click a card to inspect, or select to act in bulk.</p>
        </div>
      </div>
      <div id="gia-kpis-wrap"></div>
    </div>
    ${buildToolbar()}
    <div id="gia-bulk-wrap"></div>
    <div id="gia-grid" class="gia-grid"></div>
    <div id="gia-pagination" class="gia-pagination"></div>
  `;

  bindToolbarEvents();
  bindGridEvents();
  await reload();
}

export default {
  title: 'Genuine Image Audit',

  async init(container) {
    if (!AdminAuth.isOwner()) {
      container.innerHTML = `
        <div class="admin-stub">
          <div class="admin-stub__title">Access Restricted</div>
          <div class="admin-stub__text">This surface is super-admin only.</div>
        </div>
      `;
      return;
    }
    FilterState.showBar(false);
    _container = container;
    _state = {
      page: 1, search: '',
      source: 'genuine', pack: 'singles_only',
      excludeRibbons: true, missingOnly: false, externalOnly: false,
      verdict: '', status: '', brand: '', sort: 'name_asc',
    };
    _products = [];
    _stats = null;
    _selected = new Set();
    await render();
  },

  destroy() {
    _loadToken++;
    _container = null;
    _products = [];
    _brands = [];
    _stats = null;
    _selected = new Set();
  },

  onSearch(query) {
    _state.search = query;
    _state.page = 1;
    const input = document.getElementById('gia-search');
    if (input && input.value !== query) input.value = query;
    loadList();
  },
};
