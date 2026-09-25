#!/usr/bin/env node
/**
 * Do chip/code pages actually reach Googlebot — and do both sides agree?
 * =============================================================================
 * ERR-270.
 *
 * `/shop?brand=<slug>&code=<code>` served crawlers the GENERIC brand hub: the
 * edge built the prerender path from the brand slug alone and dropped the rest
 * of the query. The backend has shipped the code-specific page since Sep 2026,
 * so the SEO win was sitting there unrequested.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS PROBE
 * -------------------------------------------------
 * tests/chip-prerender-sep2026.test.js proves middleware.js and seo-meta.js
 * build the same URL, by executing both. It cannot prove that URL still
 * ANSWERS. The prerender endpoints belong to a service in another repo, on a
 * cold-starting Render instance, behind a rate limiter nobody here controls.
 * The edge's failure mode is silent by design — `!response.ok` returns
 * undefined and the bot falls through to the SPA shell — so a backend
 * regression would look exactly like nothing happening, with a green suite.
 *
 * §4 is the half we do NOT own: the chip/code sitemap shard. It is reported as
 * a NOTE, never a failure, because no change in this repo can move it.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * GETs against public pages, the public prerender endpoints and the public
 * sitemap. There is no --record and no --write, deliberately: a probe that can
 * record may be green only because it just overwrote what it compared against
 * (sweep:b2b ate a committed fixture, 2026-08-12). The mode is PRINTED below.
 *
 * It reads the REAL allowlist out of inkcartridges/middleware.js rather than
 * carrying its own copy — ERR-231's probe was certifying a replica of the thing
 * it was supposed to be checking, and agreed with it perfectly while both were
 * wrong.
 *
 * Exit: 0 = the chain holds
 *       1 = a real finding
 *       2 = could not run (network / cold start). "We could not look" is never
 *           reported as "we looked and it was fine".
 *
 *   npm run probe:chip-prerender
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = process.env.PROBE_BASE || 'https://www.inkcartridges.co.nz';
const API = process.env.PROBE_API || 'https://ink-backend-zaeq.onrender.com';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36';

let pass = 0;
const failures = [];
const notes = [];
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const cannotRun = (m) => { console.log(`\n\x1b[33m▲ probe could not run\x1b[0m — ${m}`); process.exit(2); };

console.log('\n\x1b[1mprobe:chip-prerender — do code pages reach crawlers? (ERR-270)\x1b[0m');
console.log('\x1b[2m  READ-ONLY. No --write, no --record. GETs only.\x1b[0m');
console.log(`\x1b[2m  site ${SITE}\x1b[0m`);
console.log(`\x1b[2m  api  ${API}\x1b[0m\n`);

/** The ONE transport function. A second one means this is no longer one probe. */
async function get(url, ua) {
    const res = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'text/html' }, redirect: 'follow' });
    const body = await res.text();
    return { status: res.status, headers: res.headers, body };
}
const titleOf = (html) => (html.match(/<title>([^<]*)<\/title>/i) || [, null])[1];
const canonicalOf = (html) => {
    const m = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]*)"/i);
    return m ? m[1].replace(/&amp;/g, '&') : null;
};

// ── §0 — the allowlist, read from the real source ───────────────────────────
console.log('\x1b[1m§0 the forwarded allowlist, read from middleware.js\x1b[0m');
let allowlist = null;
try {
    const src = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'middleware.js'), 'utf8');
    const m = src.match(/for \(const key of \[([^\]]+)\]\)/);
    if (!m) {
        bad('middleware.js declares a forwarded allowlist',
            'could not find `for (const key of [...])` in the brand arm — this probe reads the real '
            + 'list rather than carrying a copy, so it stops here rather than checking a guess');
    } else {
        allowlist = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
        if (allowlist.join(',') === 'code,category') {
            ok(`allowlist is [${allowlist.join(', ')}]`);
        } else {
            bad('allowlist is code+category', `middleware.js forwards [${allowlist.join(', ')}]`);
        }
    }
} catch (err) {
    cannotRun(`could not read middleware.js — ${err.message}`);
}

