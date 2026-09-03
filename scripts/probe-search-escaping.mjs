#!/usr/bin/env node
/**
 * probe-search-escaping.mjs — does the Sep-2026 security hand-off describe the
 * search endpoints that actually shipped, and is our own PostgREST escaping real?
 * =============================================================================
 *
 * The backend hand-off (security-hardening-sep2026-FE-handoff.md) said "nothing
 * is required of the frontend". Most of it held. Two claims did not, and this
 * probe is what turns that from an assertion in a markdown file into something
 * anyone can re-run in thirty seconds.
 *
 *   §3 said all three /api/search/* endpoints "strip the characters , ( ) from
 *      the query string". Only /smart does. /by-part passes them through, where
 *      they kill the match outright. Nothing calls /by-part today, so this is a
 *      documentation defect rather than an outage — but the day somebody wires
 *      it up believing §3, they will ship a search box that dies on a bracket.
 *
 *   §4.3 said "no client-side escaping is needed (the backend handles it)".
 *      The admin SPA reaches Supabase DIRECTLY for three searches, so the
 *      backend's escaper is not in the path at all. Those three interpolated
 *      raw operator text into a comma/paren-delimited `.or()` (ERR-202).
 *
 * ── READ-ONLY. ───────────────────────────────────────────────────────────────
 * This probe only ever issues GETs. It writes nothing, records no baseline and
 * takes no flag that would change that. The PostgREST section needs an admin
 * JWT; without one it SKIPS and says so BY NAME — a skip is not a pass.
 *
 * Usage:
 *   npm run probe:search-escaping
 *   SUPABASE_JWT=<token> npm run probe:search-escaping   # includes §3
 */

const API = process.env.API_URL || 'https://ink-backend-zaeq.onrender.com';
const SB = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';
const JWT = process.env.SUPABASE_JWT || '';

console.log('probe-search-escaping — MODE: READ-ONLY (GET only; nothing is written)');
console.log(`API: ${API}`);
console.log(`PostgREST section: ${JWT ? 'ENABLED (SUPABASE_JWT present)' : 'SKIPPED (set SUPABASE_JWT to include it)'}\n`);

let failures = 0;
let skipped = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL ${m}`); };
const skip = (m) => { skipped++; console.log(`  SKIP ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(ep, q, tries = 3) {
  const url = `${API}/api/search/${ep}?limit=8&q=${encodeURIComponent(q)}`;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url);
    if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }   // limiter is real
    let j = null; try { j = await r.json(); } catch { /* non-JSON */ }
    const d = j?.data || {};
    const rows = d.products || d.results || [];
    return { status: r.status, n: rows.length, total: d.total ?? null, rows, data: d };
  }
  return { status: 429, n: 0, total: null, rows: [], data: {} };
}

// ── §1. The injection fix is real ───────────────────────────────────────────
console.log('§1  /api/search/smart — the injection the backend fixed');
{
  const base = await search('smart', 'TN251');
  if (base.n > 0) ok(`baseline "TN251" → ${base.total} rows`);
  else bad(`baseline "TN251" returned nothing (status ${base.status}) — probe cannot judge the rest`);

  for (const inj of ['zzqqxnonexistent,sku.eq.GTN251BK', 'zzqqxnonexistent,or(sku.eq.GTN251BK)']) {
    const r = await search('smart', inj);
    if (r.n === 0) ok(`injected filter is inert: ${JSON.stringify(inj)} → 0 rows`);
    else bad(`INJECTION LIVE: ${JSON.stringify(inj)} → ${r.n} rows (${r.rows.map((x) => x.sku).join(',')})`);
  }
}

// ── §2. /smart really does neutralise , ( ) — the part §3 got right ─────────
console.log('\n§2  /api/search/smart — punctuation is harmless (hand-off §3, the true half)');
{
  const plain = await search('smart', 'TN251');
  for (const variant of ['(TN251)', 'TN251,']) {
    const r = await search('smart', variant);
    if (r.total === plain.total) ok(`${JSON.stringify(variant)} ≡ "TN251" (${r.total} rows)`);
    else bad(`${JSON.stringify(variant)} → ${r.total} rows, but "TN251" → ${plain.total}`);
  }
  // Our own titles carry both characters — "(2,500 pages)".
  const withParens = await search('smart', 'HP 63XL (F6U61AA) Tri-Colour');
  const without = await search('smart', 'HP 63XL F6U61AA Tri-Colour');
  if (withParens.total === without.total) ok(`a real product title round-trips with its brackets (${withParens.total} rows)`);
  else bad(`title with brackets → ${withParens.total}, without → ${without.total}`);
}

