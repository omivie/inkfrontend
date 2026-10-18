/**
 * Pricing — one place to see and change every product's price (ERR-336, ERR-363).
 *
 * Three parts:
 *   1. Every product's current price (GET /api/admin/products — the backend is
 *      the source of truth; this page computes no price). "Price set by" is the
 *      backend's `price_source`; "Gross margin" is its `gross_margin_pct`.
 *   2. Bulk changes on a selection (ticked rows, or "Select all N matching" —
 *      one `ids_only` call). Every change is PREVIEWED first (dry run), and
 *      only the Apply button sends `confirm:true`:
 *        - Set exact price / Adjust by % or $ / Set margin → LOCKED prices
 *          (POST /api/admin/pricing/bulk, lock:true; up to 2,000 per change)
 *        - Unlock → bulk `clear_manual` (reprices the row at once, and also
 *          clears the older freezes a PUT null cannot)
 *        - Lock at current price → per-row PUT {manual_retail_price: its own
 *          price}, copied verbatim (the bulk call takes one value), capped 200
 *   3. Margin rules: by filter (brand / source / type / category / cost band,
 *      GET|POST|PATCH|DELETE /api/admin/pricing/rules — the preview is the
 *      gate), and the source × cost-band × brand ladder (pages/cc2-pricing.js,
 *      mounted as-is).
 *
 * Contract: backend response 2026-10-17 "Admin Pricing page" (inbox copy);
 * dry runs re-measured 2026-10-18. Packs are never repriced by any of these.
 */
import { AdminAPI, FilterState, esc, icon } from '../app.js';
import { DataTable } from '../components/table.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';
import { marginBadge } from '../utils/profitability.js';
import { GST_INCL, GST_EXCL, GST_BASE } from '../utils/gst-basis.js';
import { typeFilterOptions, productTypeLabel } from '../utils/product-types.js';
import {
  BULK_CAP, BULK_TARGET_CAP, filtersToParams, runSequential, lockPlan, bulkBody,
  ruleBody, ruleSummary, priceSourceOf, RULE_MARGIN_MIN, RULE_MARGIN_MAX,
} from '../utils/pricing-page.js';

const LIMIT = 100;
const MISSING = '—';
const SORTABLE = ['name', 'sku', 'retail_price', 'cost_price', 'margin_pct', 'source', 'product_type'];
const JOB_POLL_MS = 3000;
const JOB_POLL_MAX = 100; // 5 minutes

