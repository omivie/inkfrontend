/**
 * Control Center — Pricing tab: margin tier multipliers, approval-gated.
 *
 * Backend contract: backend-docs/inbox/tier-multiplier-approval-backend-contract-sep2026.md
 * (migration 187). Errors log: ERR-281. Pure logic: utils/tierProposal.js.
 *
 *   edit      the ladder from GET /tier-multipliers. Every edit re-simulates
 *             (debounced) and shows what it does to the catalogue.
 *   propose   PUT /tier-multipliers. FILES A PROPOSAL. Moves no price.
 *   review    GET …/proposals/:id: fresh impact plus a `stale` flag.
 *   approve   POST …/approve {confirm:true}. The only call that changes live
 *             prices. It starts a full-catalogue reprice, which is polled until
 *             the storefront has caught up.
 *
 * Until this rewrite the tab had a "Confirm & save" button that PUT a body the
 * contract does not describe and toasted "Saved — prices are repricing". Since
 * migration 187 that PUT can at most file a proposal, so the toast described a
 * price change that had not happened.
 *
 * Two readings of the simulate response are deliberate (measured on live on
 * 2026-09-23; see tierProposal.js):
 *   - A reprice applies DRIFT as well as the edit. The panel runs a no-change
 *     baseline and splits "this edit" from "drift a reprice applies anyway".
 *   - Rows blocked by the no-decrease ratchet KEEP their price. The aggregate
 *     "after" figures still count them at the lower table price, so the panel
 *     says so, and sample rows read "keeps $X" rather than showing a price drop.
 */
import { AdminAPI, AdminAuth, esc, icon } from '../app.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';
import { STRIPE_RATE } from '../utils/pricingCalculator.js';
import { GST_INCL, GST_EXCL, gstSub } from '../utils/gst-basis.js';
import {
  EDITABLE_SOURCES, MULT_MIN, MULT_MAX, OFFSET_LIMIT,
  SIM_DEBOUNCE_MS, POLL_MS, EDIT_PREVIEW_LIMIT, FULL_PREVIEW_LIMIT,
  sameMult, ladderKeys, bandsFromServer, validateBandLadder,
  buildProposeBody, buildSimulateBody, baselineSimulateBody,
  attribute, attributeBands, ratchetSummary, rowOutcome, diffLadders,
  errorMessage, pollDecision,
} from '../utils/tierProposal.js';

const SOURCE_LABEL = { genuine: 'Genuine', compatible: 'Compatible' };
const STATUS_LABEL = { pending: 'Awaiting approval', approved: 'Approved', rejected: 'Rejected', superseded: 'Superseded' };
const SAMPLE_RENDER_CAP = 500;

let _host = null;
let _state = null;
let _simTimer = null;
let _pollTimer = null;

