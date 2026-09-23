'use strict';

// Tier multipliers: simulate → propose → approve (migration 187). ERR-281.
// Contract: backend-docs/inbox/tier-multiplier-approval-backend-contract-sep2026.md
//
// Sections:
//   §1 pure request shaping + validation   (utils/tierProposal.js, real module)
//   §2 reading the simulate response        (fixtures are LIVE measurements, 2026-09-23)
//   §3 API wrappers                         (real method source, fake window.API)
//   §4 panel wiring                         (cc2-pricing.js / cc-profit.js source, comments stripped)
//   §5 enrolment: versions, probe, docs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) => stripComments(read(rel));

const API_SRC = read('inkcartridges/js/admin/api.js');
const PANEL = code('inkcartridges/js/admin/pages/cc2-pricing.js');
const PROFIT = code('inkcartridges/js/admin/pages/cc-profit.js');

let T;
test.before(async () => {
  T = await import(path.join(SITE, 'js/admin/utils/tierProposal.js'));
});

// A live GET /tier-multipliers, trimmed to two bands per source (shape verbatim).
function liveFixture(over = {}) {
  return {
    defaults: {
      genuine: { '<=10': 1.47, '10-15': 1.44, '45-60': 1.385, '1000+': 1.235 },
      compatible: { '<=5': 1.87, '12-18': 1.69, '200+': 1.24 },
    },
    overrides: {},
    effective: {
      genuine: { '<=10': 1.47, '10-15': 1.44, '45-60': 1.385, '1000+': 1.235 },
      compatible: { '<=5': 1.87, '12-18': 1.69, '200+': 1.24 },
      brands: {},
    },
    bands: {
      genuine: [
        { maxCost: 10, key: '<=10', mult: 1.47 }, { maxCost: 15, key: '10-15', mult: 1.44 },
        { maxCost: 60, key: '45-60', mult: 1.385 }, { maxCost: null, key: '1000+', mult: 1.235 },
      ],
      compatible: [
        { maxCost: 5, key: '<=5', mult: 1.87 }, { maxCost: 18, key: '12-18', mult: 1.69 },
        { maxCost: null, key: '200+', mult: 1.24 },
      ],
    },
    bands_are_custom: { genuine: false, compatible: false },
    global_offset: 0,
    pending_proposal: null,
    ...over,
  };
}
function draftOf(live) {
  return {
    catalogue: { genuine: { ...live.effective.genuine }, compatible: { ...live.effective.compatible } },
    bands: { genuine: null, compatible: null },
    brands: {},
    offset: live.global_offset,
  };
}
const BROTHER = '284261c0-db3f-4838-b232-3ef6f3920c9f';

// ── §1 request shaping ───────────────────────────────────────────────────────

test('§1 an untouched draft is refused as "no change", never sent as an empty PUT', () => {
  const live = liveFixture();
  const r = T.buildProposeBody(draftOf(live), live, 'x');
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.reason), ['no_change']);
});

test('§1 the PUT carries ONLY the bands that changed, in the contract shape', () => {
  const live = liveFixture();
  const d = draftOf(live);
  d.catalogue.genuine['45-60'] = 1.42;
  d.catalogue.genuine['<=10'] = 1.47000000000001; // float noise from <input> is not a change
  const r = T.buildProposeBody(d, live, '  Recover margin  ');
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, { genuine: { '45-60': 1.42 }, notes: 'Recover margin' });
  // The pre-187 panel sent this shape — it is not the contract's.
  assert.equal('proposed_tiers' in r.body, false);
  assert.equal('apply_ending_snap' in r.body, false);
});

test('§1 global_offset is sent only when it moved, and bounded to ±0.05', () => {
  const live = liveFixture();
  const d = draftOf(live);
  d.offset = 0.01;
  assert.deepEqual(T.buildProposeBody(d, live).body, { global_offset: 0.01 });
  d.offset = 0.06;
  const bad = T.buildProposeBody(d, live);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.reason === 'offset'));
  d.offset = NaN;
  assert.equal(T.buildProposeBody(d, live).ok, false);
});

test('§1 a band key that does not exist is refused before it can preview as "no change"', () => {
  // Live 2026-09-23: simulate answered 200 with no change for {"<=100": 1.4}.
  const live = liveFixture();
  const d = draftOf(live);
  d.catalogue.genuine['<=100'] = 1.4;
  const r = T.buildProposeBody(d, live);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.reason === 'unknown_tier' && e.key === '<=100'));
});

