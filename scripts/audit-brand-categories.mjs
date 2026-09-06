#!/usr/bin/env node
/**
 * audit-brand-categories.mjs
 * ==========================
 * Live oracle for the "Cartridge Brands" mega menu — every brand+category link
 * it advertises, checked against the catalogue that is actually on the shelf.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-09-06 a customer clicked Lexmark → Ink Cartridges and got
 * "No products found." We have never sold a Lexmark ink cartridge. The link had
 * been in the menu since it was written.
 *
 * `BRANDS` in js/mega-nav.js is a hardcoded array of ~31 brand+category claims.
 * `GET /api/site/nav` can reorder the cards or drop a whole brand, but
 * mega-nav.js lifts the CATEGORY lists straight out of that local array — the
 * feed can never correct a single wrong category link. Nothing in tests/ or
 * scripts/ had ever compared the array to the catalogue, so the only instrument
 * pointed at those 31 claims was a customer noticing.
 *
 * The audit runs BOTH directions, because both were live on the day it was
 * written (ERR-215):
 *
 *   A link we OFFER with ZERO live rows      → Lexmark → Ink Cartridges. A menu
 *                                              entry that can only ever land on
 *                                              an empty shelf.
 *   Rows that are LIVE with no link          → Epson's 5 maintenance boxes. Real,
 *                                              purchasable products with no path
 *                                              to them from the brand drilldown.
 *
 * MEASURE THE OUTCOME, NEVER A PROXY. The obvious instrument — the `counts`
 * facet on /api/shop — is WRONG, and check B4 exists to keep saying so. The
 * backend omits `maintenance_box` from `counts.drums` while its `?category=drums`
 * filter includes it (measured 2026-09-06: epson absent/5, canon 9/12,
 * brother 61/62). B1 and B2 therefore resolve against the catalogue walk and a
 * real `?category=` query, never the facet.
 *
 * NOT under inkcartridges/. `vercel.json` sets `outputDirectory: "."` with the
 * Vercel project root at `inkcartridges/`, so everything in that tree is served
 * publicly. Audit tooling belongs in this directory.
 *
 * ONE VOCABULARY. The brand→category claims are read out of the SHIPPED
 * js/mega-nav.js, and category membership out of the SHIPPED
 * js/admin/utils/catalogue-pathway.js. This script declares neither: an audit
 * carrying its own copy certifies a UI that does not exist.
 *
 * READ-ONLY. There is no --record, no --update-baseline, no write path of any
 * kind, and the mode is printed on every run. A probe that can record is a probe
 * that can pass because it just overwrote what it was comparing against (that is
 * how `sweep:b2b` ate a committed fixture on 2026-08-12).
 *
 * Usage:
 *   npm run audit:brand-categories
 *   node scripts/audit-brand-categories.mjs --json
 *
 * Env:
 *   API_BASE=...   (optional; defaults to the Render origin)
 *
 * Exit codes: 0 clean · 1 any drift · 2 the catalogue could not be read.
 *
 * An unreachable API is a FAILURE, never a silent pass. "I could not read the
 * catalogue" and "the catalogue agrees with us" are different sentences, and
 * collapsing them is the absence-read-as-zero mistake itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');

const ARGS = new Set(process.argv.slice(2));
const JSON_OUT = ARGS.has('--json');

const API_BASE = process.env.API_BASE || 'https://ink-backend-zaeq.onrender.com';
const PAGE_LIMIT = 200;

/**
 * Pace between requests. This walks ~21 pages of /api/products and then makes
 * one confirming call per offered link. On 2026-08-31 the backend reported that
 * hammering /api/products reliably 502s their whole instance — health endpoint
 * included — for several minutes (ERR-188 is that outage from this side). Same
 * constant, same reason, in every script that walks it.
 */
const REQUEST_DELAY_MS = Number(process.env.PROBE_DELAY_MS || 650);
const MAX_PAGE_ATTEMPTS = 4;
const RATE_LIMIT_BACKOFF_MS = 20000;

