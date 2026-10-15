#!/usr/bin/env node
/**
 * probe-chip-counts.mjs
 * =====================
 * Does every "Select a Product Code" tile on /shop say the number of products
 * it opens? (ERR-337, owner 2026-10-15: Brother toner DR2415 said 5, opened 4.)
 *
 * For every brand × category it reads the tile list (/api/shop?brand&category),
 * then for every tile fetches what the click fetches — /api/shop?code=X over
 * each category the tile spans (toner ⇄ drums, same RELATED_CATEGORY rule as
 * shop-page.js) — and compares three numbers:
 *
 *   backend  `series[].count` as the API ships it
 *   tile     what the storefront now shows: the backend count for categories
 *            outside RELATED_CATEGORY, the listing-row recount inside it
 *   click    distinct rows the click shows (a related-category row only when
 *            its series_codes carry the code — same filter as shop-page.js)
 *
 * FAIL = tile ≠ click (the storefront lies). BACKEND-DRIFT = backend ≠ click
 * (reported separately — the negative control; expected non-zero for toner/drums
 * until the backend ask in backend-docs/outbox ships).
 *
 * READ-ONLY. GET only, no credentials, no fixture written.
 * PACED (PROBE_PACE_MS, default 700ms) because the origin limiter is shared per
 * IP with the owner's browser. A RATE_LIMITED answer STOPS the probe and exits 2:
 * an unmeasured tile is a skip, and a skip is not a pass.
 *
 *   npm run probe:chip-counts                       # every brand × category
 *   npm run probe:chip-counts -- brother toner      # one pair
 */
const API = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const PACE = Number(process.env.PROBE_PACE_MS || 700);
const BRANDS = ['brother', 'canon', 'epson', 'hp', 'samsung', 'lexmark', 'oki', 'fuji-xerox', 'kyocera'];
const CATEGORIES = ['ink', 'toner', 'drums', 'label'];
const RELATED = { toner: 'drums', drums: 'toner' }; // apiCategory form of shop-page.js RELATED_CATEGORY
const PAGE = 200;

console.error(`probe:chip-counts — READ-ONLY (GET only) against ${API}, paced ${PACE}ms`);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let calls = 0;
async function shop(params) {
    await sleep(PACE);
    calls++;
    let res;
    for (let attempt = 1; ; attempt++) {
        try { res = await fetch(`${API}/api/shop?${new URLSearchParams(params)}`); break; }
        catch (err) { if (attempt === 3) throw err; await sleep(5000); } // network blip (ETIMEDOUT), not data
    }
    const body = await res.json().catch(() => null);
    if (body?.error?.code === 'RATE_LIMITED') {
        console.error(`\nSTOPPED: RATE_LIMITED after ${calls} calls — results below are INCOMPLETE (not a pass).`);
        report();
        process.exit(2);
    }
    if (!body || body.ok !== true) throw new Error(`${res.status} ${JSON.stringify(params)}`);
    return body.data;
}

const norm = (c) => String(c ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
const base = (c) => norm(c).replace(/^([A-Z]*\d+)(X{1,3}L)$/, '$1');
const halves = (c) => (norm(c).includes('/') ? norm(c).split('/').filter(Boolean) : []);
const carries = (p, code) => {
    const have = new Set((p.series_codes || []).map(base).filter(Boolean));
    return [code, ...halves(code)].some(c => have.has(base(c)));
};

async function walk(brand, category) {
    const rows = [];
    for (let page = 1; ; page++) {
        const d = await shop({ brand, category, page, limit: PAGE });
        rows.push(...d.products);
        if (d.products.length < PAGE) return rows;
    }
}

const fails = [];
const drift = [];
const summary = [];

async function probe(brand, category) {
    const spans = [category, RELATED[category]].filter(Boolean);
    const series = (await shop({ brand, category })).series || [];

    let rowsByCode = null;
    if (RELATED[category]) {
        rowsByCode = new Map();
        const seen = new Set();
        for (const c of spans) {
            for (const p of await walk(brand, c)) {
                if (seen.has(p.id)) continue;
                seen.add(p.id);
                for (const code of new Set((p.series_codes || []).map(base).filter(Boolean))) {
                    if (!rowsByCode.has(code)) rowsByCode.set(code, new Set());
                    rowsByCode.get(code).add(p.id);
                }
            }
        }
    }

    let bad = 0;
    let shown = 0;
    for (const chip of series) {
        let tile = chip.count;
        if (rowsByCode) {
            const ids = new Set();
            for (const c of [chip.code, ...halves(chip.code)]) for (const id of rowsByCode.get(base(c)) || []) ids.add(id);
            tile = ids.size;
            if (tile === 0) continue; // storefront drops it — opens nothing, shows nothing
        }
        shown++;
        const ids = new Set();
        for (const c of spans) {
            for (const p of (await shop({ brand, category: c, code: chip.code, limit: PAGE })).products) {
                // Same as shop-page.js loadProducts: a related-category row joins only if it carries the code.
                if (c !== category && !carries(p, chip.code)) continue;
                ids.add(p.id);
            }
        }
        const click = ids.size;
        const row = `${brand}\t${category}\t${chip.code}\tbackend=${chip.count}\ttile=${tile}\tclick=${click}`;
        if (tile !== click) { bad++; fails.push(row); console.log(`FAIL\t${row}`); }
        if (chip.count !== click) drift.push(row);
    }
    summary.push(`${brand}/${category}: ${shown} tiles, ${bad} wrong`);
    console.error(`  ${brand}/${category}: ${shown} tiles, ${bad} wrong`);
}

function report() {
    console.log(`\n# ${summary.length} brand/category pairs measured, ${calls} GETs`);
    for (const s of summary) console.log(`#   ${s}`);
    console.log(`# BACKEND-DRIFT (series count ≠ click; negative control): ${drift.length}`);
    for (const d of drift) console.log(`#   ${d}`);
    console.log(`# FAIL (tile ≠ click): ${fails.length}`);
}

const [onlyBrand, onlyCategory] = process.argv.slice(2);
for (const brand of onlyBrand ? [onlyBrand] : BRANDS) {
    for (const category of onlyCategory ? [onlyCategory] : CATEGORIES) {
        await probe(brand, category);
    }
}
report();
process.exit(fails.length ? 1 : 0);
