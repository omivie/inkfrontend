#!/usr/bin/env node
/**
 * probe-tracking-requested-column.mjs — is the Orders "Tracking requested" chip
 * reading a real field, does it agree with the queue, and which of its branches
 * has ever actually happened?
 * =============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-09-03 the backend handed over
 * `readfirst/orders-tracking-requested-column-FE-handoff-sep2026.md`: one new
 * `tracking_request` field per order row, to be rendered in the Invoice sent
 * cell. Unlike the two hand-offs before it (ERR-198, ERR-199), whose opening
 * sentences turned out to be false, this one was accurate — measured the same
 * day against backend commit 90ca2496, the field was on 154/154 rows.
 *
 * That is exactly why this file exists rather than a note saying "verified".
 * A contract that is true today is a contract that can be rolled back tomorrow,
 * and the failure is INVISIBLE FROM THE SCREEN: an order list with no
 * `tracking_request` key renders precisely the same cells as one where nobody
 * has asked for tracking. A green run here is the evidence for "the chip is
 * reading the backend's own answer today". A yellow run is the evidence for
 * "it is rendering nothing, and that is not the same as nobody asking".
 *
 * WHAT IT MEASURES
 * ----------------
 *   1  THE HEADLINE — is `tracking_request` on the list? on the detail? (regime)
 *   2  RECONCILE OR REFUSE — do the orders carrying a request agree, in BOTH
 *      directions, with `GET /api/admin/tracking-requests`? 7/7 on 2026-09-03.
 *   3  THE RLS SHADOW — proves `order_tracking_requests` answers 200-with-zero
 *      over PostgREST, and refuses to treat that as ground truth.
 *   4  DECOYS — five filter params that are accepted and ignored, with a real
 *      filter as the positive control.
 *   5  BRANCH COVERAGE — which render branches have ANY live data. Two of them
 *      have never had any, and this says so until they do.
 *   6  THE WAITING DISTRIBUTION — how long the open requests have actually been
 *      open, which is the number the chip exists to surface.
 *   7  WATCHDOG — the first `fulfilled` row ever to exist flips §5.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 * Read `order_tracking_requests` directly and call that the truth. The table has
 * RLS enabled with no permissive policies, so PostgREST returns `200 []` to a
 * browser-shaped client — a refusal wearing the costume of an answer, the
 * ERR-188 family. A probe that believed it would report "zero tracking requests
 * exist" and certify a completely broken column green. §3 measures that trap
 * deliberately, and then uses the admin endpoint for the actual reconciliation.
 *
 * It also never sends a shipping email to clear a request, which is the only way
 * to exercise the `sent` branch against production. That branch is unit-tested
 * instead: tests/orders-tracking-requested-column-sep2026.test.js §5.
 *
 * -- READ-ONLY. ---------------------------------------------------------------
 * Every request is a GET except the admin sign-in. This script parses no flags
 * and has no recording mode of any kind, deliberately: a probe that can record
 * may pass because it has just overwritten the thing it was comparing against
 * (sweep:b2b ate a committed fixture, 2026-08-12). The mode is PRINTED on every
 * run so it can never be assumed.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly. A file here that reads .env must never be one
 * URL away from the internet.
 *
 * Usage:  npm run probe:tracking-requested   (needs ADMIN_EMAIL / ADMIN_PASSWORD in .env)
 * Exit:   0 = every hard check passed, 1 = at least one failed, 2 = could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

/** The field the hand-off says ships on every order row. */
const FIELD = 'tracking_request';
/** Params that LOOK like they filter this column. Every one is ignored. */
const DECOYS = ['tracking_request=requested', 'tracking_requested=true',
  'has_tracking_request=true', 'tracking_state=requested', 'tracking=requested'];
/** A value no backend could plausibly honour — proves a param is not read. */
const NONSENSE = 'zzznope';
const PAGE_LIMIT = 50;
const MAX_PAGES = 12;

let pass = 0;
const failures = [];
const notes = [];
const ok = (name, detail) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name, detail) => {
  failures.push(`${name} — ${detail}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${String(detail).split('\n').join('\n      ')}`);
};
/**
 * A real gap worth reporting that the frontend already handles correctly, so it
 * must NOT redden the exit code. If a soft note could fail the run, the run gets
 * ignored — and then a hard failure gets ignored with it.
 */
