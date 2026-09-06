/**
 * Contract pricing panel — one business account's own prices.
 *
 * Rendered inside the account drawer on the Business page. Kept in
 * `components/` rather than `pages/` on purpose: `navigate()` dynamic-imports
 * `./pages/${route}.js`, so anything in `pages/` is reachable by typing a hash,
 * and this surface has no meaning without an account to hang off.
 *
 * Contract: readfirst/business-account-contract-pricing-FE-handoff-sep2026.md
 * All the rules live in `../utils/contract-pricing.js`, which is pure; this file
 * is the DOM around them.
 *
 * ── THE THREE THINGS THIS PANEL MUST NOT DO ────────────────────────────────
 *
 *  1. Compute a price, a margin or a percent. Every figure on screen is a
 *     number the server sent. `evaluatePrice()` COMPARES a typed number against
 *     three server-supplied thresholds; comparison is not derivation.
 *
 *  2. Validate over the network. `product-search` already hands us
 *     `break_even_price` and `floor_price` with the row, which is why the price
 *     box can warn while the operator types. Writes are limited to 20/min — a
 *     validation round trip per keystroke would eat that budget for nothing.
 *
 *  3. Render a null as a zero. A margin with no supplier cost is "unknown", a
 *     first price has no "was", and a withdrawn price has no "now".
 */

import { AdminAPI, icon, esc } from '../app.js';
import { Modal } from './modal.js';
import { Toast } from './toast.js';
import { attachAutocomplete } from './autocomplete.js';
import {
  NOTES_MAX,
  parsePriceInput, evaluatePrice, formatMarginPercent, formatDiscountPercent,
  formatSignedMoney,
  describeHistoryRow, describeChange, historySnapshotNote, describeSaveError,
  isAlreadyRemoved,
  BAND_BELOW_COST, BAND_BELOW_FLOOR, BAND_ABOVE_LIST, BAND_UNKNOWN, BAND_EMPTY,
} from '../utils/contract-pricing.js';

const MISSING = '—';
const escA = (s) => Security.escapeAttr(String(s ?? ''));
const money = (n) => (typeof window.formatPrice === 'function'
  ? window.formatPrice(Number(n) || 0)
  : `$${(Number(n) || 0).toFixed(2)}`);

function formatDate(d) {
  if (!d) return MISSING;
  try {
    return new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return MISSING; }
}

// ── Panel state ─────────────────────────────────────────────────────────────
//
// Module-local, single-instance: only one account drawer is ever open. Every
// async paint checks `_token`, which is bumped on open and on destroy, so a
// slow response cannot repaint a panel the operator has left. There is no abort
// story in this codebase — API.request() builds its own AbortController and
// overwrites any signal a caller passes — so a sequence token IS the mechanism.

let _token = 0;
let _account = null;
let _host = null;
let _picker = null;
let _search = '';
let _page = 1;
let _rows = null;        // null = not read yet / could not read. [] = none. Different things.
let _pagination = null;
let _onCountChange = null;

/** Bump the token and drop every handle. Called by the page on drawer close. */
export function destroyContractPanel() {
  _token++;
  if (_picker && _picker.destroy) _picker.destroy();
  _picker = null;
  _host = null;
  _account = null;
  _rows = null;
  _pagination = null;
  _search = '';
  _page = 1;
  _onCountChange = null;
}

/**
 * Mount the panel for one account.
 *
 * @param {HTMLElement} host
 * @param {object} account            the §4.2 account object
 * @param {{onCountChange?:Function}} opts
 *        `onCountChange(n)` lets the accounts table behind the drawer update
 *        its "3 custom prices" badge without a refetch. Passing the count is
 *        deliberate — re-reading the list to learn a number we already know is
 *        how a 60/min read budget gets spent on nothing.
 */
export async function mountContractPanel(host, account, { onCountChange } = {}) {
  _token++;
  const mine = _token;
  _host = host;
  _account = account;
  _onCountChange = onCountChange || null;
  _search = '';
  _page = 1;
  _rows = null;
  _pagination = null;

  host.innerHTML = shellHtml();
  bindShell(host);
  await loadRows(mine);
}

