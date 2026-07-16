/**
 * Product Codes — the /shop drilldown chips, edited by CODE rather than by product.
 *
 * The storefront categorises products brand > type > CODE. On
 * /shop?brand=canon&category=ink that's the "Select a Product Code" grid: CI3,
 * PG40/CL41, PGI5/CLI8 … This page is that grid, editable. It exists because the
 * only other way in was the per-product drawer's Product Codes tab, which is
 * product-centric when the question ("this chip is wrong") is code-centric.
 *
 * SHOWS EVERY CODE. The page lists the whole catalogue — ~1,214 codes across every
 * brand and category (AdminAPI.getCodeUniverse) — and the search box narrows it.
 * The brand and category <select>s are FILTERS on that list, not a scope you must
 * pick first, and they always open on "All": a code you can't find is worse than a
 * long list, and a filter that persisted from last visit made codes look missing.
 *
 * SCOPE STILL EXISTS, per code. A code only means something inside a brand+category
 * (every write resolves its products through getShopData({brand, category, code})),
 * and 41 codes span more than one — HP's "410" ink and Brother's "410" toner are the
 * same three characters, not the same chip. So each entry carries its `scopes`, the
 * tiles show them, and a rename or delete runs over ALL of them. Nothing here may
 * assume the code's scope is whatever the pickers happen to say.
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
  describeScopes,
  categoryLabel as catLabel,
  paginate,
  pagerHtml,
} from '../utils/product-codes.js';

let _container = null;
let _alive = false;
let _loadToken = 0;      // ERR-045: a reply from a superseded load must not render

let _brands = [];
let _brandSlug = '';     // '' = all brands. Reset on every open — see init/destroy.
let _category = '';      // '' = all categories
let _universe = [];      // [{ code, count, scopes: [{brandSlug, category}] }] — everything
let _missed = [];        // scopes that wouldn't load — the page must SAY so, not imply completeness
let _filter = '';
let _menu = null;        // { code, mode: 'menu' | 'rename' | 'delete' }
let _page = 0;           // 0-based page into the visible codes; reset when the view changes

const PER_PAGE = 60;     // ~1,200 codes is too many tiles to paint at once — page through them

const KEBAB = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`;

const norm = s => AdminAPI.normalizeProductCode(s);
const plural = n => `${n} product${n === 1 ? '' : 's'}`;
const brandLabel = slug => {
  const b = _brands.find(x => x && x.slug === slug);
  return (b && b.name) || slug;
};
/** "Canon · Ink", or every scope when a code spans several. */
const scopesOf = c => describeScopes(c.scopes, brandLabel);

/** What the brand/category pickers currently narrow to — for empty-state copy. */
function viewLabel() {
  if (!_brandSlug && !_category) return 'the catalogue';
  return `${_brandSlug ? brandLabel(_brandSlug) : 'all brands'} · ${_category ? catLabel(_category) : 'all types'}`;
}

/** The codes the pickers admit: a code shows if ANY of its scopes matches. */
function visibleCodes() {
  const f = norm(_filter);
  return _universe.filter(c => {
    if (f && !c.code.includes(f)) return false;
    if (!_brandSlug && !_category) return true;
    return (c.scopes || []).some(s =>
      (!_brandSlug || s.brandSlug === _brandSlug) && (!_category || s.category === _category));
  });
}

// ---------------------------------------------------------------- data

