/**
 * Product Codes — the /shop drilldown chips, edited by CODE rather than by product.
 *
 * The storefront categorises products brand > type > CODE. On
 * /shop?brand=canon&category=ink that's the "Select a Product Code" grid: CI3,
 * PG40/CL41, PGI5/CLI8 … This page is that grid, editable. It exists because the
 * only other way in was the per-product drawer's Product Codes tab, which is
 * product-centric when the question ("this chip is wrong") is code-centric.
 *
 * SCOPE — brand + category, mirroring /shop. Not a UI preference: a code only
 * means anything inside a brand+category, and every write path resolves its
 * products through getShopData({brand, category, code}). Note a category can span
 * several product_types (ink = ink_cartridge + ink_bottle), so an edit here reaches
 * all of them — which is exactly the grain the customer's chip grid has.
 *
 * THE OVERRIDE TRAP — `product_codes` is an override layer with "manual replaces
 * auto" semantics: a product with any row there has its backend-derived
 * series_codes ignored entirely. So a chip the backend derives has ZERO rows, and
 * "deleting" it means writing an override onto every product carrying it. Every
 * write therefore starts from each product's EFFECTIVE codes (AdminAPI's walk
 * returns them) — never from an empty list, which would silently wipe its other
 * chips. A future catalogue import can re-derive a deleted code and bring the chip
 * back; only a backend extractor change kills one permanently. The page says so.
 */

import { AdminAPI, FilterState, esc } from '../app.js';
import { Drawer } from '../components/drawer.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import {
  SHOP_CATEGORIES,
  isValidProductCode,
  describeCodesWriteError,
} from '../utils/product-codes.js';

let _container = null;
let _alive = false;
let _loadToken = 0;      // ERR-045: a reply from a superseded load must not render

let _brands = [];
let _brandSlug = '';
let _category = 'ink';
let _codes = [];         // [{ code, count }]
let _filter = '';
let _menu = null;        // { code, mode: 'menu' | 'rename' | 'delete' }