function shellHtml() {
  return `
    <div class="cp-toolbar">
      <div class="admin-ac cp-toolbar__search">
        <input class="admin-input" id="cp-search" type="search"
               placeholder="Search this account’s pricing…" autocomplete="off">
      </div>
      <button class="admin-btn admin-btn--primary" id="cp-add" type="button">${icon('plus', 13, 13)} Add a product</button>
    </div>
    <div id="cp-rows"></div>
    <div id="cp-pager" class="cp-pager"></div>
  `;
}

function bindShell(host) {
  const search = host.querySelector('#cp-search');
  let debounce = null;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      _search = search.value.trim();
      _page = 1;
      loadRows(_token);
    }, 300);
  });
  host.querySelector('#cp-add').addEventListener('click', () => openAddModal());
}

// ── The table ───────────────────────────────────────────────────────────────

async function loadRows(mine) {
  const host = _host;
  if (!host) return;
  const body = host.querySelector('#cp-rows');
  if (body) body.innerHTML = `<div class="admin-loader"><div class="admin-loading__spinner"></div></div>`;

  const res = await AdminAPI.listContractPrices(_account.id, { search: _search, page: _page, limit: 25 });
  if (mine !== _token || !_host) return;

  if (!res) {
    // Could not read. NOT "there are no contract prices" — an operator who is
    // told the account has no negotiated prices when we simply failed to ask
    // will go and set them again.
    _rows = null;
    paintRows();
    return;
  }
  _rows = res.items;
  _pagination = res.pagination;
  paintRows();

  // Only a first, unfiltered page can speak for the whole account. A search
  // result's total is the count of MATCHES, and reporting that as the account's
  // custom-price count would relabel the badge every time someone typed.
  if (_onCountChange && !_search && _page === 1) {
    const total = Number(_pagination?.total);
    if (Number.isFinite(total)) _onCountChange(total);
  }
}

function paintRows() {
  const host = _host;
  if (!host) return;
  const body = host.querySelector('#cp-rows');
  const pager = host.querySelector('#cp-pager');
  if (!body) return;

  if (_rows === null) {
    body.innerHTML = `<p class="biz-note biz-note--warn">This account’s contract prices could not be read. That is a connection problem, not an empty list — nothing has been changed.</p>`;
    if (pager) pager.innerHTML = '';
    return;
  }

  if (!_rows.length) {
    body.innerHTML = _search
      ? `<p class="admin-text-muted">No contract price on this account matches “${esc(_search)}”.</p>`
      : `<div class="admin-empty"><div class="admin-empty__title">No contract prices yet</div><div class="admin-empty__text">This account pays list price plus the ordinary volume discounts. Add a product to give them their own price.</div></div>`;
    if (pager) pager.innerHTML = '';
    return;
  }

  let h = `<div class="admin-table-wrap"><table class="admin-table cp-table"><thead><tr>
    <th>Product</th>
    <th class="cell-right">List</th>
    <th class="cell-right">This account</th>
    <th class="cell-right">Margin</th>
    <th>Last change</th>
    <th></th>
  </tr></thead><tbody>`;

  for (const r of _rows) {
    const pid = escA(r.product_id);
    h += `<tr data-product="${pid}">`;
    h += `<td><span class="cell-mono">${esc(r.sku || MISSING)}</span><br><span class="cell-truncate cell-muted">${esc(r.name || '')}</span>`;
    // The PRODUCT's own status, not the price's. A contract price on a
    // deactivated product is not an error — it is a price waiting for the
    // product to come back — but it will not be charged, so say so.
    if (r.is_active === false) h += `<br><span class="admin-badge admin-badge--cancelled">Product inactive</span>`;
    h += `</td>`;
    h += `<td class="cell-right cell-mono">${money(r.list_price)}</td>`;
    h += `<td class="cell-right cell-mono"><strong>${money(r.contract_price)}</strong>`;
    h += `<br><span class="cp-off">${esc(formatDiscountPercent(r.discount_percent))}</span></td>`;
    // `net_margin_percent` is null when the product has no supplier cost. That
    // is "unknown", never "0%" — a $0 cost reads as a 100% margin and the
    // opposite mistake is the one that loses money (ERR-068).
    h += `<td class="cell-right cell-mono${r.below_cost ? ' cp-danger' : ''}">${esc(formatMarginPercent(r.net_margin_percent))}</td>`;
    h += `<td>${lastChangeCell(r)}</td>`;
    h += `<td class="cell-right cp-actions">
      <button class="admin-btn admin-btn--ghost admin-btn--xs" data-cp="history" data-product="${pid}" type="button">History</button>
      <button class="admin-btn admin-btn--ghost admin-btn--xs" data-cp="edit" data-product="${pid}" type="button">Edit</button>
      <button class="admin-btn admin-btn--danger-text admin-btn--xs" data-cp="remove" data-product="${pid}" type="button">Remove</button>
    </td>`;
    h += `</tr>`;

    // Flags the server raised on a price that was nonetheless accepted. Shown
    // on the row rather than only at save time, because the reason a price is
    // unusual outlives the moment it was typed.
    // Each entry is ESCAPED AT ITS OWN INTERPOLATION SITE, not once at the join.
    // The two are equivalent today, but "it gets escaped three lines further
    // down" is the arrangement that survives one refactor and not two — and
    // `notes` is free text an operator typed and the backend stored verbatim.
    const flags = [];
    if (r.below_cost) flags.push('Below cost — this loses money on every unit.');
    if (r.below_floor) flags.push('Deeper than the automatic discount would ever go.');
    if (r.above_list) flags.push('Above list — this account is charged the list price until list rises above it.');
    if (r.notes) flags.push(`Note: ${esc(r.notes)}`);
    if (flags.length) {
      h += `<tr class="cp-flags-row"><td colspan="6"><span class="cp-flags">${flags.join(' · ')}</span></td></tr>`;
    }
  }
  h += `</tbody></table></div>`;
  body.innerHTML = h;

  body.querySelectorAll('[data-cp]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = _rows.find((r) => String(r.product_id) === btn.dataset.product);
      if (!row) return;
      if (btn.dataset.cp === 'history') openHistoryModal(row);
      else if (btn.dataset.cp === 'edit') openEditModal(row);
      else if (btn.dataset.cp === 'remove') confirmRemove(row);
    });
  });

  paintPager();
}