const money = (v) => (v == null || !Number.isFinite(Number(v)) ? MISSING : `$${Number(v).toFixed(2)}`);
const pct = (v) => (v == null || !Number.isFinite(Number(v)) ? MISSING : `${Number(v).toFixed(1)}%`);
const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString('en-NZ')} ${n === 1 ? one : many}`;

let _container = null;
let _table = null;
let _rules = null;
let _brands = [];
let _filters = null;
let _page = 1;
let _total = null;
let _pageFull = false;
let _stop = false;
let _searchTimer = null;
let _jobTimer = null;
// Every row this page has read (list pages), by id. Lock reads the current
// price from here; a selected id not in it is refused, never guessed.
let _rowsById = new Map();

function renderShell(brands) {
  _container.innerHTML = `
    <div class="admin-page-header">
      <div>
        <h1 class="admin-page-title">${icon('finance', 22, 22)} Pricing</h1>
        <div class="cc2-subtitle">Every product's price, the margin rules behind it, and bulk changes. Every change is previewed before it is saved.</div>
      </div>
    </div>

    <section class="admin-card pricing-section" aria-labelledby="pricing-grid-title">
      <h2 id="pricing-grid-title" class="pricing-h2">All product prices</h2>
      <div class="pricing-filters">
        <input class="admin-input" type="search" data-f="search" placeholder="Search name or SKU" aria-label="Search">
        <select class="admin-select" data-f="brand" aria-label="Brand"><option value="">All brands</option>
          ${brands.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select>
        <select class="admin-select" data-f="source" aria-label="Genuine or compatible">
          <option value="">Genuine + compatible</option><option value="genuine">Genuine</option><option value="compatible">Compatible</option></select>
        <select class="admin-select" data-f="type" aria-label="Product type">${typeFilterOptions('')}</select>
        <select class="admin-select" data-f="active" aria-label="Active">
          <option value="true">Active only</option><option value="">Active + inactive</option><option value="false">Inactive only</option></select>
        <select class="admin-select" data-f="manual" aria-label="Price set by">
          <option value="">Locked + rule</option><option value="true">Locked (manual) only</option><option value="false">Rule only</option></select>
        <span class="pricing-ranges">
          <input class="admin-input pricing-range" type="number" min="0" step="0.01" data-f="cost_min" placeholder="Cost from" aria-label="Cost from (${esc(GST_EXCL)})" title="${esc(GST_EXCL)}">
          <input class="admin-input pricing-range" type="number" min="0" step="0.01" data-f="cost_max" placeholder="Cost to" aria-label="Cost to (${esc(GST_EXCL)})" title="${esc(GST_EXCL)}">
          <input class="admin-input pricing-range" type="number" min="0" step="0.01" data-f="price_min" placeholder="Price from" aria-label="Price from (${esc(GST_INCL)})" title="${esc(GST_INCL)}">
          <input class="admin-input pricing-range" type="number" min="0" step="0.01" data-f="price_max" placeholder="Price to" aria-label="Price to (${esc(GST_INCL)})" title="${esc(GST_INCL)}">
        </span>
      </div>
      <div class="pricing-selection" id="pricing-selection"></div>
      <div id="pricing-table"></div>
    </section>

    <section class="admin-card pricing-section" aria-labelledby="pricing-filter-rules-title">
      <h2 id="pricing-filter-rules-title" class="pricing-h2">Margin rules by filter</h2>
      <p class="cc2-tiers__muted pricing-lede">A rule sets one gross margin (on the price ex GST) for every product
        that matches its filter and has no manual price. The most specific matching rule wins; products no rule
        matches follow the ladder below. Prices still get an ending and the floors. Nothing is saved until you
        confirm the preview.</p>
      <div id="pricing-filter-rules"></div>
    </section>

    <section class="admin-card pricing-section" aria-labelledby="pricing-rules-title">
      <h2 id="pricing-rules-title" class="pricing-h2">Margin ladder</h2>
      <p class="cc2-tiers__muted pricing-lede">The ladder prices every product with no manual price and no matching
        filter rule: per genuine/compatible × supplier-cost band, optionally per brand. Type a margin % or a
        multiplier — margin here is gross on the price ex GST, before price endings and floors; the preview shows
        the real shelf price. The ladder never lowers a price.</p>
      <div id="pricing-rules"></div>
    </section>`;
}

function columns() {
  return [
    { key: 'sku', label: 'SKU', sortable: true, render: (r) => `<span class="cell-mono">${esc(r.sku || MISSING)}</span>` },
    { key: 'name', label: 'Name', sortable: true, render: (r) => `<span class="cell-truncate" style="display:block;max-width:300px">${esc(r.name || MISSING)}</span>` },
    { key: 'brand', label: 'Brand', render: (r) => esc((r.brand && r.brand.name) || r.brand_name || (r.brands && r.brands.name) || MISSING) },
    { key: 'source', label: 'Source', sortable: true, render: (r) => esc(r.source || MISSING) },
    { key: 'product_type', label: 'Type', sortable: true, render: (r) => esc(r.product_type ? productTypeLabel(r.product_type) : MISSING) },
    { key: 'cost_price', label: 'Cost', sortable: true, gst: GST_EXCL, align: 'right', render: (r) => `<span class="cell-mono">${esc(money(r.cost_price))}</span>` },
    { key: 'retail_price', label: 'Price', sortable: true, gst: GST_INCL, align: 'right', render: (r) => `<span class="cell-mono"><strong>${esc(money(r.retail_price))}</strong></span>` },
    {
      // Sorts by `margin_pct`, which ranks rows exactly as gross margin does
      // (the two always differ by the same 2.65-point card fee).
      key: 'margin_pct', label: 'Gross margin', sortable: true, gst: GST_BASE, align: 'right',
      title: '(price ex GST − cost) ÷ price ex GST, before card fees — the margin the rules use (backend gross_margin_pct).',
      render: (r) => (r.gross_margin_pct == null ? MISSING : `<span class="cell-mono">${esc(pct(r.gross_margin_pct))}</span>`),
    },
    {
      key: 'net_margin_incl_fixed_pct', label: 'Net margin', align: 'right',
      title: 'After card fees and the $0.30 per-order fee (backend figure).',
      render: (r) => marginBadge(r.net_margin_incl_fixed_pct),
    },
    { key: 'price_source', label: 'Price set by', render: (r) => priceSourceCell(r) },
  ];
}

// The chip names where the price comes from; a click locks or unlocks that row.
function priceSourceCell(r) {
  const src = priceSourceOf(r);
  if (src.kind === 'manual') {
    return `<button type="button" class="pricing-chip pricing-chip--lock pricing-chip--btn" data-act="unlock-one" data-id="${esc(r.id)}" title="Click to unlock: the rules price this product again">${esc(src.label)}</button>`;
  }
  if (src.lockable) {
    return `<button type="button" class="pricing-chip pricing-chip--btn" data-act="lock-one" data-id="${esc(r.id)}" title="Click to lock at the current price">${esc(src.label)}</button>`;
  }
  return `<span class="pricing-chip" title="${src.kind === 'pack' ? 'Pack prices follow their singles; bulk changes and rules never move them' : 'The server did not say where this price comes from'}">${esc(src.label)}</span>`;
}

async function load() {
  _table.setLoading(true);
  try {
    const data = await AdminAPI.listProductsStrict(filtersToParams(_filters), _page, LIMIT);
    if (!_table) return;
    const rows = Array.isArray(data) ? data : (data && (data.products || data.data)) || [];
    rows.forEach((r) => r && r.id && _rowsById.set(String(r.id), r));
    // An unknown total is unknown — never rows.length (ERR-220).
    const p = (data && data.pagination) || {};
    const t = p.total ?? (data && data.total);
    _total = t != null && Number.isFinite(Number(t)) ? Number(t) : null;
    _table.setData(rows, _total != null
      ? { page: _page, limit: LIMIT, total: _total }
      : { page: _page, limit: LIMIT, totalUnknown: true, hasMore: rows.length >= LIMIT });
    _pageFull = rows.length >= LIMIT;
  } catch (e) {
    if (!_table) return;
    _total = null;
    _pageFull = false;
    _table.setData([], null);
    _container.querySelector('#pricing-table').insertAdjacentHTML('afterbegin',
      `<div class="cc2-tiers__banner cc2-tiers__banner--danger" role="alert"><div>Could not load prices: ${esc(e.message)}. Nothing on this page is current.</div></div>`);
  }
  renderSelection();
}

function selectedIds() { return _table ? [..._table.getSelected()] : []; }

function renderSelection() {
  const el = _container && _container.querySelector('#pricing-selection');
  if (!el) return;
  const n = selectedIds().length;
  const more = _total != null ? n < _total : _pageFull || _page > 1;
  const all = n > 0 && more
    ? ` · <button class="admin-btn admin-btn--sm admin-btn--ghost" data-act="select-all">Select all${_total != null ? ` ${esc(_total.toLocaleString('en-NZ'))}` : ''} matching</button>` : '';
  const dis = n ? '' : 'disabled';
  el.innerHTML = `
    <span class="pricing-selection__count">${n ? `<strong>${esc(n.toLocaleString('en-NZ'))}</strong> selected` : 'Tick products to change their price'}${all}
      ${n ? '<button class="admin-btn admin-btn--sm admin-btn--ghost" data-act="clear-sel">Clear</button>' : ''}</span>
    <span class="pricing-selection__actions">
      <button class="admin-btn admin-btn--sm admin-btn--primary" data-act="set-exact" ${dis}>Set exact price</button>
      <button class="admin-btn admin-btn--sm" data-act="adjust" ${dis}>Adjust by % / $</button>
      <button class="admin-btn admin-btn--sm" data-act="set-margin" ${dis}>Set margin</button>
      <button class="admin-btn admin-btn--sm" data-act="lock" ${dis}>Lock at current price</button>
      <button class="admin-btn admin-btn--sm" data-act="clear-manual" ${dis}>Unlock</button>
    </span>`;
}

// "Select all N matching": ONE ids_only call for the same filter. A refusal is
// loud — a half-built selection must not look complete.
async function selectAllMatching(btn) {
  btn.disabled = true;
  btn.textContent = 'Selecting…';
  let res;
  try {
    res = await AdminAPI.listProductIds(filtersToParams(_filters));
  } catch (e) {
    Toast.error(`Select all failed: ${e.message}. Nothing was added to the selection.`);
    renderSelection();
    return;
  }
  if (!_table) return;
  if (res.total != null && res.ids.length < res.total) {
    Toast.error(`The server matched ${res.total} products but sent ${res.ids.length} ids. Nothing was added — narrow the filter.`);
    renderSelection();
    return;
  }
  res.ids.forEach((id) => _table.selected.add(id));
  _table.setData(_table.data, _table.pagination);
  _total = res.ids.length;
  Toast.info(`Selected all ${res.ids.length.toLocaleString('en-NZ')} matching products.`);
  renderSelection();
}

function lockedCount(ids) {
  const known = ids.filter((id) => _rowsById.has(String(id)));
  const locked = known.filter((id) => _rowsById.get(String(id)).has_manual_price === true).length;
  return known.length === ids.length ? `${locked}` : `at least ${locked}`;
}

// ── Bulk change: inputs → PREVIEW (dry run) → Apply (confirm:true) ─────────
const BULK_KINDS = {
  'set-exact': {
    title: (n) => `Set an exact price on ${plural(n, 'product')}`,
    fields: () => `<div class="admin-form-group"><label for="pricing-v">Price (${esc(GST_INCL)})</label>
        <input id="pricing-v" class="admin-input" type="number" step="0.01" min="0.01" placeholder="e.g. 29.99" autocomplete="off"></div>`,
    facts: ['Every product gets this exact price, as typed: no ending and no margin floor.',
      'A price below cost after the card fee is refused for that product.'],
    read: (b) => ({ action: 'set', value: b.querySelector('#pricing-v').value }),
  },
  adjust: {
    title: (n) => `Adjust the price of ${plural(n, 'product')}`,
    fields: () => `<div class="admin-form-group"><label for="pricing-v">Change</label>
        <span class="pricing-inline"><input id="pricing-v" class="admin-input" type="number" step="0.01" placeholder="e.g. 5 or -2.50" autocomplete="off">
        <select id="pricing-unit" class="admin-select" aria-label="Unit"><option value="adjust_pct">%</option><option value="adjust_abs">$ (${esc(GST_INCL)})</option></select></span></div>
      <label class="pricing-check"><input type="checkbox" id="pricing-dec"> Allow prices to go down</label>`,
    facts: ['Applied to each current shelf price, then rounded UP to .49 / .79 / .99 (ribbons .95 / .99), then floored.'],
    read: (b) => ({ action: b.querySelector('#pricing-unit').value, value: b.querySelector('#pricing-v').value, allowDecrease: b.querySelector('#pricing-dec').checked }),
  },
  'set-margin': {
    title: (n) => `Set a margin on ${plural(n, 'product')}`,
    fields: () => `<div class="admin-form-group"><label for="pricing-v">Gross margin % (on the price ex GST)</label>
        <input id="pricing-v" class="admin-input" type="number" step="0.1" min="0" max="99.9" placeholder="e.g. 38" autocomplete="off"></div>
      <label class="pricing-check"><input type="checkbox" id="pricing-dec"> Allow prices to go down</label>`,
    facts: ['Price = cost ÷ (1 − margin) × 1.15, rounded up to an ending, then floored. A product with no cost fails (NO_COST).',
      'To keep a margin WITHOUT locking — so it holds after every import — save it as a rule under "Margin rules by filter".'],
    read: (b) => ({ action: 'set_margin', value: b.querySelector('#pricing-v').value, allowDecrease: b.querySelector('#pricing-dec').checked }),
  },
  'clear-manual': {
    title: (n) => `Unlock ${plural(n, 'product')}`,
    fields: () => '',
    facts: ['The manual price (and any older freeze) comes off, and each product is repriced NOW by its rule or the ladder — that can lower it.',
      'Packs and ribbons keep their shelf price.'],
    read: () => ({ action: 'clear_manual' }),
  },
};

function openBulk(kind, ids = selectedIds()) {
  const k = BULK_KINDS[kind];
  if (!ids.length) return;
  if (ids.length > BULK_TARGET_CAP) {
    Toast.warning(`${ids.length} selected — one change covers at most ${BULK_TARGET_CAP.toLocaleString('en-NZ')}. Narrow the filter, or save the margin as a rule.`);
    return;
  }
  const lockedNote = kind === 'clear-manual' ? '' : `<li class="cc2-tiers__warntext">The result is LOCKED: rules and the ladder will not move these prices until you unlock them. Existing manual prices are replaced (${esc(lockedCount(ids))} locked now).</li>`;
  const m = Modal.open({
    title: k.title(ids.length),
    body: `${k.fields()}
      <ul class="cc2-tiers__facts">${k.facts.map((f) => `<li>${esc(f)}</li>`).join('')}${lockedNote}<li>Packs are never repriced.</li></ul>
      <div id="pricing-preview" aria-live="polite"></div>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn" data-action="preview">Preview</button>
      <button class="admin-btn admin-btn--primary" data-action="apply" disabled>Apply</button>`,
  });
  if (!m) return;
  let previewed = null; // the exact body the preview ran on — Apply sends THAT
  const out = m.body.querySelector('#pricing-preview');
  const apply = m.footer.querySelector('[data-action="apply"]');
  m.body.addEventListener('input', () => { previewed = null; apply.disabled = true; out.innerHTML = ''; });
  m.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => m.close());
  m.footer.querySelector('[data-action="preview"]').addEventListener('click', async (e) => {
    const built = bulkBody({ ...k.read(m.body), lock: kind !== 'clear-manual', ids });
    if (built.error) { Toast.warning(built.error); return; }
    e.target.disabled = true;
    out.innerHTML = '<p class="cc2-tiers__muted">Previewing… (nothing is saved)</p>';
    try {
      const res = await AdminAPI.controlCenter.pricingBulk(built.body, true);
      previewed = built.body;
      out.innerHTML = bulkOutcomeHtml(res, true);
      const n = Number(res && res.affected) || 0;
      apply.disabled = n === 0;
      apply.textContent = n ? `Apply to ${plural(n, 'product')}` : 'Nothing would change';
    } catch (err) {
      out.innerHTML = `<p class="cc2-tiers__warntext" role="alert">Preview refused: ${esc(err.message)}</p>`;
    } finally { e.target.disabled = false; }
  });
  apply.addEventListener('click', async () => {
    if (!previewed) return;
    apply.disabled = true;
    apply.textContent = 'Saving…';
    let res;
    try {
      res = await AdminAPI.controlCenter.pricingBulk(previewed, false);
    } catch (err) {
      out.innerHTML = `<p class="cc2-tiers__warntext" role="alert">Not saved: ${esc(err.message)}. No price changed by this call.</p>`;
      apply.textContent = 'Apply';
      apply.disabled = false;
      return;
    }
    m.close();
    showBulkResult(res, k.title(ids.length));
    if (_table) { _table.clearSelection(); load(); }
  });
}

// Preview and write share one renderer: every count, the failures, the packs.
function bulkOutcomeHtml(res, dry, headHtml = null) {
  const r = res || {};
  const n = (v) => Number(v) || 0;
  const head = headHtml != null ? headHtml : dry
    ? `<strong>${plural(n(r.affected), 'price')}</strong> would change, ${n(r.unchanged)} would stay the same.`
    : `<strong>${plural(n(r.updated), 'price')}</strong> changed, ${n(r.unchanged)} unchanged${(r.failed || []).length ? `, <strong>${r.failed.length} failed</strong>` : ''}.`;
  const blocked = [
    n(r.blocked_by_floor) ? `${n(r.blocked_by_floor)} held at a price floor (or refused below cost)` : '',
    n(r.blocked_by_no_decrease) ? `${n(r.blocked_by_no_decrease)} kept their higher price (no-decrease)` : '',
  ].filter(Boolean);
  const sample = Array.isArray(r.sample) ? r.sample : [];
  const failed = Array.isArray(r.failed) ? r.failed : [];
  const packs = r.packs && (r.packs.excluded || r.packs.action_required)
    ? `<p class="cc2-tiers__muted">${r.packs.excluded ? `${plural(n(r.packs.excluded), 'pack')} left out: ` : ''}packs follow their singles and re-anchor overnight.</p>` : '';
  return `<p>${head}</p>
    ${blocked.length ? `<p class="cc2-tiers__warntext">${esc(blocked.join(' · '))}.</p>` : ''}
    ${sample.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>SKU</th><th>Now</th><th>${dry ? 'Would be' : 'New'}</th><th>Gross margin</th></tr></thead><tbody>
      ${sample.slice(0, 25).map((s) => `<tr><td class="cell-mono">${esc(s.sku || s.id)}</td><td class="cell-mono">${esc(money(s.old_retail))}</td><td class="cell-mono"><strong>${esc(money(s.new_retail))}</strong></td><td class="cell-mono">${esc(pct(s.margin_before))} → ${esc(pct(s.margin_after))}</td></tr>`).join('')}
      </tbody></table></div>${sample.length > 25 ? `<p class="cc2-tiers__muted">First 25 of ${sample.length} sample rows.</p>` : ''}` : ''}
    ${failed.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Product</th><th>Why it ${dry ? 'would fail' : 'failed'}</th></tr></thead><tbody>
      ${failed.map((f) => `<tr><td class="cell-mono">${esc(f.sku || f.id)}</td><td>${esc(f.code ? `${f.code}: ` : '')}${esc(f.message || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${packs}`;
}

// The result stays on screen (not a toast).
function showBulkResult(res, title) {
  const m = Modal.open({
    title: `${title}: saved`,
    body: bulkOutcomeHtml(res, false),
    footer: '<button class="admin-btn admin-btn--primary" data-action="close">Close</button>',
  });
  m?.footer.querySelector('[data-action="close"]').addEventListener('click', () => m.close());
}

// ── Lock at current price: per-row PUT, each row its OWN price ─────────────
function openLock(ids = selectedIds()) {
  if (ids.length > BULK_CAP) { Toast.warning(`${ids.length} selected — locking at the current price runs one product at a time, capped at ${BULK_CAP}. Narrow the filter.`); return; }
  const plan = lockPlan(ids, _rowsById);
  const one = ids.length === 1 && plan.send.length === 1;
  const row = one ? _rowsById.get(String(plan.send[0].id)) : null;
  const m = Modal.open({
    title: one ? `Lock ${row.sku || 'this product'} at ${money(plan.send[0].price)}?`
      : `Lock ${plan.send.length} product${plan.send.length === 1 ? '' : 's'} at their current price?`,
    body: `<ul class="cc2-tiers__facts">
        <li>Each product keeps the price it shows now (${esc(GST_INCL)}). Rules and the ladder will not move it until you unlock it.</li>
        ${plan.already.length ? `<li>${plan.already.length} already locked — left as they are.</li>` : ''}
        ${plan.noPrice.length ? `<li class="cc2-tiers__warntext">${plan.noPrice.length} have no current price on this page and will not be locked.</li>` : ''}
      </ul>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="confirm" ${plan.send.length ? '' : 'disabled'}>Lock</button>`,
  });
  if (!m) return;
  m.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => m.close());
  m.footer.querySelector('[data-action="confirm"]').addEventListener('click', () => {
    m.close();
    const price = new Map(plan.send.map((x) => [String(x.id), x.price]));
    runBulk(plan.send.map((x) => x.id), (id) => AdminAPI.updateProduct(id, { manual_retail_price: price.get(String(id)) }), { label: 'Lock at current price' });
  });
}

async function runBulk(ids, put, { expect = null, label }) {
  _stop = false;
  const m = Modal.open({
    title: `${label} — running`,
    body: '<p id="pricing-progress" aria-live="polite">Starting…</p>',
    footer: '<button class="admin-btn admin-btn--ghost" data-action="stop">Stop</button>',
  });
  m?.footer.querySelector('[data-action="stop"]').addEventListener('click', (e) => { _stop = true; e.target.disabled = true; e.target.textContent = 'Stopping…'; });
  const res = await runSequential(ids, put, {
    expect,
    shouldStop: () => _stop,
    onProgress: (done, total) => { const p = m && m.body.querySelector('#pricing-progress'); if (p) p.textContent = `${done} / ${total}`; },
  });
  m?.close();
  showResult(res, label, put, expect);
  if (_table) { _table.clearSelection(); load(); }
}

// Every failure with its message, the rows never tried, and the rows whose
// shelf price did not come back as asked.
function showResult(res, label, put, expect) {
  const unapplied = res.ok.filter((r) => r.unapplied);
  const row = (id) => {
    const r = (_table && _table.data.find((x) => String(x.id) === id)) || {};
    return esc(r.sku || id);
  };
  const m = Modal.open({
    title: `${label}: ${res.ok.length} done, ${res.failed.length} failed${res.notAttempted.length ? `, ${res.notAttempted.length} not attempted` : ''}`,
    body: `${res.refused ? `<p class="cc2-tiers__warntext">${esc(res.reason)}</p>` : ''}
      ${unapplied.length ? `<p class="cc2-tiers__warntext">${unapplied.length} saved, but the price the server returned is not ${esc(money(expect))}: ${unapplied.map((r) => row(r.id)).join(', ')}</p>` : ''}
      ${res.failed.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Product</th><th>Why it failed</th></tr></thead><tbody>
        ${res.failed.map((f) => `<tr><td class="cell-mono">${row(f.id)}</td><td>${esc(f.message)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${res.notAttempted.length && !res.refused ? `<p>Stopped: ${res.notAttempted.length} products were not attempted.</p>` : ''}`,
    footer: `${res.failed.length ? '<button class="admin-btn" data-action="retry">Retry failed</button>' : ''}
      <button class="admin-btn admin-btn--primary" data-action="close">Close</button>`,
  });
  if (!m) return;
  m.footer.querySelector('[data-action="close"]').addEventListener('click', () => m.close());
  m.footer.querySelector('[data-action="retry"]')?.addEventListener('click', () => { m.close(); runBulk(res.failed.map((f) => f.id), put, { expect, label }); });
}

// ── Margin rules by filter ─────────────────────────────────────────────────
async function loadFilterRules() {
  const host = _container && _container.querySelector('#pricing-filter-rules');
  if (!host) return;
  host.innerHTML = '<p class="cc2-tiers__muted">Loading rules…</p>';
  let rules;
  try {
    rules = await AdminAPI.controlCenter.listPricingRules();
  } catch (e) {
    if (!_container) return;
    host.innerHTML = `<div class="cc2-tiers__banner cc2-tiers__banner--danger" role="alert"><div>Could not load the margin rules: ${esc(e.message)}. The rules shown elsewhere may be out of date.</div></div>
      <button class="admin-btn admin-btn--sm" data-rule-act="reload">Try again</button>`;
    return;
  }
  if (!_container) return;
  host.innerHTML = `
    ${rules.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr>
        <th>Applies to</th><th>Gross margin</th><th>Can lower prices</th><th>Priority</th><th>Status</th><th>Notes</th><th></th></tr></thead><tbody>
      ${rules.map((r) => `<tr>
        <td>${esc(ruleSummary(r, productTypeLabel))}</td>
        <td class="cell-mono">${esc(pct(r.margin_pct))}</td>
        <td>${r.allow_decrease ? 'Yes' : 'No'}</td>
        <td class="cell-mono">${esc(r.priority ?? 0)}</td>
        <td>${r.is_active === false ? '<span class="pricing-chip">Off</span>' : '<span class="pricing-chip pricing-chip--lock">On</span>'}</td>
        <td>${esc(r.notes || '')}</td>
        <td><button class="admin-btn admin-btn--sm" data-rule-act="toggle" data-id="${esc(r.id)}" data-on="${r.is_active === false ? '0' : '1'}">${r.is_active === false ? 'Turn on' : 'Turn off'}</button>
          <button class="admin-btn admin-btn--sm admin-btn--ghost" data-rule-act="delete" data-id="${esc(r.id)}">Delete</button></td>
      </tr>`).join('')}</tbody></table></div>`
      : '<p class="cc2-tiers__muted">No filter rules yet — every unlocked product follows the ladder.</p>'}
    <button class="admin-btn admin-btn--sm admin-btn--primary" data-rule-act="new">New rule</button>
    <p id="pricing-job" class="cc2-tiers__muted" aria-live="polite"></p>`;
  host._rules = rules;
}

function openNewRule() {
  const m = Modal.open({
    title: 'New margin rule',
    body: `<div class="pricing-rule-form">
        <div class="admin-form-group"><label for="rule-brand">Brand</label>
          <select id="rule-brand" class="admin-select"><option value="">Any brand</option>
          ${_brands.map((b) => `<option value="${esc(b.slug || b.id)}">${esc(b.name)}</option>`).join('')}</select></div>
        <div class="admin-form-group"><label for="rule-source">Genuine or compatible</label>
          <select id="rule-source" class="admin-select"><option value="">Both</option><option value="genuine">Genuine</option><option value="compatible">Compatible</option></select></div>
        <div class="admin-form-group"><label for="rule-type">Product type</label>
          <select id="rule-type" class="admin-select">${typeFilterOptions('')}</select></div>
        <div class="admin-form-group"><label for="rule-cat">Category code (optional)</label>
          <input id="rule-cat" class="admin-input" placeholder="e.g. CON-INK" autocomplete="off"></div>
        <div class="admin-form-group"><label>Supplier cost band (${esc(GST_EXCL)}, optional)</label>
          <span class="pricing-inline"><input id="rule-cmin" class="admin-input" type="number" min="0" step="0.01" placeholder="from">
          <input id="rule-cmax" class="admin-input" type="number" min="0" step="0.01" placeholder="to"></span></div>
        <div class="admin-form-group"><label for="rule-m">Gross margin % (${RULE_MARGIN_MIN}–${RULE_MARGIN_MAX})</label>
          <input id="rule-m" class="admin-input" type="number" step="0.1" min="${RULE_MARGIN_MIN}" max="${RULE_MARGIN_MAX}" placeholder="e.g. 38"></div>
        <label class="pricing-check"><input type="checkbox" id="rule-dec"> Allow this rule to lower prices</label>
        <div class="admin-form-group"><label for="rule-pr">Priority (tie-break, optional)</label>
          <input id="rule-pr" class="admin-input" type="number" step="1" placeholder="0"></div>
        <div class="admin-form-group"><label for="rule-notes">Notes (optional)</label>
          <input id="rule-notes" class="admin-input" maxlength="500"></div>
      </div>
      <ul class="cc2-tiers__facts"><li>Locked (manual) prices are never moved by a rule.</li><li>Saving queues a background reprice of the rule's products.</li></ul>
      <div id="pricing-preview" aria-live="polite"></div>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn" data-action="preview">Preview</button>
      <button class="admin-btn admin-btn--primary" data-action="apply" disabled>Save rule</button>`,
  });
  if (!m) return;
  const read = () => ruleBody({
    brand: m.body.querySelector('#rule-brand').value,
    source: m.body.querySelector('#rule-source').value,
    product_type: m.body.querySelector('#rule-type').value,
    category: m.body.querySelector('#rule-cat').value,
    cost_min: m.body.querySelector('#rule-cmin').value,
    cost_max: m.body.querySelector('#rule-cmax').value,
    margin_pct: m.body.querySelector('#rule-m').value,
    allow_decrease: m.body.querySelector('#rule-dec').checked,
    priority: m.body.querySelector('#rule-pr').value,
    notes: m.body.querySelector('#rule-notes').value,
  });
  wirePreviewApply(m, {
    preview: (body) => AdminAPI.controlCenter.savePricingRule(body, false),
    apply: (body) => AdminAPI.controlCenter.savePricingRule(body, true),
    read,
    applyLabel: 'Save rule',
  });
}

// Shared by New rule and Turn on/off: preview (no confirm) → confirm.
function wirePreviewApply(m, { preview, apply: save, read, applyLabel }) {
  let previewed = null;
  const out = m.body.querySelector('#pricing-preview');
  const apply = m.footer.querySelector('[data-action="apply"]');
  m.body.addEventListener('input', () => { previewed = null; apply.disabled = true; out.innerHTML = ''; });
  m.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => m.close());
  const run = async (btn) => {
    const built = read();
    if (built.error) { Toast.warning(built.error); return; }
    if (btn) btn.disabled = true;
    out.innerHTML = '<p class="cc2-tiers__muted">Previewing… (nothing is saved)</p>';
    try {
      const res = await preview(built.body);
      previewed = built.body;
      out.innerHTML = rulePreviewHtml(res);
      apply.disabled = false;
    } catch (err) {
      out.innerHTML = `<p class="cc2-tiers__warntext" role="alert">Preview refused: ${esc(err.message)}</p>`;
    } finally { if (btn) btn.disabled = false; }
  };
  m.footer.querySelector('[data-action="preview"]')?.addEventListener('click', (e) => run(e.target));
  apply.addEventListener('click', async () => {
    if (!previewed) return;
    apply.disabled = true;
    apply.textContent = 'Saving…';
    let res;
    try { res = await save(previewed); } catch (err) {
      out.innerHTML = `<p class="cc2-tiers__warntext" role="alert">Not saved: ${esc(err.message)}</p>`;
      apply.textContent = applyLabel;
      apply.disabled = false;
      return;
    }
    m.close();
    Toast.success(`Saved. ${res && res.job_id ? 'Repricing its products in the background.' : ''}`);
    await loadFilterRules();
    if (res && res.job_id) pollJob(res.job_id);
    if (_table) load();
  });
  return run;
}

function rulePreviewHtml(res) {
  const r = res || {};
  const n = (v) => Number(v) || 0;
  return bulkOutcomeHtml(r, true,
    `<strong>${plural(n(r.affected), 'price')}</strong> would change, ${n(r.unchanged)} stay the same, ${n(r.locked)} locked (never moved by a rule).`);
}

function openToggleRule(id, on) {
  const m = Modal.open({
    title: on ? 'Turn this rule off?' : 'Turn this rule on?',
    body: `<ul class="cc2-tiers__facts"><li>${on ? 'Its products go back to the next matching rule, or the ladder.' : 'Its products are priced by this rule again.'}</li></ul>
      <div id="pricing-preview" aria-live="polite"></div>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="apply" disabled>${on ? 'Turn off' : 'Turn on'}</button>`,
  });
  if (!m) return;
  const patch = { is_active: !on };
  const run = wirePreviewApply(m, {
    preview: (body) => AdminAPI.controlCenter.patchPricingRule(id, body, false),
    apply: (body) => AdminAPI.controlCenter.patchPricingRule(id, body, true),
    read: () => ({ body: patch }),
    applyLabel: on ? 'Turn off' : 'Turn on',
  });
  run(null); // preview straight away: the change has no inputs
}

function openDeleteRule(id) {
  const host = _container && _container.querySelector('#pricing-filter-rules');
  const rule = ((host && host._rules) || []).find((r) => String(r.id) === String(id));
  Modal.confirm({
    title: 'Delete this margin rule?',
    message: `${rule ? ruleSummary(rule, productTypeLabel) : 'This rule'}: its products go back to the next matching rule, or the ladder. ${rule && rule.allow_decrease ? 'This rule allowed decreases, so their prices may come down.' : 'Prices only come down where the rule allowed it.'}`,
    confirmLabel: 'Delete rule',
    onConfirm: async () => {
      try {
        const res = await AdminAPI.controlCenter.deletePricingRule(id);
        Toast.success('Rule deleted.');
        await loadFilterRules();
        if (res && res.job_id) pollJob(res.job_id);
      } catch (e) { Toast.error(e.message); }
    },
  });
}

// Reprice job progress, in words. Three states (getRepriceJob): row, missing, null.
function pollJob(jobId, tick = 0) {
  clearTimeout(_jobTimer);
  const el = _container && _container.querySelector('#pricing-job');
  if (!el) return;
  if (tick >= JOB_POLL_MAX) { el.textContent = `Reprice job ${jobId} is still running — check back later.`; return; }
  _jobTimer = setTimeout(async () => {
    const job = await AdminAPI.controlCenter.getRepriceJob(jobId);
    const now = _container && _container.querySelector('#pricing-job');
    if (!now) return;
    if (job && job.missing) { now.textContent = `Reprice job ${jobId} was not found.`; return; }
    if (!job) { now.textContent = 'Reprice: could not read progress, retrying…'; pollJob(jobId, tick + 1); return; }
    // Same job shape the ladder polls (cc2-pricing.js startPolling).
    const status = String(job.status || 'pending');
    const updated = job.counts && job.counts.updated;
    if (status === 'completed') {
      now.textContent = `Reprice complete${typeof updated === 'number' ? `: ${plural(updated, 'price')} updated` : ''}.`;
      if (_table) load();
      return;
    }
    if (status === 'failed') { now.textContent = `Reprice FAILED${job.error ? `: ${job.error}` : ''}. The rule is saved; prices may not have moved.`; now.classList.add('cc2-tiers__warntext'); return; }
    now.textContent = `Reprice ${status}…`;
    pollJob(jobId, tick + 1);
  }, JOB_POLL_MS);
}

function onRuleClick(e) {
  const b = e.target.closest('[data-rule-act]');
  if (!b) return;
  const act = b.dataset.ruleAct;
  if (act === 'new') openNewRule();
  else if (act === 'reload') loadFilterRules();
  else if (act === 'toggle') openToggleRule(b.dataset.id, b.dataset.on === '1');
  else if (act === 'delete') openDeleteRule(b.dataset.id);
}

function onFilter(e) {
  const f = e.target.dataset.f;
  if (!f) return;
  _filters[f] = e.target.value;
  _page = 1;
  if (_table) _table.clearSelection();
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(load, e.target.tagName === 'INPUT' ? 300 : 0);
}

function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'select-all') selectAllMatching(b);
  else if (act === 'clear-sel') { _table.clearSelection(); renderSelection(); }
  else if (act === 'lock') openLock();
  else if (act === 'lock-one') openLock([b.dataset.id]);
  else if (act === 'unlock-one') openBulk('clear-manual', [b.dataset.id]);
  else if (BULK_KINDS[act]) openBulk(act);
}

export default {
  title: 'Pricing',
  async init(container) {
    _container = container;
    FilterState.showBar(false); // the global date/brand bar does not drive this page
    _filters = { search: '', brand: '', source: '', type: '', active: 'true', manual: '', cost_min: '', cost_max: '', price_min: '', price_max: '', sort: '', order: 'asc' };
    _rowsById = new Map();
    _page = 1;
    _brands = (await AdminAPI.getBrands() || []).filter((b) => b && b.id && b.name).sort((a, b) => a.name.localeCompare(b.name));
    if (_container !== container) return;
    renderShell(_brands);
    _container.querySelector('.pricing-filters').addEventListener('input', onFilter);
    _container.querySelector('.pricing-filters').addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') onFilter(e); });
    _container.querySelector('#pricing-selection').addEventListener('click', onClick);
    _container.querySelector('#pricing-table').addEventListener('click', onClick);
    _container.querySelector('#pricing-filter-rules').addEventListener('click', onRuleClick);
    _table = new DataTable(_container.querySelector('#pricing-table'), {
      columns: columns(),
      rowKey: 'id',
      selectable: true,
      emptyMessage: 'No products match these filters',
      onSelectionChange: renderSelection,
      onPageChange: (p) => { _page = p; load(); },
      onSort: (key, dir) => {
        if (!SORTABLE.includes(key)) return;
        _filters.sort = key; _filters.order = dir; _page = 1; load();
      },
    });
    renderSelection();
    load();
    loadFilterRules();
    const rules = (await import('./cc2-pricing.js')).default;
    const host = _container && _container.querySelector('#pricing-rules');
    if (!host) return;
    _rules = rules;
    rules.init(host);
  },
  destroy() {
    clearTimeout(_searchTimer);
    clearTimeout(_jobTimer);
    if (_rules) { try { _rules.destroy(); } catch (e) { /* tab may have failed to init */ } }
    _rules = null;
    _table = null;
    _container = null;
    _rowsById = new Map();
  },
};
