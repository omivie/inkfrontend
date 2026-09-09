#!/usr/bin/env node
/**
 * probe:admin-only — is the admin-only test product genuinely invisible?
 * =====================================================================
 * ERR-234 · Sep 2026
 *
 * WHAT THIS ANSWERS THAT A TEST CANNOT. Every assertion in
 * tests/admin-only-test-product-sep2026.test.js is about our source. None of
 * them can tell you whether the BACKEND actually withholds the row, and that is
 * the entire security claim. ERR-224 shipped 21 green source-grep tests over a
 * layout that was wrong on screen; this file exists so that cannot happen here.
 *
 * READ-ONLY. Every request is a GET besides the sign-ins. There is no --record,
 * no baseline, no fixture and no write verb of any kind, and the mode is printed
 * on every run. A probe that can record is a probe that can pass because it just
 * overwrote what it was comparing against — that is how `sweep:b2b` ate a
 * committed fixture on 2026-08-12.
 *
 * EXIT CODES
 *   0  pass
 *   1  a real finding — the product leaked, or admin preview is broken
 *   2  the probe could not run. Deliberately NOT 1, and never 0: "we could not
 *      look" must never be reported as "we looked and it was fine". Until the
 *      backend brief is applied there is no column and no mirror, so 2 is the
 *      CORRECT answer to this probe and the one you should expect today.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly (ERR-229). A file here reads .env and must
 * never be one URL away from the internet.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const API = process.env.API_BASE || 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = process.env.SUPABASE_URL || 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const SKU = process.env.TEST_SKU || 'TEST-ADMIN-001';
const FAST = process.argv.includes('--fast');

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[90m', x: '\x1b[0m' };
const findings = [];
const notes = [];
let checked = 0;

const pass = (m) => { checked++; console.log(`  ${C.g}✓${C.x} ${m}`); };
const fail = (m) => { checked++; findings.push(m); console.log(`  ${C.r}✗${C.x} ${m}`); };
const note = (m) => { notes.push(m); console.log(`  ${C.d}·${C.x} ${m}`); };
const pace = () => FAST ? Promise.resolve() : new Promise(r => setTimeout(r, 700));

function readEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch (_) { /* no .env — caller decides whether that is fatal */ }
  return out;
}

function anonKey() {
  if (process.env.SUPABASE_ANON_KEY) return process.env.SUPABASE_ANON_KEY;
  // The published storefront key; it is in config.js and on every page already.
  const cfg = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/config.js'), 'utf8');
  return (cfg.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/) || [])[1] || '';
}

async function getJson(url, headers) {
  const res = await fetch(url, { method: 'GET', headers: headers || {} });
  let body = null;
  try { body = await res.json(); } catch (_) { /* leave null */ }
  return { status: res.status, body, headers: res.headers };
}

async function signIn(email, password, ANON) {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await res.json().catch(() => ({}));
  return j.access_token || null;
}

/** Does this payload mention the SKU anywhere at all? Deliberately blunt. */
const mentions = (body) => JSON.stringify(body == null ? '' : body).toUpperCase().includes(SKU.toUpperCase());