// ── §3. …but /by-part does NOT. The hand-off is wrong here. ────────────────
console.log('\n§3  /api/search/by-part — hand-off §3 says it strips , ( ). It does not.');
{
  const plain = await search('by-part', 'TN251');
  const trimmed = await search('by-part', 'TN251 ');
  if (plain.n > 0) {
    ok(`baseline "TN251" → ${plain.n} rows`);
    if (trimmed.n === plain.n) ok('trailing WHITESPACE is trimmed (so it does normalise something)');
    let stripped = true;
    for (const variant of ['(TN251)', 'TN251,']) {
      const r = await search('by-part', variant);
      if (r.n !== plain.n) {
        stripped = false;
        console.log(`       ${JSON.stringify(variant)} → ${r.n} rows (vs ${plain.n} for "TN251")`);
      }
    }
    if (stripped) bad('by-part now DOES strip , ( ) — the hand-off became true; update ERR-202 and this probe');
    else ok('CONFIRMED: punctuation is passed through and kills the match — hand-off §3 is wrong');
  } else {
    skip('by-part returned no baseline rows — cannot judge (endpoint has no live caller)');
  }
}

// ── §4. Our own PostgREST filters ──────────────────────────────────────────
console.log('\n§4  Direct-to-PostgREST admin searches (ERR-202) — the escaper the backend never sees');
if (!JWT) {
  skip('PostgREST checks need an admin JWT (SUPABASE_JWT). NOT RUN — this is a skip, not a pass.');
} else {
  const pgrstLike = (s) => `"%${String(s ?? '').replace(/["\\]/g, (m) => '\\' + m)}%"`;
  const run = async (orExpr) => {
    const url = `${SB}/rest/v1/products?select=sku,name&or=(${encodeURIComponent(orExpr)})&limit=3`;
    const r = await fetch(url, { headers: { apikey: ANON, Authorization: `Bearer ${JWT}` } });
    let body = null; try { body = await r.json(); } catch { /* non-JSON */ }
    return { status: r.status, body };
  };

  // The OLD form, to show the failure is real and not folklore.
  const rawOr = (s) => `name.ilike.%${s}%,sku.ilike.%${s}%`;
  const legacy = await run(rawOr('Smith, Ltd'));
  if (legacy.status === 400) ok(`the OLD raw form still 400s on "Smith, Ltd" (${legacy.body?.code}) — the bug was real`);
  else console.log(`       note: raw form returned ${legacy.status}, not the 400 recorded in ERR-202`);

  // The shipped form.
  const safeOr = (s) => `name.ilike.${pgrstLike(s)},sku.ilike.${pgrstLike(s)}`;
  for (const q of ['Smith, Ltd', 'Acme (NZ)', 'x,is_active.eq.false', 'quote" inject']) {
    const r = await run(safeOr(q));
    if (r.status === 200) ok(`quoted form survives ${JSON.stringify(q)} → 200`);
    else bad(`quoted form broke on ${JSON.stringify(q)} → ${r.status} ${r.body?.message || ''}`);
  }

  // POSITIVE CONTROL — the escaper must not have made search useless.
  const control = await run(safeOr('TN251'));
  const rows = Array.isArray(control.body) ? control.body : [];
  if (control.status === 200 && rows.length > 0) ok(`positive control: "TN251" still returns rows (${rows.length})`);
  else bad('positive control FAILED — escaping neutered the search itself');

  // And the thing that used to be impossible: our own punctuated title.
  const title = await run(safeOr('Black (2,500 pages)'));
  const tRows = Array.isArray(title.body) ? title.body : [];
  if (title.status === 200 && tRows.length > 0) ok(`"Black (2,500 pages)" now FINDS ${tRows.length} rows (used to 400)`);
  else bad(`"Black (2,500 pages)" → ${title.status}, ${tRows.length} rows`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s), ${skipped} skipped.`);
if (skipped) console.log('A skip is not a pass: the skipped section above did not run.');
process.exit(failures === 0 ? 0 : 1);
