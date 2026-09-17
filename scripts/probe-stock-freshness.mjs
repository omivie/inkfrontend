#!/usr/bin/env node
/**
 * How long does a stock change take to reach the storefront?
 * ==========================================================
 * ERR-263 / BF-064.
 *
 * A shopper saw a search card reading "Contact Us For Stock Enquiries" beside a
 * PDP for the SAME SKU reading "In Stock · Only 1 left". Neither surface was
 * broken and neither payload was wrong: `api.inkcartridges.co.nz` serves
 * `s-maxage=300, stale-while-revalidate=600`, so an admin stock write stays
 * invisible for 5 minutes guaranteed and up to 15 in the stale tail — and
 * `/api/products/:sku` and `/api/search/smart` are SEPARATE CACHE KEYS with
 * SEPARATE AGES, which is how one can be right while the other is wrong at the
 * same instant.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS PROBE
 * ------------------------------------------------
 * tests/stock-status-surface-agreement-sep2026.test.js proves the two surfaces
 * agree about a ROW. It cannot prove they are looking at the same row — that is
 * a property of the cache in front of us, not of our code, and no unit test can
 * reach it. If the backend ships the BF-064 purge, this probe is how we find
 * out; if the purge regresses, this is the only thing that would notice.
 *
 * 🚨 MEASURE THE HOST THE BROWSER CALLS. `ink-backend-zaeq.onrender.com` answers
 * `cf-cache-status: DYNAMIC` on EVERY request, so measuring the Render origin
 * makes the cache look absent and clears it of suspicion falsely. That cost an
 * hour. `js/config.js:19-21` points production at `api.inkcartridges.co.nz`, and
 * that is the only host worth asking. This probe refuses to use any other.
 *
 * ── READ-ONLY of the CATALOG — but NOT of search_analytics. ─────────────────
 * GETs only, and it never changes stock: YOU do that in the admin UI, then this
 * watches. There is no --write and no --record, deliberately — a probe that can
 * write is a probe that can be green because it just overwrote what it compared
 * against, and one in this repo has already written to a live order (ERR-257).
 *
 * But two of the four surfaces are `/api/search/*`, and every GET to those
 * writes a `search_analytics` row server-side (ERR-254). The term here is a REAL
 * SKU — prefixing it would measure a different query — so those rows land in the
 * live top-search-terms list looking like organic traffic. The banner says so on
 * every run. A probe is not more read-only for staying quiet about it.
 *
 *   npm run probe:stock-freshness -- --sku G273HYKCMY
 *   npm run probe:stock-freshness -- --sku G273HYKCMY --minutes 20
 */

import { SEARCH_ANALYTICS_NOTICE } from './lib/probe-search-notice.mjs';

const API = 'https://api.inkcartridges.co.nz';
const ORIGIN = 'https://www.inkcartridges.co.nz';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const SKU = argOf('--sku', '');
const MINUTES = Number(argOf('--minutes', '16'));
const EVERY_MS = 20000;

console.log('─'.repeat(78));
console.log('probe:stock-freshness — MODE: READ-ONLY of stock (GET only; it changes no catalog row)');
console.log(`host: ${API}   ← the host the browser calls; the Render origin says DYNAMIC forever`);
console.log(SEARCH_ANALYTICS_NOTICE);
console.log('─'.repeat(78));

if (!SKU) {
    console.error('\nNeed a SKU:  npm run probe:stock-freshness -- --sku G273HYKCMY\n');
    process.exit(2);
}

async function probe(path) {
    const started = Date.now();
    try {
        const res = await fetch(`${API}${path}`, { headers: { Origin: ORIGIN } });
        const body = await res.json().catch(() => null);
        return {
            ok: res.ok,
            status: res.status,
            cache: res.headers.get('cf-cache-status'),
            age: res.headers.get('age'),
            ms: Date.now() - started,
            body,
        };
    } catch (err) {
        return { ok: false, status: 0, cache: null, age: null, ms: Date.now() - started, error: String(err) };
    }
}

// Pull every row out of whatever envelope this endpoint happens to use.
function rowsOf(body) {
    if (!body) return [];
    if (Array.isArray(body)) return body;
    for (const key of ['data', 'results', 'products', 'items', 'suggestions']) {
        const v = body[key];
        if (Array.isArray(v)) return v;
        if (v && typeof v === 'object') return rowsOf(v);
    }
    return typeof body === 'object' ? [body] : [];
}