// ── Formatting (display only — never price arithmetic) ───────────────────────
const int = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-NZ'));
const money = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `$${Number(v).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const signedMoney = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${Number(v) >= 0 ? '+' : '−'}${money(Math.abs(Number(v)))}`);
const pct = (v, dp = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${Number(v).toFixed(dp)}%`);
const signedPct = (v, dp = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(dp)}%`);
const signedInt = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${Number(v) >= 0 ? '+' : '−'}${int(Math.abs(Number(v)))}`);
const mult = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(3).replace(/0$/, ''));
const offsetPct = (v) => `${Number(v) >= 0 ? '+' : ''}${(Number(v) * 100).toFixed(1)}%`;
const when = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short' });
};
const who = (uuid) => (uuid ? `${String(uuid).slice(0, 8)}…` : '—');

function costRange(prevMax, maxCost) {
  if (prevMax == null && maxCost != null) return `≤ $${maxCost}`;
  if (maxCost == null) return `> $${prevMax}`;
  return `$${prevMax} – $${maxCost}`;
}

// ── State ────────────────────────────────────────────────────────────────────
function freshState() {
  return {
    live: null,            // GET /tier-multipliers data
    loadError: null,
    brands: [],            // [{id, slug, name}]
    brandId: '',           // '' = the catalogue table
    source: 'compatible',
    mode: 'multipliers',   // 'multipliers' | 'bands'
    includeOverrides: false,
    draft: null,
    sim: null,
    baseline: null,
    baselineKey: null,
    simError: null,
    simLoading: false,
    simSeq: 0,
    validation: [],
    sampleLimit: EDIT_PREVIEW_LIMIT,
    view: 'edit',          // 'edit' | 'review'
    review: null,          // GET /proposals/:id data
    reviewBaseline: null,
    reviewError: null,
    job: null,             // { id, status, counts, outcome, error, startedAt, packs, message }
    history: null,
    historyError: null,
    historyStatus: '',
    reviewedOnce: false,   // auto-open a pending proposal once per mount, not on every reload
  };
}

function draftFromLive(live) {
  const eff = (live && live.effective) || {};
  return {
    catalogue: {
      genuine: { ...(eff.genuine || {}) },
      compatible: { ...(eff.compatible || {}) },
    },
    bands: { genuine: null, compatible: null },
    brands: {},
    offset: Number((live && live.global_offset) || 0),
  };
}

function brandsMeta() {
  const out = {};
  for (const b of _state.brands) out[b.id] = { slug: b.slug, name: b.name };
  return out;
}

function currentBrand() {
  return _state.brands.find((b) => b.id === _state.brandId) || null;
}

function liveBrandTable(brandId) {
  const t = _state.live && _state.live.effective && _state.live.effective.brands;
  return (t && t[brandId]) || null;
}

// The ladder rows for the active source, in the draft's form. Bands mode edits
// a copy of the boundaries; multiplier mode reads the live boundaries.
function activeBandRows() {
  const s = _state.source;
  if (_state.draft.bands[s]) return _state.draft.bands[s];
  return bandsFromServer(_state.live.bands && _state.live.bands[s]);
}

// True when the draft differs from live (even if the difference is invalid).
function draftDirty() {
  return !(buildProposeBody(_state.draft, _state.live, null).errors || []).some((e) => e.reason === 'no_change');
}

// ── Shell ────────────────────────────────────────────────────────────────────
function renderShell() {
  _host.innerHTML = `
    <div class="cc2-tiers">
      <div data-slot="status"></div>
      <div data-slot="main"></div>
      <details class="admin-card cc2-tiers__history" data-slot="history-wrap">
        <summary><strong>Proposal history</strong> <span class="cc2-tiers__muted">— who proposed what, who approved it, and the impact they were shown</span></summary>
        <div data-slot="history"></div>
      </details>
    </div>`;
  _host.addEventListener('click', onClick);
  _host.addEventListener('input', onInput);
  _host.addEventListener('change', onChange);
  _host.querySelector('[data-slot="history-wrap"]').addEventListener('toggle', (e) => {
    if (e.target.open && !_state.history) loadHistory();
  });
}

function slot(name) {
  return _host && _host.querySelector(`[data-slot="${name}"]`);
}

// ── Status strip: pending proposal / running reprice ─────────────────────────
function renderStatus() {
  const el = slot('status');
  if (!el) return;
  const parts = [];
  const job = _state.job;
  if (job) parts.push(renderJobCard(job));
  const pending = _state.live && _state.live.pending_proposal;
  if (pending && _state.view === 'edit') {
    parts.push(`<div class="cc2-tiers__banner cc2-tiers__banner--info" role="status">
      <div><strong>A proposal is awaiting approval</strong> — filed ${esc(when(pending.created_at))} by ${esc(who(pending.created_by))}${pending.notes ? ` · “${esc(pending.notes)}”` : ''}.
      Proposing again <strong>supersedes</strong> it.</div>
      <button class="admin-btn admin-btn--sm" data-action="open-review" data-id="${esc(pending.id)}">Review it</button>
    </div>`);
  }
  el.innerHTML = parts.join('');
}

function renderJobCard(job) {
  const c = job.counts || {};
  const counts = job.counts
    ? `<div class="cc2-tiers__jobcounts">
        <span>matched <strong>${int(c.matched)}</strong></span>
        <span>updated <strong>${int(c.updated)}</strong></span>
        <span>unchanged <strong>${int(c.unchanged)}</strong></span>
        <span>skipped (manual price) <strong>${int(c.skipped_frozen)}</strong></span>
        <span>skipped (ineligible) <strong>${int(c.skipped_ineligible)}</strong></span>
      </div>` : '';
  const packs = job.packs
    ? `<div class="cc2-tiers__checklist">
        <label><input type="checkbox" data-field="packs-done"> <strong>Follow-up: re-anchor packs.</strong> Value packs and multipacks are not repriced by a tier change. They stay on their old price until an operator runs:</label>
        <code class="cc2-tiers__code">${esc(job.packs.action_required || 'node scripts/repair-pack-prices.js --apply')}</code>
        ${job.packs.note ? `<p class="cc2-tiers__muted">${esc(job.packs.note)}</p>` : ''}
      </div>` : '';
  if (job.outcome === 'enqueue_failed') {
    return `<div class="cc2-tiers__banner cc2-tiers__banner--danger" role="alert">
      <div><strong>The new ladder IS live, but no reprice started.</strong> Shelf prices have not moved. ${esc(job.message || '')}</div>
      <button class="admin-btn admin-btn--sm admin-btn--primary" data-action="retry-reprice">${icon('refresh', 14, 14)} Retry reprice</button>
    </div>${packs}`;
  }
  if (job.outcome === 'completed') {
    return `<div class="cc2-tiers__banner cc2-tiers__banner--success" role="status">
      <div><strong>Live on the site.</strong> The reprice finished ${esc(when(job.finished_at))}.</div>
      <button class="admin-btn admin-btn--sm admin-btn--ghost" data-action="dismiss-job">Dismiss</button>
    </div>${counts}${packs}`;
  }
  if (job.outcome === 'failed' || job.outcome === 'missing') {
    return `<div class="cc2-tiers__banner cc2-tiers__banner--danger" role="alert">
      <div><strong>${job.outcome === 'missing' ? 'The reprice job could not be found' : 'The reprice failed'}</strong> — the ladder is live but shelf prices may not have moved. ${esc(job.error || '')} Job <code>${esc(job.id)}</code>.</div>
      <button class="admin-btn admin-btn--sm" data-action="retry-reprice">${icon('refresh', 14, 14)} Retry reprice</button>
    </div>${counts}`;
  }
  if (job.outcome === 'timeout') {
    return `<div class="cc2-tiers__banner cc2-tiers__banner--warn" role="status">
      <div><strong>Still repricing after 10 minutes</strong> (last status: ${esc(job.status || 'unknown')}). This is not a success yet. Job <code>${esc(job.id)}</code>.</div>
      <button class="admin-btn admin-btn--sm" data-action="poll-again">Check again</button>
    </div>${counts}${packs}`;
  }
  return `<div class="cc2-tiers__banner cc2-tiers__banner--info" role="status" aria-live="polite">
    <div><span class="admin-loading__spinner cc2-tiers__spin"></span> <strong>Repricing the catalogue</strong> (${esc(job.status || 'queued')}). The ladder is live, and shoppers see new prices once this job completes. Job <code>${esc(job.id)}</code>.</div>
  </div>${counts}${packs}`;
}

// ── Main: edit view ──────────────────────────────────────────────────────────
function renderMain() {
  const el = slot('main');
  if (!el) return;
  if (_state.loadError) {
    el.innerHTML = `<div class="admin-card cc2-tiers__banner cc2-tiers__banner--danger" role="alert">
      <div><strong>Could not load the live ladder.</strong> Editing is disabled, because a proposal built on a guessed ladder would describe changes nobody made. ${esc(_state.loadError)}</div>
      <button class="admin-btn admin-btn--sm" data-action="reload">Retry</button>
    </div>`;
    return;
  }
  if (!_state.live) {
    el.innerHTML = '<div class="admin-card cc2-tiers__loading"><div class="admin-loader"><div class="admin-loading__spinner"></div></div></div>';
    return;
  }
  if (_state.view === 'review') { renderReview(); return; }

  const owner = AdminAuth.isOwner();
  const brand = currentBrand();
  const brandOpts = _state.brands.map((b) => `<option value="${esc(b.id)}" ${b.id === _state.brandId ? 'selected' : ''}>${esc(b.name)}${liveBrandTable(b.id) ? ' • own ladder' : ''}</option>`).join('');
  const custom = _state.live.bands_are_custom || {};
  el.innerHTML = `
    <div class="cc2-tiers__layout">
      <section class="admin-card cc2-tiers__editor" aria-labelledby="cc2-tiers-title">
        <header class="cc2-section-header cc2-tiers__head">
          <h2 id="cc2-tiers-title">Margin tier multipliers</h2>
          <span class="cc2-tiers__muted">retail = cost × multiplier × 1.15 GST, then ending snap and floors. The simulator's price is the real answer.</span>
        </header>
        <div class="cc2-tiers__controls">
          <label class="cc2-field"><span>Brand</span>
            <select class="admin-select" data-field="brand">
              <option value="">All brands (catalogue table)</option>${brandOpts}
            </select></label>
          <label class="cc2-field"><span>Source</span>
            <select class="admin-select" data-field="source">
              ${EDITABLE_SOURCES.map((s) => `<option value="${s}" ${s === _state.source ? 'selected' : ''}>${SOURCE_LABEL[s]}${custom[s] ? ' (custom bands)' : ''}</option>`).join('')}
            </select></label>
          <div class="cc2-field"><span>Edit</span>
            <div class="cc-source-toggle" role="group" aria-label="Edit mode">
              <button class="cc-source-toggle__btn ${_state.mode === 'multipliers' ? 'active' : ''}" data-action="mode" data-mode="multipliers">Multipliers</button>
              <button class="cc-source-toggle__btn ${_state.mode === 'bands' ? 'active' : ''}" data-action="mode" data-mode="bands" ${brand ? 'disabled title="Cost boundaries are catalogue-wide; a brand sets multipliers inside them"' : ''}>Cost bands</button>
            </div></div>
          <label class="cc2-field"><span>Global offset (±${OFFSET_LIMIT})</span>
            <input class="admin-input cc2-tiers__num" type="number" step="0.005" min="${-OFFSET_LIMIT}" max="${OFFSET_LIMIT}" value="${esc(_state.draft.offset)}" data-field="offset" aria-describedby="cc2-offset-help">
            <small id="cc2-offset-help" class="cc2-tiers__muted">Added to every multiplier. Live: ${esc(offsetPct(_state.live.global_offset || 0))}</small></label>
          <label class="cc2-field cc2-field--checkbox"><input type="checkbox" data-field="include-overrides" ${_state.includeOverrides ? 'checked' : ''}> <span>Include rows with a manual retail price (shows what they would be; they are never repriced)</span></label>
        </div>
        ${brand ? renderBrandNote(brand) : ''}
        <div data-slot="validation"></div>
        <div class="admin-table-wrap"><table class="admin-table cc2-tiers__ladder" data-slot="ladder"></table></div>
        ${_state.mode === 'bands' && !brand ? `<div class="cc2-tiers__bandtools">
            <button class="admin-btn admin-btn--sm admin-btn--ghost" data-action="band-add">${icon('plus', 14, 14)} Add band</button>
            <span class="cc2-tiers__muted">Moving a boundary renames its band. Brand multipliers keyed to a band that no longer exists are refused (UNKNOWN_TIER_BAND).</span>
          </div>` : ''}
        <div class="cc2-tiers__actions">
          <button class="admin-btn admin-btn--ghost" data-action="discard">Discard changes</button>
          <button class="admin-btn admin-btn--ghost" data-action="reset-defaults" ${brand || _state.mode === 'bands' ? 'hidden' : ''} title="Fills this source's table with the ladder shipped in code — it is still only a proposal">Fill with shipped defaults</button>
          ${owner ? `<button class="admin-btn admin-btn--primary" data-action="propose">${icon('check', 14, 14)} Propose change…</button>` : '<span class="cc2-tiers__muted">Proposing needs a super_admin account.</span>'}
        </div>
        <p class="cc2-tiers__muted cc2-tiers__fineprint">Proposing moves no price. A proposal goes live only when it is approved, and approval reprices the whole catalogue. Automated repricing never lowers a live price.</p>
      </section>
      <section class="cc2-tiers__results" aria-live="polite">
        <div data-slot="metrics"></div>
        <div data-slot="sample"></div>
      </section>
    </div>`;
  renderLadder();
  renderValidation();
  renderMetrics();
  renderSample();
}

function renderBrandNote(brand) {
  const edit = _state.draft.brands[brand.id];
  const live = liveBrandTable(brand.id);
  const cleared = edit && edit.clear;
  return `<div class="cc2-tiers__banner cc2-tiers__banner--info">
    <div><strong>${esc(brand.name)}</strong>: ${cleared ? 'its own ladder will be <strong>removed</strong> if this proposal is approved. It then falls back to the catalogue table.' : live ? 'it has its own ladder. Bands it does not set inherit the catalogue value.' : 'it has no ladder of its own. Every band inherits the catalogue value until you set one here.'}
    Leave a band blank to inherit it.</div>
    ${live && !cleared ? `<button class="admin-btn admin-btn--sm admin-btn--ghost" data-action="brand-clear">Remove ${esc(brand.name)}'s ladder</button>` : ''}
    ${cleared ? '<button class="admin-btn admin-btn--sm admin-btn--ghost" data-action="brand-unclear">Keep it</button>' : ''}
  </div>`;
}

function renderLadder() {
  const table = slot('ladder');
  if (!table) return;
  const s = _state.source;
  const brand = currentBrand();
  const rows = activeBandRows();
  const keys = ladderKeys(rows);
  const defaults = (_state.live.defaults && _state.live.defaults[s]) || {};
  const liveEff = (_state.live.effective && _state.live.effective[s]) || {};
  const bandsMode = _state.mode === 'bands' && !brand;

  const head = `<thead><tr>
      <th>Band</th><th>Cost range${gstSub(GST_EXCL)}</th>
      <th class="num">${brand ? `${esc(brand.name)} multiplier` : 'Multiplier'}</th>
      <th class="num">${bandsMode ? 'Upper bound' : brand ? 'Catalogue' : 'Default'}</th>
      <th class="num">Products</th>
      <th class="num" title="Mean net margin after Stripe fees, now → at the table's price">Net margin now → after</th>
      <th class="num" title="Mean per-SKU retail change at the table's price">Price change</th>
      <th class="num" title="Rows this band will actually raise / rows priced lower that keep their price">Rises · keeps</th>
    </tr></thead>`;

  let prev = null;
  const body = rows.map((r, i) => {
    const key = keys[i];
    const range = costRange(prev, r.max_cost);
    prev = r.max_cost;
    let multCell;
    let refCell;
    if (bandsMode) {
      multCell = `<input class="admin-input cc2-tiers__num" type="number" step="0.005" min="${MULT_MIN}" max="${MULT_MAX}" value="${esc(r.mult)}" data-band-mult="${i}" aria-label="Multiplier for band ${i + 1}">`;
      refCell = i === rows.length - 1
        ? '<span class="cc2-tiers__muted">open-ended</span>'
        : `<label class="cc2-tiers__bound">≤ $<input class="admin-input cc2-tiers__num" type="number" step="1" min="0" value="${esc(r.max_cost)}" data-band-max="${i}" aria-label="Upper cost boundary for band ${i + 1}"></label>
           <button class="admin-btn admin-btn--sm admin-btn--ghost" data-action="band-remove" data-index="${i}" aria-label="Remove band ${esc(key)}" ${rows.length <= 2 ? 'disabled' : ''}>${icon('trash', 12, 12)}</button>`;
    } else if (brand) {
      const edit = (_state.draft.brands[brand.id] && _state.draft.brands[brand.id][s]) || {};
      const liveB = (liveBrandTable(brand.id) || {})[s] || {};
      const own = key in edit ? edit[key] : liveB[key];
      const cleared = _state.draft.brands[brand.id] && _state.draft.brands[brand.id].clear;
      multCell = `<input class="admin-input cc2-tiers__num" type="number" step="0.005" min="${MULT_MIN}" max="${MULT_MAX}" value="${own != null && !cleared ? esc(own) : ''}" placeholder="${esc(mult(_state.draft.catalogue[s][key]))} inherited" data-brand-key="${esc(key)}" aria-label="${esc(brand.name)} multiplier for ${esc(key)}" ${cleared ? 'disabled' : ''}>`;
      refCell = `<span class="cc2-tiers__muted">${esc(mult(liveEff[key]))}</span>`;
    } else {
      const v = _state.draft.catalogue[s][key];
      const changed = !sameMult(v, liveEff[key]);
      const overridden = defaults[key] != null && !sameMult(v, defaults[key]);
      multCell = `<input class="admin-input cc2-tiers__num ${changed ? 'is-changed' : ''}" type="number" step="0.005" min="${MULT_MIN}" max="${MULT_MAX}" value="${esc(v)}" data-tier="${esc(key)}" aria-label="Multiplier for ${esc(key)}">`;
      refCell = defaults[key] == null
        ? '<span class="cc2-tiers__muted">—</span>'
        : overridden
          ? `<span class="cc2-tiers__muted">${esc(mult(defaults[key]))}</span> <button class="admin-btn admin-btn--sm admin-btn--ghost" data-action="reset-band" data-key="${esc(key)}" title="Propose the shipped default for this band">reset</button>`
          : `<span class="cc2-tiers__muted">${esc(mult(defaults[key]))}</span>`;
    }
    return `<tr data-row-key="${esc(key)}" data-row-index="${i}">
      <td class="cell-mono" data-key-cell="${i}">${esc(key)}</td>
      <td class="cc2-tiers__muted" data-range-cell="${i}">${esc(range)}</td>
      <td class="num">${multCell}</td>
      <td class="num">${refCell}</td>
      <td class="num" data-stat="products">—</td>
      <td class="num" data-stat="margin">—</td>
      <td class="num" data-stat="change">—</td>
      <td class="num" data-stat="rises">—</td>
    </tr>`;
  }).join('');
  table.innerHTML = head + `<tbody>${body}</tbody>`;
  paintBandStats();
}

// Refresh the key/range cells in bands mode without re-rendering the inputs
// (a re-render would drop focus mid-typing).
function paintKeys() {
  const rows = activeBandRows();
  const keys = ladderKeys(rows);
  let prev = null;
  rows.forEach((r, i) => {
    const k = _host.querySelector(`[data-key-cell="${i}"]`);
    const rg = _host.querySelector(`[data-range-cell="${i}"]`);
    const tr = _host.querySelector(`tr[data-row-index="${i}"]`);
    if (k) k.textContent = keys[i];
    if (rg) rg.textContent = costRange(prev, r.max_cost);
    if (tr) tr.dataset.rowKey = keys[i];
    prev = r.max_cost;
  });
}

function paintBandStats() {
  if (!_host) return;
  const s = _state.source;
  const rows = _state.sim ? attributeBands(_state.sim, _state.baseline) : [];
  const idx = new Map(rows.filter((r) => r.source === s).map((r) => [r.tier, r]));
  _host.querySelectorAll('tr[data-row-key]').forEach((tr) => {
    const r = idx.get(tr.dataset.rowKey);
    const set = (name, html) => { const c = tr.querySelector(`[data-stat="${name}"]`); if (c) c.innerHTML = html; };
    if (!r) {
      const txt = _state.simLoading ? '…' : '—';
      ['products', 'margin', 'change', 'rises'].forEach((n) => set(n, `<span class="cc2-tiers__muted">${txt}</span>`));
      return;
    }
    set('products', int(r.products));
    set('margin', `${pct(r.avg_net_margin_before_pct, 1)} → <strong>${pct(r.avg_net_margin_after_pct, 1)}</strong>`);
    set('change', `<span class="${r.avg_retail_change_pct > 0 ? 'cc2-pricing__delta--up' : ''}">${signedPct(r.avg_retail_change_pct, 2)}</span>`);
    set('rises', `${int(r.products_increasing)} · <span class="${r.blocked_by_no_decrease ? 'cc2-tiers__warntext' : ''}">${int(r.blocked_by_no_decrease)}</span>`);
  });
}

function renderValidation() {
  const el = slot('validation');
  if (!el) return;
  const errs = _state.validation.filter((e) => e.reason !== 'no_change');
  el.innerHTML = errs.length
    ? `<div class="cc2-tiers__banner cc2-tiers__banner--danger" role="alert"><div><strong>Not simulated. Fix these first</strong> (the simulator would quietly ignore them and show “no change”):<ul>${errs.map((e) => `<li>${e.source ? `${esc(SOURCE_LABEL[e.source] || e.source)}: ` : ''}${esc(e.message || e.reason)}</li>`).join('')}</ul></div></div>`
    : '';
}

// ── Metrics strip ────────────────────────────────────────────────────────────
function renderMetrics() {
  const el = slot('metrics');
  if (!el) return;
  if (_state.simError) {
    el.innerHTML = `<div class="admin-card cc2-tiers__banner cc2-tiers__banner--danger" role="alert"><div><strong>No current preview.</strong> ${esc(_state.simError)}</div>
      <button class="admin-btn admin-btn--sm" data-action="resimulate">Retry</button></div>`;
    return;
  }
  const sim = _state.sim;
  if (!sim) {
    el.innerHTML = `<div class="admin-card cc2-tiers__metrics"><div class="admin-loader"><div class="admin-loading__spinner"></div></div></div>`;
    return;
  }
  el.innerHTML = metricsHtml(sim, _state.baseline, { dirty: draftDirty(), loading: _state.simLoading, scope: scopeLabel() });
}

function scopeLabel() {
  const brand = currentBrand();
  return `${brand ? esc(brand.name) : 'Whole catalogue'} · genuine + compatible singles${_state.includeOverrides ? ' · including manual-price rows' : ''}`;
}

// Shared by the edit strip and the review card.
function metricsHtml(sim, baseline, { dirty = true, loading = false, scope = '' } = {}) {
  const a = sim.aggregate || {};
  const att = attribute(sim, baseline);
  const rat = ratchetSummary(sim);
  const brandRows = (sim.by_brand || []).map((b) => `<tr>
      <td>${esc(b.name || b.slug || b.brand_id)}</td><td class="num">${int(b.products)}</td>
      <td class="num">${int(b.products_increasing)}</td><td class="num">${int(b.blocked_by_no_decrease)}</td>
      <td class="num">${pct(b.avg_net_margin_before_pct)} → ${pct(b.avg_net_margin_after_pct)}</td>
      <td class="num">${signedPct(b.avg_retail_change_pct)}</td><td class="num">${signedMoney(b.net_profit_per_unit_delta)}</td></tr>`).join('');
  const editLine = !att.available
    ? '<span class="cc2-tiers__muted">Drift baseline unavailable. The figures below mix this edit with pending drift.</span>'
    : !dirty
      ? '<span>No edit yet. These figures are the <strong>drift</strong> a reprice would apply to the live ladder today.</span>'
      : `<span><strong>This edit alone:</strong> ${signedInt(att.edit_will_change)} SKUs will move · ${signedMoney(att.edit.net_profit_per_unit_after)} net profit per unit · ${signedInt(att.edit_blocked)} newly held by the ratchet.</span>`;
  const driftLine = att.available && att.drift.will_change_skus
    ? `<p class="cc2-tiers__muted cc2-tiers__drift">Approving reprices the <strong>whole catalogue</strong>, not only these bands. With no edit at all, ${int(att.drift.will_change_skus)} SKUs would still rise (supplier-cost drift since the last reprice). That is included in “will change” above.</p>`
    : '';
  return `<div class="admin-card cc2-tiers__metrics ${loading ? 'is-loading' : ''}">
    <header class="cc2-section-header"><h3>Impact${loading ? ' <span class="cc2-tiers__muted">updating…</span>' : ''}</h3><span class="cc2-tiers__muted">${scope}</span></header>
    <div class="cc2-tiers__editline">${editLine}</div>
    <div class="admin-kpi-grid admin-kpi-grid--4">
      <div class="admin-kpi"><div class="admin-kpi__label">SKUs priced by this table</div><div class="admin-kpi__value">${int(sim.affected)}</div></div>
      <div class="admin-kpi"><div class="admin-kpi__label">Will change</div><div class="admin-kpi__value">${int(rat.willChange)}</div><div class="admin-kpi__sub">${int(a.total_skus_with_increase)} rise · ${int(a.total_skus_unchanged)} unchanged</div></div>
      <div class="admin-kpi"><div class="admin-kpi__label">Avg net margin after Stripe fees</div><div class="admin-kpi__value">${pct(a.avg_net_margin_before)} → ${pct(a.avg_net_margin_after)}</div><div class="admin-kpi__sub">“after” is at the table's price</div></div>
      <div class="admin-kpi"><div class="admin-kpi__label">Net profit per unit Δ</div><div class="admin-kpi__value">${signedMoney(a.net_profit_per_unit_delta)}</div><div class="admin-kpi__sub">one unit of each SKU. Not revenue, not a forecast</div></div>
    </div>
    <div class="cc2-tiers__minor">
      <span>Avg retail change ${signedPct(a.avg_retail_change_pct)}</span>
      <span>Catalogue value (sum of retail, incl. GST) ${money(a.catalogue_value_before)} → ${money(a.catalogue_value_after)}</span>
      <span>Below 5% survival floor: ${int(a.below_survival_floor_before)} → <strong class="${a.below_survival_floor_after > a.below_survival_floor_before ? 'cc2-tiers__warntext' : ''}">${int(a.below_survival_floor_after)}</strong></span>
      ${sim.global_offset_applied != null ? `<span>Offset in these figures ${offsetPct(sim.global_offset_applied)}</span>` : ''}
    </div>
    ${rat.warning ? `<div class="cc2-tiers__banner cc2-tiers__banner--warn" role="status"><div><strong>No-decrease ratchet:</strong> ${esc(rat.warning)}
      <br><span class="cc2-tiers__muted">The “after” margin, value and profit figures above still count these ${int(rat.blocked)} rows at the lower table price. Delivered figures will be higher by that amount.</span></div></div>` : ''}
    ${driftLine}
    ${brandRows ? `<div class="admin-table-wrap"><table class="admin-table cc2-pricing__table"><thead><tr><th>Brand ladder</th><th class="num">Products</th><th class="num">Rise</th><th class="num">Keep</th><th class="num">Net margin</th><th class="num">Price Δ</th><th class="num">Profit/unit Δ</th></tr></thead><tbody>${brandRows}</tbody></table></div>` : ''}
    <p class="cc2-tiers__muted cc2-tiers__fineprint">Net margin = profit after GST and Stripe ${(STRIPE_RATE * 100).toFixed(2)}% as a share of ex-GST revenue. There is no sales-volume weighting anywhere in these figures. Generated ${esc(when(sim.generated_at))}.</p>
  </div>`;
}

// ── Sample table ─────────────────────────────────────────────────────────────
function renderSample() {
  const el = slot('sample');
  if (!el) return;
  const sim = _state.sim;
  if (!sim || _state.simError) { el.innerHTML = ''; return; }
  // Rows that move (or are held) first: a 25-row sample of a 3,000-SKU
  // catalogue is mostly "unchanged", which hides what the edit does.
  const ORDER = { rises: 0, keeps: 1, falls: 2, unchanged: 3 };
  const all = (sim.sample || []).slice().sort((x, y) => ORDER[rowOutcome(x).kind] - ORDER[rowOutcome(y).kind]);
  const rows = all.slice(0, SAMPLE_RENDER_CAP);
  const more = _state.sampleLimit < FULL_PREVIEW_LIMIT && all.length < (sim.affected || 0);
  el.innerHTML = `<div class="admin-card">
    <header class="cc2-section-header"><h3>Sample (${int(all.length)} of ${int(sim.affected)})</h3>
      ${more ? '<button class="admin-btn admin-btn--sm admin-btn--ghost" data-action="sample-all">Show the full list</button>' : ''}</header>
    <div class="admin-table-wrap"><table class="admin-table cc2-pricing__table">
      <thead><tr><th>SKU</th><th>Brand</th><th>Band</th>
        <th class="num">Cost${gstSub(GST_EXCL)}</th><th class="num">Now${gstSub(GST_INCL)}</th>
        <th class="num">What happens${gstSub(GST_INCL)}</th>
        <th class="num">Net margin</th><th class="num">Gross markup${gstSub(GST_EXCL)}</th></tr></thead>
      <tbody>${rows.map(sampleRowHtml).join('') || '<tr><td colspan="8" class="cc2-tiers__muted">No rows in scope.</td></tr>'}</tbody>
    </table></div>
    ${all.length > SAMPLE_RENDER_CAP ? `<p class="cc2-pricing__truncated">Showing the first ${SAMPLE_RENDER_CAP} of ${int(all.length)} rows.</p>` : ''}
  </div>`;
}

function sampleRowHtml(r) {
  const o = rowOutcome(r);
  let what;
  if (o.kind === 'rises') what = `<strong>${money(o.price)}</strong> <span class="cc2-pricing__pill cc2-pricing__delta--up">+${money(o.delta)}</span>`;
  else if (o.kind === 'keeps') what = `keeps ${money(o.price)} <span class="cc2-tiers__pill--keep" title="The table prices it at ${esc(money(o.engine))}; automated repricing never lowers a live price">table ${money(o.engine)}</span>`;
  else if (o.kind === 'falls') what = `<span class="cc2-tiers__warntext">${money(o.price)} (${signedMoney(o.delta)}, not held by the ratchet)</span>`;
  else what = '<span class="cc2-tiers__muted">unchanged</span>';
  const kept = o.kind === 'keeps';
  return `<tr>
    <td><span class="cell-mono">${esc(r.sku)}</span>${r.priced_by_brand_ladder ? ' <span class="cc2-tiers__chip" title="Priced by its brand\'s own ladder">brand ladder</span>' : ''}</td>
    <td>${esc(r.brand || '—')}</td><td class="cell-mono">${esc(r.tier || '—')}</td>
    <td class="num">${money(r.cost_price)}</td><td class="num">${money(r.current_retail)}</td>
    <td class="num">${what}</td>
    <td class="num">${pct(r.current_net_margin_pct, 1)} → ${kept ? '<span class="cc2-tiers__muted">same</span>' : `<strong>${pct(r.new_net_margin_pct, 1)}</strong>`}</td>
    <td class="num">${pct(r.gross_markup_before_pct, 1)} → ${kept ? '<span class="cc2-tiers__muted">same</span>' : `<strong>${pct(r.gross_markup_after_pct, 1)}</strong>`}</td>
  </tr>`;
}

// ── Simulation ───────────────────────────────────────────────────────────────
function scheduleSimulate() {
  clearTimeout(_simTimer);
  _simTimer = setTimeout(runSimulate, SIM_DEBOUNCE_MS);
}

async function runSimulate() {
  if (!_host || !_state.live) return;
  const check = buildProposeBody(_state.draft, _state.live, null);
  _state.validation = check.errors || [];
  renderValidation();
  if (_state.validation.some((e) => e.reason !== 'no_change')) return;

  const brand = currentBrand();
  const opts = {
    includeOverrides: _state.includeOverrides,
    previewLimit: _state.sampleLimit,
    brandSlug: brand ? brand.slug : undefined,
    brandsMeta: brandsMeta(),
  };
  const body = buildSimulateBody(_state.draft, _state.live, opts);
  const baseBody = baselineSimulateBody(body, _state.live);
  const baseKey = JSON.stringify(baseBody);
  const dirty = !(check.errors || []).some((e) => e.reason === 'no_change');

  // API.request drops AbortSignal, so a slower earlier response is discarded
  // by sequence number instead of cancelled.
  const seq = ++_state.simSeq;
  _state.simLoading = true;
  _state.simError = null;
  renderMetrics(); paintBandStats();
  try {
    const needBaseline = _state.baselineKey !== baseKey;
    const [sim, baseline] = await Promise.all([
      dirty ? AdminAPI.controlCenter.simulatePricing(body) : null,
      needBaseline ? AdminAPI.controlCenter.simulatePricing(baseBody) : _state.baseline,
    ]);
    if (!_host || seq !== _state.simSeq) return;
    _state.baseline = baseline;
    _state.baselineKey = baseKey;
    // No edit: the baseline IS the answer, so the strip reads it as drift.
    _state.sim = dirty ? sim : baseline;
  } catch (e) {
    if (!_host || seq !== _state.simSeq) return;
    _state.simError = errorMessage(e);
  } finally {
    if (_host && seq === _state.simSeq) {
      _state.simLoading = false;
      renderMetrics(); renderSample(); paintBandStats();
    }
  }
}

// ── Events ───────────────────────────────────────────────────────────────────
function onInput(e) {
  const t = e.target;
  const s = _state.source;
  if (t.dataset.tier) {
    const v = parseFloat(t.value);
    if (Number.isFinite(v)) _state.draft.catalogue[s][t.dataset.tier] = v;
    t.classList.toggle('is-changed', !sameMult(v, (_state.live.effective[s] || {})[t.dataset.tier]));
    scheduleSimulate();
  } else if (t.dataset.brandKey) {
    const id = _state.brandId;
    const edit = (_state.draft.brands[id] = _state.draft.brands[id] || {});
    const map = (edit[s] = edit[s] || {});
    const v = parseFloat(t.value);
    if (t.value === '') {
      // Blank = inherit. A band that has a live brand value cannot be removed
      // one at a time (the contract has only clear:true for the whole ladder),
      // so a blank on such a band keeps the live value and says so.
      const liveB = ((liveBrandTable(id) || {})[s] || {})[t.dataset.brandKey];
      delete map[t.dataset.brandKey];
      if (liveB != null) Toast.info('A single brand band cannot be un-set. Use “Remove ladder”, or type the catalogue value.');
    } else if (Number.isFinite(v)) {
      map[t.dataset.brandKey] = v;
    }
    scheduleSimulate();
  } else if (t.dataset.bandMult != null || t.dataset.bandMax != null) {
    const rows = ensureDraftBands();
    const i = Number(t.dataset.bandMult ?? t.dataset.bandMax);
    const v = parseFloat(t.value);
    if (t.dataset.bandMult != null) rows[i].mult = Number.isFinite(v) ? v : NaN;
    else rows[i].max_cost = Number.isFinite(v) ? v : NaN;
    paintKeys();
    scheduleSimulate();
  } else if (t.dataset.field === 'offset') {
    const v = parseFloat(t.value);
    _state.draft.offset = Number.isFinite(v) ? v : NaN;
    scheduleSimulate();
  }
}

function onChange(e) {
  const t = e.target;
  const f = t.dataset.field;
  if (f === 'brand') {
    _state.brandId = t.value;
    if (_state.brandId && _state.mode === 'bands') _state.mode = 'multipliers';
    renderMain();
    scheduleSimulate();
  } else if (f === 'source') {
    _state.source = t.value;
    renderMain();
  } else if (f === 'include-overrides') {
    _state.includeOverrides = t.checked;
    scheduleSimulate();
  } else if (f === 'history-status') {
    _state.historyStatus = t.value;
    loadHistory();
  }
}

function ensureDraftBands() {
  const s = _state.source;
  if (!_state.draft.bands[s]) _state.draft.bands[s] = bandsFromServer(_state.live.bands[s]).map((r) => ({ max_cost: r.max_cost, mult: r.mult }));
  return _state.draft.bands[s];
}

async function onClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn || !_host.contains(btn) || btn.disabled) return;
  const a = btn.dataset.action;
  const s = _state.source;
  switch (a) {
    case 'mode':
      _state.mode = btn.dataset.mode;
      renderMain();
      break;
    case 'reset-band':
      _state.draft.catalogue[s][btn.dataset.key] = _state.live.defaults[s][btn.dataset.key];
      renderLadder(); scheduleSimulate();
      break;
    case 'reset-defaults':
      for (const k of Object.keys(_state.draft.catalogue[s])) {
        if (_state.live.defaults[s] && _state.live.defaults[s][k] != null) _state.draft.catalogue[s][k] = _state.live.defaults[s][k];
      }
      renderLadder(); scheduleSimulate();
      break;
    case 'band-add': {
      const rows = ensureDraftBands();
      const lastClosed = rows.length >= 2 ? Number(rows[rows.length - 2].max_cost) : 0;
      const open = rows[rows.length - 1];
      rows.splice(rows.length - 1, 0, { max_cost: Math.round((lastClosed || 10) * 1.5), mult: open.mult });
      renderLadder(); scheduleSimulate();
      break;
    }
    case 'band-remove': {
      const rows = ensureDraftBands();
      rows.splice(Number(btn.dataset.index), 1);
      renderLadder(); scheduleSimulate();
      break;
    }
    case 'brand-clear':
      _state.draft.brands[_state.brandId] = { clear: true };
      renderMain(); scheduleSimulate();
      break;
    case 'brand-unclear':
      delete _state.draft.brands[_state.brandId];
      renderMain(); scheduleSimulate();
      break;
    case 'discard':
      _state.draft = draftFromLive(_state.live);
      renderMain(); scheduleSimulate();
      break;
    case 'sample-all':
      _state.sampleLimit = FULL_PREVIEW_LIMIT;
      _state.baselineKey = null; // the baseline carries preview_limit too
      runSimulate();
      break;
    case 'resimulate':
      runSimulate();
      break;
    case 'propose':
      openProposeDialog();
      break;
    case 'open-review':
      openReview(btn.dataset.id);
      break;
    case 'back-to-edit':
      _state.view = 'edit'; _state.review = null;
      renderStatus(); renderMain(); scheduleSimulate();
      break;
    case 'approve':
      openApproveDialog();
      break;
    case 'reject':
      openRejectDialog();
      break;
    case 'retry-reprice':
      retryReprice(btn);
      break;
    case 'poll-again':
      if (_state.job) startPolling(_state.job.id, _state.job.packs);
      break;
    case 'dismiss-job':
      _state.job = null; renderStatus();
      break;
    case 'reload':
      loadLive();
      break;
    case 'history-view':
      openReview(btn.dataset.id);
      break;
    default:
  }
}

// ── Propose ──────────────────────────────────────────────────────────────────
function changeSummaryHtml(body) {
  const items = [];
  for (const src of EDITABLE_SOURCES) {
    if (body[src]) for (const [k, v] of Object.entries(body[src])) {
      const live = (_state.live.effective[src] || {})[k];
      items.push(`<tr><td>${esc(SOURCE_LABEL[src])}</td><td class="cell-mono">${esc(k)}</td><td class="num cell-mono">${esc(mult(live))}</td><td class="num cell-mono"><strong>${esc(mult(v))}</strong></td></tr>`);
    }
  }
  if (body.bands) for (const [src, rows] of Object.entries(body.bands)) {
    items.push(`<tr><td>${esc(SOURCE_LABEL[src])}</td><td colspan="3">New cost bands: <span class="cell-mono">${esc(ladderKeys(rows).join(' · '))}</span></td></tr>`);
  }
  if (body.brands) for (const b of body.brands) {
    const name = (_state.brands.find((x) => x.id === b.brand_id) || {}).name || b.brand_id;
    if (b.clear) { items.push(`<tr><td>${esc(name)}</td><td colspan="3">Remove its own ladder</td></tr>`); continue; }
    for (const src of EDITABLE_SOURCES) if (b[src]) for (const [k, v] of Object.entries(b[src])) {
      items.push(`<tr><td>${esc(name)} · ${esc(SOURCE_LABEL[src])}</td><td class="cell-mono">${esc(k)}</td><td class="num cell-mono">—</td><td class="num cell-mono"><strong>${esc(mult(v))}</strong></td></tr>`);
    }
  }
  if (body.global_offset != null) {
    items.push(`<tr><td>Global offset</td><td></td><td class="num cell-mono">${esc(offsetPct(_state.live.global_offset || 0))}</td><td class="num cell-mono"><strong>${esc(offsetPct(body.global_offset))}</strong></td></tr>`);
  }
  return `<div class="admin-table-wrap"><table class="admin-table" style="margin:0"><thead><tr><th>Table</th><th>Band</th><th class="num">Live</th><th class="num">Proposed</th></tr></thead><tbody>${items.join('')}</tbody></table></div>`;
}

function openProposeDialog() {
  const built = buildProposeBody(_state.draft, _state.live, null);
  if (!built.ok) {
    const errs = built.errors;
    _state.validation = errs;
    renderValidation();
    Toast.warning(errs[0].reason === 'no_change' ? 'Nothing differs from the live ladder.' : 'Fix the highlighted problems first.');
    return;
  }
  const pending = _state.live.pending_proposal;
  const rat = ratchetSummary(_state.sim);
  const m = Modal.open({
    title: 'Propose this change?',
    body: `<p class="cc2-tiers__muted" style="margin:0 0 10px">This files a <strong>proposal</strong>. No price moves until someone approves it.</p>
      ${pending ? `<div class="cc2-tiers__banner cc2-tiers__banner--warn"><div>It <strong>supersedes</strong> the proposal filed ${esc(when(pending.created_at))}${pending.notes ? ` (“${esc(pending.notes)}”)` : ''}. That one can no longer be approved.</div></div>` : ''}
      ${changeSummaryHtml(built.body)}
      ${rat.warning ? `<p class="cc2-tiers__warntext" style="margin:10px 0 0">${esc(rat.warning)}</p>` : ''}
      <div class="admin-form-group" style="margin-top:12px"><label for="cc2-propose-notes">Why (shown to the approver)</label>
        <input id="cc2-propose-notes" class="admin-input" style="width:100%" maxlength="500" placeholder="e.g. Recover margin on mid-cost genuine toner"></div>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="confirm">${pending ? 'Supersede and propose' : 'Propose'}</button>`,
  });
  if (!m) return;
  m.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => m.close());
  const go = m.footer.querySelector('[data-action="confirm"]');
  go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = 'Proposing…';
    const notes = m.body.querySelector('#cc2-propose-notes').value.trim();
    try {
      const body = buildProposeBody(_state.draft, _state.live, notes).body;
      const data = await AdminAPI.controlCenter.proposeTierMultipliers(body);
      if (!_host) return;
      m.close();
      Toast.success('Proposed. It is awaiting approval, and no price has moved.');
      await loadLive({ keepDraft: false });
      const id = data && data.proposal && data.proposal.id;
      if (id) openReview(id);
    } catch (err) {
      Toast.error(errorMessage(err));
      go.disabled = false; go.textContent = pending ? 'Supersede and propose' : 'Propose';
    }
  });
}

// ── Review ───────────────────────────────────────────────────────────────────
async function openReview(id) {
  _state.view = 'review';
  _state.review = null;
  _state.reviewError = null;
  clearTimeout(_simTimer);
  renderStatus(); renderMain();
  try {
    const data = await AdminAPI.controlCenter.getTierProposal(id);
    if (!_host) return;
    _state.review = data;
    // Drift baseline for the review impact: the live ladder, whole catalogue.
    if (data && data.proposal && data.proposal.status === 'pending') {
      try {
        const base = await AdminAPI.controlCenter.simulatePricing(baselineSimulateBody({ scope: { include_overrides: false }, proposed_tiers: {}, preview_limit: 1 }, _state.live));
        if (_host) _state.reviewBaseline = base;
      } catch { _state.reviewBaseline = null; }
    }
  } catch (err) {
    if (!_host) return;
    _state.reviewError = errorMessage(err);
  }
  renderMain();
}

function renderReview() {
  const el = slot('main');
  if (_state.reviewError) {
    el.innerHTML = `<div class="admin-card cc2-tiers__banner cc2-tiers__banner--danger" role="alert"><div>${esc(_state.reviewError)}</div>
      <button class="admin-btn admin-btn--sm" data-action="back-to-edit">Back to the ladder</button></div>`;
    return;
  }
  const d = _state.review;
  if (!d) { el.innerHTML = '<div class="admin-card cc2-tiers__loading"><div class="admin-loader"><div class="admin-loading__spinner"></div></div></div>'; return; }
  const p = d.proposal || {};
  const pending = p.status === 'pending';
  const owner = AdminAuth.isOwner();
  const impact = d.impact || p.impact || null;
  const diff = diffLadders(p, _state.live);
  const approveDisabled = !pending || d.stale || !owner;
  el.innerHTML = `<section class="admin-card cc2-tiers__review" aria-labelledby="cc2-review-title">
    <header class="cc2-section-header cc2-tiers__head">
      <h2 id="cc2-review-title">Proposal <span class="cc2-tiers__status cc2-tiers__status--${esc(p.status || 'unknown')}">${esc(STATUS_LABEL[p.status] || p.status || 'unknown')}</span></h2>
      <button class="admin-btn admin-btn--sm admin-btn--ghost" data-action="back-to-edit">← Back to the ladder</button>
    </header>
    <dl class="cc2-tiers__meta">
      <div><dt>Filed</dt><dd>${esc(when(p.created_at))} by ${esc(who(p.created_by))}</dd></div>
      ${p.notes ? `<div><dt>Why</dt><dd>${esc(p.notes)}</dd></div>` : ''}
      ${p.reviewed_at ? `<div><dt>${esc(STATUS_LABEL[p.status] || 'Reviewed')}</dt><dd>${esc(when(p.reviewed_at))} by ${esc(who(p.reviewed_by))}${p.review_notes ? ` · “${esc(p.review_notes)}”` : ''}</dd></div>` : ''}
      ${p.applied_at ? `<div><dt>Applied</dt><dd>${esc(when(p.applied_at))}${p.reprice_job_id ? ` · job <code>${esc(p.reprice_job_id)}</code>` : ''}</dd></div>` : ''}
    </dl>
    ${d.stale ? `<div class="cc2-tiers__banner cc2-tiers__banner--danger" role="alert"><div><strong>Stale.</strong> Someone changed the live ladder after this was filed, so approving it is refused. Re-propose from the current ladder.</div></div>` : ''}
    <h3 class="cc2-tiers__h3">What it changes</h3>
    ${diffTableHtml(diff)}
    <h3 class="cc2-tiers__h3">${pending ? 'Impact, measured now' : 'Impact, as stored on the proposal'}</h3>
    ${impact ? metricsHtml(impact, pending ? _state.reviewBaseline : null, { scope: pending ? 'Re-measured on open because supplier costs move' : 'Snapshot' }) : '<p class="cc2-tiers__muted">No impact figures were returned for this proposal.</p>'}
    ${pending ? `<div class="cc2-tiers__actions">
      <button class="admin-btn admin-btn--ghost" data-action="reject" ${owner ? '' : 'disabled'}>Reject</button>
      <button class="admin-btn admin-btn--primary" data-action="approve" ${approveDisabled ? 'disabled' : ''} ${d.stale ? 'title="Stale: the live ladder changed after this proposal was filed"' : ''}>${icon('check', 14, 14)} Approve and reprice…</button>
    </div>` : ''}
  </section>`;
}

function diffTableHtml(diff) {
  if (!diff.length) return '<p class="cc2-tiers__muted">No differences from the live ladder (it may already be applied).</p>';
  const rows = diff.map((r) => {
    if (r.scope === 'bands') return `<tr><td>${esc(SOURCE_LABEL[r.source] || r.source)}</td><td colspan="3">New cost bands: <span class="cell-mono">${esc(r.key)}</span></td></tr>`;
    if (r.scope === 'offset') return `<tr><td>Global offset</td><td></td><td class="num cell-mono">${r.live == null ? '—' : esc(offsetPct(r.live))}</td><td class="num cell-mono"><strong>${esc(offsetPct(r.proposed))}</strong></td></tr>`;
    const label = r.scope === 'brand' ? `${esc(r.brand)} · ${esc(SOURCE_LABEL[r.source] || r.source)}` : esc(SOURCE_LABEL[r.source] || r.source);
    const lower = r.live != null && r.proposed < r.live;
    return `<tr><td>${label}</td><td class="cell-mono">${esc(r.key)}</td><td class="num cell-mono">${esc(mult(r.live))}</td>
      <td class="num cell-mono"><strong>${esc(mult(r.proposed))}</strong>${lower ? ' <span class="cc2-tiers__warntext" title="A lower multiplier does not lower live prices">↓ ratchet</span>' : ''}</td></tr>`;
  }).join('');
  return `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Table</th><th>Band</th><th class="num">Live</th><th class="num">Proposed</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// Approve: ALWAYS re-read the proposal first (contract §8). A dialog built on