/** Every code that exists, from the shared universe. */
async function loadCodes({ force = false } = {}) {
  const myToken = ++_loadToken;
  const grid = _container && _container.querySelector('#pcp-grid');
  // The catalogue is a fan-out across every brand+type, and a cold CF cache makes
  // that slow (see AdminAPI.getCodeUniverse). Say so, rather than show a bare
  // spinner that reads as a hang.
  if (grid) {
    grid.innerHTML = `<div class="admin-loader">
        <div class="admin-loading__spinner"></div>
        <div class="admin-pcp-note">Reading every code on /shop — the first load of the day can take a moment.</div>
      </div>`;
  }

  let universe = null;
  try {
    universe = await AdminAPI.getCodeUniverse({ force });
  } catch (e) {
    universe = null;
  }
  if (!_alive || myToken !== _loadToken) return;

  if (!universe) {
    _universe = [];
    _missed = [];
    renderGrid('The code catalogue is built from the live /shop chips, and it didn’t load.');
    return;
  }

  _universe = universe.codes;
  _missed = universe.missed || [];
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
    // Say which scopes it will reach — a code can live under several brands.
    return `<div class="admin-pc-code admin-pc-code--act admin-pc-code--confirm">`
      + `<span class="admin-pc-code__label">Delete ${esc(c.code)} from ${esc(scopesOf(c))} · ${esc(plural(c.count))}?</span>`
      + `<button type="button" class="admin-pc-act admin-pc-act--danger" data-act="delete-go" data-code="${esc(c.code)}">Delete</button>`
      + `<button type="button" class="admin-pc-act admin-pc-act--x" data-act="cancel" aria-label="Cancel">✕</button>`
      + `</div>`;
  }

  return `<div class="admin-pc-code">`
    + `<button type="button" class="admin-pc-code__toggle" data-act="members" data-code="${esc(c.code)}" title="Edit which products carry ${esc(c.code)} in ${esc(scopesOf(c))}">`
    + `<span class="admin-pc-code__label">${esc(c.code)}</span>`
    + `<span class="admin-pc-code__scope">${esc(scopesOf(c))}</span>`
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

  const shown = visibleCodes();

  if (!shown.length) {
    grid.innerHTML = `<div class="admin-stub">
        <div class="admin-stub__text">${
          _universe.length
            ? (_filter
                ? `No code matches “${esc(_filter)}” in ${esc(viewLabel())}.`
                : `No codes in ${esc(viewLabel())} yet.`)
            : 'No codes yet.'
        }</div>
      </div>`;
    return;
  }

  // A catalogue that is missing a brand must never look like a complete one —
  // that is precisely how Canon went missing while the grid looked healthy.
  const warning = _missed.length
    ? `<div class="admin-pcp-incomplete">
         <strong>This list is incomplete.</strong> ${esc(describeScopes(_missed, brandLabel))}
         ${_missed.length === 1 ? 'did not load' : 'did not load'}, so their codes are missing here.
         <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" data-act="retry">Retry</button>
       </div>`
    : '';

  // One page of tiles; the tally still reports the full filtered total below.
  const pg = paginate(shown, _page, PER_PAGE);
  _page = pg.page;   // clamp — a filter/picker change may have shrunk the list
  grid.innerHTML = warning
    + `<div class="admin-pc-grid admin-pc-grid--page">${pg.items.map(renderTile).join('')}</div>`
    + pagerHtml(pg);
  renderTally(shown.length);

  const input = grid.querySelector('[data-rename-input]');
  if (input) { input.focus(); input.select(); }
}

/** "Showing 43 of 1,214 codes" — with 1,200+ tiles, a bare grid hides its own scale. */
function renderTally(shownCount) {
  const el = _container && _container.querySelector('#pcp-tally');
  if (!el) return;
  const total = _universe.length;
  const n = v => v.toLocaleString('en-NZ');
  el.textContent = shownCount === total
    ? `${n(total)} code${total === 1 ? '' : 's'}`
    : `Showing ${n(shownCount)} of ${n(total)} codes`;
}

// ---------------------------------------------------------------- rename / delete

/**
 * Commit a rename (toCode set) or delete (toCode null) across every scope the
 * code lives in. Commits immediately — there is no page-level Save.
 *
 * The scopes come from the CODE, not from the pickers: with the pickers on All,
 * there is no implied brand+category, and even with them set a code may span
 * scopes the current view doesn't show. Editing only the visible scope would
 * leave the same chip alive elsewhere under its old name.
 */