/**
 * Ribbons are exempt from B2 — and the exemption is PRINTED, by name, with its
 * row count, on every run. A skip is not a pass: a category quietly dropped from
 * the loop looks identical to a category that had nothing in it.
 *
 * Ribbons are a second universe. A ribbon's brand is the PRINTER brand
 * (`ribbon_brands` / `product_ribbon_brands`), not `products.brand_id`, so they
 * are indexed on a different axis from the cartridge catalogue. All of the OEM
 * brands that carry ribbon rows are in the 63-brand taxonomy behind the
 * "Typewriter and Printer Ribbons" mega, and shop-page.js hard-redirects
 * `?category=ribbons` to /ribbons. They are reachable; they are simply not the
 * Cartridge Brands mega's job.
 */
const B2_EXEMPT_CATEGORIES = new Set(['ribbons']);

const say = (...a) => { if (!JSON_OUT) console.log(...a); };
const rule = (ch = '─') => say(ch.repeat(78));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Two buckets, and the difference decides the exit code.
//
//   findings          — FRONTEND-owned drift. We can fix these in this repo, so
//                       they block, always, with no baseline to age into silence.
//   backendConditions — states of the live API we do not control. Always
//                       PRINTED, never swallowed, but they cannot make a correct
//                       frontend fail forever.
const findings = [];
const backendConditions = [];
const notes = [];
const exemptions = [];
const fail = (check, subject, detail) => findings.push({ check, subject, detail });
const backendCondition = (check, subject, detail) => backendConditions.push({ check, subject, detail });
const note = (msg) => { notes.push(msg); };

// ──────────────────────────────────────────────────────────────────────────
// The one interpreter — load the SHIPPED claims
// ──────────────────────────────────────────────────────────────────────────

function readSite(rel) {
    const p = path.join(SITE, rel);
    if (!fs.existsSync(p)) {
        console.error(`\n✖ cannot find ${p} — is this running from the repo root?\n`);
        process.exit(2);
    }
    return fs.readFileSync(p, 'utf8');
}

/**
 * The shipped `BRANDS` array out of js/mega-nav.js.
 *
 * mega-nav.js is a classic IIFE that touches `document` on load, so it cannot be
 * imported. Slice out just the array literal and evaluate THAT — it contains
 * nothing but object literals, and evaluating the real source beats
 * re-transcribing it here where it could drift.
 *
 * If this extraction ever fails the audit EXITS, loudly. An audit that cannot
 * find the list must never report "no bad links found" — that is the same
 * absence-read-as-zero mistake it exists to catch.
 */
function loadMegaBrands() {
    const src = readSite('js/mega-nav.js');
    const start = src.indexOf('const BRANDS = [');
    if (start === -1) {
        console.error('\n✖ could not find `const BRANDS = [` in js/mega-nav.js.');
        console.error('  The audit cannot certify a menu it cannot read. If the array was renamed');
        console.error('  or restructured, update this extractor — do not delete the check.\n');
        process.exit(2);
    }
    const open = src.indexOf('[', start);
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === '[') depth++;
        else if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) {
        console.error('\n✖ js/mega-nav.js `const BRANDS = [` is not balanced — cannot read the menu.\n');
        process.exit(2);
    }
    let brands;
    try {
        brands = vm.runInNewContext(`(${src.slice(open, end + 1)})`, Object.create(null), { timeout: 1000 });
    } catch (err) {
        console.error(`\n✖ could not evaluate the BRANDS literal from js/mega-nav.js: ${err.message}\n`);
        process.exit(2);
    }
    if (!Array.isArray(brands) || !brands.length) {
        console.error('\n✖ js/mega-nav.js BRANDS evaluated to an empty list — refusing to certify a menu of nothing.\n');
        process.exit(2);
    }
    for (const b of brands) {
        if (!b || typeof b.slug !== 'string' || !Array.isArray(b.categories)) {
            console.error(`\n✖ a BRANDS entry has no slug or no categories array: ${JSON.stringify(b)}\n`);
            process.exit(2);
        }
    }
    return brands;
}