// ── §1 — the backend half ───────────────────────────────────────────────────
console.log('\n\x1b[1m§1 the backend still answers the code-specific page\x1b[0m');
let backendTitle = null;
try {
    const r = await get(`${API}/api/prerender/brand/brother?code=LC73`, GOOGLEBOT);
    if (r.status !== 200) cannotRun(`backend prerender answered ${r.status} (cold start? rate limit?)`);
    backendTitle = titleOf(r.body);
    if (backendTitle && /LC73/i.test(backendTitle)) ok(`backend: ${backendTitle}`);
    else bad('backend serves a code-specific title', `got ${backendTitle}`);
} catch (err) {
    cannotRun(`backend unreachable — ${err.message}`);
}

// ── §2 — the acceptance checks from the handoff, verbatim ───────────────────
console.log('\n\x1b[1m§2 the handoff\'s two acceptance checks, through www as Googlebot\x1b[0m');
const ACCEPTANCE = [
    { url: `${SITE}/shop?brand=brother&code=LC73`, must: /Brother LC73 Ink Cartridges NZ/i },
    { url: `${SITE}/shop?brand=brother&category=toner`, must: /Brother Toner Cartridges NZ/i },
];
for (const check of ACCEPTANCE) {
    try {
        const r = await get(check.url, GOOGLEBOT);
        const title = titleOf(r.body);
        const prerendered = r.headers.get('x-prerendered');
        if (r.status !== 200) { bad(check.url, `HTTP ${r.status}`); continue; }
        if (!title) { bad(check.url, 'no <title> in the response'); continue; }
        if (check.must.test(title)) {
            ok(`${check.url.replace(SITE, '')}\n      ${title}${prerendered ? '  [x-prerendered]' : ''}`);
        } else if (!prerendered) {
            bad(check.url.replace(SITE, ''),
                `got "${title}" and NO x-prerendered header — the edge fell through to the SPA shell. `
                + 'Either the middleware did not deploy, or the backend fetch failed (!response.ok '
                + 'returns undefined silently by design).');
        } else {
            bad(check.url.replace(SITE, ''), `prerendered, but the title is "${title}"`);
        }
    } catch (err) {
        cannotRun(`${check.url} — ${err.message}`);
    }
}

// ── §3 — the edge cases the allowlist exists for ────────────────────────────
console.log('\n\x1b[1m§3 the allowlist holds at the edge\x1b[0m');
try {
    // A tracking param must not change the page served. If forwarding ever
    // widens to url.search, this stays green — which is why §3b checks the
    // canonical too, where a forwarded junk param WOULD show up.
    const clean = await get(`${SITE}/shop?brand=brother&code=LC73`, GOOGLEBOT);
    const tracked = await get(`${SITE}/shop?brand=brother&code=LC73&utm_source=probe&gclid=xyz`, GOOGLEBOT);
    if (titleOf(clean.body) === titleOf(tracked.body)) {
        ok('utm_source/gclid do not change the served page');
    } else {
        bad('tracking params are inert',
            `"${titleOf(clean.body)}" vs "${titleOf(tracked.body)}"`);
    }

    const canon = canonicalOf(tracked.body);
    if (canon && !/utm_source|gclid/.test(canon)) ok(`canonical stays clean: ${canon}`);
    else if (canon) bad('canonical excludes tracking params', `got ${canon}`);
    else soft('canonical on the tracked URL', 'no canonical found — the SPA shell was probably served');
} catch (err) {
    cannotRun(`edge-case fetch failed — ${err.message}`);
}