const soft = (name, detail) => {
  notes.push(`${name} — ${detail}`);
  console.log(`  \x1b[33m~\x1b[0m ${name}\n      ${String(detail).split('\n').join('\n      ')}`);
};
/** A check that DECLINED TO RUN says so by name. A skip is not a pass. */
const skip = (name, why) => {
  notes.push(`SKIPPED: ${name} — ${why}`);
  console.log(`  \x1b[90m⊘ SKIPPED\x1b[0m ${name}\n      ${why}`);
};

function readEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return {};
  return Object.fromEntries(
    fs.readFileSync(f, 'utf8').split('\n')
      .filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => [l.slice(0, l.indexOf('=')).trim(),
        l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
  );
}

/**
 * Load the SHIPPED reader rather than re-implementing it.
 *
 * The point of §1 and §5 is "does the vocabulary the frontend actually renders
 * still fit the data production is serving?". A second copy of the parse in this
 * file would drift from the page and start certifying something nobody ships.
 * Same rule, same reason, as probe-orders-invoice-sent.mjs loading orderChannel
 * and probe-lookalike-rows.mjs loading ProductIdentity.
 */
function loadShippedReader() {
  const file = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'utils', 'order-tracking-request.js');
  if (!fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, 'utf8')
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/export\s+(const|let|var|function|class)\s+/gm, '$1 ');
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math, Number, Object, Array, String, Boolean, JSON, Date, RegExp, Error,
    DebugLog: { warn() {}, log() {}, error() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try {
    vm.runInContext(src + '\n;this.__api = { readTrackingRequest, resolveTrackingInfo, trackingChipCopy, TRACK_STATE };',
      sandbox, { filename: 'order-tracking-request.js' });
  } catch { return null; }
  return sandbox.__api || null;
}