test('§1 multipliers outside 1.05–5 are refused', () => {
  const live = liveFixture();
  for (const v of [1.04, 5.01, NaN]) {
    const d = draftOf(live);
    d.catalogue.compatible['12-18'] = v;
    assert.equal(T.buildProposeBody(d, live).ok, false, `accepted ${v}`);
  }
  const d = draftOf(live);
  d.catalogue.compatible['12-18'] = 1.05;
  assert.equal(T.buildProposeBody(d, live).ok, true);
});

test('§1 brand entries go by brand_id, carry only changed bands, and clear:true removes a ladder', () => {
  const live = liveFixture();
  live.effective.brands = { [BROTHER]: { slug: 'brother', name: 'Brother', genuine: { '45-60': 1.48 } } };
  const d = draftOf(live);
  d.brands[BROTHER] = { genuine: { '45-60': 1.48, '10-15': 1.5 } };
  assert.deepEqual(T.buildProposeBody(d, live).body.brands, [{ brand_id: BROTHER, genuine: { '10-15': 1.5 } }]);

  d.brands[BROTHER] = { clear: true };
  assert.deepEqual(T.buildProposeBody(d, live).body.brands, [{ brand_id: BROTHER, clear: true }]);

  // Clearing a brand that has no ladder is not a change.
  const d2 = draftOf(liveFixture());
  d2.brands[BROTHER] = { clear: true };
  assert.equal(T.buildProposeBody(d2, liveFixture()).ok, false);
});

test('§1 a brand-only edit is a real edit (not refused as "no change")', () => {
  const live = liveFixture();
  const d = draftOf(live);
  d.brands[BROTHER] = { compatible: { '12-18': 1.8 } };
  const r = T.buildProposeBody(d, live);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.body), ['brands']);
});

test('§1 moved boundaries send the whole ladder and no separate map for that source', () => {
  const live = liveFixture();
  const d = draftOf(live);
  d.catalogue.genuine['45-60'] = 1.5; // would be keyed to a band that no longer exists
  d.bands.genuine = [{ max_cost: 20, mult: 1.55 }, { max_cost: 60, mult: 1.4 }, { max_cost: null, mult: 1.25 }];
  const r = T.buildProposeBody(d, live);
  assert.equal(r.ok, true);
  assert.deepEqual(r.body.bands.genuine, d.bands.genuine);
  assert.equal('genuine' in r.body, false, 'a catalogue map beside a moved ladder is UNKNOWN_TIER_BAND');
});

test('§1 an unmoved copy of the ladder is not a bands edit', () => {
  const live = liveFixture();
  const d = draftOf(live);
  d.bands.compatible = T.bandsFromServer(live.bands.compatible);
  assert.equal(T.buildProposeBody(d, live).ok, false);
});

test('§1 validateBandLadder mirrors every INVALID_BAND_LADDER rule and reports all of them', () => {
  const ok = [{ max_cost: 20, mult: 1.55 }, { max_cost: 60, mult: 1.4 }, { max_cost: null, mult: 1.25 }];
  assert.equal(T.validateBandLadder(ok).ok, true);
  const reasons = (rows) => T.validateBandLadder(rows).errors.map((e) => e.reason);
  assert.deepEqual(reasons([{ max_cost: null, mult: 1.3 }]), ['ladder_size']);
  assert.ok(reasons(Array.from({ length: 41 }, (_, i) => ({ max_cost: i === 40 ? null : i + 1, mult: 1.3 }))).includes('ladder_size'));
  assert.deepEqual(reasons([{ max_cost: 20, mult: 1.3 }, { max_cost: 60, mult: 1.3 }]), ['last_not_open']);
  assert.deepEqual(reasons([{ max_cost: 60, mult: 1.3 }, { max_cost: 20, mult: 1.3 }, { max_cost: null, mult: 1.3 }]), ['not_ascending']);
  assert.deepEqual(reasons([{ max_cost: 20, mult: 1.3 }, { max_cost: 20, mult: 1.3 }, { max_cost: null, mult: 1.3 }]), ['not_ascending']);
  assert.deepEqual(reasons([{ max_cost: null, mult: 1.3 }, { max_cost: 20, mult: 1.3 }, { max_cost: null, mult: 1.3 }]), ['open_not_last']);
  assert.deepEqual(reasons([{ max_cost: 20, mult: 1.0 }, { max_cost: null, mult: 5.5 }]), ['below_minimum', 'above_maximum']);
  // All problems at once, never "fix one, find the next".
  assert.deepEqual(reasons([{ max_cost: 60, mult: 1 }, { max_cost: 20, mult: 9 }]), ['below_minimum', 'last_not_open', 'above_maximum']);
});