// figures from when the page opened can approve a proposal that went stale.
async function openApproveDialog() {
  const id = _state.review && _state.review.proposal && _state.review.proposal.id;
  if (!id) return;
  let fresh;
  try {
    fresh = await AdminAPI.controlCenter.getTierProposal(id);
  } catch (err) { Toast.error(errorMessage(err)); return; }
  if (!_host) return;
  _state.review = fresh;
  if (fresh.stale || (fresh.proposal && fresh.proposal.status !== 'pending')) {
    renderMain();
    Toast.warning(fresh.stale ? 'This proposal went stale and can no longer be approved.' : 'This proposal is no longer pending.');
    return;
  }
  const impact = fresh.impact || {};
  const rat = ratchetSummary(impact);
  const att = attribute(impact, _state.reviewBaseline);
  const a = impact.aggregate || {};
  const m = Modal.open({
    title: 'Approve and reprice the catalogue?',
    body: `<p style="margin:0 0 8px">Approving makes this ladder <strong>live now</strong> and starts a <strong>full-catalogue reprice</strong>. Shoppers see new prices once the job completes, usually within a couple of minutes.</p>
      <div class="cc2-tiers__banner cc2-tiers__banner--warn"><div><strong>This cannot be undone with a second click.</strong> Automated repricing never lowers a price, so undoing an increase means setting a manual retail price on each product.</div></div>
      <ul class="cc2-tiers__facts">
        <li><strong>${int(impact.affected)}</strong> SKUs are priced by this table</li>
        <li><strong>${int(rat.willChange)}</strong> will change price${att.available && att.drift.will_change_skus ? `, including <strong>${int(att.drift.will_change_skus)}</strong> from cost drift that any reprice would apply` : ''}</li>
        <li><strong>${int(rat.blocked)}</strong> are priced lower by this table and will <strong>keep</strong> their current price</li>
        <li>Net profit per unit Δ <strong>${signedMoney(a.net_profit_per_unit_delta)}</strong> (one unit of each SKU)</li>
        <li>Below the 5% survival floor after: <strong>${int(a.below_survival_floor_after)}</strong></li>
        <li>Value packs and multipacks do <strong>not</strong> move. They need a manual re-anchor afterwards.</li>
      </ul>
      <div class="admin-form-group"><label for="cc2-approve-notes">Approval notes (optional)</label>
        <input id="cc2-approve-notes" class="admin-input" style="width:100%" maxlength="500"></div>
      <label class="cc2-field cc2-field--checkbox"><input type="checkbox" id="cc2-approve-ack"> <span>I have read the impact and I want these prices live.</span></label>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="confirm" disabled>Approve and reprice</button>`,
  });
  if (!m) return;
  const go = m.footer.querySelector('[data-action="confirm"]');
  m.body.querySelector('#cc2-approve-ack').addEventListener('change', (e) => { go.disabled = !e.target.checked; });
  m.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => m.close());
  go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = 'Approving…';
    try {
      const data = await AdminAPI.controlCenter.approveTierProposal(id, m.body.querySelector('#cc2-approve-notes').value.trim());
      if (!_host) return;
      m.close();
      handleApproved(data);
    } catch (err) {
      Toast.error(errorMessage(err));
      go.textContent = 'Approve and reprice';
      if (err && (err.code === 'PROPOSAL_STALE' || err.code === 'PROPOSAL_NOT_PENDING')) { m.close(); openReview(id); return; }
      go.disabled = false;
    }
  });
}

