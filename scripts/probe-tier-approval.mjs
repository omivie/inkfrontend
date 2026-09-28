#!/usr/bin/env node
/**
 * probe-tier-approval.mjs — the live contract behind the approval-gated tier
 * multiplier panel (backend migration 187). ERR-281.
 * ==========================================================================
 *
 * Contract: backend-docs/inbox/tier-multiplier-approval-backend-contract-sep2026.md
 * Panel:    inkcartridges/js/admin/pages/cc2-pricing.js
 * Logic:    inkcartridges/js/admin/utils/tierProposal.js (imported here, so the
 *           probe checks the SHIPPED key grammar against the server's)
 *
 * ── READ-ONLY, AND THERE IS NO WRITE MODE ─────────────────────────────────
 *
 * GET and POST /simulate only. The simulator is read-only on the server. This
 * probe never proposes, approves, rejects or reprices:
 *   - a proposal SUPERSEDES whatever is pending, so a probe that files one can
 *     destroy an operator's work in progress;
 *   - approval reprices the whole catalogue and cannot be undone with a second
 *     click, because automated repricing never lowers a price.
 * The propose → review → reject path was exercised once by hand, with the
 * owner's permission, on 2026-09-23 (see ERR-281).
 *
 * ── WHAT IT MEASURES ──────────────────────────────────────────────────────
 *   §1 the routes exist        401 unauthenticated vs 404 for a made-up route
 *                              (the negative control; without it a 401 proves nothing)
 *   §2 the GET ladder shape    every key the panel reads is PRESENT (absent ≠ null)
 *   §3 the key grammar         keys rebuilt from boundaries by the shipped util
 *                              match the server's keys, band for band
 *   §4 a one-band simulate     the edited band echoes the proposed multiplier
 *   §5 drift                   what a no-change reprice would move today (note);
 *                              the server's `baseline` block must equal it and
 *                              `edit_only` must be zero for a no-change simulate
 *   §6 the ratchet             `aggregate.delivered` exists (BF-068 2.1) and the
 *                              `baseline`/`edit_only` blocks add up to it (2.2)
 *                              — the panel's headline figures READ these
 *   §7 simulate refuses        unknown band key, bad ladder, non-id brand key,
 *                              unknown brand id → 400 with PUT's codes (2.3)
 *   §8 job 404                 a made-up reprice job id → NOT_FOUND, the state
 *                              the panel's poller stops on
 *
 * NOT exercised: POST /reprice-jobs (the retry route). It QUEUES A FULL
 * CATALOGUE REPRICE — that is a write, and the transport below refuses it.
 *
 * Needs ADMIN_EMAIL / ADMIN_PASSWORD (a super_admin) in .env or the environment.
 * Lives in scripts/, not inkcartridges/scripts/ (that tree is served publicly).
 *
 * Usage:  npm run probe:tier-approval  [-- --json]
 * Exit:   0 all checks passed · 1 a real finding · 2 could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const JSON_OUT = process.argv.includes('--json');

const { ladderKeys, bandsFromServer, ratchetSummary } = await import(path.join(SITE, 'js/admin/utils/tierProposal.js'));

function loadDotEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

function configConstant(name) {
  const src = fs.readFileSync(path.join(SITE, 'js', 'config.js'), 'utf8');
  const m = new RegExp(`${name}:\\s*'([^']+)'`).exec(src);
  if (!m) throw new Error(`config.js no longer defines ${name} — update the probe`);
  return m[1];
}
const SUPABASE_URL = configConstant('SUPABASE_URL');
const SUPABASE_ANON_KEY = configConstant('SUPABASE_ANON_KEY');
const API_BASE = process.env.API_BASE || 'https://api.inkcartridges.co.nz';

let pass = 0;
const findings = [];
const notes = [];
const results = [];
const say = (s = '') => { if (!JSON_OUT) console.log(s); };
const ok = (name, detail = '') => { pass++; results.push({ status: 'pass', name, detail }); say(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`); };
const bad = (name, detail = '') => { findings.push(`${name} — ${detail}`); results.push({ status: 'fail', name, detail }); say(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`); };
// Real and worth reporting, already handled by the panel — must not redden the exit code.
const soft = (name, detail = '') => { notes.push(`${name} — ${detail}`); results.push({ status: 'note', name, detail }); say(`  \x1b[33m~\x1b[0m ${name}\n      ${detail}`); };
const cannotRun = (msg) => { console.error(`\n\x1b[33m▲ probe could not run\x1b[0m — ${msg}\n`); process.exit(2); };

let TOKEN = null;
async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.access_token) throw new Error(`sign-in failed (${res.status})`);
  return json.access_token;
}

// The ONE transport. GET, or POST to /simulate — nothing else is allowed out.
async function api(method, p, body, { auth = true } = {}) {
  if (method !== 'GET' && !(method === 'POST' && p === '/api/admin/pricing/simulate')) {
    throw new Error(`READ-ONLY probe refused ${method} ${p}`);
  }
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (auth && TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(API_BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

say('\n\x1b[1mprobe:tier-approval\x1b[0m — MODE: \x1b[36mREAD-ONLY\x1b[0m (GET + POST /simulate; never proposes, approves, rejects or reprices)');
say(`  API ${API_BASE}\n`);

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
if (!email || !password) cannotRun('ADMIN_EMAIL / ADMIN_PASSWORD not set (.env or environment)');

// §1 routes exist — with a negative control
say('§1 routes');
{
  const real = await api('GET', '/api/admin/pricing/tier-multipliers/proposals', null, { auth: false });
  const fake = await api('GET', '/api/admin/pricing/zz-probe-no-such-route', null, { auth: false });
  if (fake.status !== 404) bad('negative control', `a made-up route answered ${fake.status}, not 404 — §1 cannot tell deployed from absent`);
  else if (real.status === 404) bad('proposals route', 'answers 404 like a made-up route — migration 187 routes are not deployed');
  else ok('proposals route is deployed', `unauth ${real.status} vs made-up route 404`);
}

try { TOKEN = await signIn(email, password); } catch (e) { cannotRun(e.message); }

// §2 ladder shape
say('\n§2 GET /tier-multipliers');
const ladder = await api('GET', '/api/admin/pricing/tier-multipliers');
if (ladder.status === 403) cannotRun('403 — ADMIN_EMAIL is not a super_admin');
if (ladder.status !== 200 || !ladder.json?.ok) cannotRun(`GET ladder → ${ladder.status}`);
const L = ladder.json.data;
for (const k of ['defaults', 'overrides', 'effective', 'bands', 'bands_are_custom', 'global_offset', 'pending_proposal']) {
  if (k in L) ok(`data.${k} present`, k === 'pending_proposal' ? (L[k] ? `PENDING ${L[k].id}` : 'null') : k === 'global_offset' ? String(L[k]) : '');
  else bad(`data.${k}`, 'ABSENT — the panel reads it; absent is not null');
}

// §3 key grammar
say('\n§3 band keys');
for (const src of ['genuine', 'compatible']) {
  const server = (L.bands?.[src] || []);
  const rebuilt = ladderKeys(bandsFromServer(server));
  const serverKeys = server.map((b) => b.key);
  if (!server.length) { bad(`${src} bands`, 'empty'); continue; }
  if (server[server.length - 1].maxCost !== null) bad(`${src} last band`, 'not open-ended');
  if (JSON.stringify(rebuilt) === JSON.stringify(serverKeys)) ok(`${src}: ${server.length} keys rebuilt from boundaries match the server`);
  else bad(`${src} key grammar`, `server ${serverKeys.join(',')} vs util ${rebuilt.join(',')}`);
  const eff = Object.keys(L.effective?.[src] || {});
  if (eff.length === serverKeys.length && serverKeys.every((k) => eff.includes(k))) ok(`${src}: effective keys == band keys`);
  else bad(`${src} effective`, 'effective keys and band keys disagree — the panel edits one and simulates the other');
}

// §4 one-band simulate
say('\n§4 simulate one band');
const band = L.bands.genuine[0];
const bumped = Math.min(5, Number((band.mult + 0.01).toFixed(4)));
const one = await api('POST', '/api/admin/pricing/simulate', { scope: { source: 'genuine' }, proposed_tiers: { genuine: { [band.key]: bumped } }, preview_limit: 1 });
if (one.status !== 200) bad('simulate', `${one.status} ${JSON.stringify(one.json?.error)}`);
else {
  const row = (one.json.data.by_tier || []).find((r) => r.source === 'genuine' && r.tier === band.key);
  if (!row) bad('by_tier row', `no row for ${band.key}`);
  else if (Math.abs(row.proposed_multiplier - bumped) < 1e-9) ok(`by_tier echoes ${band.key} → ${bumped}`, `current ${row.current_multiplier}`);
  else bad('by_tier echo', `proposed ${row.proposed_multiplier}, sent ${bumped}`);
  for (const k of ['affected', 'aggregate', 'by_tier', 'no_decrease_ratchet', 'sample', 'global_offset_applied']) {
    if (!(k in one.json.data)) bad(`simulate.${k}`, 'ABSENT');
  }
}

// §5 drift
say('\n§5 drift (no-change baseline)');
const base = await api('POST', '/api/admin/pricing/simulate', { scope: {}, proposed_tiers: {}, preview_limit: 1 });
if (base.status !== 200) bad('baseline simulate', String(base.status));
else {
  const r = base.json.data.no_decrease_ratchet || {};
  if (r.will_change_skus > 0) soft('a reprice with NO edit would still move prices', `${r.will_change_skus} SKUs rise, ${r.blocked_skus} held by the ratchet — the panel shows this as drift, separate from the edit`);
  else ok('no drift', 'a no-change reprice moves nothing');
  const b = base.json.data.baseline;
  const e = base.json.data.edit_only;
  if (!b || !e) bad('baseline / edit_only blocks', 'ABSENT — the panel prints "Not split" on every preview (BF-068 2.2 regressed)');
  else {
    if (b.will_change_skus === r.will_change_skus && b.blocked_skus === r.blocked_skus) ok('`baseline` of a no-change simulate is the simulate itself', `${b.will_change_skus} change · ${b.blocked_skus} held`);
    else bad('baseline self-consistency', `baseline ${b.will_change_skus}/${b.blocked_skus} vs ratchet ${r.will_change_skus}/${r.blocked_skus}`);
    if (e.skus_priced_differently === 0 && e.net_profit_per_unit_delta_delivered === 0) ok('`edit_only` of a no-change simulate is zero');
    else bad('edit_only of no change', JSON.stringify(e));
  }
}

// §6 ratchet inside the aggregate
say('\n§6 no-decrease ratchet');
const cband = L.bands.compatible[Math.min(3, L.bands.compatible.length - 1)];
const low = Math.max(1.05, Number((cband.mult - 0.1).toFixed(4)));
const cut = await api('POST', '/api/admin/pricing/simulate', { scope: { source: 'compatible' }, proposed_tiers: { compatible: { [cband.key]: low } }, preview_limit: 5000 });
if (cut.status !== 200) bad('ratchet simulate', String(cut.status));
else {
  const d = cut.json.data;
  const rs = ratchetSummary(d);
  if (d.no_decrease_ratchet?.enforced === true) ok('ratchet enforced', `${rs.blocked} blocked, ${rs.willChange} will change`);
  else bad('ratchet', `enforced = ${d.no_decrease_ratchet?.enforced} — the contract says always true in production`);
  // BF-068 2.1: the plain *_after fields keep their TABLE meaning; `delivered`
  // holds the ratchet-applied twins the panel leads with.
  const dl = d.aggregate?.delivered;
  const twins = ['avg_retail_change_pct', 'avg_net_margin_after', 'net_profit_per_unit_after', 'net_profit_per_unit_delta', 'catalogue_value_after', 'below_survival_floor_after'];
  const missing = dl ? twins.filter((k) => !Number.isFinite(dl[k])) : twins;
  if (missing.length) bad('aggregate.delivered', `missing ${missing.join(', ')} — the panel falls back to TABLE figures and says so`);
  else if (rs.blocked > 0 && !(dl.net_profit_per_unit_delta > d.aggregate.net_profit_per_unit_delta)) {
    bad('delivered applies the ratchet', `${rs.blocked} rows held, yet delivered Δ ${dl.net_profit_per_unit_delta} is not above table Δ ${d.aggregate.net_profit_per_unit_delta}`);
  } else ok('aggregate.delivered carries all six shelf twins', `profit/unit Δ table ${d.aggregate.net_profit_per_unit_delta} vs shelf ${dl.net_profit_per_unit_delta}`);
  const b = d.baseline;
  const e = d.edit_only;
  if (b && e && dl) {
    const sum = Math.round((b.net_profit_per_unit_delta_delivered + e.net_profit_per_unit_delta_delivered) * 100) / 100;
    if (Math.abs(sum - dl.net_profit_per_unit_delta) <= 0.02) ok('drift + this edit = the delivered total', `${b.net_profit_per_unit_delta_delivered} + ${e.net_profit_per_unit_delta_delivered} = ${dl.net_profit_per_unit_delta}`);
    else bad('baseline + edit_only ≠ delivered', `${b.net_profit_per_unit_delta_delivered} + ${e.net_profit_per_unit_delta_delivered} = ${sum}, delivered ${dl.net_profit_per_unit_delta}`);
  } else bad('baseline / edit_only on an edit', 'ABSENT');
}

// §7 simulate refuses what PUT refuses (BF-068 2.3). A 200 here previews a
// typo as "no change".
say('\n§7 simulate refuses what PUT refuses');
for (const [what, body, want] of [
  ['an unknown band key', { proposed_tiers: { genuine: { '<=100': 1.4 } } }, 'UNKNOWN_TIER_BAND'],
  ['a descending ladder', { proposed_tiers: { bands: { genuine: [{ max_cost: 10, mult: 1.5 }, { max_cost: 5, mult: 1.4 }, { max_cost: null, mult: 1.3 }] } } }, 'INVALID_BAND_LADDER'],
  ['a brand keyed by slug', { proposed_tiers: { brands: { hp: { genuine: { '<=10': 1.5 } } } } }, 'VALIDATION_FAILED'],
  ['an unknown brand id', { proposed_tiers: { brands: { '00000000-0000-0000-0000-000000000000': { genuine: { '<=10': 1.5 } } } } }, 'UNKNOWN_BRAND'],
]) {
  const r = await api('POST', '/api/admin/pricing/simulate', { ...body, preview_limit: 1 });
  const code = r.json?.error?.code || r.json?.code;
  if (r.status === 400 && code === want) ok(`${what} → 400 ${want}`);
  else bad(`${what}`, `HTTP ${r.status} ${code || ''} — expected 400 ${want}`);
}

// §8 reprice job 404
say('\n§8 reprice job');
const job = await api('GET', '/api/admin/pricing/reprice-jobs/00000000-0000-0000-0000-000000000000');
if (job.status === 404 && job.json?.error?.code === 'NOT_FOUND') ok('a made-up job id is 404 NOT_FOUND', 'the poller stops on it instead of polling a dead id');
else bad('reprice job 404', `${job.status} ${JSON.stringify(job.json?.error)}`);

say(`\n${pass} passed · ${findings.length} failed · ${notes.length} notes  (READ-ONLY: nothing was written)\n`);
if (JSON_OUT) console.log(JSON.stringify({ mode: 'read-only', pass, findings, notes, results }, null, 2));
process.exit(findings.length ? 1 : 0);