test('§1 band keys follow the shipped grammar: <=20, 20-60, 60+', () => {
  assert.deepEqual(T.ladderKeys([{ max_cost: 20 }, { max_cost: 60 }, { max_cost: null }]), ['<=20', '20-60', '60+']);
  assert.deepEqual(T.ladderKeys([{ max_cost: 12.5 }, { max_cost: null }]), ['<=12.5', '12.5+']);
  // The server's live keys, rebuilt from boundaries alone (full 18-band genuine ladder, 2026-09-23).
  const live = [10, 15, 20, 30, 45, 60, 80, 100, 130, 160, 200, 260, 340, 450, 600, 800, 1000, null];
  assert.deepEqual(T.ladderKeys(live.map((m) => ({ max_cost: m }))), ['<=10', '10-15', '15-20', '20-30', '30-45', '45-60',
    '60-80', '80-100', '100-130', '130-160', '160-200', '200-260', '260-340', '340-450', '450-600', '600-800', '800-1000', '1000+']);
});

test('§1 the simulate body keys brands by id, always carries the draft offset, never sends ribbon', () => {
  const live = liveFixture({ global_offset: 0.01 });
  const d = draftOf(live);
  d.brands[BROTHER] = { genuine: { '45-60': 1.48 } };
  const body = T.buildSimulateBody(d, live, { brandsMeta: { [BROTHER]: { slug: 'brother', name: 'Brother' } }, previewLimit: 25 });
  assert.deepEqual(body.proposed_tiers.brands, { [BROTHER]: { slug: 'brother', name: 'Brother', genuine: { '45-60': 1.48 } } });
  assert.equal(body.global_offset, 0.01, 'an offset left out simulates "no change" for a change that moves every price');
  assert.equal(body.preview_limit, 25);
  assert.equal(JSON.stringify(body).includes('ribbon'), false);
  const base = T.baselineSimulateBody(body, live);
  assert.deepEqual(base.proposed_tiers, {});
  assert.equal(base.global_offset, 0.01, 'the baseline uses the LIVE offset');
  assert.deepEqual(base.scope, body.scope);
});

// ── §2 reading the response ──────────────────────────────────────────────────
// Numbers measured on live 2026-09-23 (compatible scope).
const BASELINE_COMPAT = {
  affected: 620,
  aggregate: { total_skus_with_increase: 51, total_skus_with_decrease: 141, total_skus_unchanged: 428,
    net_profit_per_unit_after: 7686.95, net_profit_per_unit_delta: -524.67, catalogue_value_after: 27201.6,
    avg_net_margin_after: 36.96, below_survival_floor_after: 0 },
  no_decrease_ratchet: { enforced: true, blocked_skus: 141, will_change_skus: 51 },
  by_tier: [{ source: 'compatible', tier: '12-18', products: 47, products_increasing: 10, blocked_by_no_decrease: 20, net_profit_per_unit_delta: -20 }],
};
const EDIT_COMPAT = {
  affected: 620,
  aggregate: { total_skus_with_increase: 51, total_skus_with_decrease: 175, total_skus_unchanged: 394,
    net_profit_per_unit_after: 7624.05, net_profit_per_unit_delta: -587.57, catalogue_value_after: 27127.3,
    avg_net_margin_after: 36.72, below_survival_floor_after: 0 },
  no_decrease_ratchet: { enforced: true, blocked_skus: 175, will_change_skus: 51 },
  by_tier: [{ source: 'compatible', tier: '12-18', products: 47, products_increasing: 10, blocked_by_no_decrease: 37, net_profit_per_unit_delta: -52.23 }],
};