/**
 * "was $114.32 → now $104.90", straight off the embedded `last_change`.
 *
 * The row carries its own history entry precisely so this column costs no
 * second call per row — do not add one. `describeChange()` owns the null table:
 * a first `set` has no "was" and never renders "$0.00 →".
 */
function lastChangeCell(r) {
  const lc = r.last_change;
  if (!lc) return `<span class="cell-muted">${MISSING}</span>`;
  const d = describeHistoryRow(lc);
  const text = describeChange(lc);
  if (!text) return `<span class="cell-muted">${MISSING}</span>`;
  const who = d?.changedByEmail ? ` · ${d.changedByEmail}` : '';
  return `<span class="cell-nowrap">${esc(text)}</span><br><span class="cell-muted">${esc(formatDate(d?.at))}${esc(who)}</span>`;
}

function paintPager() {
  const pager = _host && _host.querySelector('#cp-pager');
  if (!pager) return;
  const totalPages = Number(_pagination?.total_pages) || 1;
  const total = Number(_pagination?.total);
  if (totalPages <= 1) {
    pager.innerHTML = Number.isFinite(total) && total > 0
      ? `<span class="admin-text-muted">${total} product${total === 1 ? '' : 's'} priced for this account.</span>`
      : '';
    return;
  }
  pager.innerHTML = `
    <button class="admin-btn admin-btn--ghost admin-btn--sm" data-cp-page="prev" ${_page <= 1 ? 'disabled' : ''} type="button">Previous</button>
    <span class="admin-text-muted">Page ${_page} of ${totalPages}${Number.isFinite(total) ? ` · ${total} priced` : ''}</span>
    <button class="admin-btn admin-btn--ghost admin-btn--sm" data-cp-page="next" ${_page >= totalPages ? 'disabled' : ''} type="button">Next</button>
  `;
  pager.querySelectorAll('[data-cp-page]').forEach((b) => b.addEventListener('click', () => {
    _page += b.dataset.cpPage === 'next' ? 1 : -1;
    loadRows(_token);
  }));
}

// ── Add / edit ──────────────────────────────────────────────────────────────

/**
 * Add a product to this account's pricing.
 *
 * The type-ahead runs against `product-search`, which is scoped to the account
 * — so every hit already knows whether this account has a price for it
 * (`has_contract_price`) and carries the two guard-rail figures. Picking a row
 * therefore arms the price box completely, with no further request.
 */