function handleApproved(data) {
  const r = (data && data.reprice) || {};
  const packs = (data && data.packs) || null;
  if (r.status === 'queued' && r.job_id) {
    Toast.success('Approved. The ladder is live and the catalogue is repricing.');
    startPolling(r.job_id, packs);
  } else if (r.status === 'enqueue_failed') {
    Toast.error('Approved, but the reprice did not start. Shelf prices have not moved.');
    _state.job = { id: r.job_id || null, outcome: 'enqueue_failed', message: r.message, packs };
  } else {
    // skipped (or a shape we do not know): say exactly what the server said.
    Toast.info(r.message || `Approved. Reprice status: ${r.status || 'not reported'}.`);
    _state.job = r.job_id ? { id: r.job_id, status: r.status, outcome: 'running', packs } : null;
    if (r.job_id) startPolling(r.job_id, packs);
  }
  _state.view = 'edit';
  _state.review = null;
  loadLive();
}

function openRejectDialog() {
  const id = _state.review && _state.review.proposal && _state.review.proposal.id;
  if (!id) return;
  const m = Modal.open({
    title: 'Reject this proposal?',
    body: `<p style="margin:0 0 10px">Nothing changes on the store. The proposal is kept in the history as rejected.</p>
      <div class="admin-form-group"><label for="cc2-reject-notes">Reason (optional)</label>
      <input id="cc2-reject-notes" class="admin-input" style="width:100%" maxlength="500"></div>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--danger" data-action="confirm">Reject</button>`,
  });
  if (!m) return;
  m.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => m.close());
  const go = m.footer.querySelector('[data-action="confirm"]');
  go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = 'Rejecting…';
    try {
      await AdminAPI.controlCenter.rejectTierProposal(id, m.body.querySelector('#cc2-reject-notes').value.trim());
      if (!_host) return;
      m.close();
      Toast.success('Rejected. Nothing changed on the store.');
      _state.view = 'edit'; _state.review = null;
      _state.history = null;
      await loadLive();
    } catch (err) {
      Toast.error(errorMessage(err));
      go.disabled = false; go.textContent = 'Reject';
    }
  });
}