try {
    // An UNRESOLVED code must not mint a new indexable URL. This is the
    // measurement a peer session read backwards in Sep 2026: TN2330 falls back
    // to the category (or the bare brand) because the backend does not resolve
    // it — NOT because category outranks code. A resolved code wins every time.
    const junk = await get(`${SITE}/shop?brand=brother&code=NOSUCHCODE123`, GOOGLEBOT);
    const canon = canonicalOf(junk.body);
    if (canon && !/NOSUCHCODE123/.test(canon)) {
        ok(`an unresolved code collapses its canonical: ${canon}`);
    } else if (canon) {
        bad('unresolved codes must not mint canonicals',
            `got ${canon} — every junk ?code= would become its own indexable URL (ERR-242 shape)`);
    } else {
        soft('unresolved-code canonical', 'no canonical found (SPA shell served)');
    }
} catch (err) {
    soft('unresolved-code check', `could not complete — ${err.message}`);
}

try {
    // Parity: the SPA reconciles against the SAME prerender. If a human's
    // rendered title differs from the crawler's, SeoMeta.reconcile() is
    // pointing somewhere else and the render pass will overwrite the win.
    const bot = await get(`${SITE}/shop?brand=brother&code=LC73`, GOOGLEBOT);
    const direct = await get(`${API}/api/prerender/brand/brother?code=LC73`, HUMAN);
    if (titleOf(bot.body) === titleOf(direct.body)) {
        ok('edge output matches the backend page seo-meta reconciles against');
    } else {
        bad('SPA/bot parity',
            `edge "${titleOf(bot.body)}" vs prerender "${titleOf(direct.body)}" — the SPA would `
            + 'overwrite the crawler\'s title on Google\'s render pass');
    }
} catch (err) {
    soft('parity check', `could not complete — ${err.message}`);
}

// ── §4 — the half we do not own ─────────────────────────────────────────────
console.log('\n\x1b[1m§4 the backend\'s half: are chip/code URLs in the sitemap yet?\x1b[0m');
try {
    const r = await get(`${SITE}/sitemap.xml`, GOOGLEBOT);
    const shards = [...r.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    // The backend named it `sitemap-series.xml` (2026-09-21, ERR-286) — the
    // old /code|chip/ test could not see it and kept reporting "not yet".
    const codeShard = shards.find((s) => /code|chip|series/i.test(s));
    if (codeShard) {
        ok(`a code/chip shard is published: ${codeShard}`);
        // Every URL in it must be the TWO-param canonical our pages declare;
        // a three-param URL there would be a sitemap listing a noindex page.
        const shard = await get(codeShard, GOOGLEBOT);
        const locs = [...shard.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
        const offShape = locs.filter((u) => {
            try {
                const q = new URL(u).searchParams;
                return [...q.keys()].sort().join(',') !== 'brand,code';
            } catch { return true; }
        });
        if (locs.length && !offShape.length) ok(`all ${locs.length} shard URLs are brand+code only — the canonical shape`);
        else if (!locs.length) bad('the series shard is empty', codeShard);
        else bad('shard URLs off the canonical shape', `${offShape.length} of ${locs.length}, e.g. ${offShape.slice(0, 3).join(' | ')}`);
    } else {
        soft('no chip/code sitemap shard yet',
            `${shards.length} shards published, none of them code/chip. This is the backend's to `
            + 'ship and is what ERR-270 unlocks — reported as a NOTE, not a failure, because no '
            + 'change in this repo can move it. See '
            + 'backend-docs/outbox/fe-verification-two-fixes-FE-response-sep2026.md.');
    }
} catch (err) {
    soft('sitemap check', `could not fetch the sitemap — ${err.message}`);
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n\x1b[1mSummary\x1b[0m');
console.log(`  passed: ${pass}   failed: ${failures.length}   notes: ${notes.length}`);
if (notes.length) {
    console.log('\n  Notes (not failures — mostly the backend half):');
    notes.forEach((n) => console.log(`    ~ ${n.split('\n')[0]}`));
}
if (failures.length) {
    console.log('\n\x1b[31m  FAILURES\x1b[0m');
    failures.forEach((f) => console.log(`    ✗ ${f.split('\n')[0]}`));
    process.exit(1);
}
console.log('\n\x1b[32m  OK\x1b[0m — chip/code pages reach crawlers, and both sides agree.\n');