async function applyCodeChange(entry, toCode) {
  const fromCode = entry.code;
  const scopes = entry.scopes || [];
  const where = scopesOf(entry);
  const label = toCode ? `Renaming ${fromCode} → ${toCode}` : `Deleting ${fromCode}`;
  Toast.info(`${label} in ${where}…`);
  try {
    let changed = 0, failed = 0, products = 0;
    for (const s of scopes) {
      const res = await AdminAPI.applyBrandCodeChange({
        brandSlug: s.brandSlug, category: s.category, fromCode, toCode,
      });
      changed += res.changed; failed += res.failed; products += res.products;
    }
    if (!_alive) return;

    if (!products) {
      // The walk found nobody carrying the code. Before Jul 2026 this was the
      // silent failure mode for every slash code (PG40/CL41 normalised to
      // PG40CL41 and matched nothing) — so say it loudly rather than pretend.
      Toast.warning(`No products in ${where} carry ${fromCode} — nothing changed.`);
    } else if (failed) {
      Toast.warning(`${label}: ${changed} of ${products} products updated, ${failed} failed.`);
    } else {
      Toast.success(toCode
        ? `Renamed ${fromCode} → ${toCode} across ${plural(changed)}.`
        : `Deleted ${fromCode} from ${plural(changed)}.`);
    }
  } catch (e) {
    if (!_alive) return;
    Toast.error(`Couldn’t ${toCode ? 'rename' : 'delete'} ${fromCode} — ${describeCodesWriteError(e)}`);
  }
  _menu = null;
  // The write invalidated the universe cache; force a rebuild rather than
  // re-reading the snapshot we just made stale.
  if (_alive) await loadCodes({ force: true });
}

// ---------------------------------------------------------------- membership drawer

/**
 * Edit which products carry a code, across every scope it lives in. Also the
 * "+ Add code" path, where the code doesn't exist yet and nothing starts ticked.
 *
 * The candidate pool is the union of each scope's products, and each product
 * remembers which scope it came from — setCodeMembership re-walks a single
 * brand+category, so the save has to hand each product back to its own scope.
 *
 * @param {{code:string, scopes:Array<{brandSlug,category}>}} entry
 */