// ── Reprice job polling ──────────────────────────────────────────────────────
function startPolling(jobId, packs) {
  clearTimeout(_pollTimer);
  const startedAt = Date.now();
  _state.job = { id: jobId, status: 'queued', outcome: 'running', packs: packs || (_state.job && _state.job.packs) || null };
  renderStatus();
  const tick = async () => {
    if (!_host) return;
    const job = await AdminAPI.controlCenter.getRepriceJob(jobId);
    if (!_host || !_state.job || _state.job.id !== jobId) return;
    const d = pollDecision(job, Date.now() - startedAt);
    if (job && !job.missing) Object.assign(_state.job, { status: job.status, counts: job.counts, error: job.error, finished_at: job.finished_at });
    if (d.stop) {
      _state.job.outcome = d.outcome;
      if (d.outcome === 'completed') {
        const n = job.counts && job.counts.updated;
        Toast.success(typeof n === 'number' ? `Live on the site: ${n} price${n === 1 ? '' : 's'} updated.` : 'Live on the site: repricing complete.');
        loadLive();
      } else if (d.outcome === 'failed') Toast.error('The reprice failed. The ladder is live but prices may not have moved.');
      else if (d.outcome === 'missing') Toast.error('The reprice job could not be found.');
    } else {
      _pollTimer = setTimeout(tick, POLL_MS);
    }
    renderStatus();
  };
  _pollTimer = setTimeout(tick, 0);
}