async function main() {
  console.log(`\n${C.b}probe:admin-only${C.x} — is ${C.b}${SKU}${C.x} invisible to everyone but an admin?`);
  console.log(`${C.y}MODE: READ-ONLY${C.x} — every request is a GET besides the sign-ins. No --record exists.`);
  console.log(`${C.d}api=${API}  supabase=${SUPABASE}${C.x}\n`);

  const ANON = anonKey();
  if (!ANON) {
    console.error(`${C.r}CANNOT RUN${C.x} — no Supabase anon key. Nothing was verified.\n`);
    process.exit(2);
  }
  const env = readEnv();
  const adminEmail = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
  const adminPass = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;

  // ── §0 Liveness. A green run against a catalogue with no test product and no
  // column proves nothing at all, so establish both before asserting anything.
  console.log(`${C.b}§0 can this probe run?${C.x}`);

  const col = await getJson(`${SUPABASE}/rest/v1/products?select=sku,admin_only&limit=1`, { apikey: ANON });
  if (col.status === 400 && /admin_only/.test(JSON.stringify(col.body))) {
    console.log(`  ${C.y}·${C.x} products.admin_only DOES NOT EXIST (400 / 42703).`);
    console.log(`\n${C.y}CANNOT RUN${C.x} — the backend brief has not been applied.`);
    console.log('The column, the RLS filter and /api/admin/catalog/* are all still absent,');
    console.log('so there is nothing to hide and nothing to hide it from.');
    console.log(`${C.d}This is the EXPECTED answer until admin-only-test-product-backend-brief-sep2026.md ships.${C.x}`);
    console.log(`${C.d}Nothing was verified. Do NOT read this as a pass.${C.x}\n`);
    process.exit(2);
  }
  pass('products.admin_only exists');
  await pace();

  // ── §1 THE NEGATIVE CONTROL. This is the security assertion.
  console.log(`\n${C.b}§1 anonymous — the product must be invisible${C.x}`);

  const anonSurfaces = [
    ['/api/products/:sku', `${API}/api/products/${encodeURIComponent(SKU)}`],
    ['/api/shop', `${API}/api/shop?limit=100`],
    ['/api/products?search=', `${API}/api/products?search=${encodeURIComponent(SKU)}&limit=100`],
    ['/api/search/smart', `${API}/api/search/smart?q=${encodeURIComponent(SKU)}&limit=40`],
    ['/api/search/suggest', `${API}/api/search/suggest?q=${encodeURIComponent(SKU)}&limit=10`],
  ];
  for (const [label, url] of anonSurfaces) {
    const r = await getJson(url);
    if (mentions(r.body)) fail(`${label} RETURNED ${SKU} to an anonymous visitor (${r.status})`);
    else pass(`${label} withholds it (${r.status})`);
    await pace();
  }

  // Direct PostgREST — the side door. RLS, not the API layer, is what closes it.
  const pg = await getJson(
    `${SUPABASE}/rest/v1/products?sku=eq.${encodeURIComponent(SKU)}&select=sku,admin_only`, { apikey: ANON });
  if (pg.status !== 200) {
    note(`PostgREST answered ${pg.status}, not 200 — cannot distinguish "hidden" from "query broken". Treating as could-not-run.`);
    findings.push('__CANNOT_RUN__');
  } else if (Array.isArray(pg.body) && pg.body.length === 0) {
    pass('direct PostgREST (anon) returns [] — RLS is closed');
  } else {
    fail(`direct PostgREST (anon) RETURNED the row — RLS is open (${JSON.stringify(pg.body).slice(0, 120)})`);
  }
  await pace();

  // The SEO surfaces. Leaving the row here publishes it to Google Merchant Centre.
  for (const [label, url] of [['sitemap.xml', `${API}/sitemap.xml`], ['google-shopping feed', `${API}/feeds/google-shopping.xml`]]) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (text.toUpperCase().includes(SKU.toUpperCase())) fail(`${label} CONTAINS ${SKU} — it is published to the open web`);
      else pass(`${label} withholds it (${res.status})`);
    } catch (e) { note(`${label} unreachable (${e.message}) — not verified`); }
    await pace();
  }

  // ── §2 POSITIVE CONTROL. Without this, "invisible" could just mean a broken
  // query answering nothing for everybody (the ERR-229 lesson).
  console.log(`\n${C.b}§2 positive control — the same calls DO return a real product${C.x}`);
  const ctl = await getJson(`${SUPABASE}/rest/v1/products?select=sku&is_active=eq.true&limit=1`, { apikey: ANON });
  const realSku = Array.isArray(ctl.body) && ctl.body[0] ? ctl.body[0].sku : null;
  if (!realSku) {
    note('could not obtain a control SKU — §1 is UNPROVEN, not passed');
    findings.push('__CANNOT_RUN__');
  } else {
    const r = await getJson(`${API}/api/products/${encodeURIComponent(realSku)}`);
    if (JSON.stringify(r.body || '').toUpperCase().includes(realSku.toUpperCase())) {
      pass(`/api/products/:sku returns the control product ${realSku} — §1 is a real absence`);
    } else {
      fail(`the control product ${realSku} is ALSO missing (${r.status}) — §1 proves nothing, the query is broken`);
    }
  }
  await pace();

  // ── §3 The admin can actually see it, and the mirror is never cached.
  console.log(`\n${C.b}§3 admin — the product must be visible, and never edge-cached${C.x}`);
  if (!adminEmail || !adminPass) {
    note('ADMIN_EMAIL / ADMIN_PASSWORD not set (.env or environment) — the admin leg did not run');
    findings.push('__CANNOT_RUN__');
  } else {
    const jwt = await signIn(adminEmail, adminPass, ANON);
    if (!jwt) {
      note('admin sign-in failed — the admin leg did not run');
      findings.push('__CANNOT_RUN__');
    } else {
      const H = { Authorization: `Bearer ${jwt}` };
      const mirrors = [
        ['mirror /products/:sku', `${API}/api/admin/catalog/products/${encodeURIComponent(SKU)}`],
        ['mirror /shop', `${API}/api/admin/catalog/shop?limit=100`],
        ['mirror /search/smart', `${API}/api/admin/catalog/search/smart?q=${encodeURIComponent(SKU)}&limit=40`],
      ];
      for (const [label, url] of mirrors) {
        const r = await getJson(url, H);
        if (r.status === 404) {
          note(`${label} is ABSENT (404) — the mirror has not shipped; admin preview is off, not empty`);
          findings.push('__CANNOT_RUN__');
        } else if (mentions(r.body)) {
          pass(`${label} returns it`);
          const cc = String(r.headers.get('cache-control') || '');
          const cf = String(r.headers.get('cf-cache-status') || '');
          if (!/no-store/.test(cc)) fail(`${label} lacks no-store (cache-control: ${cc || 'absent'}) — this is ERR-124 with extra steps`);
          else pass(`${label} is no-store`);
          if (/^(HIT|MISS)$/i.test(cf)) fail(`${label} is EDGE-CACHED (cf-cache-status: ${cf}) — an admin body can reach a shared entry`);
          else pass(`${label} is not edge-cached (cf-cache-status: ${cf || 'absent'})`);
        } else {
          fail(`${label} did NOT return ${SKU} (${r.status}) — an admin cannot see the test product`);
        }
        await pace();
      }

      // The ERR-124 regression detector: after an admin has read it, the
      // anonymous URL must still 404. If a token ever poisons the shared entry,
      // this is the line that catches it.
      const after = await getJson(`${API}/api/products/${encodeURIComponent(SKU)}`);
      if (mentions(after.body)) fail('after an admin read, the ANONYMOUS url now returns it — the shared cache is poisoned (ERR-124)');
      else pass('after an admin read, the anonymous url still withholds it');
      await pace();
    }
  }

  // ── §4 A signed-in NON-admin is just a shopper.
  console.log(`\n${C.b}§4 signed-in non-admin — still a shopper${C.x}`);
  const bizEmail = process.env.BUSINESS_EMAIL || env.BUSINESS_EMAIL;
  const bizPass = process.env.BUSINESS_PASSWORD || env.BUSINESS_PASSWORD;
  if (!bizEmail || !bizPass) {
    note('BUSINESS_EMAIL / BUSINESS_PASSWORD not set — the non-admin leg did not run');
    findings.push('__CANNOT_RUN__');
  } else {
    const jwt = await signIn(bizEmail, bizPass, ANON);
    if (!jwt) {
      note('non-admin sign-in failed — the non-admin leg did not run');
      findings.push('__CANNOT_RUN__');
    } else {
      const r = await getJson(`${API}/api/products/${encodeURIComponent(SKU)}`, { Authorization: `Bearer ${jwt}` });
      if (mentions(r.body)) fail(`a signed-in non-admin can see ${SKU} (${r.status})`);
      else pass('a signed-in non-admin cannot see it');
      await pace();

      const m = await getJson(`${API}/api/admin/catalog/products/${encodeURIComponent(SKU)}`, { Authorization: `Bearer ${jwt}` });
      if (m.status === 404) note('mirror absent — non-admin gating on it not verified');
      else if (m.status === 401 || m.status === 403) pass(`the mirror refuses a non-admin (${m.status})`);
      else fail(`the mirror answered ${m.status} to a NON-ADMIN — it must be 401/403`);
      await pace();

      const pgAuth = await getJson(
        `${SUPABASE}/rest/v1/products?sku=eq.${encodeURIComponent(SKU)}&select=sku`,
        { apikey: ANON, Authorization: `Bearer ${jwt}` });
      if (pgAuth.status === 200 && Array.isArray(pgAuth.body) && pgAuth.body.length === 0) {
        pass('direct PostgREST as `authenticated` returns [] — RLS covers signed-in users too');
      } else if (pgAuth.status === 200) {
        fail('direct PostgREST as `authenticated` RETURNED the row — the RLS policy only covers anon');
      } else {
        note(`PostgREST (authenticated) answered ${pgAuth.status} — not verified`);
      }
    }
  }

  // ── The write path. Read-only probe: we can say it was not measured, and we
  // must not say it passed.
  console.log(`\n${C.b}§5 write path${C.x}`);
  note('POST /api/cart/items with this product as a non-admin is NOT MEASURED — this probe is read-only.');
  note('Brief §5 asks for 403 ADMIN_ONLY_PRODUCT there. Verify it by hand, or with a deliberate one-off.');

  // ── Verdict
  const cannotRun = findings.filter(f => f === '__CANNOT_RUN__').length;
  const real = findings.filter(f => f !== '__CANNOT_RUN__');
  console.log(`\n${'─'.repeat(72)}`);
  if (real.length) {
    console.log(`${C.r}${C.b}${real.length} FINDING(S)${C.x} across ${checked} checks:`);
    for (const f of real) console.log(`  ${C.r}·${C.x} ${f}`);
    console.log('');
    process.exit(1);
  }
  if (cannotRun) {
    console.log(`${C.y}${C.b}COULD NOT FULLY RUN${C.x} — ${cannotRun} leg(s) did not execute.`);
    for (const n of notes) console.log(`  ${C.d}·${C.x} ${n}`);
    console.log(`${C.d}Nothing that did not run was verified. Do NOT read this as a pass.${C.x}\n`);
    process.exit(2);
  }
  console.log(`${C.g}${C.b}PASS${C.x} — ${checked} checks. ${SKU} is invisible to anonymous and signed-in`);
  console.log('non-admin visitors on every surface measured, visible to an admin, and the');
  console.log('mirror is not edge-cached.\n');
  process.exit(0);
}

main().catch(err => {
  console.error(`\n${C.r}CANNOT RUN${C.x} — ${err && err.stack ? err.stack : err}`);
  console.error('Nothing was verified.\n');
  process.exit(2);
});