function stockOf(body, sku) {
    const row = rowsOf(body).find(r => r && String(r.sku || '').toUpperCase() === sku.toUpperCase());
    if (!row) return null;
    // Absent, null and 0 are THREE different answers — never collapse them.
    const has = (k) => Object.prototype.hasOwnProperty.call(row, k);
    return {
        in_stock: has('in_stock') ? row.in_stock : '<absent>',
        stock_quantity: has('stock_quantity') ? row.stock_quantity : '<absent>',
        stock_status: has('stock_status') ? row.stock_status : '<absent>',
    };
}

const SURFACES = [
    ['PDP    ', `/api/products/${encodeURIComponent(SKU)}`],
    ['smart  ', `/api/search/smart?q=${encodeURIComponent(SKU)}&limit=20`],
    ['literal', `/api/products?search=${encodeURIComponent(SKU)}&limit=20`],
    ['suggest', `/api/search/suggest?q=${encodeURIComponent(SKU)}&limit=20`],
];

console.log(`\nWatching ${SKU} for ${MINUTES} min, every ${EVERY_MS / 1000}s.`);
console.log('Change the stock in the admin Inventory tab NOW, then watch each surface flip.');
console.log('A surface that lags the others is the cache, not the code.\n');

const firstSeen = new Map();
const flippedAt = new Map();
const startedAt = Date.now();
const deadline = startedAt + MINUTES * 60 * 1000;

while (Date.now() < deadline) {
    const t = ((Date.now() - startedAt) / 1000).toFixed(0).padStart(4);
    const line = [];
    for (const [label, path] of SURFACES) {
        const r = await probe(path);
        const s = r.ok ? stockOf(r.body, SKU) : null;
        const shown = s
            ? `in_stock=${s.in_stock} qty=${s.stock_quantity} status=${s.stock_status}`
            : (r.ok ? 'SKU not in response' : `HTTP ${r.status}`);

        const key = JSON.stringify(s);
        if (!firstSeen.has(label)) firstSeen.set(label, key);
        else if (firstSeen.get(label) !== key && !flippedAt.has(label)) {
            flippedAt.set(label, (Date.now() - startedAt) / 1000);
        }

        line.push(`  ${label}  ${String(r.cache || '-').padEnd(11)} age=${String(r.age ?? '-').padEnd(4)} ${shown}`
            + (flippedAt.has(label) ? `   ← CHANGED at +${flippedAt.get(label).toFixed(0)}s` : ''));
    }
    console.log(`t+${t}s`);
    console.log(line.join('\n'));

    // Disagreement between surfaces is the whole point — call it out as it happens.
    const states = SURFACES.map(([l]) => firstSeen.get(l));
    if (flippedAt.size > 0 && flippedAt.size < SURFACES.length) {
        const behind = SURFACES.filter(([l]) => !flippedAt.has(l)).map(([l]) => l.trim());
        console.log(`  ⚠️  SURFACES DISAGREE — still serving the old answer: ${behind.join(', ')}`);
    }
    console.log('');

    if (flippedAt.size === SURFACES.length) {
        console.log('All surfaces have changed. Times to reflect the write:');
        for (const [label, secs] of flippedAt) console.log(`  ${label}  +${secs.toFixed(0)}s`);
        const spread = Math.max(...flippedAt.values()) - Math.min(...flippedAt.values());
        console.log(`\nSpread between fastest and slowest surface: ${spread.toFixed(0)}s`);
        console.log(spread > 30
            ? '⇒ A shopper CAN see one surface contradict another. BF-064 is not fixed.'
            : '⇒ Surfaces move together. If this used to be minutes, BF-064 has landed.');
        process.exit(0);
    }
    await new Promise(r => setTimeout(r, EVERY_MS));
}

console.log(`Window closed after ${MINUTES} min.`);
if (flippedAt.size === 0) {
    console.log('NOTHING CHANGED on any surface. Either no write happened, or it has not');
    console.log('reached the edge yet. This is NOT evidence that the cache is fine.');
} else {
    const behind = SURFACES.filter(([l]) => !flippedAt.has(l)).map(([l]) => l.trim());
    console.log(`Still stale when the window closed: ${behind.join(', ') || '(none)'}`);
}
process.exit(1);