async function loadShippedCategoryMap() {
    // A plain ES module with no DOM references — imports directly, so we get the
    // real membership the admin and storefront share, not a reconstruction.
    const url = new URL(`file://${path.join(SITE, 'js/admin/utils/catalogue-pathway.js')}`);
    const mod = await import(url.href);
    if (!mod.CATEGORY_PRODUCT_TYPES_FALLBACK || typeof mod.categoryForType !== 'function') {
        console.error('\n✖ catalogue-pathway.js did not export CATEGORY_PRODUCT_TYPES_FALLBACK / categoryForType\n');
        process.exit(2);
    }
    return mod;
}

// ──────────────────────────────────────────────────────────────────────────
// Live reads
// ──────────────────────────────────────────────────────────────────────────

async function getJsonWithBackoff(url) {
    for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt++) {
        let body = null;
        try {
            // GET, never HEAD. A HEAD probe against this origin once produced a
            // fake regression report (ERR-159) — the edge answers it differently.
            const res = await fetch(url, { headers: { Accept: 'application/json' } });
            body = await res.json();
        } catch (err) {
            if (attempt === MAX_PAGE_ATTEMPTS) throw new Error(`${url}: ${err.message}`);
            await sleep(1500 * attempt);
            continue;
        }
        const code = body && body.error && body.error.code;
        if (code !== 'RATE_LIMITED') return body;
        if (attempt === MAX_PAGE_ATTEMPTS) break;
        say(`    rate limited — backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s (attempt ${attempt}/${MAX_PAGE_ATTEMPTS})`);
        await sleep(RATE_LIMIT_BACKOFF_MS);
    }
    throw new Error(`rate limited after ${MAX_PAGE_ATTEMPTS} attempts: ${url}`);
}

/**
 * Walk /api/products anonymously. Param order is `page` then `limit` to match
 * API.CATALOG_PARAM_ORDER (js/api.js) so the sweep warms the storefront's
 * existing Cloudflare edge keys rather than minting a parallel set (ERR-124).
 */
async function collectCatalog() {
    const rows = [];
    let page = 1;
    let meta = null;
    let removedFromPage = 0;
    let sawRemovedKey = false;
    let endedCleanly = false;
    let guard = 0;

    say(`\nWalking ${API_BASE}/api/products …`);
    for (;;) {
        if (++guard > 200) throw new Error('catalog walk exceeded 200 pages — refusing to loop');
        if (page > 1) await sleep(REQUEST_DELAY_MS);
        const body = await getJsonWithBackoff(`${API_BASE}/api/products?page=${page}&limit=${PAGE_LIMIT}`);
        if (!body || body.ok === false) {
            throw new Error(`catalog page ${page} failed: ${JSON.stringify(body && body.error)}`);
        }
        const data = body.data || body;
        const items = data.products || data.items || (Array.isArray(data) ? data : []);
        meta = body.meta || data.pagination || {};
        // Count the KEY, not a truthy value: a page that removed nothing reports
        // 0, and an endpoint that never gained the field also reads 0.
        if (Object.prototype.hasOwnProperty.call(meta, 'removed_from_page')) {
            sawRemovedKey = true;
            removedFromPage += Number(meta.removed_from_page) || 0;
        }
        rows.push(...items.filter(p => p && typeof p.sku === 'string' && p.sku.trim()));
        say(`  page ${page}: +${items.length} (running ${rows.length}${meta.total ? '/' + meta.total : ''})`);

        if (meta.has_next === false || items.length === 0) { endedCleanly = true; break; }
        page++;
    }

    if (!endedCleanly) throw new Error('catalog walk did not terminate on has_next=false');
    if (rows.length === 0) throw new Error('catalog walk returned ZERO products — refusing to report "clean"');

    if (typeof meta.total === 'number' && rows.length !== meta.total) {
        if (sawRemovedKey && removedFromPage === Math.abs(meta.total - rows.length)) {
            note(`meta.total claims ${meta.total}; ${rows.length} returned + ${removedFromPage} removed_from_page reconciles exactly. Nothing is hiding in the difference.`);
        } else {
            backendCondition('L0-catalogue-count-mismatch', `${API_BASE}/api/products`,
                `walked to has_next=false and collected ${rows.length} products, but meta.total claims ${meta.total} — ${Math.abs(meta.total - rows.length)} row(s) are counted by the API but never served by it. Everything below was checked against the ${rows.length} rows that ARE reachable, so "offered but empty" is a weaker claim than usual on this run.`);
        }
    }
    return { rows, removedFromPage: sawRemovedKey ? removedFromPage : null };
}

