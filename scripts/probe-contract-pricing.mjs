#!/usr/bin/env node
/**
 * probe-contract-pricing.mjs — the live contract for per-account contract
 * pricing (backend migration 165)
 * ==========================================================================
 *
 * An admin sets one business account's own price for one product. The price
 * applies to that account and nothing else; no catalogue row is ever written.
 * Hand-off: `readfirst/business-account-contract-pricing-FE-handoff-sep2026.md`.
 *
 * ── WHY THIS PROBE HAS A WRITE MODE, WHEN ALMOST NONE OF THE OTHERS DO ─────
 *
 * On the day this shipped, production held **zero contract prices**. Both
 * business accounts reported `custom_price_count: 0`, and `custom-prices` and
 * `price-history` both answered `items: []`.
 *
 * That means every populated shape in the hand-off — the §4.3 row, the §4.6
 * history row and its four-action null table, the per-line `contract` block on
 * both quote endpoints, the §8 cart figures — is UNPROVEN by reading. A
 * read-only probe against this feature can confirm that the endpoints exist and
 * that they answer empty. It cannot confirm a single thing the frontend
 * actually renders.
 *
 * "Count the live rows before believing a feature works" is the rule
 * (ERR-180). Here there are no live rows to count, so the probe makes one,
 * measures it, and removes it.
 *
 * ── THE MODE IS PRINTED BEFORE ANY WORK, AND WRITING IS NEVER INFERRED ─────
 *
 * Default is READ-ONLY. `--write` arms the mutation cycle and nothing else
 * does. This is not ceremony: `sweep:b2b` once passed because it had silently
 * overwritten the fixture it was comparing against (2026-08-12), and a probe
 * that can write without saying so is a probe whose green result means nothing.
 *
 * The write cycle records NOTHING to disk. It asserts and it cleans up.
 *
 * ── CLEANUP IS ITSELF A CHECK ──────────────────────────────────────────────
 *
 * Cleanup runs from a `finally` and from the crash handlers, every DELETE is
 * printed, and a cleanup that fails forces exit 1 even when every other check
 * passed — with the account id, the product id and a copy-pasteable curl. A
 * probe that can leave a live contract price on a real customer's account and
 * not tell you is worse than no probe.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT TEST ───────────────────────────────────
 *
 * The §8 CART effect. Proving it needs a second sign-in as the account's own
 * customer and a mutation of a real person's cart. Same reasoning as
 * probe-invoice-quote's refusal to create invoices: a probe that writes to a
 * customer's cart is a probe nobody dares run, and one nobody runs is worse
 * than one that does less. The cart figures are checked by hand and by
 * tests/cart-contract-pricing-sep2026.test.js.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel
 * output directory and is served publicly. A file here that reads .env must
 * never be one URL away from the internet.
 *
 * Usage:
 *   npm run probe:contract-pricing                    read-only (default)
 *   npm run probe:contract-pricing -- --write         + the full mutation cycle
 *   npm run probe:contract-pricing -- --write --force ...even if prices exist
 *   npm run probe:contract-pricing -- --json
 *
 * Needs ADMIN_EMAIL / ADMIN_PASSWORD in .env — a super_admin, or every route
 * here 403s.
 *
 * Exit: 0 = every check passed · 1 = a real finding (or a failed cleanup)
 *       2 = could not run. "We could not look" is never reported as "we looked
 *       and it was fine".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SITE = path.join(ROOT, 'inkcartridges');

const ARGS = new Set(process.argv.slice(2));
const JSON_OUT = ARGS.has('--json');
const WRITE = ARGS.has('--write');
const FORCE = ARGS.has('--force');

// ──────────────────────────────────────────────────────────────────────────
// Environment
// ──────────────────────────────────────────────────────────────────────────

/** Minimal .env reader — no dependency, and the file is gitignored. */
function loadDotEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const rawLine of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

/**
 * Read a constant out of the shipped config.js rather than duplicating it, so
 * the probe follows the storefront if the Supabase project moves instead of
 * quietly authenticating against the wrong tenant.
 *
 * NOT used for API_URL: config.js defines that as a hostname ternary rather
 * than a quoted literal, so the regex cannot read it. The default below is the
 * same backend the ternary picks in production.
 */
function configConstant(name) {
  const src = fs.readFileSync(path.join(SITE, 'js', 'config.js'), 'utf8');
  const m = new RegExp(`${name}:\\s*'([^']+)'`).exec(src);
  if (!m) throw new Error(`config.js no longer defines ${name} — update the probe`);
  return m[1];
}

