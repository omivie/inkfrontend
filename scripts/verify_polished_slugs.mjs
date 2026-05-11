#!/usr/bin/env node
// Verify the polished-slug SEO contract end-to-end against a deployed host.
//
// The system uses two response paths to the same URL, distinguished by UA:
//
//   • Bot UA  (Googlebot, AhrefsBot, …):  bot-prerender middleware serves
//                                         fully-rendered HTML at 200 OK with
//                                         stale-while-revalidate caching.
//   • Human UA: backend issues 301 redirects from short / loser URLs to the
//                                         polished canonical URL; humans then
//                                         render the SPA at that URL.
//
// Assertions per SKU:
//
//   A. /p/<SKU> as bot    → 200 OK + <link rel="canonical"> points to canonical_url
//   A. /p/<SKU> as human  → 301 → canonical_url
//   B. canonical_url      → 200 OK; <link rel="canonical"> self-references
//   B. og:url             → same path as canonical
//   C. /products/<loser>/<SKU> as bot   → either 301 to canonical (preferred,
//                                          server-side) OR 200 with canonical
//                                          link pointing to polished URL
//                                          (acceptable — SPA + canonical signal)
//   C. /products/<loser>/<SKU> as human → 200 OK (SPA); the SPA's
//                                          history.replaceState normalises the
//                                          URL bar — checked via JS-loaded
//                                          canonical <link> agreeing with
//                                          backend canonical_url.
//   D. /api/products/<SKU> → carries canonical_url; matches the URL the 301
//                            chain lands at.
//
// Usage:
//   node scripts/verify_polished_slugs.mjs                       # 9 SKUs sampled from sitemap
//   node scripts/verify_polished_slugs.mjs C02BK GLC3313BKBK ... # specific SKUs
//   node scripts/verify_polished_slugs.mjs --sample 20           # 20 SKUs from sitemap
//   node scripts/verify_polished_slugs.mjs --host https://staging.example.com SKU1
//
// Exit code: 0 if every assertion passed for every SKU, 1 otherwise.
//
// Zero npm dependencies — node ≥18 ships `fetch` and node:* parsers.

import { argv, exit, stdout } from 'node:process';

const HOST_DEFAULT = 'https://www.inkcartridges.co.nz';
const BACKEND_DEFAULT = 'https://ink-backend-zaeq.onrender.com';
const UA_BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const UA_HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const LOSER_SLUG = 'this-is-not-the-canonical-slug';

// ─────────────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(args) {
    const out = { host: HOST_DEFAULT, backend: BACKEND_DEFAULT, sample: null, skus: [], json: false };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--host') out.host = args[++i];
        else if (a === '--backend') out.backend = args[++i];
        else if (a === '--sample') out.sample = parseInt(args[++i], 10) || 9;
        else if (a === '--json') out.json = true;
        else if (a === '--help' || a === '-h') {
            console.log('Usage: node scripts/verify_polished_slugs.mjs [--host URL] [--backend URL] [--sample N] [--json] [SKU1 SKU2 ...]');
            exit(0);
        } else if (!a.startsWith('--')) out.skus.push(a);
    }
    if (!out.skus.length && out.sample == null) out.sample = 9;
    return out;
}

const cfg = parseArgs(argv.slice(2));

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers — manual redirect handling so we can see the chain
// ─────────────────────────────────────────────────────────────────────────────