async function openMembership(entry, { isNew = false } = {}) {
  const code = entry.code;
  const scopes = entry.scopes || [];
  const ctx = describeScopes(scopes, brandLabel);
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
    const perScope = await Promise.all(scopes.map(s =>
      AdminAPI.listBrandCategoryProducts({ brandSlug: s.brandSlug, category: s.category })
        .then(rows => rows.map(p => ({ ...p, scope: s })))));
    pool = perScope.flat();
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
    const multi = scopes.length > 1;
    list.innerHTML = sorted.length
      ? sorted.map(p => {
        const on = ticked.has(p.id);
        const others = p.codes.filter(c => c !== code);
        // With several scopes in one pool, the SKU alone doesn't say which.
        const scopeBit = multi
          ? ` · ${brandLabel(p.scope.brandSlug)} ${catLabel(p.scope.category)}`
          : '';
        return `<label class="admin-pcm-row${on ? ' is-on' : ''}">
            <input type="checkbox" data-pid="${esc(p.id)}"${on ? ' checked' : ''}>
            ${p.image
              ? `<img class="admin-pcm-row__img" src="${esc(p.image)}" alt="" loading="lazy">`
              : `<span class="admin-pcm-row__img admin-pcm-row__img--none" aria-hidden="true"></span>`}
            <span class="admin-pcm-row__text">
              <span class="admin-pcm-row__name">${esc(p.name)}</span>
              <span class="admin-pcm-row__meta">${esc(p.sku)}${esc(scopeBit)}${
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
      // setCodeMembership re-walks ONE brand+category to re-read effective codes
      // at write time, so each product must go back to the scope it came from.
      const scopeOf = new Map(pool.map(p => [p.id, p.scope]));
      const key = s => `${s.brandSlug}|${s.category}`;
      const batches = new Map();   // scope key → { scope, add[], remove[] }
      const bucket = (id, field) => {
        const s = scopeOf.get(id);
        if (!s) return;
        const k = key(s);
        if (!batches.has(k)) batches.set(k, { scope: s, add: [], remove: [] });
        batches.get(k)[field].push(id);
      };
      add.forEach(id => bucket(id, 'add'));
      remove.forEach(id => bucket(id, 'remove'));

      let changed = 0, failed = 0;
      for (const b of batches.values()) {
        const res = await AdminAPI.setCodeMembership({
          brandSlug: b.scope.brandSlug, category: b.scope.category,
          code, add: b.add, remove: b.remove,
        });
        changed += res.changed; failed += res.failed;
      }
      if (!_alive) return;
      if (failed) {
        Toast.warning(`${code}: ${plural(changed)} updated, ${failed} failed.`);
      } else {
        Toast.success(`${code} now on ${plural(ticked.size)}.`);
      }
      Drawer.close();
      await loadCodes({ force: true });
    } catch (e) {
      if (!_alive) return;
      Toast.error(`Couldn’t save ${code} — ${describeCodesWriteError(e)}`);
      syncSaveBtn();
    }
  });
}

/**
 * "+ Add code" — name it, pick the brand+category it belongs to, then choose its
 * products in the same membership drawer.
 *
 * The scope has to be asked for: the pickers default to All, and even when they
 * aren't, a code has to be BORN somewhere — a chip only exists inside one
 * brand+category. The pickers seed the two <select>s when they're set.
 */
function promptNewCode() {
  const brandOpts = _brands.map(b =>
    `<option value="${esc(b.slug)}"${b.slug === _brandSlug ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
  const catOpts = SHOP_CATEGORIES.map(c =>
    `<option value="${esc(c.value)}"${c.value === _category ? ' selected' : ''}>${esc(c.label)}</option>`).join('');

  const modal = Modal.open({
    title: 'Add a product code',
    body: `<div class="admin-form-group">
        <label for="pcp-new-code">Code</label>
        <input type="text" id="pcp-new-code" class="admin-input" maxlength="24" placeholder="e.g. PG40/CL41" autocomplete="off">
        <div class="admin-form-help">Letters, numbers and “/”, 2–24 characters. Use “/” only for a merged pair code, written the way the catalogue writes it.</div>
      </div>
      <div class="admin-form-group">
        <label for="pcp-new-brand">Brand and type</label>
        <div class="admin-pcp-pickers">
          <select class="admin-select" id="pcp-new-brand" aria-label="Brand">${brandOpts}</select>
          <select class="admin-select" id="pcp-new-category" aria-label="Type">${catOpts}</select>
        </div>
        <div class="admin-form-help">A code is a chip inside one brand and type — that’s where customers will drill into it.</div>
        <div class="admin-form-error" id="pcp-new-err"></div>
      </div>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-act="cancel">Cancel</button>
             <button class="admin-btn admin-btn--primary" data-act="next">Choose products</button>`,
  });
  if (!modal) return;

  const input = modal.body.querySelector('#pcp-new-code');
  const brandEl = modal.body.querySelector('#pcp-new-brand');
  const catEl = modal.body.querySelector('#pcp-new-category');
  const err = modal.body.querySelector('#pcp-new-err');
  input.focus();

  const submit = () => {
    const code = AdminAPI.normalizeProductCode(input.value);
    if (!isValidProductCode(code)) {
      err.textContent = 'That code isn’t valid — 2–24 letters, numbers or “/”.';
      return;
    }
    const scope = { brandSlug: brandEl.value, category: catEl.value };
    const existing = _universe.find(c => c.code === code);
    // Same code, same scope = the chip already exists. Same code, DIFFERENT scope
    // is legitimate — "410" is HP ink and Brother toner — so only block the former.
    if (existing && (existing.scopes || []).some(s =>
      s.brandSlug === scope.brandSlug && s.category === scope.category)) {
      err.textContent = `${code} already exists in ${brandLabel(scope.brandSlug)} · ${catLabel(scope.category)} — pick it from the grid to edit its products.`;
      return;
    }
    Modal.close();
    openMembership({ code, scopes: [scope] }, { isNew: true });
  };

  modal.footer.querySelector('[data-act="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-act="next"]').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
}

// ---------------------------------------------------------------- shell

function renderShell(container) {
  // "All" leads both lists and is the default — see the note in init().
  const brandOpts = `<option value="">All brands</option>` + _brands.map(b =>
    `<option value="${esc(b.slug)}"${b.slug === _brandSlug ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
  const catOpts = `<option value="">All types</option>` + SHOP_CATEGORIES.map(c =>
    `<option value="${esc(c.value)}"${c.value === _category ? ' selected' : ''}>${esc(c.label)}</option>`).join('');

  container.innerHTML = `
    <div class="admin-page-header">
      <h1>Product Codes</h1>
    </div>

    <p class="admin-pcp-lede admin-text-muted">
      Every chip customers pick from on /shop. Search for one, or narrow by brand and type.
      Renaming or deleting a code changes it for every product that carries it, in every
      brand and type it appears under — the tile says which.
    </p>

    <div class="admin-toolbar admin-pcp-pickers">
      <select class="admin-select" id="pcp-brand" aria-label="Brand">${brandOpts}</select>
      <select class="admin-select" id="pcp-category" aria-label="Type">${catOpts}</select>
      <span class="admin-pcp-tally admin-text-muted" id="pcp-tally"></span>
    </div>

    <div class="admin-pc-toolbar">
      <div class="admin-pc-filterwrap">
        <input type="search" class="admin-pc-filter" id="pcp-filter" placeholder="Search every code…" aria-label="Search codes">
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
    _page = 0;             // a narrowed list starts at its first page
    renderGrid();          // the universe is global — filtering is local
  });
  container.querySelector('#pcp-category').addEventListener('change', (e) => {
    _category = e.target.value;
    _menu = null;
    _page = 0;
    renderGrid();
  });
  container.querySelector('#pcp-filter').addEventListener('input', (e) => {
    _filter = e.target.value;
    _page = 0;
    renderGrid();
  });
  container.querySelector('#pcp-add').addEventListener('click', promptNewCode);

  // One delegated handler for the whole grid — tiles are re-rendered constantly.
  container.querySelector('#pcp-grid').addEventListener('click', (e) => {
    // Pager first — it changes the window, not a code.
    const pager = e.target.closest('[data-pcpage]');
    if (pager) {
      _page += pager.getAttribute('data-pcpage') === 'next' ? 1 : -1;   // renderGrid clamps
      renderGrid();
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    const code = btn.getAttribute('data-code');
    // Every write travels with the code's own scopes, so resolve the entry once.
    const entry = code ? _universe.find(c => c.code === code) : null;

    if (act === 'retry') { loadCodes({ force: true }); return; }
    if (!entry && act !== 'cancel') return;
    if (act === 'members') { openMembership(entry); return; }
    if (act === 'menu') { _menu = { code, mode: 'menu' }; renderGrid(); return; }
    if (act === 'cancel') { _menu = null; renderGrid(); return; }
    if (act === 'rename') { _menu = { code, mode: 'rename' }; renderGrid(); return; }
    if (act === 'delete') { _menu = { code, mode: 'delete' }; renderGrid(); return; }
    if (act === 'delete-go') { applyCodeChange(entry, null); return; }
    if (act === 'rename-go') {
      const input = e.target.closest('.admin-pc-code').querySelector('[data-rename-input]');
      commitRename(entry, input && input.value);
    }
  });

  container.querySelector('#pcp-grid').addEventListener('keydown', (e) => {
    if (!e.target.matches('[data-rename-input]')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const tile = e.target.closest('.admin-pc-code');
      const go = tile && tile.querySelector('[data-act="rename-go"]');
      const code = go && go.getAttribute('data-code');
      commitRename(code ? _universe.find(c => c.code === code) : null, e.target.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      _menu = null;
      renderGrid();
    }
  });
}

function commitRename(entry, rawTo) {
  if (!entry) return;
  const to = AdminAPI.normalizeProductCode(rawTo);
  if (!isValidProductCode(to)) {
    Toast.error('The new code must be 2–24 letters, numbers or “/”.');
    return;
  }
  if (to === entry.code) { _menu = null; renderGrid(); return; }
  applyCodeChange(entry, to);
}

export default {
  title: 'Product Codes',

  async init(container) {
    _container = container;
    _alive = true;
    // The page ALWAYS opens on All brands / All types. These are module-level and
    // survive navigation, so without this reset last visit's narrowing silently
    // carries over — you come back, see a slice, and read it as the whole
    // catalogue. Cleared here AND in destroy(): whichever runs, the next open is
    // unfiltered.
    _brandSlug = '';
    _category = '';
    _filter = '';
    _menu = null;
    _page = 0;
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

    renderShell(container);
    await loadCodes();
  },

  destroy() {
    _alive = false;
    _loadToken++;
    if (Drawer.isOpen()) Drawer.close();
    _container = null;
    _universe = [];
    _menu = null;
    _filter = '';
    _brandSlug = '';
    _category = '';
    _page = 0;
  },
};