const KEBAB = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`;

const norm = s => String(s || '').trim().toUpperCase();
const plural = n => `${n} product${n === 1 ? '' : 's'}`;
const categoryLabel = v => (SHOP_CATEGORIES.find(c => c.value === v) || {}).label || v;
const brandLabel = slug => {
  const b = _brands.find(x => x && x.slug === slug);
  return (b && b.name) || slug;
};

// ---------------------------------------------------------------- data

/** The chip universe for the current brand+category — literally what /shop shows. */
async function loadCodes() {
  const myToken = ++_loadToken;
  const grid = _container && _container.querySelector('#pcp-grid');
  if (grid) grid.innerHTML = `<div class="admin-loader"><div class="admin-loading__spinner"></div></div>`;

  let series = [];
  let failed = false;
  try {
    const resp = await window.API.getShopData({ brand: _brandSlug, category: _category });
    series = (resp && resp.ok && resp.data && Array.isArray(resp.data.series)) ? resp.data.series : [];
  } catch (e) {
    failed = true;
  }
  if (!_alive || myToken !== _loadToken) return;

  if (failed) {
    _codes = [];
    renderGrid(`Couldn’t load codes for ${esc(brandLabel(_brandSlug))} · ${esc(categoryLabel(_category))}.`);
    return;
  }

  _codes = series
    .filter(s => s && s.code)
    .map(s => ({ code: norm(s.code), count: Number(s.count) || 0 }))
    .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true, sensitivity: 'base' }));
  renderGrid();
}

// ---------------------------------------------------------------- chip grid

function renderTile(c) {
  const mode = (_menu && _menu.code === c.code) ? _menu.mode : '';

  if (mode === 'menu') {
    return `<div class="admin-pc-code admin-pc-code--act">`
      + `<span class="admin-pc-code__label">${esc(c.code)}</span>`
      + `<button type="button" class="admin-pc-act" data-act="rename" data-code="${esc(c.code)}">Rename</button>`
      + `<button type="button" class="admin-pc-act admin-pc-act--danger" data-act="delete" data-code="${esc(c.code)}">Delete</button>`
      + `<button type="button" class="admin-pc-act admin-pc-act--x" data-act="cancel" aria-label="Cancel">✕</button>`
      + `</div>`;
  }
  if (mode === 'rename') {
    return `<div class="admin-pc-code admin-pc-code--act">`
      + `<span class="admin-pc-code__label admin-pc-code__label--from">${esc(c.code)}</span>`
      + `<span class="admin-pc-code__arrow" aria-hidden="true">→</span>`
      + `<input type="text" class="admin-pc-rename" data-rename-input value="${esc(c.code)}" maxlength="24" aria-label="New spelling for ${esc(c.code)}">`
      + `<button type="button" class="admin-pc-act admin-pc-act--go" data-act="rename-go" data-code="${esc(c.code)}">Save</button>`
      + `<button type="button" class="admin-pc-act admin-pc-act--x" data-act="cancel" aria-label="Cancel">✕</button>`
      + `</div>`;
  }
  if (mode === 'delete') {
    return `<div class="admin-pc-code admin-pc-code--act admin-pc-code--confirm">`
      + `<span class="admin-pc-code__label">Delete ${esc(c.code)} · ${esc(plural(c.count))}?</span>`
      + `<button type="button" class="admin-pc-act admin-pc-act--danger" data-act="delete-go" data-code="${esc(c.code)}">Delete</button>`
      + `<button type="button" class="admin-pc-act admin-pc-act--x" data-act="cancel" aria-label="Cancel">✕</button>`
      + `</div>`;
  }

  return `<div class="admin-pc-code">`
    + `<button type="button" class="admin-pc-code__toggle" data-act="members" data-code="${esc(c.code)}" title="Edit which products carry ${esc(c.code)}">`
    + `<span class="admin-pc-code__label">${esc(c.code)}</span>`
    + (c.count ? `<span class="admin-pc-code__count">${c.count}</span>` : '')
    + `</button>`
    + `<button type="button" class="admin-pc-code__menu" data-act="menu" data-code="${esc(c.code)}" aria-label="Rename or delete ${esc(c.code)}">${KEBAB}</button>`
    + `</div>`;
}

function renderGrid(errorMsg) {
  const grid = _container && _container.querySelector('#pcp-grid');
  if (!grid) return;

  if (errorMsg) {
    grid.innerHTML = `<div class="admin-stub">
        <div class="admin-stub__title">Couldn’t load codes</div>
        <div class="admin-stub__text">${esc(errorMsg)}</div>
        <button class="admin-btn admin-btn--primary" data-act="retry">Retry</button>
      </div>`;
    return;
  }

  const f = norm(_filter);
  const shown = f ? _codes.filter(c => c.code.includes(f)) : _codes;

  if (!shown.length) {
    grid.innerHTML = `<div class="admin-stub">
        <div class="admin-stub__text">${
          _codes.length
            ? `No code matches “${esc(_filter)}”.`
            : `No codes for ${esc(brandLabel(_brandSlug))} · ${esc(categoryLabel(_category))} yet.`
        }</div>
      </div>`;
    return;
  }

  grid.innerHTML = `<div class="admin-pc-grid">${shown.map(renderTile).join('')}</div>`;

  const input = grid.querySelector('[data-rename-input]');
  if (input) { input.focus(); input.select(); }
}

// ---------------------------------------------------------------- rename / delete

/**
 * Commit a brand-wide rename (toCode set) or delete (toCode null). Commits
 * immediately — there is no page-level Save.
 */
async function applyCodeChange(fromCode, toCode) {
  const label = toCode ? `Renaming ${fromCode} → ${toCode}` : `Deleting ${fromCode}`;
  Toast.info(`${label}…`);
  try {
    const res = await AdminAPI.applyBrandCodeChange({
      brandSlug: _brandSlug, category: _category, fromCode, toCode,
    });
    if (!_alive) return;

    if (!res.products) {
      // The walk found nobody carrying the code. Before Jul 2026 this was the
      // silent failure mode for every slash code (PG40/CL41 normalised to
      // PG40CL41 and matched nothing) — so say it loudly rather than pretend.
      Toast.warning(`No products in ${brandLabel(_brandSlug)} · ${categoryLabel(_category)} carry ${fromCode} — nothing changed.`);
    } else if (res.failed) {
      Toast.warning(`${label}: ${res.changed} of ${res.products} products updated, ${res.failed} failed.`);
    } else {
      Toast.success(toCode
        ? `Renamed ${fromCode} → ${toCode} across ${plural(res.changed)}.`
        : `Deleted ${fromCode} from ${plural(res.changed)}.`);
    }
  } catch (e) {
    if (!_alive) return;
    Toast.error(`Couldn’t ${toCode ? 'rename' : 'delete'} ${fromCode} — ${describeCodesWriteError(e)}`);
  }
  _menu = null;
  if (_alive) await loadCodes();
}

// ---------------------------------------------------------------- membership drawer

/**
 * Edit which products carry `code`. Also the "+ Add code" path, where the code
 * doesn't exist yet and nothing starts ticked.
 */
async function openMembership(code, { isNew = false } = {}) {
  const ctx = `${brandLabel(_brandSlug)} · ${categoryLabel(_category)}`;
  const drawer = Drawer.open({
    title: isNew ? `New code: ${code}` : `Products with ${code}`,
    width: 620,
    body: `<div class="admin-loader"><div class="admin-loading__spinner"></div></div>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-act="cancel">Cancel</button>
             <button class="admin-btn admin-btn--primary" data-act="save" disabled>Save</button>`,
  });
  if (!drawer) return;

  const myToken = ++_loadToken;
  let pool = [];
  try {
    pool = await AdminAPI.listBrandCategoryProducts({ brandSlug: _brandSlug, category: _category });
  } catch (e) {
    if (_alive && Drawer.isOpen()) {
      drawer.body.innerHTML = `<div class="admin-stub"><div class="admin-stub__text">Couldn’t load the products for ${esc(ctx)}.</div></div>`;
    }
    return;
  }
  if (!_alive || myToken !== _loadToken || !Drawer.isOpen()) return;

  // Baseline = who carries the code right now, per their EFFECTIVE codes.
  const baseline = new Set(pool.filter(p => p.codes.includes(code)).map(p => p.id));
  const ticked = new Set(baseline);
  let search = '';

  const saveBtn = drawer.footer.querySelector('[data-act="save"]');

  const diff = () => {
    const add = [...ticked].filter(id => !baseline.has(id));
    const remove = [...baseline].filter(id => !ticked.has(id));
    return { add, remove };
  };

  const syncSaveBtn = () => {
    const { add, remove } = diff();
    const n = add.length + remove.length;
    saveBtn.disabled = n === 0;
    saveBtn.textContent = n ? `Save ${n} change${n === 1 ? '' : 's'}` : 'Save';
  };

  const renderList = () => {
    const q = search.trim().toLowerCase();
    const rows = q
      ? pool.filter(p => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q))
      : pool;

    // Ticked products float to the top — the membership IS the subject here.
    const sorted = [...rows].sort((a, b) => {
      const at = ticked.has(a.id) ? 0 : 1;
      const bt = ticked.has(b.id) ? 0 : 1;
      return at !== bt ? at - bt : a.name.localeCompare(b.name);
    });

    const list = drawer.body.querySelector('#pcp-members');
    if (!list) return;
    list.innerHTML = sorted.length
      ? sorted.map(p => {
        const on = ticked.has(p.id);
        const others = p.codes.filter(c => c !== code);
        return `<label class="admin-pcm-row${on ? ' is-on' : ''}">
            <input type="checkbox" data-pid="${esc(p.id)}"${on ? ' checked' : ''}>
            ${p.image
              ? `<img class="admin-pcm-row__img" src="${esc(p.image)}" alt="" loading="lazy">`
              : `<span class="admin-pcm-row__img admin-pcm-row__img--none" aria-hidden="true"></span>`}
            <span class="admin-pcm-row__text">
              <span class="admin-pcm-row__name">${esc(p.name)}</span>
              <span class="admin-pcm-row__meta">${esc(p.sku)}${
                others.length ? ` · also ${esc(others.join(', '))}` : ''
              }</span>
            </span>
          </label>`;
      }).join('')
      : `<div class="admin-stub"><div class="admin-stub__text">No product matches “${esc(search)}”.</div></div>`;
  };

  drawer.body.innerHTML = `
    <p class="admin-pcp-note">
      Tick every product that should appear under <strong>${esc(code)}</strong> on
      /shop for ${esc(ctx)}. Ticking a product pins its whole code list, so the codes
      shown beside it stop tracking the catalogue’s automatic ones.
    </p>
    <input type="search" class="admin-input admin-pcm-search" id="pcp-member-search" placeholder="Search ${esc(String(pool.length))} products by name or SKU…" aria-label="Search products">
    <div class="admin-pcm-list" id="pcp-members"></div>`;
  renderList();
  syncSaveBtn();

  const searchEl = drawer.body.querySelector('#pcp-member-search');
  searchEl.addEventListener('input', () => { search = searchEl.value; renderList(); });

  drawer.body.querySelector('#pcp-members').addEventListener('change', (e) => {
    const box = e.target.closest('input[type="checkbox"]');
    if (!box) return;
    const id = box.getAttribute('data-pid');
    if (box.checked) ticked.add(id); else ticked.delete(id);
    box.closest('.admin-pcm-row').classList.toggle('is-on', box.checked);
    syncSaveBtn();
  });

  drawer.footer.querySelector('[data-act="cancel"]').addEventListener('click', () => Drawer.close());

  saveBtn.addEventListener('click', async () => {
    const { add, remove } = diff();
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const res = await AdminAPI.setCodeMembership({
        brandSlug: _brandSlug, category: _category, code, add, remove,
      });
      if (!_alive) return;
      if (res.failed) {
        Toast.warning(`${code}: ${plural(res.changed)} updated, ${res.failed} failed.`);
      } else {
        Toast.success(`${code} now on ${plural(ticked.size)}.`);
      }
      Drawer.close();
      await loadCodes();
    } catch (e) {
      if (!_alive) return;
      Toast.error(`Couldn’t save ${code} — ${describeCodesWriteError(e)}`);
      syncSaveBtn();
    }
  });
}

/** "+ Add code" — name it, then pick its products in the same membership drawer. */
function promptNewCode() {
  const modal = Modal.open({
    title: 'Add a product code',
    body: `<div class="admin-form-group">
        <label for="pcp-new-code">Code</label>
        <input type="text" id="pcp-new-code" class="admin-input" maxlength="24" placeholder="e.g. PG40/CL41" autocomplete="off">
        <div class="admin-form-help">Letters, numbers and “/”, 2–24 characters. Use “/” only for a merged pair code, written the way the catalogue writes it.</div>
        <div class="admin-form-error" id="pcp-new-err"></div>
      </div>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-act="cancel">Cancel</button>
             <button class="admin-btn admin-btn--primary" data-act="next">Choose products</button>`,
  });
  if (!modal) return;

  const input = modal.body.querySelector('#pcp-new-code');
  const err = modal.body.querySelector('#pcp-new-err');
  input.focus();

  const submit = () => {
    const code = AdminAPI.normalizeProductCode(input.value);
    if (!isValidProductCode(code)) {
      err.textContent = 'That code isn’t valid — 2–24 letters, numbers or “/”.';
      return;
    }
    if (_codes.some(c => c.code === code)) {
      err.textContent = `${code} already exists — pick it from the grid to edit its products.`;
      return;
    }
    Modal.close();
    openMembership(code, { isNew: true });
  };

  modal.footer.querySelector('[data-act="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-act="next"]').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
}

// ---------------------------------------------------------------- shell

function renderShell(container) {
  const brandOpts = _brands.map(b =>
    `<option value="${esc(b.slug)}"${b.slug === _brandSlug ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
  const catOpts = SHOP_CATEGORIES.map(c =>
    `<option value="${esc(c.value)}"${c.value === _category ? ' selected' : ''}>${esc(c.label)}</option>`).join('');

  container.innerHTML = `
    <div class="admin-page-header">
      <h1>Product Codes</h1>
    </div>

    <p class="admin-pcp-lede admin-text-muted">
      The chips customers pick from on /shop. Renaming or deleting one changes it for
      every product in the selected brand and category.
    </p>

    <div class="admin-toolbar admin-pcp-pickers">
      <select class="admin-select" id="pcp-brand" aria-label="Brand">${brandOpts}</select>
      <select class="admin-select" id="pcp-category" aria-label="Category">${catOpts}</select>
    </div>

    <div class="admin-pc-toolbar">
      <div class="admin-pc-filterwrap">
        <input type="text" class="admin-pc-filter" id="pcp-filter" placeholder="Filter codes…" aria-label="Filter codes">
      </div>
      <button class="admin-btn admin-btn--primary" id="pcp-add">+ Add code</button>
    </div>

    <div id="pcp-grid"></div>

    <p class="admin-pcp-caveat">
      Codes the catalogue derives automatically can come back after a product import —
      a deletion here only overrides them on the storefront. Click a code to change which
      products carry it.
    </p>`;

  container.querySelector('#pcp-brand').addEventListener('change', (e) => {
    _brandSlug = e.target.value;
    _menu = null;
    loadCodes();
  });
  container.querySelector('#pcp-category').addEventListener('change', (e) => {
    _category = e.target.value;
    _menu = null;
    loadCodes();
  });
  container.querySelector('#pcp-filter').addEventListener('input', (e) => {
    _filter = e.target.value;
    renderGrid();
  });
  container.querySelector('#pcp-add').addEventListener('click', promptNewCode);

  // One delegated handler for the whole grid — tiles are re-rendered constantly.
  container.querySelector('#pcp-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    const code = btn.getAttribute('data-code');

    if (act === 'retry') { loadCodes(); return; }
    if (act === 'members') { openMembership(code); return; }
    if (act === 'menu') { _menu = { code, mode: 'menu' }; renderGrid(); return; }
    if (act === 'cancel') { _menu = null; renderGrid(); return; }
    if (act === 'rename') { _menu = { code, mode: 'rename' }; renderGrid(); return; }
    if (act === 'delete') { _menu = { code, mode: 'delete' }; renderGrid(); return; }
    if (act === 'delete-go') { applyCodeChange(code, null); return; }
    if (act === 'rename-go') {
      const input = e.target.closest('.admin-pc-code').querySelector('[data-rename-input]');
      commitRename(code, input && input.value);
    }
  });

  container.querySelector('#pcp-grid').addEventListener('keydown', (e) => {
    if (!e.target.matches('[data-rename-input]')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const tile = e.target.closest('.admin-pc-code');
      const go = tile && tile.querySelector('[data-act="rename-go"]');
      commitRename(go && go.getAttribute('data-code'), e.target.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      _menu = null;
      renderGrid();
    }
  });
}

