/**
 * Brands manager — the surface that makes "adding a brand is one admin write" true.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Until 2026-08-31 /shop decided which brands rendered a tile by filtering
 * `/api/brands` against a hardcoded ten-slug array inside `renderBrands()`, with
 * logos in a second hardcoded map. A brand present in the database but absent
 * from that array appeared in search, on its product pages and throughout the
 * admin, and rendered **no tile on /shop** — with no error anywhere. Seventeen
 * live brands were in exactly that state and nothing in the system could say so.
 *
 * The backend replaced it with `brands.show_on_shop` + `sort_order`, and quietly
 * shipped `POST`/`PUT`/`DELETE /api/admin/brands` without mentioning them. Without
 * this page those columns are reachable only by hand-written SQL, which would have
 * moved the hardcoded list out of a JS file and into a database column that nobody
 * in the admin can edit — a smaller version of the same problem.
 *
 * ── The contract, MEASURED (2026-08-31) ────────────────────────────────────
 *
 *   POST   /api/admin/brands       201 → data.brand    name + slug REQUIRED
 *   PUT    /api/admin/brands/:id   200 → data.brand    merges; absent keys survive
 *   DELETE /api/admin/brands/:id   200 → {deleted,id,slug}
 *   PATCH                          404 — does not exist
 *
 * Writable: name, slug, logo_url, show_on_shop, sort_order.
 * `logo_path` is DERIVED — sending it echoes back null, so it is never offered.
 *
 * ── Two hazards this page is built around ──────────────────────────────────
 *
 * 1. UNKNOWN KEYS ARE SILENTLY STRIPPED, not rejected. A field the API does not
 *    recognise returns 200 and changes nothing — the "it appeared to work and did
 *    nothing" failure that this entire area exists to clean up. So every write is
 *    read back and compared, and a field that did not stick is reported by name.
 *    The check MEASURES rather than assumes, so it self-heals if the backend
 *    later adds the column (same shape as refEchoMissing, ERR-182/BF-051).
 *
 * 2. /api/brands IS EDGE-CACHED (`s-maxage=300, stale-while-revalidate=600`,
 *    measured) and ALSO client-SWR-cached for 5 minutes. Two consequences:
 *
 *    a. A change takes minutes to reach /shop. Left unsaid that reads as "the
 *       toggle did nothing" — the very failure this feature removes — so the page
 *       states the delay in the operator's own terms.
 *
 *    b. This page must NEVER re-read the list to show the result of its own write,
 *       because that read can be served from the CDN and hand back the row as it
 *       was BEFORE the write. So it doesn't re-read: every write returns the
 *       updated row, and that echo — the server's own answer about the row it just
 *       changed — is patched into local state. Same doctrine as ERR-179 (patch the
 *       cell, never re-render from a fresh fetch) and it also keeps us off the
 *       cache-buster that ERR-124 bans on catalog URLs, which would have made
 *       every one of these reads a guaranteed edge MISS.
 */

import { AdminAuth, AdminAPI, esc } from '../app.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';

/** How long a write takes to reach /shop, from the measured cache headers. */
const PROPAGATION_NOTE =
  'Changes here reach /shop within about 5 minutes (the brand list is cached at the '
  + 'CDN for 5 minutes and in each visitor’s browser for 5). The admin always shows '
  + 'the live values.';

/**
 * Which of the fields we asked for did NOT come back as we sent them?
 *
 * Measures by comparing the echoed row, so it reports nothing once the backend
 * agrees — a warning that cannot heal itself becomes noise and then gets ignored.
 * Compared loosely on purpose: the API may normalise (trim a string, coerce a
 * numeric string), and only a genuine disagreement is worth reporting.
 */
export function brandEchoMissing(sent, echoed) {
  if (!sent || !echoed || typeof echoed !== 'object') return [];
  const missing = [];
  for (const key of Object.keys(sent)) {
    const want = sent[key];
    const got = echoed[key];
    if (want === undefined) continue;
    if (!(key in echoed)) { missing.push(key); continue; }
    if (typeof want === 'boolean' || typeof want === 'number') {
      if (got !== want) missing.push(key);
    } else {
      const a = want == null ? '' : String(want).trim();
      const b = got == null ? '' : String(got).trim();
      if (a !== b) missing.push(key);
    }
  }
  return missing;
}