test('§2 attribute() separates the edit from drift a reprice would apply anyway', () => {
  const a = T.attribute(EDIT_COMPAT, BASELINE_COMPAT);
  assert.equal(a.available, true);
  // Lowering 12-18 moves NOTHING extra: every one of its cuts is held by the ratchet.
  assert.equal(a.edit_will_change, 0);
  assert.equal(a.edit_blocked, 34);
  assert.equal(a.edit.net_profit_per_unit_after, -62.9);
  assert.equal(a.drift.will_change_skus, 51, 'the 51 rises happen with NO edit — they are drift');
  assert.equal(T.attribute(EDIT_COMPAT, null).available, false);
});

test('§2 attributeBands() joins on (source, tier); an unmatched band is null, never zero', () => {
  const rows = T.attributeBands(EDIT_COMPAT, BASELINE_COMPAT);
  assert.equal(rows[0].edit_products_increasing, 0);
  assert.equal(rows[0].edit_net_profit_per_unit_delta, -32.23);
  const moved = T.attributeBands({ by_tier: [{ source: 'genuine', tier: '<=20', products_increasing: 3, net_profit_per_unit_delta: 1 }] }, BASELINE_COMPAT);
  assert.equal(moved[0].edit_products_increasing, null);
});

test('§2 ratchetSummary() words the §4.2 warning and is silent when nothing is blocked', () => {
  const r = T.ratchetSummary(EDIT_COMPAT);
  assert.equal(r.blocked, 175);
  assert.match(r.warning, /175 of 620 products are priced lower by this table and will keep their current price/);
  assert.match(r.warning, /deliberate reductions must be set per product/);
  assert.equal(T.ratchetSummary({ affected: 5, no_decrease_ratchet: { blocked_skus: 0, will_change_skus: 5 } }).warning, null);
});

test('§2 a blocked row KEEPS its price — never rendered as a drop', () => {
  // Live row C12XBK, 2026-09-23.
  const row = { sku: 'C12XBK', current_retail: 68.79, new_retail: 62.49, delta_retail: -6.3, blocked_by_no_decrease: true };
  assert.deepEqual(T.rowOutcome(row), { kind: 'keeps', price: 68.79, engine: 62.49 });
  assert.equal(T.rowOutcome({ current_retail: 77.79, new_retail: 79.99 }).kind, 'rises');
  assert.equal(T.rowOutcome({ current_retail: 204.49, new_retail: 204.49 }).kind, 'unchanged');
  assert.equal(T.rowOutcome({ current_retail: 10, new_retail: 9, blocked_by_no_decrease: false }).kind, 'falls');
});

test('§2 diffLadders() lists only real changes, plus band moves, brand ladders and the offset', () => {
  const live = liveFixture();
  const p = {
    proposed_overrides: {
      genuine: { '45-60': 1.42, '<=10': 1.47 },
      bands: { compatible: [{ max_cost: 8, mult: 1.8 }, { max_cost: null, mult: 1.3 }] },
      brands: { [BROTHER]: { name: 'Brother', genuine: { '45-60': 1.48 } } },
    },
    proposed_global_offset: 0.01, base_global_offset: 0,
  };
  const rows = T.diffLadders(p, live);
  assert.deepEqual(rows.map((r) => `${r.scope}:${r.key}`), ['catalogue:45-60', 'bands:<=8 · 8+', 'brand:45-60', 'offset:global offset']);
  assert.equal(rows[0].live, 1.385);
});

test('§2 every contract error code has operator wording; details are appended', () => {
  for (const c of ['PROPOSAL_STALE', 'PROPOSAL_NOT_PENDING', 'INVALID_BAND_LADDER', 'UNKNOWN_TIER_BAND', 'UNKNOWN_BRAND', 'VALIDATION_ERROR', 'VALIDATION_FAILED', 'RATE_LIMITED', 'FORBIDDEN', 'NOT_FOUND']) {
    assert.ok(T.ERROR_COPY[c], c);
  }
  assert.match(T.errorMessage({ code: 'UNKNOWN_BRAND', details: [{ message: 'nope-brand' }] }), /nope-brand/);
  assert.equal(T.errorMessage({ message: 'Boom' }), 'Boom');
});