async function loadBrandRows() {
    const body = await getJsonWithBackoff(`${API_BASE}/api/brands`);
    const rows = Array.isArray(body && body.data) ? body.data : null;
    if (!rows || !rows.length) throw new Error('/api/brands returned no rows');
    return rows;
}

/**
 * The REAL total for a brand+category — what a shopper following the link gets.
 *
 * Returns a number, or null when the request could not be resolved. null is
 * "unmeasured", and it is never allowed to read as 0: the whole point of this
 * script is that an empty answer and an unanswered question are different.
 */
async function categoryTotal(brand, category) {
    await sleep(REQUEST_DELAY_MS);
    try {
        const body = await getJsonWithBackoff(
            `${API_BASE}/api/shop?brand=${encodeURIComponent(brand)}&category=${encodeURIComponent(category)}&limit=1`);
        if (!body || body.ok === false) return null;
        const total = body.meta && body.meta.total;
        return typeof total === 'number' ? total : null;
    } catch {
        return null;
    }
}

/** The brand-scoped `counts` facet — the thing B4 exists to distrust. */
async function facetCounts(brand) {
    await sleep(REQUEST_DELAY_MS);
    try {
        const body = await getJsonWithBackoff(`${API_BASE}/api/shop?brand=${encodeURIComponent(brand)}&limit=1`);
        if (!body || body.ok === false) return null;
        return (body.data && body.data.counts) || null;
    } catch {
        return null;
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Checks
// ──────────────────────────────────────────────────────────────────────────

const CATEGORY_ORDER = ['ink', 'toner', 'drums', 'label', 'paper', 'ribbons'];

/** The facet key that carries a category's count, or null if it has none. */
function facetKeyFor(category) {
    if (category === 'ribbons') return 'ribbon';
    return category;
}

async function audit(brands, brandRows, catalogue, pathway, removedFromPage) {
    const { categoryForType } = pathway;

    // brand slug → category → live row count, from the catalogue walk.
    const shelf = new Map();
    let unmapped = 0;
    for (const p of catalogue) {
        const slug = p.brand && p.brand.slug;
        const category = categoryForType(p.product_type);
        if (!slug) continue;
        if (!category) { unmapped++; continue; }
        if (!shelf.has(slug)) shelf.set(slug, new Map());
        const row = shelf.get(slug);
        row.set(category, (row.get(category) || 0) + 1);
    }
    if (unmapped) {
        note(`${unmapped} live product(s) have a product_type that maps to no /shop category at all — they are invisible to every brand+category link. \`npm run audit:types\` (check T7) is the instrument that names them.`);
    }

    const byRow = (slug) => shelf.get(slug) || new Map();
    const brandRowBySlug = new Map(brandRows.map(b => [b.slug, b]));
    const megaSlugs = new Set(brands.map(b => b.slug));

    // ── The shelf, printed. An operator should be able to read the whole
    //    catalogue's shape here without running anything else.
    say('\nLIVE brand × category (catalogue walk) vs the mega menu');
    rule();
    say('  ' + 'brand'.padEnd(14) + CATEGORY_ORDER.map(c => c.padStart(9)).join('') + '   mega offers');
    const allSlugs = [...new Set([...brands.map(b => b.slug), ...shelf.keys()])];
    for (const slug of allSlugs) {
        const row = byRow(slug);
        const offered = megaSlugs.has(slug)
            ? new Set(brands.find(b => b.slug === slug).categories.map(c => c.param))
            : null;
        const cells = CATEGORY_ORDER.map(c => {
            const n = row.get(c) || 0;
            const shown = n ? String(n) : '·';
            if (!offered) return shown.padStart(9);
            if (offered.has(c)) return (n ? shown : `${shown}!DEAD`).padStart(9);
            return shown.padStart(9);
        }).join('');
        const tail = offered ? [...offered].join(' ') : '(not in the mega)';
        say('  ' + slug.padEnd(14) + cells + '   ' + tail);
    }

    say('\nChecks');
    rule();

    // ── B1 — a link we OFFER that lands on nothing. The Lexmark → Ink trap.
    //
    // Resolved against BOTH instruments: the catalogue walk and a real
    // ?category= query. A finding needs both to agree that the shelf is empty,
    // because one instrument alone has been wrong before.
    for (const brand of brands) {
        for (const cat of brand.categories) {
            const walked = byRow(brand.slug).get(cat.param) || 0;
            if (walked > 0) continue;
            const served = await categoryTotal(brand.slug, cat.param);
            if (served === null) {
                backendCondition('B1-unconfirmable', `${brand.slug}/${cat.param}`,
                    `the catalogue walk found 0 rows, but /api/shop?brand=${brand.slug}&category=${cat.param} could not be read, so the link is UNVERIFIED — not cleared. Re-run before trusting a clean result.`);
                continue;
            }
            if (served === 0) {
                fail('B1-offered-but-empty', `${brand.slug}/${cat.param}`,
                    `the mega menu links "${cat.label}" on the ${brand.name} card to /shop?brand=${brand.slug}&category=${cat.param}, and that page has ZERO products (catalogue walk: 0 rows; /api/shop meta.total: 0). Remove the entry from BRANDS in js/mega-nav.js, or stock the category.`);
            } else {
                backendCondition('B1-instruments-disagree', `${brand.slug}/${cat.param}`,
                    `the catalogue walk found 0 rows but /api/shop?category=${cat.param} serves ${served}. The link works; the walk is missing rows. Do not remove the entry on the strength of the walk alone.`);
            }
        }
    }

    // ── B2 — rows that are LIVE with no link. The Epson maintenance-box trap.
    //
    // Scoped to brands the /shop grid shows (show_on_shop === true, strict —
    // absent is not visible). A brand that is off the grid has no card in the
    // mega to carry a link, so a missing link there is not drift.
    for (const brand of brands) {
        const row = byRow(brand.slug);
        const offered = new Set(brand.categories.map(c => c.param));
        for (const [category, n] of row) {
            if (offered.has(category) || n === 0) continue;
            if (B2_EXEMPT_CATEGORIES.has(category)) {
                exemptions.push({ brand: brand.slug, category, rows: n });
                continue;
            }
            fail('B2-live-but-unoffered', `${brand.slug}/${category}`,
                `${n} live product(s) sit under ${brand.name} → ${category}, and the mega menu offers no link to them. Add { label, param: '${category}' } to the ${brand.slug} entry in BRANDS (js/mega-nav.js), or the only path to those rows is search.`);
        }
    }

    // ── B3 — enrolment. "Every surface knows about the new brand" is a list
    //    nobody maintains (ERR-150/160), so make it a check instead.
    for (const row of brandRows) {
        if (row.show_on_shop !== true) continue;
        if (megaSlugs.has(row.slug)) continue;
        const total = [...byRow(row.slug).values()].reduce((s, n) => s + n, 0);
        fail('B3-on-the-grid-not-in-the-mega', row.slug,
            `${row.name} is show_on_shop=true (it has a tile on the /shop brand grid, ${total} live product(s)) but has no card in the mega menu's BRANDS array. The /api/site/nav feed can reorder cards; it cannot invent one.`);
    }
    for (const brand of brands) {
        const row = brandRowBySlug.get(brand.slug);
        if (!row) {
            fail('B3-mega-brand-is-not-a-brand', brand.slug,
                `the mega menu carries a ${brand.name} card, but /api/brands has no row with slug "${brand.slug}". Every link on that card is unreachable.`);
        } else if (row.show_on_shop !== true) {
            fail('B3-mega-brand-off-the-grid', brand.slug,
                `the mega menu carries a ${brand.name} card, but the brand row has show_on_shop=${JSON.stringify(row.show_on_shop)} — /shop's own brand grid hides it. The two surfaces disagree about whether we sell this brand.`);
        }
    }

    // ── B4 — the facet vs the truth.
    //
    // This is the check that caught ERR-215's second half. /shop's category step
    // gates its tiles on the `counts` facet; the mega links straight past it. When
    // the two disagree, a category is reachable from one surface and invisible
    // from the other — which is exactly what Epson's 5 maintenance boxes did.
    // Direction matters, and only ONE direction is a defect.
    //
    //   facet HIGHER than the walk — expected. /api/products drops rows per page
    //     (the pack guard) and reports how many in `removed_from_page`; the facet
    //     counts before that guard runs. These over-counts should sum to exactly
    //     the walk's shortfall, and the audit ASSERTS that rather than assuming
    //     it. Reporting a fully-explained gap as an open condition makes a solved
    //     thing read as a live limitation (ERR-184/186).
    //
    //   facet LOWER than the walk, or ABSENT while rows exist — real. Something
    //     the catalogue holds is missing from the number /shop gates its tiles on.
    const facetDrift = [];
    let overCount = 0;
    let overCountUnmeasured = false;
    for (const brand of brands) {
        const counts = await facetCounts(brand.slug);
        if (counts === null) {
            overCountUnmeasured = true;
            backendCondition('B4-facet-unreadable', brand.slug,
                `could not read the counts facet for ${brand.name}; the facet-vs-truth comparison did not run for this brand.`);
            continue;
        }
        for (const category of CATEGORY_ORDER) {
            if (category === 'ribbons') continue;   // not served by /api/shop's cartridge facet
            const walked = byRow(brand.slug).get(category) || 0;
            const key = facetKeyFor(category);
            const present = Object.prototype.hasOwnProperty.call(counts, key);
            const facet = present ? (Number(counts[key]) || 0) : 0;
            if (facet === walked) continue;
            if (facet > walked) { overCount += facet - walked; continue; }
            facetDrift.push({ brand: brand.slug, category, facet: present ? facet : null, real: walked });
            backendCondition('B4-facet-undercounts-the-catalogue', `${brand.slug}/${category}`,
                `/api/shop?brand=${brand.slug} reports counts.${key}=${present ? facet : 'ABSENT'}, but the catalogue holds ${walked} row(s) in that category. ` +
                (present
                    ? `The tile still renders, so no customer-visible path is lost here — but the number behind it is ${walked - facet} short.`
                    : `ABSENT is the dangerous one: an absent key reads as 0, and a category counted as 0 gets its tile HIDDEN — so those ${walked} product(s) would have no path from the /shop brand drilldown.`));
        }
    }
    if (overCount) {
        if (overCountUnmeasured) {
            note(`the facet reads ${overCount} higher than the walk in total, but at least one brand's facet could not be read, so that figure could not be reconciled against removed_from_page.`);
        } else if (removedFromPage === null) {
            backendCondition('B4-overcount-unreconciled', `${API_BASE}/api/shop`,
                `the counts facet reads ${overCount} row(s) higher than the catalogue walk, and /api/products did not report removed_from_page, so the excess is unexplained.`);
        } else if (overCount === removedFromPage) {
            note(`the facet reads ${overCount} higher than the walk, which is exactly the ${removedFromPage} row(s) /api/products reported as removed_from_page — the facet counts before the per-page pack guard runs. Fully explained; not drift.`);
        } else {
            backendCondition('B4-overcount-unreconciled', `${API_BASE}/api/shop`,
                `the counts facet reads ${overCount} row(s) higher than the catalogue walk, but /api/products only reported ${removedFromPage} removed_from_page. ${Math.abs(overCount - removedFromPage)} row(s) of the excess are unexplained.`);
        }
    }
    if (facetDrift.length) {
        note(`${facetDrift.length} facet UNDERCOUNT(s) above. Known cause (2026-09-06): the backend omits \`maintenance_box\` from \`counts.drums\` while its \`?category=drums\` filter includes it. shop-page.js defends itself by confirming a zero for any multi-type family before hiding a tile — do not remove that confirm on the grounds that the facet "looks fine".`);
    }

    return {
        shelf: Object.fromEntries([...shelf].map(([k, v]) => [k, Object.fromEntries(v)])),
        mega: Object.fromEntries(brands.map(b => [b.slug, b.categories.map(c => c.param)])),
        facet_drift: facetDrift,
        brands_in_mega: brands.length,
        products: catalogue.length,
    };
}

// ──────────────────────────────────────────────────────────────────────────
// Report
// ──────────────────────────────────────────────────────────────────────────

async function main() {
    say('');
    rule('═');
    say('  BRAND × CATEGORY AUDIT — the mega menu vs the live catalogue');
    say('  MODE: READ-ONLY (this script has no write path — nothing is recorded)');
    say(`  API:  ${API_BASE}`);
    say(`  PACE: ${REQUEST_DELAY_MS}ms between requests`);
    rule('═');

    const brands = loadMegaBrands();
    const pathway = await loadShippedCategoryMap();
    const links = brands.reduce((s, b) => s + b.categories.length, 0);
    say(`\nShipped menu: ${brands.length} brand card(s), ${links} brand+category link(s) — read from js/mega-nav.js.`);
    say(`Category membership: ${Object.keys(pathway.CATEGORY_PRODUCT_TYPES_FALLBACK).length} categories — read from js/admin/utils/catalogue-pathway.js.`);

    let catalogue;
    let removedFromPage = null;
    let brandRows;
    try {
        brandRows = await loadBrandRows();
        ({ rows: catalogue, removedFromPage } = await collectCatalog());
    } catch (err) {
        console.error(`\n✖ CATALOGUE UNREADABLE — ${err.message}`);
        console.error('  This is a FAILURE, not a pass. Nothing was verified.\n');
        process.exit(2);
    }

    const summary = await audit(brands, brandRows, catalogue, pathway, removedFromPage);

    if (!findings.length) {
        say('  ✓ every brand+category link in the mega menu has live products');
        say('  ✓ every live brand+category has a link (ribbons exempt, named below)');
        say('  ✓ the mega menu and the /shop brand grid carry the same brands');
    } else {
        for (const f of findings) say(`  ✖ [${f.check}] ${f.subject}\n      ${f.detail}`);
    }

    // The exemption is printed whether or not anything else is. A skip nobody
    // sees is indistinguishable from a check that passed.
    say('\nExemptions — checked, then deliberately not counted');
    rule();
    if (exemptions.length) {
        const rows = exemptions.reduce((s, e) => s + e.rows, 0);
        say(`  · ribbons: ${rows} row(s) across ${exemptions.length} brand(s) — ` +
            exemptions.map(e => `${e.brand}:${e.rows}`).join(', '));
        say('    Reachable via the "Typewriter and Printer Ribbons" mega (the ribbon_brands');
        say('    taxonomy, keyed on PRINTER brand), and shop-page.js redirects ?category=ribbons');
        say('    to /ribbons. Not the Cartridge Brands mega\'s job — exempt by design, not by oversight.');
    } else {
        say('  · none — no exempt category had live rows this run.');
    }

    if (backendConditions.length) {
        say('\nBackend conditions — NOT frontend drift, and NOT ignored');
        rule();
        for (const f of backendConditions) say(`  ! [${f.check}] ${f.subject}\n      ${f.detail}`);
    }

    if (notes.length) {
        say('\nNotes');
        rule();
        for (const n of notes) say(`  · ${n}`);
    }

    const verdict = findings.length
        ? `✖ ${findings.length} frontend finding(s)`
        : (backendConditions.length
            ? `✓ menu clean, with ${backendConditions.length} backend condition(s) above`
            : '✓ clean');

    say('');
    rule('═');
    say(`  ${verdict} — ${summary.products} products, ${summary.brands_in_mega} brand card(s), ${links} link(s)`);
    rule('═');
    say('');

    if (JSON_OUT) {
        console.log(JSON.stringify({
            mode: 'read-only', api_base: API_BASE, ...summary,
            findings, backend_conditions: backendConditions, exemptions, notes,
        }, null, 2));
    }

    process.exit(findings.length ? 1 : 0);
}

main().catch(err => {
    console.error(`\n✖ audit crashed: ${err && err.stack || err}\n`);
    process.exit(2);
});