function commitRename(fromCode, rawTo) {
  const to = AdminAPI.normalizeProductCode(rawTo);
  if (!fromCode) return;
  if (!isValidProductCode(to)) {
    Toast.error('The new code must be 2–24 letters, numbers or “/”.');
    return;
  }
  if (to === fromCode) { _menu = null; renderGrid(); return; }
  applyCodeChange(fromCode, to);
}

export default {
  title: 'Product Codes',

  async init(container) {
    _container = container;
    _alive = true;
    _filter = '';
    _menu = null;
    FilterState.showBar(false);   // the page ships its own brand/category pickers

    container.innerHTML = `<div class="admin-loader"><div class="admin-loading__spinner"></div></div>`;

    const brands = await AdminAPI.getBrands();
    if (!_alive) return;

    _brands = (Array.isArray(brands) ? brands : [])
      .filter(b => b && b.slug && b.name)
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!_brands.length) {
      container.innerHTML = `<div class="admin-stub">
          <div class="admin-stub__title">Couldn’t load brands</div>
          <div class="admin-stub__text">The brand list is needed to resolve a code’s products. Reload to try again.</div>
        </div>`;
      return;
    }

    // Canon/ink is where the merged pair codes live, so it's the useful default.
    if (!_brandSlug || !_brands.some(b => b.slug === _brandSlug)) {
      _brandSlug = _brands.some(b => b.slug === 'canon') ? 'canon' : _brands[0].slug;
    }

    renderShell(container);
    await loadCodes();
  },

  destroy() {
    _alive = false;
    _loadToken++;
    if (Drawer.isOpen()) Drawer.close();
    _container = null;
    _codes = [];
    _menu = null;
    _filter = '';
  },
};