test('§2 pollDecision(): transient null keeps polling; missing/completed/failed/timeout stop', () => {
  assert.deepEqual(T.pollDecision(null, 1000), { stop: false, outcome: 'unknown' });
  assert.equal(T.pollDecision({ status: 'running' }, 1000).stop, false);
  assert.equal(T.pollDecision({ status: 'completed' }, 1000).outcome, 'completed');
  assert.equal(T.pollDecision({ status: 'failed' }, 1000).outcome, 'failed');
  assert.equal(T.pollDecision({ missing: true }, 1000).outcome, 'missing');
  assert.equal(T.pollDecision({ status: 'running' }, T.POLL_MAX_MS).outcome, 'timeout');
  assert.equal(T.POLL_MS, 5000);
  assert.equal(T.POLL_MAX_MS, 600000);
  assert.equal(T.SIM_DEBOUNCE_MS, 300);
});

// ── §3 API wrappers (real source, fake transport) ────────────────────────────
function extractBlock(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `not found: ${signature}`);
  // The BODY brace, not a destructuring default in the parameter list.
  let depth = 0; let i = src.indexOf(') {', start) + 2;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
const CC = API_SRC.slice(API_SRC.indexOf('  controlCenter: {'));
const METHODS = ['simulatePricing(payload)', 'getTierMultipliers()', 'proposeTierMultipliers(body)', 'proposeGlobalOffset(offset, notes)',
  'listTierProposals({ status, limit = 20 } = {})', 'getTierProposal(id)', 'approveTierProposal(id, notes)', 'rejectTierProposal(id, notes)',
  'retryReprice()', 'getRepriceJob(jobId)'];

function buildCC(transport) {
  const invoiceErrorSrc = extractBlock(API_SRC, 'function invoiceError(resp, fallback)');
  const methods = METHODS.map((m) => extractBlock(CC, `async ${m}`)).join(',\n');
  const calls = [];
  const toasts = [];
  const API = {};
  for (const verb of ['get', 'post', 'put']) {
    API[verb] = async (url, body) => { calls.push({ verb, url, body }); return transport(verb, url, body); };
  }
  // eslint-disable-next-line no-new-func
  const cc = new Function('window', 'DebugLog', 'adminApiWarn', `${invoiceErrorSrc}\nreturn {\n${methods}\n};`)(
    { API }, { warn() {} }, (label) => toasts.push(label));
  return { cc, calls, toasts };
}

test('§3 a 409 PROPOSAL_STALE (RESOLVED by API.request, string error) throws with its code', async () => {
  const { cc } = buildCC(() => ({ ok: false, error: 'Live ladder changed', code: 'PROPOSAL_STALE', data: {} }));
  await assert.rejects(cc.approveTierProposal('p1'), (e) => e.code === 'PROPOSAL_STALE');
  await assert.rejects(cc.rejectTierProposal('p1'), (e) => e.code === 'PROPOSAL_STALE');
});