/** A slug the API will accept, derived from a display name. */
export function slugifyBrand(name) {
  return String(name || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

let _brands = [];
let _host = null;
let _onChanged = null;

function sortForDisplay(rows) {
  const rank = (b) => (b.show_on_shop === true ? 0 : b.show_on_shop === false ? 1 : 2);
  return [...rows].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const ao = Number.isFinite(a.sort_order) ? a.sort_order : Number.MAX_SAFE_INTEGER;
    const bo = Number.isFinite(b.sort_order) ? b.sort_order : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function row(b) {
  const shown = b.show_on_shop === true;
  const unknown = b.show_on_shop !== true && b.show_on_shop !== false;
  const logo = b.logo_url || b.logo_path || '';
  return `
    <tr data-brand-row="${esc(String(b.id))}">
      <td class="admin-brands__logo">${logo
        ? `<img src="${esc(logo)}" alt="" loading="lazy">`
        : '<span class="admin-brands__nologo">no logo</span>'}</td>
      <td>
        <div class="admin-brands__name">${esc(b.name || b.slug || '')}</div>
        <div class="admin-brands__slug"><code>${esc(b.slug || '')}</code></div>
      </td>
      <td>
        <label class="admin-brands__toggle">
          <input type="checkbox" data-brand-toggle="${esc(String(b.id))}" ${shown ? 'checked' : ''}>
          <span>${unknown ? 'not set' : shown ? 'On /shop' : 'Hidden'}</span>
        </label>
      </td>
      <td>
        <input class="admin-input admin-input--sm admin-brands__order" type="number"
               data-brand-order="${esc(String(b.id))}"
               value="${Number.isFinite(b.sort_order) ? esc(String(b.sort_order)) : ''}"
               ${shown ? '' : 'disabled'} title="${shown ? 'Tile order on /shop' : 'Only applies while the brand is on /shop'}">
      </td>
      <td class="admin-brands__actions">
        <button class="admin-btn admin-btn--ghost admin-btn--sm" data-brand-edit="${esc(String(b.id))}">Edit</button>
        <button class="admin-btn admin-btn--ghost admin-btn--sm admin-btn--danger-text" data-brand-delete="${esc(String(b.id))}">Delete</button>
      </td>
    </tr>`;
}

function paint() {
  const shown = _brands.filter(b => b.show_on_shop === true).length;
  _host.innerHTML = `
    <div class="admin-brands">
      <div class="admin-brands__head">
        <div>
          <h3 class="admin-cb-h">Brands</h3>
          <p class="admin-cb-note">${esc(_brands.length)} brands · ${esc(shown)} render a tile on /shop.
            ${esc(PROPAGATION_NOTE)}</p>
        </div>
        <button class="admin-btn admin-btn--primary admin-btn--sm" data-brand-new>+ Add brand</button>
      </div>
      <table class="admin-table admin-brands__table">
        <thead><tr>
          <th>Logo</th><th>Brand</th><th>On /shop</th><th>Order</th><th></th>
        </tr></thead>
        <tbody>${sortForDisplay(_brands).map(row).join('')}</tbody>
      </table>
    </div>`;
  wire();
}

function wire() {
  _host.querySelector('[data-brand-new]')?.addEventListener('click', () => openEditor(null));
  _host.querySelectorAll('[data-brand-edit]').forEach(btn =>
    btn.addEventListener('click', () => openEditor(_brands.find(b => String(b.id) === btn.dataset.brandEdit))));
  _host.querySelectorAll('[data-brand-delete]').forEach(btn =>
    btn.addEventListener('click', () => confirmDelete(_brands.find(b => String(b.id) === btn.dataset.brandDelete))));

  _host.querySelectorAll('[data-brand-toggle]').forEach(cb =>
    cb.addEventListener('change', async () => {
      const b = _brands.find(x => String(x.id) === cb.dataset.brandToggle);
      if (!b) return;
      cb.disabled = true;
      // A brand joining the grid with no order would sort last by accident rather
      // than by decision — give it one, at the end, and let the operator move it.
      const patch = { show_on_shop: cb.checked };
      if (cb.checked && !Number.isFinite(b.sort_order)) {
        patch.sort_order = Math.max(0, ..._brands.map(x => Number.isFinite(x.sort_order) ? x.sort_order : 0)) + 1;
      }
      await save(b, patch, cb.checked ? `${b.name} now shows on /shop` : `${b.name} hidden from /shop`);
      cb.disabled = false;
    }));

  _host.querySelectorAll('[data-brand-order]').forEach(input =>
    input.addEventListener('change', async () => {
      const b = _brands.find(x => String(x.id) === input.dataset.brandOrder);
      if (!b) return;
      const n = parseInt(input.value, 10);
      if (!Number.isFinite(n)) { Toast.error('Order must be a whole number.'); return; }
      await save(b, { sort_order: n }, `${b.name} order set to ${n}`);
    }));
}

/**
 * Write, then READ BACK and compare.
 *
 * The API strips unknown keys silently, so a 200 is not evidence that anything
 * changed. Only the echo is.
 */
async function save(brand, patch, successMessage) {
  try {
    const echoed = await AdminAPI.updateBrand(brand.id, patch);
    const missing = brandEchoMissing(patch, echoed);
    if (missing.length) {
      Toast.error(`The server accepted the change but did not store: ${missing.join(', ')}. `
        + 'Nothing about those fields has changed on /shop.');
    } else {
      Toast.success(successMessage);
    }
    // Patch from the ECHO, never a re-read: /api/brands is CDN-cached, so a fetch
    // here can legitimately return the row as it was before this write.
    applyEcho(brand.id, echoed);
  } catch (e) {
    Toast.error(e.message || 'Could not save the brand.');
  }
}

/**
 * Fold a server-echoed row into local state.
 *
 * The echo is authoritative for the row it describes — it IS the server's answer
 * about the write that just happened — and it cannot be stale the way a cached
 * list read can. An echo we cannot read leaves state untouched rather than
 * guessing at it.
 */
function applyEcho(id, echoed) {
  if (echoed && typeof echoed === 'object' && echoed.id != null) {
    const i = _brands.findIndex(b => String(b.id) === String(echoed.id));
    if (i >= 0) _brands[i] = { ..._brands[i], ...echoed };
    else _brands.push(echoed);
  }
  paint();
  if (typeof _onChanged === 'function') _onChanged(_brands);
}

function openEditor(brand) {
  const isNew = !brand;
  const b = brand || { name: '', slug: '', logo_url: '', show_on_shop: false, sort_order: null };
  const modal = Modal.open({
    title: isNew ? 'Add a brand' : `Edit ${b.name || b.slug}`,
    body: `
      <div class="admin-form-group">
        <label class="admin-label">Name</label>
        <input class="admin-input" id="brand-name" value="${esc(b.name || '')}" placeholder="Ricoh">
      </div>
      <div class="admin-form-group">
        <label class="admin-label">Slug</label>
        <input class="admin-input" id="brand-slug" value="${esc(b.slug || '')}" placeholder="ricoh"
               ${isNew ? '' : 'disabled title="The slug is part of every /shop URL for this brand — changing it would break existing links."'}>
        <small class="admin-help">Lowercase, hyphenated. Used in <code>/shop?brand=…</code>.</small>
      </div>
      <div class="admin-form-group">
        <label class="admin-label">Logo URL</label>
        <input class="admin-input" id="brand-logo" value="${esc(b.logo_url || '')}" placeholder="https://…/logo.png">
        <small class="admin-help">Optional. A brand with no logo renders its name instead, which is a
          supported look — better than a broken image.</small>
      </div>
      <label class="admin-brands__toggle" style="margin-top:8px">
        <input type="checkbox" id="brand-shown" ${b.show_on_shop === true ? 'checked' : ''}>
        <span>Show a tile on /shop</span>
      </label>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">${isNew ? 'Create brand' : 'Save'}</button>
    `,
  });
  if (!modal) return;

  const nameEl = modal.body.querySelector('#brand-name');
  const slugEl = modal.body.querySelector('#brand-slug');
  // Autofill the slug from the name while the operator has not typed one, and
  // stop the moment they do — an autofill that overwrites a typed value is the
  // ERR-178 shape (presence standing in for provenance).
  let slugTouched = !isNew;
  slugEl?.addEventListener('input', () => { slugTouched = true; });
  nameEl?.addEventListener('input', () => { if (!slugTouched) slugEl.value = slugifyBrand(nameEl.value); });

  modal.footer.querySelector('[data-action="cancel"]')?.addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]')?.addEventListener('click', async () => {
    const payload = {
      name: nameEl.value.trim(),
      logo_url: modal.body.querySelector('#brand-logo').value.trim() || null,
      show_on_shop: modal.body.querySelector('#brand-shown').checked,
    };
    if (isNew) payload.slug = slugifyBrand(slugEl.value || payload.name);
    if (!payload.name) { Toast.error('A brand needs a name.'); return; }
    if (isNew && !payload.slug) { Toast.error('A brand needs a slug.'); return; }

    try {
      const echoed = isNew ? await AdminAPI.createBrand(payload) : await AdminAPI.updateBrand(b.id, payload);
      const missing = brandEchoMissing(payload, echoed);
      Modal.close();
      if (missing.length) {
        Toast.error(`Saved, but the server did not store: ${missing.join(', ')}.`);
      } else {
        Toast.success(isNew ? `${payload.name} added.` : `${payload.name} saved.`);
      }
      applyEcho(isNew ? echoed?.id : b.id, echoed);
    } catch (e) {
      Toast.error(e.message || 'Could not save the brand.');
    }
  });
}