async function retryReprice(btn) {
  btn.disabled = true;
  try {
    const d = await AdminAPI.controlCenter.retryReprice();
    if (!_host) return;
    if (d.job_id) { Toast.success('Reprice started.'); startPolling(d.job_id, _state.job && _state.job.packs); }
    else { Toast.info(d.message || 'Reprice requested. No job id came back, so progress cannot be tracked here.'); }
  } catch (err) {
    Toast.error(errorMessage(err));
    btn.disabled = false;
  }
}

// Resume after a page refresh mid-reprice: the job id comes back on the most
// recently approved proposal (contract §7).
async function resumeRunningJob() {
  try {
    const [latest] = await AdminAPI.controlCenter.listTierProposals({ status: 'approved', limit: 1 });
    if (!_host || !latest || !latest.reprice_job_id || _state.job) return;
    const job = await AdminAPI.controlCenter.getRepriceJob(latest.reprice_job_id);
    if (!_host || !job || job.missing) return;
    if (job.status === 'pending' || job.status === 'running') startPolling(latest.reprice_job_id, null);
  } catch { /* history read failure is reported by the history panel itself */ }
}

// ── History ──────────────────────────────────────────────────────────────────
async function loadHistory() {
  const el = slot('history');
  if (!el) return;
  el.innerHTML = '<div class="admin-loader"><div class="admin-loading__spinner"></div></div>';
  try {
    _state.history = await AdminAPI.controlCenter.listTierProposals({ status: _state.historyStatus || undefined, limit: 50 });
    _state.historyError = null;
  } catch (err) {
    _state.history = null;
    _state.historyError = errorMessage(err);
  }
  if (_host) renderHistory();
}