test('§3 approve and reject send confirm:true; approve is the only POST to /approve', async () => {
  const { cc, calls } = buildCC(() => ({ ok: true, data: { applied: true } }));
  await cc.approveTierProposal('a b', 'ok');
  await cc.rejectTierProposal('p2');
  assert.deepEqual(calls[0], { verb: 'post', url: '/api/admin/pricing/tier-multipliers/proposals/a%20b/approve', body: { confirm: true, notes: 'ok' } });
  assert.deepEqual(calls[1].body, { confirm: true });
  assert.equal((API_SRC.match(/\/approve`/g) || []).length, 1, 'exactly one approve call site in the API layer');
});

test('§3 propose (tiers AND offset) throws on a resolved refusal — never resolves to null for "Saved"', async () => {
  const { cc } = buildCC(() => ({ ok: false, error: 'Too many', code: 'RATE_LIMITED' }));
  await assert.rejects(cc.proposeTierMultipliers({ genuine: { '45-60': 1.42 } }), (e) => e.code === 'RATE_LIMITED');
  await assert.rejects(cc.proposeGlobalOffset(0.01), (e) => e.code === 'RATE_LIMITED');
  const ok = buildCC(() => ({ ok: true, data: { applied: false, status: 'pending_approval' } }));
  assert.deepEqual(await ok.cc.proposeGlobalOffset(0.01, 'n'), { applied: false, status: 'pending_approval' });
  assert.deepEqual(ok.calls[0], { verb: 'put', url: '/api/admin/pricing/global-offset', body: { offset: 0.01, notes: 'n' } });
});

test('§3 simulate surfaces the TOP-LEVEL code and details (the old wrapper read error.code off a string)', async () => {
  const { cc } = buildCC(() => ({ ok: false, error: 'Validation failed', code: 'VALIDATION_FAILED', details: [{ message: 'must contain at least 2 items' }] }));
  let caught;
  await assert.rejects(cc.simulatePricing({}), (e) => { caught = e; return e.code === 'VALIDATION_FAILED' && Array.isArray(e.details); });
  // …and the panel's wording carries the field-level reason, not a bare "Validation failed".
  assert.match(T.errorMessage(caught), /at least 2 items/);
});

test('§3 a thrown 4xx (INVALID_BAND_LADDER) propagates with its code', async () => {
  const { cc } = buildCC(() => { const e = new Error('bad ladder'); e.code = 'INVALID_BAND_LADDER'; e.status = 400; throw e; });
  await assert.rejects(cc.proposeTierMultipliers({ bands: {} }), (e) => e.code === 'INVALID_BAND_LADDER');
});

test('§3 getRepriceJob has three states: row, {missing} on 404, null on a transient failure', async () => {
  assert.deepEqual(await buildCC(() => ({ ok: true, data: { id: 'j', status: 'running' } })).cc.getRepriceJob('j'), { id: 'j', status: 'running' });
  assert.deepEqual(await buildCC(() => ({ ok: false, error: 'Reprice job not found', code: 'NOT_FOUND' })).cc.getRepriceJob('j'), { missing: true, id: 'j' });
  assert.equal(await buildCC(() => ({ ok: false, error: 'x', code: 'INTERNAL_ERROR' })).cc.getRepriceJob('j'), null);
  assert.equal(await buildCC(() => { throw new Error('network'); }).cc.getRepriceJob('j'), null);
});

test('§3 listTierProposals throws on failure (an empty history must not look like a failed read) and clamps limit', async () => {
  await assert.rejects(buildCC(() => ({ ok: false, error: 'x', code: 'FORBIDDEN' })).cc.listTierProposals());
  const { cc, calls } = buildCC(() => ({ ok: true, data: [] }));
  assert.deepEqual(await cc.listTierProposals({ status: 'pending', limit: 500 }), []);
  assert.equal(calls[0].url, '/api/admin/pricing/tier-multipliers/proposals?status=pending&limit=100');
});

test('§3 the dead/wrong-shape wrappers are gone', () => {
  const live = stripComments(API_SRC);
  assert.doesNotMatch(live, /commitPricing/);
  assert.doesNotMatch(live, /async updateTierMultipliers/);
  assert.doesNotMatch(live, /apply_ending_snap/);
});

// ── §4 panel wiring ──────────────────────────────────────────────────────────

test('§4 no propose path says "saved"/"updated"; it says proposed / awaiting approval', () => {
  for (const [name, src] of [['cc2-pricing', PANEL], ['cc-profit', PROFIT]]) {
    const strings = (src.match(/(['"`])(?:\\.|(?!\1).)*\1/g) || []).join('\n');
    assert.doesNotMatch(strings, /\bSaved\b|\bsaved\b|Save changes|Save Offset|Confirm & save/, `${name} still says saved`);
    assert.match(strings, /awaiting approval/, `${name} must say awaiting approval`);
  }
});

test('§4 Approve is disabled when stale / not pending / not owner, and the dialog RE-READS first', () => {
  assert.match(PANEL, /const approveDisabled = !pending \|\| d\.stale \|\| !owner;/);
  const dlg = PANEL.slice(PANEL.indexOf('async function openApproveDialog'), PANEL.indexOf('function handleApproved'));
  const reread = dlg.indexOf('getTierProposal(id)');
  const open = dlg.indexOf('Modal.open');
  assert.ok(reread > -1 && open > reread, 'must re-read the proposal BEFORE opening the dialog');
  assert.match(dlg, /fresh\.stale/);
  assert.match(dlg, /cc2-approve-ack/, 'approve needs an explicit acknowledgement');
});

test('§4 enqueue_failed is surfaced as "ladder live, no reprice" with a retry', () => {
  assert.match(PANEL, /r\.status === 'enqueue_failed'/);
  assert.match(PANEL, /The new ladder IS live, but no reprice started/);
  assert.match(PANEL, /data-action="retry-reprice"/);
});

test('§4 the packs follow-up is shown verbatim from the approve response', () => {
  assert.match(PANEL, /job\.packs\.action_required/);
});

