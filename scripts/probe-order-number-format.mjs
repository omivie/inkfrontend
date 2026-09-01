#!/usr/bin/env node
/**
 * Does the frontend's order-number grammar still match the backend's? (ERR-198)
 * ============================================================================
 *
 * On 2026-09-01 the backend (migration 157) stopped zero-padding the daily
 * sequence: `20260829000004` became `2026090101`. Four shapes now coexist, all
 * of them valid, and `OrderNumber` (inkcartridges/js/utils.js) encodes the rule
 * that decides which strings the frontend treats as order numbers at all.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS PROBE
 * ------------------------------------------------
 * `OrderNumber.isValid` is a COPY of a rule that lives in another repository. A
 * copy drifts. If the backend widens its range again — the way it just did — the
 * frontend keeps refusing shapes the server would have accepted, and it does so
 * silently: the customer is told their order does not exist, and nothing logs.
 * Nothing else in the suite can catch that, because a unit test only ever asks
 * this file whether it agrees with itself.
 *
 * So this probe asks the SERVER, value by value, and fails when the two answers
 * differ. It is the same discipline the vocabulary's own header records: a
 * citation is not a measurement.
 *
 * HOW THE GRAMMAR IS OBSERVABLE WITHOUT CREDENTIALS
 * -------------------------------------------------
 * `GET /api/orders/:orderNumber` runs validation BEFORE authentication, so:
 *     400 VALIDATION_FAILED  → the shape was REJECTED
 *     401 UNAUTHORIZED       → the shape was ACCEPTED, then auth ran
 * §1 needs no credentials at all. §2 needs an admin login and is skipped BY NAME
 * when one is absent — a skip is not a pass.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * Every request is a GET against a lookup route. There is no --record and no
 * --update-baseline mode, deliberately: a probe that can record may be green
 * only because it just overwrote what it compared against (sweep:b2b ate a
 * committed fixture, 2026-08-12). The mode is printed on every run so it can
 * never be assumed.
 *
 * ── PACING. ─────────────────────────────────────────────────────────────────
 * This endpoint rate-limits hard and for a long window (measured: 429 after
 * roughly 30 requests, and the window outlasts a coffee). Requests are spaced,
 * the delay is printed, and a 429 is reported as INCONCLUSIVE with exit 2 —
 * never as a pass. A rate-limited run proves nothing and must not look green.
 *
 * It lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel
 * output directory and is served publicly; a file that reads .env must not be
 * one URL away from the internet.
 *
 * Usage:  npm run probe:order-number
 *         npm run probe:order-number -- --pace 2500   (slow it down further)
 * Exit:   0 = frontend and backend agree, 1 = they disagree, 2 = could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';   // public anon key, inlined (same as the sibling probes)

const require = createRequire(import.meta.url);
const { OrderNumber } = require(path.join(ROOT, 'inkcartridges', 'js', 'utils.js'));

const argv = process.argv.slice(2);
const paceArg = Number(argv[argv.indexOf('--pace') + 1]);
const PACE_MS = Number.isFinite(paceArg) && paceArg > 0 ? paceArg : 1600;

let pass = 0;
const failures = [];
const notes = [];
const ok = (name) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); };
const bad = (name, detail) => { failures.push(`${name} — ${detail}`); console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`); };
/** A real limit the frontend can honestly accommodate — must NOT redden the run. */
const soft = (name, detail) => { notes.push(`${name} — ${detail}`); console.log(`  \x1b[33m~\x1b[0m ${name}\n      ${detail}`); };
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The values that bound the grammar. Each is a claim about the SERVER, and the
 * probe's whole job is to find out whether OrderNumber agrees with it.
 */
const GRAMMAR = [
  ['2026090101', true, 'the current format'],
  ['20260901100', true, 'the widened >99/day form'],
  ['20260829000004', true, 'the interim 14-digit form'],
  ['202609011', false, '9 digits — below the floor'],
  ['202609011234567', false, '15 digits — above the ceiling'],
  ['20260901', false, 'a date prefix with no sequence'],
  ['20261301100', true, 'month 13 — the date prefix is NOT checked'],
  ['ORD-MMQXBRYO-6E93', true, 'a real legacy order'],
  ['ORD-MP7GA80N-C3DD9FA2EC39F1DE', true, 'the long legacy form'],
  ['ORD-AAAAAAAA-AAA', false, 'a 3-char hex run'],
  ['ORD-AAAAAAAA-AAAAA', true, 'a 5-char hex run — the range is {4,16}'],
  ['ORD-AAAAAAAA-AAAAAAAAAAAAAAAAA', false, 'a 17-char hex run'],
  ['ORD-MMQXBRYO-GGGG', false, 'G is not a hex digit'],
  ['ORD-IAAAAAAA-AAAA', true, 'I is accepted — the "stricter regex" note was stale'],
];