const SUPABASE_URL = configConstant('SUPABASE_URL');
const SUPABASE_ANON_KEY = configConstant('SUPABASE_ANON_KEY');
const API_BASE = process.env.API_BASE || 'https://api.inkcartridges.co.nz';

// ──────────────────────────────────────────────────────────────────────────
// Output
// ──────────────────────────────────────────────────────────────────────────

let pass = 0;
const findings = [];
const notes = [];
const results = [];

const say = (s = '') => { if (!JSON_OUT) console.log(s); };
const ok = (name, detail = '') => {
  pass++; results.push({ status: 'pass', name, detail });
  say(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
};
const bad = (name, detail = '') => {
  findings.push(`${name} — ${detail}`); results.push({ status: 'fail', name, detail });
  say(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
};
/**
 * Real, worth reporting, and already handled correctly by the frontend — so it
 * must NOT redden the exit code. Keeping these separate is the point: if a soft
 * note could fail the run, the run gets ignored, and a hard failure gets
 * ignored with it.
 */
const soft = (name, detail = '') => {
  notes.push(`${name} — ${detail}`); results.push({ status: 'note', name, detail });
  say(`  \x1b[33m~\x1b[0m ${name}\n      ${detail}`);
};
const check = (cond, name, detail) => (cond ? ok(name, typeof cond === 'string' ? cond : '') : bad(name, detail));
const cannotRun = (msg) => {
  console.error(`\n\x1b[33m▲ probe could not run\x1b[0m — ${msg}\n`);
  process.exit(2);
};
const money = (n) => (n == null ? 'null' : `$${Number(n).toFixed(2)}`);

/**
 * Present, and a number or null. An ABSENT key is the failure that matters:
 * Number(undefined) is NaN, the UI reads that as "no value", and the result is
 * indistinguishable from a genuine zero.
 */
function nullableNumber(obj, key, where) {
  if (!obj || !(key in obj)) {
    return bad(`${where}.${key}`, 'ABSENT — absent, null and 0 are three different facts here');
  }
  const v = obj[key];
  if (v === null || typeof v === 'number') return ok(`${where}.${key}`, v === null ? 'null' : money(v));
  bad(`${where}.${key}`, `expected number|null, got ${typeof v} (${JSON.stringify(v)})`);
}

// ──────────────────────────────────────────────────────────────────────────
// Transport
// ──────────────────────────────────────────────────────────────────────────

let TOKEN = null;

async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.access_token) throw new Error(`sign-in failed (${res.status}): ${JSON.stringify(json).slice(0, 200)}`);
  return json.access_token;
}

/**
 * The ONE transport function. If you are adding a second, stop and ask whether
 * this is still the probe it says it is on the tin.
 */
async function api(method, p, body) {
  const res = await fetch(API_BASE + p, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text, data: json?.data ?? null, error: json?.error ?? null };
}
const GET = (p) => api('GET', p);

// ──────────────────────────────────────────────────────────────────────────
// Cleanup — registered BEFORE the first write, honoured on every exit path
// ──────────────────────────────────────────────────────────────────────────

/** @type {{accountId:string, productId:string, sku:string}|null} */
let PENDING = null;
let cleanupFailed = null;

async function cleanup() {
  if (!PENDING) return;
  const { accountId, productId, sku } = PENDING;
  say('\n\x1b[1mCleanup\x1b[0m');
  try {
    const del = await api('DELETE', `/api/admin/business/accounts/${accountId}/custom-prices/${productId}`);
    if (del.status === 200) say(`  \x1b[32m✓\x1b[0m removed the probe's contract price on ${sku}`);
    else if (del.status === 404) say(`  \x1b[32m✓\x1b[0m nothing left to remove on ${sku} (already gone)`);
    else throw new Error(`DELETE answered ${del.status}: ${del.text.slice(0, 160)}`);

    // Verify, don't assume. A cleanup that reports success without looking is
    // the same class of claim this whole probe exists to stop making.
    const after = await GET(`/api/admin/business/accounts/${accountId}/custom-prices?search=${encodeURIComponent(sku)}`);
    const left = (after.data?.items || []).filter((r) => r.sku === sku);
    if (left.length) throw new Error(`${sku} still has a contract price of ${money(left[0].contract_price)}`);
    say(`  \x1b[32m✓\x1b[0m verified: the account has no contract price for ${sku}`);
    PENDING = null;
  } catch (e) {
    cleanupFailed = e.message;
    console.error(`\n\x1b[41m\x1b[97m CLEANUP FAILED \x1b[0m`);
    console.error(`\x1b[31mA contract price this probe created may still be LIVE on a real account.\x1b[0m`);
    console.error(`  account : ${accountId}`);
    console.error(`  product : ${productId} (${sku})`);
    console.error(`  reason  : ${e.message}`);
    console.error(`\n  Remove it by hand:`);
    console.error(`    curl -X DELETE '${API_BASE}/api/admin/business/accounts/${accountId}/custom-prices/${productId}' \\`);
    console.error(`      -H "Authorization: Bearer $TOKEN"\n`);
  }
}