function renderHistory() {
  const el = slot('history');
  if (!el) return;
  const filter = `<label class="cc2-field cc2-tiers__histfilter"><span>Status</span><select class="admin-select" data-field="history-status">
      <option value="">All</option>${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${k === _state.historyStatus ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`;
  if (_state.historyError) { el.innerHTML = filter + `<p class="cc2-tiers__warntext">Could not load the history: ${esc(_state.historyError)}</p>`; return; }
  const list = _state.history || [];
  if (!list.length) { el.innerHTML = filter + '<p class="cc2-tiers__muted">No proposals yet.</p>'; return; }
  el.innerHTML = filter + `<div class="admin-table-wrap"><table class="admin-table cc2-pricing__table">
    <thead><tr><th>Filed</th><th>Status</th><th>Changes</th><th>Why</th><th>Reviewed</th><th class="num">Would change</th><th class="num">Held by ratchet</th><th></th></tr></thead>
    <tbody>${list.map((p) => {
      const n = diffLadders(p, _state.live).length;
      const imp = (p.impact && (p.impact.at_approval || p.impact)) || {};
      const r = imp.no_decrease_ratchet || {};
      return `<tr>
        <td>${esc(when(p.created_at))}<br><span class="cc2-tiers__muted">${esc(who(p.created_by))}</span></td>
        <td><span class="cc2-tiers__status cc2-tiers__status--${esc(p.status)}">${esc(STATUS_LABEL[p.status] || p.status)}</span></td>
        <td>${int(n)}</td><td>${esc(p.notes || '—')}</td>
        <td>${p.reviewed_at ? `${esc(when(p.reviewed_at))}<br><span class="cc2-tiers__muted">${esc(who(p.reviewed_by))}</span>` : '—'}</td>
        <td class="num">${int(r.will_change_skus)}</td><td class="num">${int(r.blocked_skus)}</td>
        <td><button class="admin-btn admin-btn--sm admin-btn--ghost" data-action="history-view" data-id="${esc(p.id)}">View</button></td></tr>`;
    }).join('')}</tbody></table></div>`;
}