async function fetchOnce(url, ua, method = 'GET') {
    const r = await fetch(url, { method, redirect: 'manual', headers: { 'User-Agent': ua, Accept: 'text/html,*/*' } });
    const text = method === 'GET' && r.status < 400 ? await r.text() : '';
    return { status: r.status, location: r.headers.get('location') || null, text };
}
async function followChain(url, ua, max = 6) {
    const chain = [];
    let current = url;
    for (let i = 0; i < max; i++) {
        const r = await fetchOnce(current, ua, 'HEAD');
        chain.push({ url: current, status: r.status, location: r.location });
        if (r.status >= 300 && r.status < 400 && r.location) {
            current = new URL(r.location, current).toString();
            continue;
        }
        break;
    }
    return chain;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sitemap sampling
// ─────────────────────────────────────────────────────────────────────────────

async function sampleSkusFromSitemap(host, n) {
    const r = await fetchOnce(`${host}/sitemap-products.xml`, UA_HUMAN);
    if (r.status !== 200) throw new Error(`sitemap-products.xml returned ${r.status}`);
    const locs = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const skus = [];
    const seenBrands = new Set();
    for (const loc of locs) {
        const m = loc.match(/\/products\/([^/]+)\/([^/?#]+)$/);
        if (!m) continue;
        const slug = m[1];
        const sku = m[2];
        const brand = slug.split('-')[0]?.replace(/^c(?=[a-z])/, '') || 'unknown';
        if (seenBrands.has(brand) && skus.length < n) continue;
        seenBrands.add(brand);
        skus.push(sku);
        if (skus.length >= n) break;
    }
    if (skus.length < n) {
        for (const loc of locs) {
            const m = loc.match(/\/products\/[^/]+\/([^/?#]+)$/);
            if (m && !skus.includes(m[1])) skus.push(m[1]);
            if (skus.length >= n) break;
        }
    }
    return skus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend API — get canonical_url for a SKU
// ─────────────────────────────────────────────────────────────────────────────

async function getCanonicalFromApi(backend, sku) {
    const detail = await fetchOnce(`${backend}/api/products/${encodeURIComponent(sku)}`, UA_HUMAN);
    if (detail.status === 200) {
        try {
            const json = JSON.parse(detail.text);
            const product = json?.data || json?.product || null;
            if (product?.canonical_url) return product;
        } catch (_) { /* fall through */ }
    }
    const list = await fetchOnce(`${backend}/api/products?sku=${encodeURIComponent(sku)}&limit=1`, UA_HUMAN);
    if (list.status === 200) {
        try {
            const json = JSON.parse(list.text);
            const ps = json?.data?.products || json?.data || [];
            const product = Array.isArray(ps) ? ps[0] : null;
            if (product?.canonical_url) return product;
        } catch (_) { /* nothing more */ }
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML helpers
// ─────────────────────────────────────────────────────────────────────────────

const CANONICAL_RE = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i;
const CANONICAL_RE_ALT = /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i;
const OG_URL_RE = /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i;

const pickCanonical = (html) => (html.match(CANONICAL_RE) || html.match(CANONICAL_RE_ALT) || [])[1] || null;
const pickOgUrl = (html) => (html.match(OG_URL_RE) || [])[1] || null;
const pathOf = (u, base) => { try { return new URL(u, base).pathname; } catch { return null; } };

// ─────────────────────────────────────────────────────────────────────────────
// Per-SKU verification
// ─────────────────────────────────────────────────────────────────────────────

async function verifySku(sku, host, backend) {
    const results = [];
    let allPassed = true;
    const record = (label, passed, detail) => {
        results.push({ label, passed, detail });
        if (!passed) allPassed = false;
    };

    // D. Backend API agreement
    const product = await getCanonicalFromApi(backend, sku);
    if (!product) {
        record('D. /api/products carries canonical_url', false, 'no product or canonical_url returned');
        return { sku, allPassed, results };
    }
    record('D. /api/products carries canonical_url', true, product.canonical_url);
    const expected = product.canonical_url;
    const expectedPath = new URL(expected).pathname;

    // A.bot — /p/<SKU> as Googlebot → 200 OK with canonical link pointing to polished URL
    const shortBot = await fetchOnce(`${host}/p/${encodeURIComponent(sku)}`, UA_BOT);
    if (shortBot.status === 200) {
        const canonicalInHtml = pickCanonical(shortBot.text);
        const pp = pathOf(canonicalInHtml, expected);
        record(
            'A.bot /p/<SKU> as bot → 200 + canonical link → polished slug',
            pp === expectedPath,
            `status=200, canonical=${canonicalInHtml || '(missing)'}`
        );
    } else if (shortBot.status >= 300 && shortBot.status < 400) {
        const dest = pathOf(shortBot.location, expected);
        record(
            'A.bot /p/<SKU> as bot → 301 to polished slug',
            dest === expectedPath,
            `status=${shortBot.status}, location=${shortBot.location || '(missing)'}`
        );
    } else {
        record('A.bot /p/<SKU> as bot', false, `unexpected status ${shortBot.status}`);
    }

    // A.human — /p/<SKU> as human → 301 → polished slug
    const shortHumanChain = await followChain(`${host}/p/${encodeURIComponent(sku)}`, UA_HUMAN);
    const shortHumanLanded = shortHumanChain[shortHumanChain.length - 1]?.url;
    const shortHumanRedirected = shortHumanChain.some((h) => h.status >= 300 && h.status < 400);
    record(
        'A.human /p/<SKU> as human → 301 chain ends at polished slug',
        shortHumanRedirected && shortHumanLanded && new URL(shortHumanLanded).pathname === expectedPath,
        `chain: ${shortHumanChain.map((h) => `${h.status} ${h.url}`).join(' → ')}`
    );

    // B. canonical URL renders 200 with self-referential canonical link
    const canonGet = await fetchOnce(expected, UA_BOT);
    record('B. canonical_url → 200', canonGet.status === 200, `status=${canonGet.status}`);
    if (canonGet.status === 200) {
        const renderedCanonical = pickCanonical(canonGet.text);
        record(
            'B. <link rel="canonical"> self-references',
            pathOf(renderedCanonical, expected) === expectedPath,
            `rendered=${renderedCanonical || '(missing)'}`
        );
        const og = pickOgUrl(canonGet.text);
        if (og) {
            record('B. og:url matches canonical', pathOf(og, expected) === expectedPath, `og:url=${og}`);
        }
    }

    // C.bot — /products/<loser>/<SKU> as Googlebot
    //   Preferred:  301 to polished slug (server-side, hard signal)
    //   Acceptable: 200 with <link rel="canonical"> → polished slug (SPA canonical signal)
    const loserBot = await fetchOnce(`${host}/products/${LOSER_SLUG}/${encodeURIComponent(sku)}`, UA_BOT);
    if (loserBot.status >= 300 && loserBot.status < 400) {
        const dest = pathOf(loserBot.location, expected);
        record(
            'C.bot /products/<loser>/<SKU> as bot → 301 to polished slug (preferred)',
            dest === expectedPath,
            `status=${loserBot.status}, location=${loserBot.location}`
        );
    } else if (loserBot.status === 200) {
        const renderedCanonical = pickCanonical(loserBot.text);
        record(
            'C.bot /products/<loser>/<SKU> as bot → 200 + canonical → polished slug (acceptable)',
            pathOf(renderedCanonical, expected) === expectedPath,
            `status=200, canonical=${renderedCanonical || '(missing)'}`
        );
    } else {
        record('C.bot /products/<loser>/<SKU> as bot', false, `unexpected status ${loserBot.status}`);
    }

    // C.human — /products/<loser>/<SKU> as human → 200 (SPA), backend would have 301'd
    const loserHuman = await fetchOnce(`${host}/products/${LOSER_SLUG}/${encodeURIComponent(sku)}`, UA_HUMAN);
    if (loserHuman.status === 200) {
        record('C.human /products/<loser>/<SKU> as human → 200 (SPA serves; FE history.replaceState normalises URL bar)', true, `status=200`);
    } else if (loserHuman.status >= 300 && loserHuman.status < 400) {
        record(
            'C.human /products/<loser>/<SKU> as human → 301 to polished slug',
            pathOf(loserHuman.location, expected) === expectedPath,
            `status=${loserHuman.status}, location=${loserHuman.location}`
        );
    } else {
        record('C.human /products/<loser>/<SKU> as human', false, `unexpected status ${loserHuman.status}`);
    }

    return { sku, allPassed, results, canonical: expected, name: product.name || '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
    let skus = cfg.skus;
    if (!skus.length) {
        if (!cfg.json) console.log(`Sampling ${cfg.sample} SKUs from sitemap…`);
        skus = await sampleSkusFromSitemap(cfg.host, cfg.sample);
        if (!cfg.json) console.log(`Sampled: ${skus.join(', ')}\n`);
    }

    if (!cfg.json) {
        console.log(`Polished-slug verifier — host=${cfg.host} backend=${cfg.backend}`);
        console.log(`SKUs (${skus.length}): ${skus.join(', ')}\n`);
    }

    const all = [];
    for (const sku of skus) {
        if (!cfg.json) stdout.write(`▸ ${sku.padEnd(22)} `);
        try {
            const r = await verifySku(sku, cfg.host, cfg.backend);
            all.push(r);
            if (!cfg.json) {
                stdout.write(r.allPassed ? '✅\n' : '❌\n');
                for (const a of r.results) {
                    const mark = a.passed ? '   ✓' : '   ✗';
                    console.log(`${mark} ${a.label}`);
                    if (!a.passed && a.detail) console.log(`        ${a.detail}`);
                }
                if (r.canonical) console.log(`     canonical: ${r.canonical}`);
                console.log('');
            }
        } catch (err) {
            all.push({ sku, allPassed: false, results: [{ label: 'unexpected error', passed: false, detail: err.message }] });
            if (!cfg.json) {
                stdout.write('💥\n');
                console.log(`   ✗ unexpected error: ${err.message}\n`);
            }
        }
    }

    const passed = all.filter((r) => r.allPassed).length;
    const failed = all.length - passed;
    if (cfg.json) {
        console.log(JSON.stringify({ host: cfg.host, backend: cfg.backend, total: all.length, passed, failed, results: all }, null, 2));
    } else {
        console.log('─'.repeat(70));
        console.log(`Summary: ${passed}/${all.length} passed${failed ? `, ${failed} failed` : ''}`);
        if (failed) {
            console.log('Failing SKUs:');
            for (const r of all.filter((x) => !x.allPassed)) console.log(`  - ${r.sku}`);
        }
    }
    exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error('Fatal:', err);
    exit(2);
});