for (const sig of ['uncaughtException', 'unhandledRejection']) {
  process.on(sig, async (e) => {
    console.error(`\n\x1b[31m${sig}:\x1b[0m ${e && e.message ? e.message : e}`);
    await cleanup();
    process.exit(2);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Read-only checks
// ──────────────────────────────────────────────────────────────────────────

async function readOnlyChecks(accounts) {
  say('\n\x1b[1m1 · GET /api/admin/business/accounts — the list that did not exist\x1b[0m');
  check(Array.isArray(accounts) && accounts.length > 0, `${accounts.length} business account(s)`,
    'no accounts at all — every later check would be vacuous');
  const a = accounts[0];
  for (const k of ['id', 'user_id', 'company_name', 'status', 'custom_price_count']) {
    check(k in a, `accounts[0].${k} present`, `ABSENT — the hand-off documents it`);
  }
  if ('application_id' in a) {
    soft('accounts[0].application_id', 'present and NOT in the hand-off — harmless, but they should document it');
  }

  say('\n\x1b[1m2 · the query parameters refuse rather than clamp (ERR-221)\x1b[0m');
  const over = await GET('/api/admin/business/accounts?limit=200');
  check(over.status === 400, 'limit=200 → 400, not a silent clamp',
    `got ${over.status} — if this ever starts clamping, the ERR-221 comment in api.js is stale`);
  const at = await GET('/api/admin/business/accounts?limit=100');
  check(at.status === 200, 'limit=100 → 200', `got ${at.status}`);
  const wrongStatus = await GET('/api/admin/business/accounts?status=approved');
  check(wrongStatus.status === 400, 'status=approved → 400 (the STOREFRONT vocabulary is not this route\'s)',
    `got ${wrongStatus.status} — /api/business/status answers "approved", this route does not accept it`);
  const rightStatus = await GET('/api/admin/business/accounts?status=active');
  check(rightStatus.status === 200, 'status=active → 200', `got ${rightStatus.status}`);

  say('\n\x1b[1m3 · search actually filters (unlike /business-applications)\x1b[0m');
  // /api/admin/business/applications accepts `search=` and SILENTLY IGNORES it,
  // returning the whole table (ERR-151). Proving this endpoint really filters is
  // what licenses using `search` in the account picker at all.
  const nonsense = await GET('/api/admin/business/accounts?search=zzzznotreal');
  check(nonsense.status === 200 && (nonsense.data?.accounts || []).length === 0,
    'search=zzzznotreal → 0 rows (a real filter, not a decoy)',
    `got ${nonsense.status} with ${(nonsense.data?.accounts || []).length} rows — a bogus filter returning EVERYTHING is the ERR-151 shape`);

  say('\n\x1b[1m4 · path validation\x1b[0m');
  const notUuid = await GET('/api/admin/business/accounts/not-a-uuid/custom-prices');
  check(notUuid.status === 400 && notUuid.error?.code === 'VALIDATION_FAILED',
    'a non-UUID id → 400 VALIDATION_FAILED', `got ${notUuid.status} ${notUuid.error?.code}`);
  const missing = await GET('/api/admin/business/accounts/00000000-0000-0000-0000-000000000000');
  check(missing.status === 404 && missing.error?.code === 'NOT_FOUND',
    'an unknown account → 404 NOT_FOUND, never a silent empty', `got ${missing.status}`);

  say('\n\x1b[1m5 · the per-account reads\x1b[0m');
  const detail = await GET(`/api/admin/business/accounts/${a.id}`);
  check(detail.status === 200 && detail.data?.account?.id === a.id, 'GET /accounts/:id', `got ${detail.status}`);
  const prices = await GET(`/api/admin/business/accounts/${a.id}/custom-prices`);
  check(prices.status === 200 && Array.isArray(prices.data?.items), 'GET /custom-prices', `got ${prices.status}`);
  const history = await GET(`/api/admin/business/accounts/${a.id}/price-history`);
  check(history.status === 200 && Array.isArray(history.data?.items), 'GET /price-history', `got ${history.status}`);
  check(history.data && 'product_id' in history.data,
    'price-history echoes the product_id filter (null when account-wide)', 'ABSENT');

  say('\n\x1b[1m6 · product-search carries the guard rails the price box needs\x1b[0m');
  const search = await GET(`/api/admin/business/accounts/${a.id}/product-search?limit=5`);
  check(search.status === 200 && (search.data?.items || []).length > 0,
    'GET /product-search returns products', `got ${search.status}`);
  const p = (search.data?.items || [])[0];
  if (p) {
    for (const k of ['product_id', 'sku', 'list_price', 'has_contract_price']) {
      check(k in p, `product-search[0].${k} present`, 'ABSENT');
    }
    // The CONSISTENCY is the contract, not the values: with no supplier cost,
    // cost_price, break_even_price and floor_price must ALL be null together.
    // A break-even of $0 beside a null cost would be a licence to give the
    // product away.
    const costKnown = p.cost_price != null;
    const guardsKnown = p.break_even_price != null && p.floor_price != null;
    check(costKnown === guardsKnown,
      `guard rails agree with cost_price (cost ${costKnown ? 'known' : 'unknown'}, guards ${guardsKnown ? 'present' : 'null'})`,
      `cost_price=${p.cost_price} but break_even=${p.break_even_price} / floor=${p.floor_price} — "margin unknown" and "$0 break-even" are not the same statement`);
    if (guardsKnown) {
      check(Number(p.break_even_price) <= Number(p.floor_price),
        `break-even ${money(p.break_even_price)} ≤ floor ${money(p.floor_price)} ≤ list ${money(p.list_price)}`,
        'the guard rails are out of order — the amber band would sit below the red one');
    }
  }

  say('\n\x1b[1m7 · both quote endpoints, with no identifier (the unchanged baseline)\x1b[0m');
  const lines = [{ product_code: p?.sku || 'CLC73BK', quantity: 1 }];
  const invNone = await api('POST', '/api/admin/invoices/quote', { line_items: lines });
  check(invNone.status === 200 && invNone.data?.contract_prices_consulted === false,
    'invoices/quote with NO identifier → consulted:false, unchanged behaviour',
    `got ${invNone.status} consulted=${invNone.data?.contract_prices_consulted}`);
  const qoNone = await api('POST', '/api/admin/quick-orders/quote', { line_items: lines });
  check(qoNone.status === 200, 'quick-orders/quote exists', `got ${qoNone.status}`);
  // A bogus customer id answers 200 with consulted:false — INDISTINGUISHABLE
  // from a genuine retail customer. Recorded so the UI copy stays honest: it
  // says "no business account", never "list pricing confirmed".
  const bogus = await api('POST', '/api/admin/invoices/quote',
    { customer_id: '00000000-0000-0000-0000-000000000000', line_items: lines });
  if (bogus.status === 200 && bogus.data?.contract_prices_consulted === false) {
    soft('a bogus customer_id answers 200 / consulted:false',
      'identical to a real retail customer — the FE cannot tell a mistyped id from "no account", and says so');
  } else {
    ok('a bogus customer_id is distinguishable', `status ${bogus.status}`);
  }
  return { account: a, product: p, baselineInvoice: invNone.data };
}

// ──────────────────────────────────────────────────────────────────────────
// The write cycle
// ──────────────────────────────────────────────────────────────────────────

async function writeCycle(accounts, product) {
  const account = accounts.find((a) => a.status === 'active') || accounts[0];
  const other = accounts.find((a) => a.id !== account.id) || null;

  if (!product || product.cost_price == null) {
    soft('write cycle skipped', 'no product with a known cost was returned — the 409 below-cost check needs one');
    return;
  }
  if (product.has_contract_price && !FORCE) {
    soft('write cycle skipped', `${product.sku} already has a contract price on this account — re-run with --force to overwrite it`);
    return;
  }

  const listPrice = Number(product.list_price);
  const breakEven = Number(product.break_even_price);
  const floor = Number(product.floor_price);
  const round2 = (n) => Math.round(n * 100) / 100;

  const first = round2((floor + listPrice) / 2);           // safe: above the floor
  // One cent BELOW the floor, not above it: the point of this price is to make
  // the server raise `below_floor`, and floor + 0.01 sits in the ordinary band
  // where it correctly reports false. Still comfortably above break-even, so it
  // must NOT trip the 409 — that is step 10's job, with a different number.
  const second = round2(floor - 0.01);
  const belowCost = round2(Math.max(0.01, breakEven - 1));  // refused

  say(`\n\x1b[1mWrite target\x1b[0m  ${product.sku} on "${account.company_name}" (${account.id})`);
  say(`  list ${money(listPrice)} · cost ${money(product.cost_price)} · break-even ${money(breakEven)} · floor ${money(floor)}`);
  say(`  will set ${money(first)} → ${money(second)}, try ${money(belowCost)} (must be refused), then remove\n`);
  if (second <= breakEven) {
    // The band between break-even and the floor is where "profitable but deeper
    // than the ladder goes" lives. If it has closed, there is no price that can
    // demonstrate below_floor without also being below cost — say so rather
    // than fail a check the data cannot satisfy.
    soft('below_floor not measurable on this product',
      `the floor ${money(floor)} sits at or under break-even ${money(breakEven)} — no price is both profitable and below the floor`);
  }

  // Registered BEFORE the first write, so a crash between the PUT and the
  // assertion still cleans up.
  PENDING = { accountId: account.id, productId: product.product_id, sku: product.sku };

  const put = (body) => api('PUT',
    `/api/admin/business/accounts/${account.id}/custom-prices/${product.product_id}`, body);

  say('\x1b[1m8 · the first price has NO previous\x1b[0m');
  const set = await put({ custom_price: first, notes: 'probe: initial' });
  check(set.status === 200, 'PUT → 200', `got ${set.status}: ${set.text.slice(0, 200)}`);

  // "set" the FIRST time this (account, product) pair is ever priced;
  // "reactivated" every time afterwards, because a removal soft-deletes rather
  // than erases. So a second run of this probe on the same product legitimately
  // reports "reactivated" here — measured 2026-09-06, when exactly that
  // happened on the second run.
  //
  // Accepting both is not a weakened assertion: the property that matters is
  // identical for the two, and it is the line below. `set` is only observable
  // once per pair in a given database, and a probe that demands it would go red
  // on its own second run forever.
  const firstAction = set.data?.action;
  check(firstAction === 'set' || firstAction === 'reactivated',
    `action = "${firstAction}"${firstAction === 'reactivated' ? ' (this pair has been priced before — a removal soft-deletes)' : ''}`,
    `got "${firstAction}" — expected set or reactivated`);
  check(set.data?.previous_price === null,
    `previous_price === null on a "${firstAction}"`,
    `got ${JSON.stringify(set.data?.previous_price)} — null means "no predecessor", 0 would mean "it used to be free". This is the row of the §4.6 table both set AND reactivated share.`);
  const item = set.data?.item;
  check(!!item, 'the response carries the fully-shaped row (splice, do not refetch)', 'data.item is absent');
  if (item) {
    for (const k of ['product_id', 'sku', 'name', 'list_price', 'contract_price', 'discount_amount',
      'discount_percent', 'cost_price', 'net_margin_percent', 'below_cost', 'below_floor',
      'above_list', 'last_change']) {
      check(k in item, `item.${k} present`, 'ABSENT — the §4.3 shape');
    }
    check(Math.abs(Number(item.contract_price) - first) < 0.005,
      `item.contract_price = ${money(item.contract_price)}`, `expected ${money(first)}`);
  }

  say('\n\x1b[1m9 · update → previous and new, side by side\x1b[0m');
  const upd = await put({ custom_price: second, notes: 'probe: renegotiated' });
  check(upd.data?.action === 'updated', 'action = "updated"', `got "${upd.data?.action}"`);
  check(Math.abs(Number(upd.data?.previous_price) - first) < 0.005,
    `previous_price = ${money(upd.data?.previous_price)} (the price we set in step 8)`,
    `expected ${money(first)}`);
  const ev = upd.data?.evaluation;
  check(!!ev, 'evaluation block present on a successful save', 'ABSENT');
  if (ev) {
    if (second > breakEven) {
      check(ev.below_floor === true, 'below_floor flagged (profitable, deeper than the ladder goes)',
        `got ${ev.below_floor} at ${money(second)} against a floor of ${money(floor)}`);
      check(ev.below_cost === false, 'and below_cost is NOT raised — the two bands are distinct',
        `got ${ev.below_cost} at ${money(second)} against break-even ${money(breakEven)}`);
    }
    check(Array.isArray(ev.warnings), 'evaluation.warnings is an array we can print verbatim', 'not an array');
    check(ev.cost_known === true, 'cost_known true for a product with a cost', `got ${ev.cost_known}`);
  }

  say('\n\x1b[1m10 · below cost is REFUSED, and the refusal changes nothing\x1b[0m');
  const refused = await put({ custom_price: belowCost, notes: 'probe: below cost' });
  check(refused.status === 409, 'a below-cost price → 409', `got ${refused.status}`);
  check(refused.error?.code === 'PRICE_BELOW_COST', 'code = PRICE_BELOW_COST', `got ${refused.error?.code}`);
  check(refused.error?.details?.requires === 'acknowledge_below_cost',
    'details.requires names the flag to re-send', `got ${JSON.stringify(refused.error?.details?.requires)}`);
  const refusedEval = refused.error?.details?.evaluation;
  check(!!refusedEval && refusedEval.below_cost === true,
    'details.evaluation is present and says below_cost',
    'ABSENT — this is what the confirm dialog quotes; without it we refuse to offer a blind override');
  if (refusedEval) {
    // A percent, not money — printed as a percent so a reader is not invited to
    // read "-18.1" as dollars.
    check('net_margin_percent' in refusedEval, `refusal.evaluation.net_margin_percent = ${refusedEval.net_margin_percent}%`, 'ABSENT');
    nullableNumber(refusedEval, 'break_even_price', 'refusal.evaluation');
  }
  // "The refused request changes nothing" is a claim. Measure it.
  const afterRefusal = await GET(`/api/admin/business/accounts/${account.id}/custom-prices?search=${encodeURIComponent(product.sku)}`);
  const stillThere = (afterRefusal.data?.items || []).find((r) => r.sku === product.sku);
  check(stillThere && Math.abs(Number(stillThere.contract_price) - second) < 0.005,
    `the stored price is untouched at ${money(stillThere?.contract_price)}`,
    `expected ${money(second)} — a refusal that half-applied would be far worse than one that failed`);

  say('\n\x1b[1m11 · acknowledged, it goes through\x1b[0m');
  const acked = await put({ custom_price: belowCost, notes: 'probe: below cost', acknowledge_below_cost: true });
  check(acked.status === 200, 'the identical body + acknowledge_below_cost → 200', `got ${acked.status}`);
  check(acked.data?.evaluation?.below_cost === true, 'and the saved row is flagged below_cost',
    `got ${acked.data?.evaluation?.below_cost}`);
  await put({ custom_price: second, notes: 'probe: restored' });   // back to something sane

  say('\n\x1b[1m12 · the history, and its four-action null table\x1b[0m');
  const hist = await GET(`/api/admin/business/accounts/${account.id}/price-history?product_id=${product.product_id}&limit=50`);
  const rows = hist.data?.items || [];
  check(rows.length >= 3, `${rows.length} history rows`, 'expected at least set + updated + updated');
  const setRow = rows.find((r) => r.action === 'set');
  const updRow = rows.find((r) => r.action === 'updated');
  if (setRow) {
    check(setRow.previous_price === null, 'set row: previous_price === null', `got ${setRow.previous_price}`);
    check(setRow.change_amount === null, 'set row: change_amount === null (not "no change")', `got ${setRow.change_amount}`);
    check(typeof setRow.sku === 'string' && setRow.sku.length > 0,
      'set row carries a SNAPSHOT sku', 'ABSENT — history must survive a rename or a delete');
    check('name' in setRow, 'set row carries a SNAPSHOT name', 'ABSENT');
  }
  if (updRow) {
    check(updRow.previous_price != null && updRow.new_price != null,
      'updated row: both prices present', `prev=${updRow.previous_price} new=${updRow.new_price}`);
    check(typeof updRow.change_amount === 'number', 'updated row: change_amount is a signed number',
      `got ${JSON.stringify(updRow.change_amount)}`);
  }
  check(rows.every((r) => ['set', 'updated', 'reactivated', 'removed'].includes(r.action)),
    'every action is one of the four documented values',
    `saw: ${[...new Set(rows.map((r) => r.action))].join(', ')}`);

  say('\n\x1b[1m13 · ISOLATION — the price belongs to one account, and to no catalogue row\x1b[0m');
  if (other) {
    const otherPrices = await GET(`/api/admin/business/accounts/${other.id}/custom-prices?search=${encodeURIComponent(product.sku)}`);
    check((otherPrices.data?.items || []).length === 0,
      `"${other.company_name}" resolves NOTHING for ${product.sku}`,
      'the other account can see this price — it is not per-account at all');
    const otherSearch = await GET(`/api/admin/business/accounts/${other.id}/product-search?q=${encodeURIComponent(product.sku)}`);
    const otherRow = (otherSearch.data?.items || []).find((r) => r.sku === product.sku);
    check(otherRow && otherRow.has_contract_price === false,
      `and product-search tells them has_contract_price:false`, `got ${otherRow?.has_contract_price}`);
  } else {
    soft('cross-account isolation not measured', 'only one business account exists — nothing to isolate against');
  }
  // "No catalogue row is ever written" is the guarantee that makes this safe to
  // ship. It is also the one that would be silent if it broke.
  const freshSearch = await GET(`/api/admin/business/accounts/${account.id}/product-search?q=${encodeURIComponent(product.sku)}`);
  const freshRow = (freshSearch.data?.items || []).find((r) => r.sku === product.sku);
  check(freshRow && Math.abs(Number(freshRow.list_price) - listPrice) < 0.005,
    `the catalogue list price is unchanged at ${money(freshRow?.list_price)}`,
    `it moved from ${money(listPrice)} — a contract price wrote to the product`);

  say('\n\x1b[1m14 · the quote endpoints now see it (bridge parity)\x1b[0m');
  const qLines = [{ product_code: product.sku, quantity: 1 }];
  const inv = await api('POST', '/api/admin/invoices/quote', { customer_id: account.user_id, line_items: qLines });
  const qo = await api('POST', '/api/admin/quick-orders/quote', { customer_id: account.user_id, line_items: qLines });
  check(inv.data?.business_account_id === account.id, 'invoice quote resolved the account from customer_id alone',
    `got ${inv.data?.business_account_id}`);
  check(inv.data?.contract_priced_line_count === 1, 'contract_priced_line_count = 1', `got ${inv.data?.contract_priced_line_count}`);
  const invLine = inv.data?.lines?.[0];
  const qoLine = qo.data?.lines?.[0];
  check(invLine?.contract && invLine.contract.unit_excl_gst != null,
    `invoice line carries contract.unit_excl_gst = ${invLine?.contract?.unit_excl_gst}`, 'contract is null');
  // THE CHECK THAT LICENSES KEEPING BOTH EDITORS ON ONE ENDPOINT. The invoice
  // quote's qty-1 `unit_excl_gst` must equal the quick-order quote's
  // pre-resolved `unit_price_excl_gst` at quantity 1. If these ever disagree,
  // the shared quote path in utils/invoice-quote.js is wrong and Quick Order
  // must move to its own endpoint.
  if (invLine && qoLine) {
    const a = Number(invLine.unit_excl_gst);
    const b = Number(qoLine.unit_price_excl_gst);
    check(Math.abs(a - b) < 0.005,
      `bridge parity at qty 1: invoice ${money(a)} === quick order ${money(b)}`,
      `they DISAGREE (${money(a)} vs ${money(b)}) — the shared quote path picks the wrong field; Quick Order must move to /api/admin/quick-orders/quote`);
    // A contract price must never be dressed as a volume discount: those three
    // keys are persisted into the saved record and cross the QO → invoice bridge.
    check(qoLine.volume_discount_percent == null && qoLine.volume_saving_excl_gst == null && qoLine.volume_quantity == null,
      'a contract price fills NONE of the three volume_* display keys',
      `got ${qoLine.volume_discount_percent} / ${qoLine.volume_saving_excl_gst} / ${qoLine.volume_quantity}`);
  }
  if (other) {
    const otherQuote = await api('POST', '/api/admin/invoices/quote', { customer_id: other.user_id, line_items: qLines });
    check(otherQuote.data?.contract_priced_line_count === 0,
      `the other account is quoted at list (0 contract-priced lines)`,
      `got ${otherQuote.data?.contract_priced_line_count}`);
  }

  say('\n\x1b[1m15 · remove → 404 on the second attempt → re-add is a REACTIVATION\x1b[0m');
  const del = await api('DELETE', `/api/admin/business/accounts/${account.id}/custom-prices/${product.product_id}`);
  check(del.status === 200, 'DELETE → 200', `got ${del.status}`);
  check(del.data?.action === 'removed', 'action = "removed"', `got ${del.data?.action}`);
  check(del.data?.previous_price != null, `previous_price names what was withdrawn (${money(del.data?.previous_price)})`, 'null');
  check(del.data?.last_change?.new_price === null, 'the removal history row has new_price === null',
    `got ${del.data?.last_change?.new_price}`);

  const dbl = await api('DELETE', `/api/admin/business/accounts/${account.id}/custom-prices/${product.product_id}`);
  check(dbl.status === 404, 'a second DELETE → 404 (a double-click reports honestly, never a fake success)',
    `got ${dbl.status}`);

  const readd = await put({ custom_price: first, notes: 'probe: re-added' });
  check(readd.data?.action === 'reactivated', 're-adding after a removal is "reactivated"', `got ${readd.data?.action}`);
  check(readd.data?.previous_price === null,
    'and a reactivation has previous_price === null, NOT the old price',
    `got ${JSON.stringify(readd.data?.previous_price)} — the subtle row of the §4.6 table`);

  say('\n\x1b[1m16 · does DELETE accept the documented optional {notes} body?\x1b[0m');
  const delWithBody = await api('DELETE',
    `/api/admin/business/accounts/${account.id}/custom-prices/${product.product_id}`,
    { notes: 'probe: contract ended' });
  if (delWithBody.status === 200) {
    ok('DELETE accepts a {notes} body', 'AdminAPI.removeContractPrice sends it when the operator gives a reason');
    PENDING = null;   // it is gone; cleanup has nothing to do
  } else {
    bad('DELETE with a {notes} body', `got ${delWithBody.status} — removeContractPrice() must stop sending it: ${delWithBody.text.slice(0, 160)}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

async function main() {
  say('\n\x1b[1mContract pricing — live contract probe\x1b[0m');
  say(WRITE
    ? '\x1b[41m\x1b[97m MODE: WRITE \x1b[0m — this run CREATES a contract price on a real account and removes it again.'
    : '\x1b[36mMODE: READ-ONLY\x1b[0m — every request is a GET or an advisory quote. Pass --write for the mutation cycle.');
  say(`API: ${API_BASE}`);

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    cannotRun('ADMIN_EMAIL / ADMIN_PASSWORD not set (.env or environment). These must be a super_admin — every route here 403s otherwise.');
  }

  try { TOKEN = await signIn(email, password); }
  catch (e) { cannotRun(e.message); }
  say(`Signed in as ${email}`);

  // Preflight. One request decides whether a failure here is nine contract
  // breaks or one auth problem — and an auth problem must never be reported as
  // nine findings.
  const pre = await GET('/api/admin/business/accounts?limit=1');
  if (pre.status === 401 || pre.status === 403) {
    cannotRun(`signed in as ${email}, but the accounts route answered ${pre.status} — this account is not super_admin. Nothing was checked.`);
  }
  if (pre.status === 404) {
    cannotRun(`GET /api/admin/business/accounts is a 404 on ${API_BASE} — migration 165 is not deployed here.`);
  }
  if (pre.status !== 200) {
    cannotRun(`preflight answered ${pre.status}: ${pre.text.slice(0, 200)}`);
  }

  const list = await GET('/api/admin/business/accounts?limit=100');
  const accounts = list.data?.accounts || [];
  say(`\n${accounts.length} business account(s):`);
  for (const a of accounts) {
    say(`  · ${a.company_name} (${a.status}) — ${a.custom_price_count} contract price(s) — ${a.id}`);
  }
  if (WRITE && !FORCE && accounts.some((a) => Number(a.custom_price_count) > 0)) {
    cannotRun('an account already holds contract prices. This probe writes to a real account, so it will not run unattended against live negotiated pricing. Re-run with --force if you are sure.');
  }

  const { product } = await readOnlyChecks(accounts);

  if (WRITE) {
    try { await writeCycle(accounts, product); }
    finally { await cleanup(); }
  } else {
    say('\n\x1b[2m  (skipped: the set → update → refuse → history → isolation → remove cycle.');
    say('   Production holds no contract prices, so every populated shape above is');
    say('   UNVERIFIED without it. Run with --write to measure them.)\x1b[0m');
  }

  report();
}

function report() {
  if (cleanupFailed) {
    findings.push(`cleanup — ${cleanupFailed}`);
  }
  if (JSON_OUT) {
    console.log(JSON.stringify({
      ok: findings.length === 0, mode: WRITE ? 'write' : 'read-only', api: API_BASE,
      checks: results.length, passed: pass, findings, notes, results,
    }, null, 2));
  } else {
    if (notes.length) {
      say(`\n\x1b[33mNotes (real, already handled — not failures):\x1b[0m`);
      for (const n of notes) say(`  · ${n}`);
    }
    if (findings.length) {
      say(`\n\x1b[31m${findings.length} failed\x1b[0m, ${pass} passed:`);
      for (const f of findings) say(`  · ${f}`);
    } else {
      say(`\n\x1b[32m✓ ${pass} checks passed\x1b[0m`);
    }
    if (!WRITE) say(`\x1b[2m  (read-only run — the write cycle was not exercised)\x1b[0m`);
    say('');
  }
  process.exit(findings.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(`\n\x1b[31mprobe crashed:\x1b[0m ${e && e.stack ? e.stack : e}`);
  await cleanup();
  process.exit(2);
});