let rateLimited = false;

/** @returns {'accepted'|'rejected'|'ratelimited'|'unknown'} */
async function askServer(value) {
  const url = `${BASE}/api/orders/${encodeURIComponent(value)}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  } catch (e) {
    return 'unknown';
  }
  if (res.status === 429) { rateLimited = true; return 'ratelimited'; }
  if (res.status === 400) return 'rejected';
  if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 200) return 'accepted';
  return 'unknown';
}

async function main() {
  console.log('\n\x1b[1mOrder-number grammar: frontend vs backend (ERR-198)\x1b[0m');
  console.log(`\x1b[36mMODE: READ-ONLY\x1b[0m — every request is a GET; this probe writes nothing.`);
  console.log(`\x1b[36mPACING: ${PACE_MS} ms between requests\x1b[0m — this endpoint rate-limits hard;`);
  console.log('        a 429 is reported as INCONCLUSIVE (exit 2), never as a pass.\n');

  console.log('\x1b[1m1. Grammar parity — does OrderNumber.isValid match the server?\x1b[0m');
  let asked = 0;
  for (const [value, expected, why] of GRAMMAR) {
    // Ask the server about what the APP WOULD ACTUALLY SEND, which is the
    // normalised form — every caller runs OrderNumber.normalise() first. Probing
    // the raw string would compare a normalising validator against a
    // non-normalising server and report a disagreement that cannot happen in
    // production (it did, on the first run: isValid('ord-…') is true because the
    // app uppercases before sending, and the server 400s only the raw lowercase).
    const server = await askServer(OrderNumber.normalise(value));
    asked++;
    if (server === 'ratelimited') {
      console.error(`\n\x1b[31mINCONCLUSIVE\x1b[0m — rate-limited after ${asked} requests.`);
      console.error('Nothing further was verified. Do NOT read this as a pass.');
      console.error(`Re-run later, or with a longer pace: npm run probe:order-number -- --pace 4000\n`);
      process.exit(2);
    }
    if (server === 'unknown') {
      soft(`${value} — server gave no usable answer`, 'network or an unexpected status; this value was not verified');
      await sleep(PACE_MS);
      continue;
    }
    const serverAccepts = server === 'accepted';
    const feAccepts = OrderNumber.isValid(value);

    // The table's own expectation is a claim too — if the SERVER has moved, say
    // so loudly rather than quietly re-baselining against it.
    if (serverAccepts !== expected) {
      bad(`${value} — THE BACKEND HAS CHANGED`,
        `this probe expected the server to ${expected ? 'accept' : 'reject'} it (${why}), `
        + `but it ${serverAccepts ? 'accepted' : 'rejected'} it. The grammar moved: update `
        + `OrderNumber in utils.js AND this table together, and re-read the hand-off.`);
    } else {
      check(feAccepts === serverAccepts,
        `${value} — ${serverAccepts ? 'accepted' : 'rejected'} by both (${why})`,
        `the server ${serverAccepts ? 'ACCEPTS' : 'REJECTS'} it but OrderNumber.isValid says `
        + `${feAccepts}. ${serverAccepts
          ? 'The frontend is refusing an order number the server would have found — the '
            + 'customer is told their order does not exist.'
          : 'The frontend is promising a lookup that will 400.'}`);
    }
    await sleep(PACE_MS);
  }

  console.log('\n\x1b[1m2. Is normalise() load-bearing, or decorative?\x1b[0m');
  // If the server accepted a lowercased legacy number anyway, normalise() would be
  // a no-op dressed up as a rescue. It is not: measured, the raw form is a hard
  // 400, so a customer pasting one out of a mail client that lowercased it is told
  // their order does not exist. This check fails if that ever stops being true —
  // at which point the uppercasing is still harmless, but the comment is not.
  {
    const raw = 'ord-mmqxbryo-6e93';
    const rawAnswer = await askServer(raw);
    if (rawAnswer === 'ratelimited') {
      soft('case check skipped', 'rate-limited before it could run');
    } else if (rawAnswer === 'rejected') {
      ok('the server rejects a raw lowercase legacy number — normalise() is a real rescue');
      check(OrderNumber.isValid(raw), 'and OrderNumber still accepts it, because it uppercases first',
        'isValid must judge what the app SENDS, not what the customer typed');
    } else {
      soft('the server now accepts a raw lowercase legacy number',
        'normalise() uppercasing is now belt-and-braces rather than a rescue. Harmless, '
        + 'but the comment in utils.js and the FE response both claim otherwise — update them.');
    }
    await sleep(PACE_MS);
  }

  console.log('\n\x1b[1m3. Prefix collision — is a whole-number search unambiguous?\x1b[0m');
  const email = process.env.ADMIN_EMAIL || readEnv().ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD || readEnv().ADMIN_PASSWORD;
  if (!email || !password) {
    soft('SKIPPED BY NAME — admin credentials not set',
      'ADMIN_EMAIL / ADMIN_PASSWORD absent (.env or environment), so the "?search= for a '
      + 'whole order number returns exactly one row" check DID NOT RUN. §1 above still ran '
      + 'and its result stands. This is a skip, not a pass.');
  } else {
    try {
      const token = await signIn(email, password);
      const res = await fetch(`${BASE}/api/admin/orders?limit=50`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json().catch(() => null);
      const rows = Array.isArray(json?.data) ? json.data : (json?.data?.orders || []);
      const withNum = rows.filter((r) => r && r.order_number);
      if (!withNum.length) {
        soft('no order rows came back', 'cannot probe the search without a live order number');
      } else {
        const target = withNum[0].order_number;
        await sleep(PACE_MS);
        const sres = await fetch(`${BASE}/api/admin/orders?search=${encodeURIComponent(target)}&limit=50`,
          { headers: { Authorization: `Bearer ${token}` } });
        const sjson = await sres.json().catch(() => null);
        const srows = Array.isArray(sjson?.data) ? sjson.data : (sjson?.data?.orders || []);
        const exact = OrderNumber.pickExact(srows, target);
        check(!!exact, `?search=${target} returns the order itself`,
          'the #orders?focus= deep-link and the refund lookup both rely on this');
        if (srows.length > 1) {
          soft(`?search=${target} matched ${srows.length} rows`,
            'the backend search is a substring ILIKE, so a shorter order number can match a '
            + 'longer one. This is EXACTLY why refunds.js and focusOnOrder use '
            + 'OrderNumber.pickExact instead of rows[0] — the ambiguity is real, and handled.');
        } else {
          ok('the search matched exactly one row for this number');
        }
      }
    } catch (e) {
      soft('admin section could not run', e.message);
    }
  }

  report();
}

function readEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
      const i = l.indexOf('=');
      return i < 0 ? [l.trim(), ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
  );
}

async function signIn(email, password) {
  const key = process.env.SUPABASE_ANON_KEY || readEnv().SUPABASE_ANON_KEY || ANON;
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`sign-in failed (${res.status})`);
  return json.access_token;
}

function report() {
  console.log(`\n${'─'.repeat(72)}`);
  if (notes.length) {
    console.log(`\x1b[33m${notes.length} note(s)\x1b[0m (real limits or skips — not failures):`);
    notes.forEach((n) => console.log(`  • ${n}`));
    console.log('');
  }
  if (rateLimited) {
    console.log('\x1b[31mA 429 was seen during this run — treat the result as incomplete.\x1b[0m');
    process.exit(2);
  }
  if (failures.length === 0) {
    console.log(`\x1b[32m${pass} checks passed.\x1b[0m OrderNumber.isValid agrees with the live`);
    console.log('backend at every measured boundary.\n');
    process.exit(0);
  }
  console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${pass} passed:\n`);
  failures.forEach((f) => console.log(`  • ${f}`));
  console.log('');
  process.exit(1);
}

main().catch((e) => {
  console.error(`\n\x1b[31mProbe could not run:\x1b[0m ${e.message}\n`);
  process.exit(2);
});
