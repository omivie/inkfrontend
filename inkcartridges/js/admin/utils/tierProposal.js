/**
 * Tier-multiplier proposals — pure logic behind the approval-gated pricing
 * panel (cc2-pricing.js). Backend contract:
 * backend-docs/inbox/tier-multiplier-approval-backend-contract-sep2026.md
 * (migration 187). Errors log: ERR-281.
 *
 * Since migration 187 a PUT to /admin/pricing/tier-multipliers FILES A
 * PROPOSAL and moves no price. Only POST …/proposals/:id/approve {confirm:true}
 * makes a ladder live, and it starts a full-catalogue reprice. Nothing here
 * computes a price — every retail figure comes from POST /admin/pricing/simulate.
 * This module only shapes requests, validates them before they leave, and
 * reads the simulate response honestly.
 *
 * Two things measured on live 2026-09-23 that the contract does not say, and
 * that this module exists to handle:
 *
 *  1. DRIFT. Simulating the live ladder with NO change (compatible) reported
 *     51 increases, 141 decreases and a net-profit-per-unit delta of −524.67.
 *     So `aggregate` is not "what my edit does"; it is "what a reprice would do
 *     with this table", and approving any edit applies the drift too.
 *     `attribute()` subtracts a no-change baseline so the panel can say which
 *     part is the edit and which part a reprice would apply anyway.
 *
 *  2. THE RATCHET IS NOT APPLIED TO THE AGGREGATE. A blocked row (C12XBK)
 *     shows new_retail 62.49 < current_retail 68.79 with
 *     blocked_by_no_decrease:true, and total_skus_with_decrease == blocked_skus.
 *     The *_after figures therefore include price cuts that will not happen.
 *     `rowOutcome()` renders those rows as "keeps its price", never as a drop.
 *
 * And one gap: simulate answers 200 with "no change" for a band key that does
 * not exist ("<=100") and for a brand id it cannot resolve. PUT refuses both.
 * A typo would preview as "no effect", so everything is validated here first.
 *
 * Dual export (ESM for the browser, loaded by `import()` in node tests), same
 * as pricingCalculator.js. No build step.
 */

import { validateMultiplier, sortTierKeys } from './pricingCalculator.js';

const EDITABLE_SOURCES = ['genuine', 'compatible'];
const MULT_MIN = 1.05;
const MULT_MAX = 5;
const OFFSET_LIMIT = 0.05;
const LADDER_MIN = 2;
const LADDER_MAX = 40;
const BRAND_ENTRIES_MAX = 50;

// Contract §3.2 / §3.9: debounce simulate at ~300 ms; poll a reprice job every
// ~5 s and stop after ~10 minutes.
const SIM_DEBOUNCE_MS = 300;
const POLL_MS = 5000;
const POLL_MAX_MS = 10 * 60 * 1000;
const EDIT_PREVIEW_LIMIT = 25;
const FULL_PREVIEW_LIMIT = 5000;