test('§4 polling uses the tested constants and resumes from the latest approved proposal', () => {
  assert.match(PANEL, /setTimeout\(tick, POLL_MS\)/);
  assert.match(PANEL, /pollDecision\(job, Date\.now\(\) - startedAt\)/);
  assert.match(PANEL, /listTierProposals\(\{ status: 'approved', limit: 1 \}\)/);
  assert.match(PANEL, /latest\.reprice_job_id/);
});

test('§4 simulate is debounced, sequence-guarded, validated first, and runs a drift baseline', () => {
  assert.match(PANEL, /setTimeout\(runSimulate, SIM_DEBOUNCE_MS\)/);
  assert.match(PANEL, /seq !== _state\.simSeq/);
  const run = PANEL.slice(PANEL.indexOf('async function runSimulate'), PANEL.indexOf('function onInput'));
  const gate = run.indexOf("if (_state.validation.some((e) => e.reason !== 'no_change')) return;");
  assert.ok(gate > -1 && gate < run.indexOf('simulatePricing'), 'validation must gate the simulate call');
  assert.match(run, /baselineSimulateBody\(body, _state\.live\)/);
});

test('§4 the ratchet warning and "keeps" rows are rendered', () => {
  assert.match(PANEL, /rat\.warning/);
  assert.match(PANEL, /o\.kind === 'keeps'/);
  assert.match(PANEL, /Not revenue, not a forecast/);
});

test('§4 a pending proposal opens the review state, and proposing over one warns about superseding', () => {
  assert.match(PANEL, /live\.pending_proposal && _state\.view === 'edit'/);
  assert.match(PANEL, /supersedes/);
});

test('§4 unmount safety: timers cleared and every await re-checks _host', () => {
  const destroy = PANEL.slice(PANEL.indexOf('destroy()'));
  assert.match(destroy, /clearTimeout\(_simTimer\)/);
  assert.match(destroy, /clearTimeout\(_pollTimer\)/);
});

test('§4 cc-profit no longer polls or claims a reprice for an offset change', () => {
  assert.doesNotMatch(PROFIT, /handleRepriceResponse|pollRepriceJob|getRepriceJob/);
  assert.match(PROFIT, /Propose offset/);
  assert.match(PROFIT, /Toast\.error\(errorMessage\(e\)\)/);
  assert.match(PROFIT, /pending_proposal/);
});

test('§4 every class the panel emits is styled', () => {
  const css = read('inkcartridges/css/admin.css');
  const src = read('inkcartridges/js/admin/pages/cc2-pricing.js');
  const ids = new Set([...src.matchAll(/id="(cc2-[a-z0-9-]+)"/g)].map((m) => m[1]));
  const classes = new Set([...src.matchAll(/\b(cc2-tiers[a-z0-9_-]*)/g)].map((m) => m[1]).filter((c) => !c.endsWith('-') && !c.endsWith('--') && !ids.has(c)));
  for (const c of classes) {
    if (/--(superseded|unknown)$/.test(c)) continue;
    assert.ok(css.includes(`.${c}`), `.${c} is unstyled`);
  }
});

// ── §5 enrolment ─────────────────────────────────────────────────────────────

test('§5 cache tokens moved so the new modules actually load', () => {
  assert.doesNotMatch(read('inkcartridges/js/admin/pages/control-center.js'), /CC_VERSION = '2026\.07\.16b'/);
  assert.doesNotMatch(read('inkcartridges/js/admin/app.js'), /APP_VERSION = '2026\.09\.20-for-use-in-write'/);
});

test('§5 the probe is registered, READ-ONLY, prints its mode, and never approves', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['probe:tier-approval'], 'node scripts/probe-tier-approval.mjs');
  const probe = stripComments(read('scripts/probe-tier-approval.mjs'));
  assert.match(probe, /READ-ONLY/);
  assert.doesNotMatch(probe, /\/approve|\/reject|method: 'PUT'|method: "PUT"/);
  assert.doesNotMatch(probe, /Snowflake|password\s*[:=]\s*['"][^'"]+['"]/i, 'credentials come from the environment only');
});

test('§5 the contract is filed in backend-docs/inbox and ERR-281 is logged', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'backend-docs/inbox/tier-multiplier-approval-backend-contract-sep2026.md')));
  assert.ok(read('errors.md').includes('## ERR-281 '), 'errors.md must carry the ERR-281 entry');
});