// ── Load ─────────────────────────────────────────────────────────────────────
async function loadLive({ keepDraft = false } = {}) {
  const live = await AdminAPI.controlCenter.getTierMultipliers();
  if (!_host) return;
  if (!live || !live.effective || !live.bands) {
    _state.live = null;
    _state.loadError = live ? 'The response did not carry `effective` and `bands`.' : 'The request failed.';
    renderStatus(); renderMain();
    return;
  }
  _state.live = live;
  _state.loadError = null;
  if (!keepDraft || !_state.draft) _state.draft = draftFromLive(live);
  _state.baselineKey = null;
  if (_state.history) loadHistory();
  // Contract §3.1: with a pending proposal the panel opens in review state.
  if (live.pending_proposal && _state.view === 'edit' && !_state.job && !_state.reviewedOnce) {
    _state.reviewedOnce = true;
    renderStatus();
    openReview(live.pending_proposal.id);
    return;
  }
  renderStatus(); renderMain();
  if (_state.view === 'edit') runSimulate();
}

export default {
  async init(host) {
    _host = host;
    _state = freshState();
    renderShell();
    renderMain();
    const brands = await AdminAPI.getBrands();
    if (!_host) return;
    _state.brands = (Array.isArray(brands) ? brands : [])
      .filter((b) => b && b.id && b.name)
      .map((b) => ({ id: b.id, slug: b.slug, name: b.name }))
      .sort((x, y) => x.name.localeCompare(y.name));
    await loadLive();
    if (_host) resumeRunningJob();
  },
  destroy() {
    clearTimeout(_simTimer);
    clearTimeout(_pollTimer);
    _host = null;
  },
};