function confirmDelete(brand) {
  if (!brand) return;
  const modal = Modal.open({
    title: `Delete ${brand.name || brand.slug}?`,
    body: `
      <p style="margin:0 0 12px;line-height:1.7">This removes the brand record itself.</p>
      <p style="margin:0;line-height:1.7;color:var(--text-secondary)">
        We have not measured what happens to products still filed under it, so if this brand has
        any products, <strong>hide it from /shop instead</strong> — that is reversible and this
        may not be.
      </p>`,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--danger" data-action="confirm">Delete brand</button>`,
  });
  if (!modal) return;
  modal.footer.querySelector('[data-action="cancel"]')?.addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="confirm"]')?.addEventListener('click', async () => {
    Modal.close();
    try {
      await AdminAPI.deleteBrand(brand.id);
      Toast.success(`${brand.name || brand.slug} deleted.`);
      _brands = _brands.filter(b => String(b.id) !== String(brand.id));
      paint();
      if (typeof _onChanged === 'function') _onChanged(_brands);
    } catch (e) {
      Toast.error(e.message || 'Could not delete the brand.');
    }
  });
}

/**
 * First load only. The ordinary cached read is right here: the operator has not
 * written anything yet, so there is nothing of theirs that a cache could hide.
 * Every subsequent change is applied from its own write echo (see applyEcho).
 */
async function reload() {
  const rows = await AdminAPI.getBrands();
  if (!Array.isArray(rows)) {
    // Never paint a half-list as if it were the whole one.
    _host.innerHTML = `<div class="admin-cb-empty"><strong>The brand list could not be read.</strong>
      <div>Nothing below would be trustworthy, so nothing is shown. Try again shortly.</div></div>`;
    return;
  }
  _brands = rows;
  paint();
  if (typeof _onChanged === 'function') _onChanged(rows);
}

/**
 * Mount the manager into `host`. Owner-only — the endpoints are super_admin.
 */
export default {
  async init(host, hooks = {}) {
    _host = host;
    _onChanged = hooks.onChanged || null;
    if (!AdminAuth.isOwner()) {
      _host.innerHTML = `<div class="admin-cb-empty"><strong>Owner access required.</strong>
        <div>Adding, editing and hiding brands needs an owner account.</div></div>`;
      return;
    }
    _host.innerHTML = '<div class="admin-cb-empty">Loading brands…</div>';
    await reload();
  },
  destroy() { _host = null; _brands = []; _onChanged = null; },
};