async function main() {
  console.log('\n\x1b[1mprobe-tracking-requested-column\x1b[0m — is the Tracking requested chip reading a real field?');
  console.log('\x1b[36mMODE: READ-ONLY\x1b[0m  (GET only besides the sign-in; no recording mode exists, nothing is written)\n');

  const env = readEnv();
  const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
  if (!email || !password) {
    // A skip is not a pass. Exit 2 and name the variable that is missing.
    console.error('\x1b[31mCANNOT RUN\x1b[0m — ADMIN_EMAIL / ADMIN_PASSWORD not set (.env or environment).');
    console.error('These must be a super_admin — the admin orders endpoints 403 for anyone else.');
    console.error('Nothing was verified. Do NOT read this as a pass.\n');
    process.exit(2);
  }

  const auth = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await auth.json();
  if (!session.access_token) {
    console.error(`\x1b[31mCANNOT RUN\x1b[0m — admin sign-in failed (${auth.status}). Nothing was verified.\n`);
    process.exit(2);
  }
  const H = { apikey: ANON, Authorization: `Bearer ${session.access_token}` };
  const get = async (p) => {
    const res = await fetch(BASE + p, { headers: H });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text };
  };
  // `/api/admin/orders` returns `data` as a BARE ARRAY; customers/contacts do
  // not (ERR-176). Normalise the same way the page does rather than assuming.
  const rowsOf = (j) => {
    const d = j?.data;
    return Array.isArray(d) ? d : (d?.orders || d?.requests || d?.items || []);
  };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
  console.log(`Signed in as ${email}\n`);

  const health = await (await fetch(`${BASE}/health`)).json().catch(() => null);
  if (health?.data?.commit) console.log(`Backend commit ${health.data.commit}, db: ${health.data.db}\n`);

  const reader = loadShippedReader();
  if (!reader) {
    console.error('\x1b[31mCANNOT RUN\x1b[0m — utils/order-tracking-request.js would not evaluate.');
    console.error('Nothing was verified. Do NOT read this as a pass.\n');
    process.exit(2);
  }
  const { readTrackingRequest, resolveTrackingInfo, TRACK_STATE } = reader;

  // ---- 1. THE HEADLINE: which regime is live? -----------------------------
  console.log('\x1b[1m1. Is `tracking_request` on the order payload?\x1b[0m');

  const all = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const r = await get(`/api/admin/orders?limit=${PAGE_LIMIT}&page=${p}`);
    if (r.status !== 200) { bad('the order list answers 200', `page ${p} returned ${r.status}`); break; }
    const rows = rowsOf(r.json);
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < PAGE_LIMIT) break;
  }
  if (!all.length) {
    console.error('\x1b[31mCANNOT RUN\x1b[0m — the order list returned no rows at all. Nothing was verified.\n');
    process.exit(2);
  }

  const carrying = all.filter(o => has(o, FIELD));
  const regime = carrying.length ? 'SERVER' : 'UNAVAILABLE';
  if (carrying.length === all.length) {
    ok(`\`${FIELD}\` present on every row`, `${all.length}/${all.length} across the whole list`);
  } else if (carrying.length) {
    // Not a failure: the page puts the whole list in SERVER on any row carrying
    // the key, exactly so a partial rollout does not change what a cell means.
    soft(`\`${FIELD}\` is on SOME rows only`, `${carrying.length}/${all.length}. The page stays in SERVER regime, `
      + 'which is correct, but a partial deploy is worth knowing about.');
  } else {
    bad(`\`${FIELD}\` is ABSENT from every row`,
      `${all.length} rows, no key. The chip renders NOTHING, which on screen is indistinguishable from `
      + '"nobody asked for tracking". The Orders page logs a DebugLog warning saying so. This is the '
      + 'degradation the column cannot show you by itself.');
  }

  // The detail endpoint is a SEPARATE contract and has already been caught
  // disagreeing with the list once: it carries `tracking_request` and does NOT
  // carry `invoice_sent`, which is the reverse of what the Invoice sent column
  // had to assume. Neither endpoint is a safe proxy for the other.
  const sample = carrying.find(o => o[FIELD]) || carrying[0] || all[0];
  if (sample?.id) {
    const d = await get(`/api/admin/orders/${sample.id}`);
    const detail = d.json?.data?.order || d.json?.data || null;
    if (detail && has(detail, FIELD)) {
      ok('the DETAIL endpoint carries it too', 'the order modal can answer without the list row');
    } else {
      soft('the DETAIL endpoint does NOT carry it',
        'the modal falls back to the list row via readTrackingRequestFrom(), which is exactly what that '
        + 'candidate ladder is for — but the modal opened from a deep link has no list row to fall back to.');
    }
    if (detail && !has(detail, 'invoice_sent')) {
      soft('the detail endpoint still lacks `invoice_sent`',
        'unchanged since 2026-09-01, and the reason openOrderModal decides the send regime from the LIST row. '
        + 'Two endpoints, two different sets of fields, disagreeing in opposite directions.');
    }
  }

  // ---- 2. RECONCILE OR REFUSE ---------------------------------------------
  console.log('\n\x1b[1m2. Does the column agree with the Tracking Requests queue?\x1b[0m');

  const q = await get('/api/admin/tracking-requests?status=pending');
  const queue = rowsOf(q.json);
  if (q.status !== 200) {
    bad('the tracking-requests queue answers 200', `got ${q.status}`);
  } else {
    const fromOrders = new Set(
      all.filter(o => resolveTrackingInfo({ order: o }).state === TRACK_STATE.REQUESTED)
        .map(o => String(o.order_number)),
    );
    const fromQueue = new Set(queue.map(r => String(r.order_number)));
    const missingHere = [...fromQueue].filter(x => !fromOrders.has(x));
    const extraHere = [...fromOrders].filter(x => !fromQueue.has(x));

    if (!missingHere.length && !extraHere.length) {
      ok('every open request appears on exactly one order row',
        `${fromQueue.size}/${fromQueue.size} reconciled, both directions`);
    } else {
      if (missingHere.length) {
        bad('the queue knows about requests the column cannot show',
          `${missingHere.length}: ${missingHere.slice(0, 8).join(', ')}. An operator working the Orders list `
          + 'would never see these customers.');
      }
      if (extraHere.length) {
        bad('the column shows requests the queue does not have',
          `${extraHere.length}: ${extraHere.slice(0, 8).join(', ')}. One of the two is wrong and the chip is `
          + 'the one an operator will act on.');
      }
    }
  }

  // ---- 3. THE RLS SHADOW ---------------------------------------------------
  console.log('\n\x1b[1m3. The ground-truth table, and why this probe will not read it\x1b[0m');

  const restResp = await fetch(`${SUPABASE}/rest/v1/order_tracking_requests?select=id,status&limit=5`, { headers: H });
  const restRows = await restResp.json().catch(() => null);
  const restCount = Array.isArray(restRows) ? restRows.length : null;
  if (restResp.status === 200 && restCount === 0) {
    ok('`order_tracking_requests` answers 200 with ZERO rows over PostgREST',
      `and there are ${queue.length} live pending requests. RLS is enabled with no permissive policies, so this `
      + 'is a REFUSAL wearing the costume of an answer (ERR-188). Anything that reads this table to check this '
      + 'feature will report "no tracking requests exist" and certify a broken column green. '
      + '§2 uses /api/admin/tracking-requests instead.');
  } else if (restResp.status !== 200) {
    ok('`order_tracking_requests` is refused outright over PostgREST', `${restResp.status} — an honest refusal`);
  } else {
    soft('`order_tracking_requests` is now READABLE over PostgREST',
      `${restCount} row(s) came back. A policy has been added since 2026-09-03. That is a permissions change `
      + 'worth reviewing on its own — this table holds customer email addresses.');
  }

  // ---- 4. DECOYS -----------------------------------------------------------
  console.log('\n\x1b[1m4. Is there a server-side filter yet? (every candidate was a decoy)\x1b[0m');

  const baseline = rowsOf((await get(`/api/admin/orders?limit=${PAGE_LIMIT}&page=1`)).json);
  // POSITIVE CONTROL FIRST. Without proof that SOME param filters, "the decoy
  // returned everything" is equally consistent with "no param filters anything",
  // and the decoy finding would be worthless.
  const controlled = rowsOf((await get(`/api/admin/orders?limit=${PAGE_LIMIT}&page=1&status=cancelled`)).json);
  const controlWorks = controlled.length > 0
    && controlled.length < baseline.length
    && controlled.every(o => String(o.status).toLowerCase() === 'cancelled');
  if (controlWorks) {
    ok('POSITIVE CONTROL — `?status=cancelled` really does filter',
      `${controlled.length} of ${baseline.length}, all cancelled`);
  } else {
    bad('POSITIVE CONTROL FAILED — `?status=` did not filter',
      'so the decoy results below prove nothing. Fix this before believing §4.');
  }

  let realFilter = null;
  for (const param of DECOYS) {
    const name = param.split('=')[0];
    const asked = rowsOf((await get(`/api/admin/orders?limit=${PAGE_LIMIT}&page=1&${param}`)).json);
    const nonsense = rowsOf((await get(`/api/admin/orders?limit=${PAGE_LIMIT}&page=1&${name}=${NONSENSE}`)).json);
    if (asked.length === baseline.length && nonsense.length === baseline.length) {
      ok(`\`?${name}=\` is still a decoy`, `full ${baseline.length}-row page for the real value AND for ${NONSENSE}`);
    } else if (nonsense.length === baseline.length) {
      soft(`\`?${name}=\` may have become real`,
        `it changed the result set (${asked.length} vs ${baseline.length}) but still ignores ${NONSENSE}. `
        + 'A param that filters for good values and silently ignores bad ones is the ERR-151/173 family.');
    } else {
      realFilter = name;
      soft(`\`?${name}=\` NOW FILTERS`,
        `${asked.length} rows for the real value, ${nonsense.length} for ${NONSENSE}. This is the request in the `
        + 'FE response: if it is genuine, the Orders page can offer a real "waiting for tracking" filter.');
    }
  }
  if (!realFilter) {
    notes.push('No server-side filter exists. A client-side one would see 20 of ' + all.length
      + ' rows while looking like a full filter, so the Orders page deliberately offers none.');
  }

  // ---- 5. BRANCH COVERAGE --------------------------------------------------
  console.log('\n\x1b[1m5. Which render branches have live data behind them?\x1b[0m');

  const infos = all.map(o => ({ o, i: resolveTrackingInfo({ order: o }) }));
  const counts = {
    requested: infos.filter(x => x.i.state === TRACK_STATE.REQUESTED && !x.i.muted && !x.i.repeat).length,
    'requested (cancelled/muted)': infos.filter(x => x.i.muted).length,
    'requested again (re-ask)': infos.filter(x => x.i.repeat).length,
    sent: infos.filter(x => x.i.state === TRACK_STATE.SENT).length,
    dismissed: infos.filter(x => x.i.state === TRACK_STATE.DISMISSED).length,
    'a countable request_count > 1': infos.filter(x => x.i.countKnown && x.i.count > 1).length,
    unreadable: infos.filter(x => x.i.state === TRACK_STATE.UNREADABLE).length,
  };
  for (const [branch, n] of Object.entries(counts)) {
    if (branch === 'unreadable') {
      if (n) bad('rows the reader could not parse', `${n} — the chip renders "Tracking unknown" on each`);
      else ok('no unparseable tracking_request values', 'every value read cleanly');
      continue;
    }
    if (n) ok(`branch "${branch}" has live data`, `${n} row(s)`);
    else {
      soft(`branch "${branch}" has NEVER been seen in production`,
        'it is held up by tests/orders-tracking-requested-column-sep2026.test.js §5 and nothing else. '
        + 'The Invoices ×N indicator had exactly this standing for eight months and had never once '
        + 'rendered (ERR-180). Not a failure — a standing caveat.');
    }
  }

  // ---- 6. THE WAITING DISTRIBUTION ----------------------------------------
  console.log('\n\x1b[1m6. How long have these customers actually been waiting?\x1b[0m');

  const open = infos.filter(x => x.i.state === TRACK_STATE.REQUESTED)
    .map(x => ({ n: x.o.order_number, status: x.o.status, days: x.i.waitingDays, muted: x.i.muted }))
    .sort((a, b) => (b.days ?? -1) - (a.days ?? -1));
  if (!open.length) {
    ok('no open tracking requests', 'nobody is waiting');
  } else {
    const oldest = open[0];
    ok(`${open.length} customer(s) waiting`,
      `oldest ${oldest.n} at ${oldest.days} days${oldest.muted ? ' (CANCELLED — can never clear)' : ''}`);
    for (const r of open) {
      console.log(`      ${String(r.n).padEnd(16)} ${String(r.status).padEnd(10)} ${String(r.days ?? '?').padStart(4)} days${r.muted ? '   ← cancelled, unclearable' : ''}`);
    }
    const stuck = open.filter(r => r.muted);
    if (stuck.length) {
      soft(`${stuck.length} request(s) can never be cleared`,
        `${stuck.map(r => r.n).join(', ')} — cancelled, so nothing will ship and no email will fire. The chip `
        + 'is muted rather than actionable. A real resolve needs the dismiss endpoint requested in '
        + 'orders-tracking-requested-column-FE-response-sep2026.md.');
    }
  }

  // ---- 7. WATCHDOG ---------------------------------------------------------
  console.log('\n\x1b[1m7. Has a request EVER been fulfilled?\x1b[0m');

  const f = await get('/api/admin/tracking-requests?status=fulfilled');
  const fulfilled = rowsOf(f.json);
  if (f.status !== 200) {
    soft('could not read the fulfilled queue', `${f.status} — §5's "sent" caveat stands unverified either way`);
  } else if (fulfilled.length) {
    ok('fulfilled requests exist', `${fulfilled.length} — the "Tracking sent" branch finally has live data. `
      + 'Re-read §5: its caveat can be retired.');
  } else {
    soft('NO request has ever been fulfilled',
      'zero rows, ever. Every clearing path in the backend is therefore also unexercised in production, which '
      + 'is worth remembering the first time one of them appears not to work.');
  }

  // ---- 8. not checked here -------------------------------------------------
  console.log('\n\x1b[1m8. Not checked here\x1b[0m');
  skip('clearing a request end-to-end',
    'the only way to do it against production is to send a real shipping email to a real customer. The state '
    + 'machine is unit-tested instead: tests/orders-tracking-requested-column-sep2026.test.js §2/§3/§5.');
  skip('POST /api/orders/track-request',
    'submitting one would create a real row in a real queue an operator then has to work.');

  // ---- summary -------------------------------------------------------------
  console.log(`\n${'─'.repeat(72)}`);
  console.log('\x1b[1mMODE: READ-ONLY\x1b[0m — nothing was written by this run.');
  console.log(`\x1b[1mREGIME: ${regime}\x1b[0m — ${regime === 'SERVER'
    ? 'the chip reads the backend\'s own tracking_request field.'
    : 'the field is absent; the chip renders nothing, which is NOT "nobody asked".'}`);
  console.log(`${pass} passed, ${failures.length} failed, ${notes.length} note(s).`);
  if (notes.length) {
    console.log('\nNotes (do not fail the run):');
    for (const n of notes) console.log(`  ~ ${n.split('\n')[0]}`);
  }
  if (failures.length) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    for (const x of failures) console.log(`  ✗ ${x.split('\n')[0]}`);
    process.exit(1);
  }
  console.log('\n\x1b[32mAll hard checks passed.\x1b[0m\n');
  process.exit(0);
}

main().catch((e) => { console.error('Probe could not run:', e.message); process.exit(2); });