// Float equality for multipliers. The server stores 3-4 dp; typed values are
// parsed from <input type=number>, so 1.4 vs 1.4000000000000001 must be equal.
function sameMult(a, b) {
  return Math.abs(Number(a) - Number(b)) < 1e-9;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── Band keys ────────────────────────────────────────────────────────────────
// The server derives a band's key from its boundaries (§1): "<=20", "20-60",
// "60+". We derive the same string ONLY to preview what a moved boundary will
// be called; the server's key is the one that is stored.
function fmtBound(n) {
  return String(Number(n));
}

function deriveBandKey(prevMax, maxCost) {
  if (maxCost == null) return `${fmtBound(prevMax)}+`;
  if (prevMax == null) return `<=${fmtBound(maxCost)}`;
  return `${fmtBound(prevMax)}-${fmtBound(maxCost)}`;
}

// Keys for a whole ladder of { max_cost } rows, in order.
function ladderKeys(rows) {
  const out = [];
  let prev = null;
  for (const r of rows || []) {
    out.push(deriveBandKey(prev, r.max_cost));
    prev = r.max_cost;
  }
  return out;
}

// GET's `bands[source]` is [{maxCost, key, mult}]; requests use
// [{max_cost, mult}]. Convert once so the editor only knows one shape.
function bandsFromServer(list) {
  return (list || []).map((b) => ({
    max_cost: b.maxCost ?? b.max_cost ?? null,
    mult: Number(b.mult),
    key: b.key,
  }));
}

// ── Validation (mirrors the 400s in contract §3.3, never repairs) ────────────
// Returns EVERY problem so the panel can mark each row, because the backend
// refuses the whole array rather than half of it.
function validateBandLadder(rows) {
  const errors = [];
  const list = Array.isArray(rows) ? rows : [];
  if (list.length < LADDER_MIN || list.length > LADDER_MAX) {
    errors.push({ index: null, reason: 'ladder_size', message: `A ladder needs ${LADDER_MIN}–${LADDER_MAX} bands (has ${list.length}).` });
  }
  let prev = null;
  list.forEach((r, i) => {
    const last = i === list.length - 1;
    const max = r.max_cost;
    if (last) {
      if (max != null) errors.push({ index: i, reason: 'last_not_open', message: 'The last band must be open-ended so every cost lands in a band.' });
    } else if (max == null) {
      errors.push({ index: i, reason: 'open_not_last', message: 'Only the last band may be open-ended.' });
    } else if (!Number.isFinite(Number(max)) || Number(max) <= 0) {
      errors.push({ index: i, reason: 'bad_boundary', message: 'Boundary must be a positive number.' });
    } else if (prev != null && !(Number(max) > prev)) {
      errors.push({ index: i, reason: 'not_ascending', message: `Boundary ${max} must be above ${prev}.` });
    }
    if (max != null && Number.isFinite(Number(max))) prev = Number(max);
    const v = validateMultiplier(r.mult);
    if (!v.ok) errors.push({ index: i, reason: v.reason, message: `Multiplier must be between ${MULT_MIN} and ${MULT_MAX}.` });
  });
  return { ok: errors.length === 0, errors };
}

function validateOffset(offset) {
  const n = Number(offset);
  if (!Number.isFinite(n)) return { ok: false, message: 'Offset must be a number.' };
  if (Math.abs(n) > OFFSET_LIMIT + 1e-12) return { ok: false, message: `Offset must be within ±${OFFSET_LIMIT}.` };
  return { ok: true, value: n };
}

// Validate a {key: mult} edit map against the keys that exist. Simulate would
// silently ignore an unknown key, so this is the only thing that catches it
// before the preview (PUT would 400).
function validateEdits(map, allowedKeys) {
  const errors = [];
  for (const [key, value] of Object.entries(map || {})) {
    if (allowedKeys && !allowedKeys.includes(key)) errors.push({ key, reason: 'unknown_tier', message: `"${key}" is not a band.` });
    const v = validateMultiplier(value);
    if (!v.ok) errors.push({ key, reason: v.reason, message: `${key}: multiplier must be between ${MULT_MIN} and ${MULT_MAX}.` });
  }
  return { ok: errors.length === 0, errors };
}

// ── Draft → request bodies ───────────────────────────────────────────────────
//
// A draft is what the panel edits:
//   {
//     catalogue: { genuine: {key: mult}, compatible: {key: mult} },  // full typed values
//     bands:     { genuine: [{max_cost, mult}] | null, compatible: … }, // null = boundaries untouched
//     brands:    { [brand_id]: { genuine?: {key:mult}, compatible?: {…}, clear?: true } },
//     offset:    number,
//   }
// and `live` is the GET /tier-multipliers data.
//
// Only what DIFFERS from live is sent. PUT merges partial edits onto the live
// table (§8), so sending unchanged bands would still be correct — but it would
// make the stored proposal and its review diff claim changes nobody made.

function changedBands(typed, live) {
  const out = {};
  for (const [k, v] of Object.entries(typed || {})) {
    if (!live || !(k in live) || !sameMult(v, live[k])) out[k] = Number(v);
  }
  return out;
}

function liveBandsForm(live, source) {
  return bandsFromServer(live && live.bands && live.bands[source]);
}

function bandsChanged(rows, liveRows) {
  if (!rows) return false;
  if (rows.length !== liveRows.length) return true;
  return rows.some((r, i) => r.max_cost !== liveRows[i].max_cost || !sameMult(r.mult, liveRows[i].mult));
}

function liveBrandTable(live, brandId) {
  const b = live && live.effective && live.effective.brands && live.effective.brands[brandId];
  return b || null;
}

// Build the PUT body (contract §3.3). Returns { ok, body } or { ok:false, errors }.
function buildProposeBody(draft, live, notes) {
  const errors = [];
  const body = {};
  const eff = (live && live.effective) || {};

  for (const source of EDITABLE_SOURCES) {
    const rows = draft.bands && draft.bands[source];
    const liveRows = liveBandsForm(live, source);
    if (rows && bandsChanged(rows, liveRows)) {
      const v = validateBandLadder(rows);
      if (!v.ok) errors.push(...v.errors.map((e) => ({ ...e, source })));
      body.bands = body.bands || {};
      body.bands[source] = rows.map((r) => ({ max_cost: r.max_cost == null ? null : Number(r.max_cost), mult: Number(r.mult) }));
      // A moved ladder carries its own multipliers; a separate catalogue map
      // for the same source would be keyed to the OLD bands (UNKNOWN_TIER_BAND).
      continue;
    }
    const changed = changedBands(draft.catalogue && draft.catalogue[source], eff[source]);
    if (Object.keys(changed).length) {
      const v = validateEdits(changed, Object.keys(eff[source] || {}));
      if (!v.ok) errors.push(...v.errors.map((e) => ({ ...e, source })));
      body[source] = changed;
    }
  }

  const brandEntries = [];
  for (const [brandId, edit] of Object.entries(draft.brands || {})) {
    if (!edit) continue;
    if (edit.clear) {
      if (liveBrandTable(live, brandId)) brandEntries.push({ brand_id: brandId, clear: true });
      continue;
    }
    const liveTable = liveBrandTable(live, brandId) || {};
    const entry = { brand_id: brandId };
    for (const source of EDITABLE_SOURCES) {
      const liveSource = liveTable[source] || {};
      const changed = {};
      for (const [k, v] of Object.entries(edit[source] || {})) {
        if (!(k in liveSource) || !sameMult(v, liveSource[k])) changed[k] = Number(v);
      }
      if (Object.keys(changed).length) {
        const allowed = Object.keys((body.bands && body.bands[source])
          ? Object.fromEntries(ladderKeys(body.bands[source]).map((k) => [k, 1]))
          : (eff[source] || {}));
        const v = validateEdits(changed, allowed);
        if (!v.ok) errors.push(...v.errors.map((e) => ({ ...e, source, brand_id: brandId })));
        entry[source] = changed;
      }
    }
    if (entry.genuine || entry.compatible) brandEntries.push(entry);
  }
  if (brandEntries.length > BRAND_ENTRIES_MAX) {
    errors.push({ reason: 'too_many_brands', message: `At most ${BRAND_ENTRIES_MAX} brand entries per proposal.` });
  }
  if (brandEntries.length) body.brands = brandEntries;

  const liveOffset = Number((live && live.global_offset) || 0);
  if (draft.offset != null && !sameMult(draft.offset, liveOffset)) {
    const v = validateOffset(draft.offset);
    if (!v.ok) errors.push({ reason: 'offset', message: v.message });
    body.global_offset = Number(draft.offset);
  }

  // The backend requires at least one of genuine / compatible / global_offset.
  // A brand-only or bands-only edit is still a real edit — but an EMPTY body
  // would be refused, so say "nothing changed" instead of sending it.
  const hasChange = body.genuine || body.compatible || body.bands || body.brands || body.global_offset != null;
  if (!hasChange) errors.push({ reason: 'no_change', message: 'Nothing differs from the live ladder.' });

  if (notes && String(notes).trim()) body.notes = String(notes).trim();
  return errors.length ? { ok: false, errors, body } : { ok: true, body };
}

// Build the simulate body (contract §3.2) for the same draft. Brands are
// keyed by id with slug/name alongside, so `by_brand` can label its rows.
function buildSimulateBody(draft, live, opts = {}) {
  const proposed = {};
  const put = buildProposeBody(draft, live, null).body || {};
  if (put.genuine) proposed.genuine = put.genuine;
  if (put.compatible) proposed.compatible = put.compatible;
  if (put.bands) proposed.bands = put.bands;
  if (put.brands) {
    const brandsMeta = opts.brandsMeta || {};
    const byId = {};
    for (const e of put.brands) {
      if (e.clear) continue; // a cleared ladder simulates as "catalogue table" — omit it
      const meta = brandsMeta[e.brand_id] || {};
      byId[e.brand_id] = { slug: meta.slug, name: meta.name };
      if (e.genuine) byId[e.brand_id].genuine = e.genuine;
      if (e.compatible) byId[e.brand_id].compatible = e.compatible;
    }
    if (Object.keys(byId).length) proposed.brands = byId;
  }
  const body = {
    scope: { include_overrides: !!opts.includeOverrides },
    proposed_tiers: proposed,
    preview_limit: opts.previewLimit || EDIT_PREVIEW_LIMIT,
  };
  if (opts.source) body.scope.source = opts.source;
  if (opts.brandSlug) body.scope.brand_slug = opts.brandSlug;
  // Always pass the offset in force for the draft: an offset-only proposal
  // simulated without it reports "no change" for a change that moves every
  // price (§3.2).
  const offset = draft.offset != null ? Number(draft.offset) : Number((live && live.global_offset) || 0);
  if (offset) body.global_offset = offset;
  return body;
}

// The no-change twin of a simulate body: same scope, same live offset, empty
// table. Its figures are the drift a reprice would apply with no edit at all.
function baselineSimulateBody(simBody, live) {
  const body = { ...simBody, proposed_tiers: {} };
  const liveOffset = Number((live && live.global_offset) || 0);
  if (liveOffset) body.global_offset = liveOffset; else delete body.global_offset;
  return body;
}

// ── Reading the simulate response honestly ──────────────────────────────────

const AGG_DELTA_FIELDS = [
  'total_skus_with_increase',
  'total_skus_with_decrease',
  'net_profit_per_unit_after',
  'catalogue_value_after',
  'avg_net_margin_after',
  'below_survival_floor_after',
];

// Split the proposal's figures into "caused by this edit" and "a reprice would
// do this anyway". Both simulations share the before-state, so the difference
// of their after-states is exactly the edit's contribution.
function attribute(sim, baseline) {
  const a = (sim && sim.aggregate) || {};
  const b = (baseline && baseline.aggregate) || null;
  if (!b) return { available: false };
  const edit = {};
  for (const f of AGG_DELTA_FIELDS) {
    if (a[f] == null || b[f] == null) { edit[f] = null; continue; }
    const d = Number(a[f]) - Number(b[f]);
    edit[f] = Number.isInteger(a[f]) && Number.isInteger(b[f]) ? d : round2(d);
  }
  const ratchetA = (sim && sim.no_decrease_ratchet) || {};
  const ratchetB = (baseline && baseline.no_decrease_ratchet) || {};
  return {
    available: true,
    edit,
    edit_will_change: numDiff(ratchetA.will_change_skus, ratchetB.will_change_skus),
    edit_blocked: numDiff(ratchetA.blocked_skus, ratchetB.blocked_skus),
    drift: {
      will_change_skus: ratchetB.will_change_skus ?? null,
      blocked_skus: ratchetB.blocked_skus ?? null,
      net_profit_per_unit_delta: b.net_profit_per_unit_delta ?? null,
    },
  };
}

function numDiff(x, y) {
  if (x == null || y == null) return null;
  return Number(x) - Number(y);
}

// Per-band attribution: join proposal by_tier to baseline by_tier on
// (source, tier). A moved boundary renames bands, so an unmatched row simply
// has no baseline (null), never a zero.
function attributeBands(sim, baseline) {
  const idx = new Map();
  for (const r of (baseline && baseline.by_tier) || []) idx.set(`${r.source}|${r.tier}`, r);
  return ((sim && sim.by_tier) || []).map((r) => {
    const b = idx.get(`${r.source}|${r.tier}`) || null;
    return {
      ...r,
      baseline_products_increasing: b ? b.products_increasing : null,
      edit_products_increasing: b ? r.products_increasing - b.products_increasing : null,
      edit_net_profit_per_unit_delta: b ? round2(r.net_profit_per_unit_delta - b.net_profit_per_unit_delta) : null,
    };
  });
}

// §4.2 warning. Null when nothing is blocked.
function ratchetSummary(sim) {
  const r = (sim && sim.no_decrease_ratchet) || null;
  if (!r) return { enforced: null, blocked: null, willChange: null, warning: null };
  const blocked = Number(r.blocked_skus) || 0;
  const total = Number(sim.affected) || 0;
  return {
    enforced: r.enforced !== false,
    blocked,
    willChange: Number(r.will_change_skus) || 0,
    warning: blocked > 0
      ? `${blocked.toLocaleString('en-NZ')} of ${total.toLocaleString('en-NZ')} products are priced lower by this table and will keep their current price — deliberate reductions must be set per product.`
      : null,
  };
}

// What will actually happen to one sample row. A blocked row is priced lower
// by the table but KEEPS its current price, so it must never read as a drop.
function rowOutcome(row) {
  const cur = Number(row.current_retail);
  const next = Number(row.new_retail);
  if (row.blocked_by_no_decrease) return { kind: 'keeps', price: cur, engine: next };
  if (Number.isFinite(cur) && Number.isFinite(next) && next - cur >= 0.005) return { kind: 'rises', price: next, delta: round2(next - cur) };
  if (Number.isFinite(cur) && Number.isFinite(next) && cur - next >= 0.005) {
    // Not blocked yet lower: the backend says the ratchet is not enforced for
    // this row. Report it as the server states it, flagged, never as a win.
    return { kind: 'falls', price: next, delta: round2(next - cur) };
  }
  return { kind: 'unchanged', price: cur };
}

// ── Review diff ──────────────────────────────────────────────────────────────
// Proposed-vs-live rows for the review card, from a proposal's
// proposed_overrides + the live effective table. Brand ladders and band moves
// are listed too so nothing the proposal does is left off the screen.
function diffLadders(proposal, live) {
  const rows = [];
  const po = (proposal && proposal.proposed_overrides) || {};
  const eff = (live && live.effective) || {};
  const defaults = (live && live.defaults) || {};
  for (const source of EDITABLE_SOURCES) {
    const map = po[source] || {};
    for (const key of sortTierKeys(Object.keys(map))) {
      const liveVal = eff[source] ? eff[source][key] : undefined;
      if (liveVal != null && sameMult(liveVal, map[key])) continue;
      rows.push({ scope: 'catalogue', source, key, live: liveVal ?? null, proposed: Number(map[key]), default: defaults[source] ? defaults[source][key] ?? null : null });
    }
  }
  const bands = po.bands || {};
  for (const source of Object.keys(bands)) {
    rows.push({ scope: 'bands', source, key: ladderKeys(bands[source]).join(' · '), live: null, proposed: null, ladder: bands[source] });
  }
  const brands = po.brands || {};
  for (const [brandId, t] of Object.entries(brands)) {
    for (const source of EDITABLE_SOURCES) {
      for (const [key, v] of Object.entries((t && t[source]) || {})) {
        rows.push({ scope: 'brand', brand_id: brandId, brand: (t && (t.name || t.slug)) || brandId, source, key, live: null, proposed: Number(v) });
      }
    }
  }
  if (proposal && proposal.proposed_global_offset != null) {
    rows.push({ scope: 'offset', key: 'global offset', live: proposal.base_global_offset ?? null, proposed: Number(proposal.proposed_global_offset) });
  }
  return rows;
}

// ── Errors ───────────────────────────────────────────────────────────────────
// One operator-facing sentence per contract error code. The server's own
// message is appended where it names specifics (bands, brands).
const ERROR_COPY = {
  PROPOSAL_STALE: 'The live ladder changed after this proposal was filed. Re-propose from the current ladder — approving this one is refused.',
  PROPOSAL_NOT_PENDING: 'This proposal was already approved, rejected or superseded. Reload to see its current state.',
  INVALID_BAND_LADDER: 'The cost bands were refused as a whole: 2–40 bands, strictly ascending, multipliers 1.05–5, last band open-ended.',
  UNKNOWN_TIER_BAND: 'A multiplier is keyed to a band that no longer exists after the boundary move. Re-enter it against the new bands, or clear that brand ladder.',
  UNKNOWN_BRAND: 'A brand in this proposal could not be resolved.',
  VALIDATION_ERROR: 'The request was refused as invalid.',
  VALIDATION_FAILED: 'The request was refused as invalid.',
  RATE_LIMITED: 'Rate limited — /admin/pricing allows 60 requests a minute per office IP. Wait a moment and retry.',
  FORBIDDEN: 'This needs a super_admin account.',
  UNAUTHORIZED: 'Your session has expired. Sign in again.',
  NOT_FOUND: 'That proposal no longer exists.',
};

function errorMessage(err) {
  const code = err && err.code;
  const base = (code && ERROR_COPY[code]) || null;
  const detail = err && err.details;
  let specifics = '';
  if (Array.isArray(detail) && detail.length) {
    specifics = detail.map((d) => (d && (d.message || d.field || d.key)) || String(d)).join('; ');
  } else if (detail && typeof detail === 'object') {
    specifics = JSON.stringify(detail);
  }
  if (base) return specifics ? `${base} (${specifics})` : base;
  return (err && err.message) || 'Request failed.';
}

// ── Reprice-job polling decision ─────────────────────────────────────────────
// Pure so the timer logic in the panel is a thin shell over tested code.
//   job === null         → transient read miss, keep polling
//   job.missing          → the job id does not exist, stop (loud)
//   completed / failed   → stop
//   elapsed > POLL_MAX   → stop, report "still running" (not success)
function pollDecision(job, elapsedMs) {
  if (job && job.missing) return { stop: true, outcome: 'missing' };
  if (job && job.status === 'completed') return { stop: true, outcome: 'completed' };
  if (job && job.status === 'failed') return { stop: true, outcome: 'failed' };
  if (elapsedMs >= POLL_MAX_MS) return { stop: true, outcome: 'timeout' };
  return { stop: false, outcome: job ? job.status : 'unknown' };
}

const TierProposal = {
  EDITABLE_SOURCES, MULT_MIN, MULT_MAX, OFFSET_LIMIT, LADDER_MIN, LADDER_MAX, BRAND_ENTRIES_MAX,
  SIM_DEBOUNCE_MS, POLL_MS, POLL_MAX_MS, EDIT_PREVIEW_LIMIT, FULL_PREVIEW_LIMIT,
  sameMult, deriveBandKey, ladderKeys, bandsFromServer,
  validateBandLadder, validateOffset, validateEdits,
  buildProposeBody, buildSimulateBody, baselineSimulateBody,
  attribute, attributeBands, ratchetSummary, rowOutcome, diffLadders,
  errorMessage, pollDecision, ERROR_COPY,
};

export {
  EDITABLE_SOURCES, MULT_MIN, MULT_MAX, OFFSET_LIMIT, LADDER_MIN, LADDER_MAX, BRAND_ENTRIES_MAX,
  SIM_DEBOUNCE_MS, POLL_MS, POLL_MAX_MS, EDIT_PREVIEW_LIMIT, FULL_PREVIEW_LIMIT,
  sameMult, deriveBandKey, ladderKeys, bandsFromServer,
  validateBandLadder, validateOffset, validateEdits,
  buildProposeBody, buildSimulateBody, baselineSimulateBody,
  attribute, attributeBands, ratchetSummary, rowOutcome, diffLadders,
  errorMessage, pollDecision, ERROR_COPY, TierProposal,
};
export default TierProposal;