function openAddModal() {
  const modal = Modal.open({
    title: `Add a product — ${_account.company_name || 'this account'}`,
    body: `
      <div class="admin-form-group">
        <label for="cp-pick">Product</label>
        <div class="admin-ac"><input class="admin-input" id="cp-pick" type="search" placeholder="Search by SKU or name…" autocomplete="off"></div>
        <div class="admin-form-help">Active products only. Setting a price here affects <strong>this account and nothing else</strong> — no catalogue row is changed.</div>
      </div>
      <div id="cp-pick-form"></div>
    `,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>`,
    className: 'admin-modal--wide',
  });
  if (!modal) return;
  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());

  const input = modal.body.querySelector('#cp-pick');
  const formHost = modal.body.querySelector('#cp-pick-form');

  if (_picker && _picker.destroy) _picker.destroy();
  _picker = attachAutocomplete(input, {
    minChars: 2,
    menuClass: 'admin-ac__menu--product',
    emptyText: (q) => `No active product matches “${q}”.`,
    fetch: async (q) => {
      const res = await AdminAPI.searchAccountProducts(_account.id, { q, limit: 20 });
      // null means the search failed. Returning [] would render "no product
      // matches", which is a claim about the catalogue rather than about us.
      if (!res) { Toast.error('Product search is unavailable right now.'); return []; }
      return res.items;
    },
    render: (p) => {
      const priced = p.has_contract_price
        ? `<span class="admin-chip admin-chip--info">Already priced ${esc(money(p.contract_price))}</span>`
        : '';
      return `<span class="cell-mono">${esc(p.sku)}</span> ${esc(p.name)} <span class="admin-ac__meta">· ${esc(money(p.list_price))}</span> ${priced}`;
    },
    onPick: (p) => {
      input.value = `${p.sku} — ${p.name}`;
      renderPriceForm(formHost, p, {
        // Re-adding a product whose price was removed is a `reactivated`, not a
        // `set`. The operator does not need to know that word, but they do need
        // to know they are changing an existing price rather than adding one.
        existing: p.has_contract_price ? { contract_price: p.contract_price } : null,
      });
    },
  });
}

function openEditModal(row) {
  const modal = Modal.open({
    title: `${row.sku} — ${_account.company_name || 'this account'}`,
    body: `<div id="cp-pick-form"></div>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>`,
    className: 'admin-modal--wide',
  });
  if (!modal) return;
  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());

  // An existing row carries `list_price` and `cost_price` but NOT the two guard
  // rails — those come from product-search. Rather than guess them (or, worse,
  // derive break-even from cost and a margin we invented), fetch the row and
  // say plainly if we could not.
  const host = modal.body.querySelector('#cp-pick-form');
  host.innerHTML = `<div class="admin-loader"><div class="admin-loading__spinner"></div></div>`;
  const mine = _token;
  AdminAPI.searchAccountProducts(_account.id, { q: row.sku, limit: 5 }).then((res) => {
    if (mine !== _token) return;
    const fresh = res && res.items.find((p) => String(p.product_id) === String(row.product_id));
    renderPriceForm(host, fresh || {
      product_id: row.product_id, sku: row.sku, name: row.name,
      list_price: row.list_price, cost_price: row.cost_price,
      // Explicitly null, not absent: this tells evaluatePrice() that the guard
      // rails are unknown, and it says so rather than grading against nothing.
      break_even_price: null, floor_price: null,
      _guardsUnknown: !fresh,
    }, { existing: row });
  });
}

/**
 * The price box and its live guard rails.
 *
 * Every keystroke re-grades against figures we already have. No request fires.
 */
function renderPriceForm(host, product, { existing } = {}) {
  if (!host) return;
  const currentPrice = existing?.contract_price;
  const guardsUnknown = product._guardsUnknown === true;

  host.innerHTML = `
    <div class="cp-form">
      <div class="cp-form__facts">
        <div><span class="cp-form__label">List price</span><span class="cp-form__value">${esc(money(product.list_price))}</span></div>
        <div><span class="cp-form__label">Break-even</span><span class="cp-form__value">${product.break_even_price != null ? esc(money(product.break_even_price)) : 'unknown'}</span></div>
        <div><span class="cp-form__label">Automatic floor</span><span class="cp-form__value">${product.floor_price != null ? esc(money(product.floor_price)) : 'unknown'}</span></div>
      </div>
      ${guardsUnknown ? `<p class="biz-note biz-note--warn">The guard rails for this product could not be re-read, so the box below can’t warn you about cost. The server still refuses a below-cost price.</p>` : ''}
      <div class="admin-form-group">
        <label for="cp-price">This account’s price <span class="admin-form-help" style="display:inline">(GST inclusive)</span></label>
        <input class="admin-input" id="cp-price" type="text" inputmode="decimal"
               value="${currentPrice != null ? escA(Number(currentPrice).toFixed(2)) : ''}"
               placeholder="e.g. 104.90" autocomplete="off">
        <div id="cp-price-note" class="cp-note"></div>
      </div>
      <div class="admin-form-group">
        <label for="cp-notes">Note <span class="admin-form-help" style="display:inline">(optional, kept on the price history)</span></label>
        <input class="admin-input" id="cp-notes" type="text" maxlength="${NOTES_MAX}"
               value="${escA(existing?.notes || '')}" placeholder="e.g. Renegotiated Sep 2026">
      </div>
      <div class="cp-form__actions">
        <button class="admin-btn admin-btn--primary" id="cp-save" type="button">${existing ? 'Update price' : 'Set price'}</button>
      </div>
    </div>
  `;

  const priceEl = host.querySelector('#cp-price');
  const noteEl = host.querySelector('#cp-price-note');
  const saveBtn = host.querySelector('#cp-save');

  const guards = {
    list_price: product.list_price,
    break_even_price: product.break_even_price,
    floor_price: product.floor_price,
    // A search row expresses "no cost on file" by sending null guards rather
    // than a `cost_known` key. Translate here so evaluatePrice() sees one shape.
    cost_known: guardsUnknown ? undefined : product.break_even_price != null,
  };

  const grade = () => {
    const parsed = parsePriceInput(priceEl.value);
    if (parsed.error) {
      noteEl.className = 'cp-note cp-note--red';
      noteEl.textContent = parsed.error;
      return null;
    }
    const ev = evaluatePrice(parsed.value, guards);
    if (ev.band === BAND_EMPTY) { noteEl.className = 'cp-note'; noteEl.textContent = ''; return parsed.value; }
    noteEl.className = 'cp-note' + (
      ev.band === BAND_BELOW_COST ? ' cp-note--red'
        : ev.band === BAND_BELOW_FLOOR ? ' cp-note--amber'
          : (ev.band === BAND_ABOVE_LIST || ev.band === BAND_UNKNOWN) ? ' cp-note--info' : ' cp-note--ok');
    noteEl.textContent = ev.message || (
      product.list_price != null
        ? `${formatDiscountPercent(pctOff(parsed.value, product.list_price))} off list.`
        : '');
    return parsed.value;
  };

  priceEl.addEventListener('input', grade);
  grade();

  saveBtn.addEventListener('click', async () => {
    const parsed = parsePriceInput(priceEl.value);
    if (parsed.error || parsed.value == null) {
      noteEl.className = 'cp-note cp-note--red';
      noteEl.textContent = parsed.error || 'Enter a price.';
      priceEl.focus();
      return;
    }
    await savePrice(product, parsed.value, host.querySelector('#cp-notes').value, saveBtn);
  });
}

/**
 * The one place a discount percent is shown for a price the server has not
 * graded yet — the live "X% off list" hint under the box.
 *
 * This IS arithmetic on a price, which the house rule forbids for anything that
 * gets saved or charged. It is allowed here for exactly one reason: it labels a
 * number the operator is typing, has not saved, and can see both inputs to. The
 * moment the price is saved, the server's own `discount_percent` replaces it in
 * the table — nothing downstream ever reads this.
 */
function pctOff(price, list) {
  const l = Number(list);
  if (!Number.isFinite(l) || l <= 0) return null;
  return ((l - Number(price)) / l) * 100;
}

/**
 * Save, with the below-cost round trip.
 *
 * §5: below cost is the ONE refusal, and it is designed to be overridden. On a
 * 409 we confirm with the server's own message — which carries the break-even
 * figure — and re-send the IDENTICAL body plus `acknowledge_below_cost`. The
 * refused request changed nothing, so there is nothing to undo.
 */
async function savePrice(product, price, notes, btn, acknowledge = false) {
  const body = { custom_price: price };
  const trimmed = String(notes ?? '').trim();
  if (trimmed) body.notes = trimmed;
  if (acknowledge) body.acknowledge_below_cost = true;

  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Saving…';

  try {
    const data = await AdminAPI.setContractPrice(_account.id, product.product_id, body);
    Modal.close();
    Toast.success(saveMessage(data, product));
    // The response carries the fully-shaped row, so splice rather than refetch.
    spliceRow(data?.item, data?.action);
    warnAboutFlags(data?.evaluation);
  } catch (e) {
    const d = describeSaveError(e);
    btn.disabled = false;
    btn.textContent = label;

    if (d.needsAcknowledge) {
      const ev = d.evaluation;
      // A confirmation that cannot say what you are agreeing to is worse than
      // an error. If the evaluation did not survive the envelope, say so and
      // refuse to offer a blind override.
      if (!ev) {
        Toast.error(`${d.message} The server did not send the margin figures, so this can’t be confirmed here.`);
        return;
      }
      Modal.confirm({
        title: d.title,
        message: `${d.message} At ${money(price)} the net margin would be ${formatMarginPercent(ev.net_margin_percent)}. Set it anyway?`,
        confirmLabel: 'Set it anyway',
        onConfirm: async () => {
          // The IDENTICAL body plus one flag — rebuilt from the same inputs so
          // the note cannot be dropped on the second attempt.
          await savePrice(product, price, notes, btn, true);
        },
      });
      return;
    }

    if (d.fieldErrors.length) {
      Toast.error(`${d.title}: ${d.fieldErrors.map((f) => f.message).join(', ')}`);
      return;
    }
    Toast.error(d.message);
  }
}

function saveMessage(data, product) {
  const action = data?.action;
  const prev = data?.previous_price;
  const now = data?.item?.contract_price;
  if (action === 'updated' && prev != null) return `${product.sku}: ${money(prev)} → ${money(now)}`;
  if (action === 'reactivated') return `${product.sku}: price re-added at ${money(now)}`;
  return `${product.sku}: price set at ${money(now)}`;
}

/** Flags on a SUCCESSFUL save. Shown verbatim — the server wrote them. */
function warnAboutFlags(evaluation) {
  const warnings = Array.isArray(evaluation?.warnings) ? evaluation.warnings : [];
  for (const w of warnings) Toast.warning(String(w));
  // `cost_known: false` is not a warning string, but it IS the thing an
  // operator most needs told: the price saved, and nobody checked the margin.
  if (evaluation && evaluation.cost_known === false) {
    Toast.warning('Saved — but this product has no recorded supplier cost, so the margin could not be checked.');
  }
}

/**
 * Put a saved row into the table without refetching.
 *
 * Falls back to a reload when the row is not the shape we expected: a table
 * that quietly drops a price the operator just set is worse than one extra
 * request.
 */
function spliceRow(item, action) {
  if (!item || !item.product_id || !Array.isArray(_rows)) { loadRows(_token); return; }
  const i = _rows.findIndex((r) => String(r.product_id) === String(item.product_id));
  if (i >= 0) _rows[i] = item;
  else _rows.unshift(item);
  if (_onCountChange && (action === 'set' || action === 'reactivated')) {
    _onCountChange((Number(_pagination?.total) || _rows.length - 1) + 1);
    if (_pagination) _pagination.total = (Number(_pagination.total) || 0) + 1;
  }
  paintRows();
}

// ── Remove ──────────────────────────────────────────────────────────────────

function confirmRemove(row) {
  Modal.confirm({
    title: `Remove ${row.sku}’s contract price?`,
    message: `${_account.company_name || 'This account'} would go back to paying the list price of ${money(row.list_price)}, plus the ordinary volume discounts. The change is recorded in the price history and can be re-added at any time.`,
    confirmLabel: 'Remove price',
    onConfirm: async () => {
      try {
        const data = await AdminAPI.removeContractPrice(_account.id, row.product_id, {});
        Toast.success(`${row.sku}: ${money(data?.previous_price ?? row.contract_price)} withdrawn — back to list.`);
        dropRow(row.product_id);
      } catch (e) {
        // 404 means it had already gone. That is an honest answer to a
        // double-click and it must not be dressed up as a success — but it is
        // not a failure the operator caused either.
        if (isAlreadyRemoved(e)) {
          Toast.warning(`${row.sku} had no contract price to remove — the list is now up to date.`);
          dropRow(row.product_id);
          return;
        }
        Toast.error(describeSaveError(e).message);
      }
    },
  });
}

function dropRow(productId) {
  if (!Array.isArray(_rows)) { loadRows(_token); return; }
  _rows = _rows.filter((r) => String(r.product_id) !== String(productId));
  if (_pagination && Number.isFinite(Number(_pagination.total))) {
    _pagination.total = Math.max(0, Number(_pagination.total) - 1);
    if (_onCountChange) _onCountChange(_pagination.total);
  }
  paintRows();
}

// ── History ─────────────────────────────────────────────────────────────────

/**
 * One product's price history, or the whole account's.
 *
 * ── RENDER THE ROW'S OWN SKU ────────────────────────────────────────────────
 *
 * `sku` and `name` on a history row are SNAPSHOTS taken at the time of the
 * change, and the row has no foreign key to `products`. That is the point: a
 * later rename, or deleting the product entirely, cannot rewrite what happened.
 * Reaching for the current product's SKU here would undo that guarantee for the
 * sake of looking tidier.
 */
export function openHistoryModal(row) {
  const scoped = !!row;
  const modal = Modal.open({
    title: scoped ? `Price history — ${row.sku}` : `Price history — ${_account.company_name || 'this account'}`,
    body: `<div id="cp-history"><div class="admin-loader"><div class="admin-loading__spinner"></div></div></div>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Close</button>`,
    className: 'admin-modal--wide',
  });
  if (!modal) return;
  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());

  const host = modal.body.querySelector('#cp-history');
  const mine = _token;
  AdminAPI.listContractPriceHistory(_account.id, { productId: scoped ? row.product_id : null, limit: 50 })
    .then((res) => {
      if (mine !== _token || !host.isConnected) return;
      if (!res) {
        host.innerHTML = `<p class="biz-note biz-note--warn">The price history could not be read. That is a connection problem, not an empty history.</p>`;
        return;
      }
      host.innerHTML = historyHtml(res.items, res.pagination);
    });
}

function historyHtml(items, pagination) {
  if (!items.length) {
    return `<p class="admin-text-muted">No recorded changes.</p>`;
  }
  let h = `<p class="admin-text-muted cp-history__note">${esc(historySnapshotNote())}</p>`;
  h += `<div class="admin-table-wrap"><table class="admin-table"><thead><tr>
    <th>When</th><th>Product</th><th>Change</th><th class="cell-right">Was → now</th><th>Who</th>
  </tr></thead><tbody>`;
  for (const raw of items) {
    const d = describeHistoryRow(raw);
    if (!d) continue;
    h += `<tr>`;
    h += `<td class="cell-nowrap">${esc(formatDate(d.at))}</td>`;
    // d.sku is the SNAPSHOT. See the docblock above.
    h += `<td><span class="cell-mono">${esc(d.sku || MISSING)}</span></td>`;
    h += `<td><span class="admin-badge admin-badge--${esc(d.known ? d.action : 'pending')}">${esc(d.label)}</span></td>`;
    h += `<td class="cell-right cell-mono">${esc(describeChange(raw) || MISSING)}`;
    if (d.delta != null) {
      h += `<br><span class="cp-delta cp-delta--${esc(d.direction)}">${esc(formatSigned(d))}</span>`;
    }
    h += `</td>`;
    h += `<td><span class="cell-truncate">${esc(d.changedByEmail || MISSING)}</span>`;
    if (d.notes) h += `<br><span class="cell-muted cell-truncate">${esc(d.notes)}</span>`;
    h += `</td>`;
    h += `</tr>`;
  }
  h += `</tbody></table></div>`;

  // A page of rows is not necessarily the whole history. Saying so is the
  // difference between "there were 3 changes" and "we read 3 of 47".
  const total = Number(pagination?.total);
  if (Number.isFinite(total) && total > items.length) {
    h += `<p class="biz-note biz-note--warn">Showing the ${items.length} most recent of ${total} changes.</p>`;
  }
  return h;
}

/**
 * The signed delta, plus what the discount was AT THE TIME.
 *
 * `discount_percent_at_change` is on the row for a reason: today's list price
 * may be nothing like the one this change was measured against, so recomputing
 * the percent from the current catalogue would misreport history. Read the
 * snapshot, like everything else on this row.
 */
function formatSigned(d) {
  const amount = formatSignedMoney(d.delta);
  const pct = d.discountPercentAtChange;
  return pct != null ? `${amount} · ${Math.round(pct * 10) / 10}% off list then` : amount;
}
