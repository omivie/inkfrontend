#!/usr/bin/env node
/**
 * probe-chip-counts.mjs
 * =====================
 * Does every "Select a Product Code" tile on /shop say the number of products
 * it opens, and is every toner/drum tile the page's OWN type?
 * (ERR-337 owner 2026-10-15: Brother toner DR2415 said 5, opened 4. ERR-379
 * 2026-11-19: DR tiles on the toner grid.)
 *
 * Since backend 5c8b73b (2026-11-20) the storefront shows the backend's numbers
 * as they are: tile = `series[].count`, click = `?code=` over the page's own
 * category (the backend pairs toners and drums by printer inside that listing).
 * Yield variants collapse exactly as the storefront collapses them (collapse()
 * below = SeriesCodes.collapseChipList): one tile, summed count, union click.
 * The FE recount walk was deleted (ERR-384), so THIS probe is now the only thing
 * that would notice the backend drifting again.
 *
 *   FAIL        tile ≠ click (the storefront lies)
 *   CROSS-TYPE  toner/drums only: a tile whose listing is ENTIRELY the other
 *               type (a drum code on the toner grid opens only drums, ERR-379)
 *
 * Brands = every brand `GET /api/brands` lists (27 on 2026-11-21), not a list
 * kept here that goes stale. A brand with no products in a category answers an
 * empty series and counts as 0 tiles.
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
const CATEGORIES = ['ink', 'toner', 'drums', 'label'];
// "Drums & Supplies" also holds waste boxes, belts and fuser units, so "no drum
// row" is normal there. A cross-type tile is one whose rows are ALL the other
// type: a drum code on the toner grid opens only drums (ERR-379).
const PARTNER_TYPE = { toner: 'drum_unit', drums: 'toner_cartridge' };
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

async function listing(brand, category, code) {
    const rows = [];
    for (let page = 1; ; page++) {
        const d = await shop({ brand, category, code, page, limit: PAGE });
        rows.push(...d.products);
        if (d.products.length < PAGE) return rows;
    }
}

const fails = [];
const crossType = [];
const summary = [];

// utils.js SeriesCodes.collapseChipList, verbatim rule: yield variants
// (604 / 604XL) become ONE tile whose count is the SUM of the backend counts and
// whose click fans out to every alias (union of rows, de-duplicated by id).
const norm = (c) => String(c ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
const base = (c) => norm(c).replace(/^([A-Z]*\d+)(X{1,3}L)$/, '$1');
function collapse(series) {
    const tiles = new Map();
    for (const chip of series) {
        const b = base(chip.code);
        if (!b) continue;
        if (!tiles.has(b)) tiles.set(b, { code: b, count: 0, aliases: [] });
        const t = tiles.get(b);
        if (!t.aliases.includes(norm(chip.code))) t.aliases.push(norm(chip.code));
        t.count += Number(chip.count) || 0;
    }
    return [...tiles.values()];
}

async function probe(brand, category) {
    const series = collapse((await shop({ brand, category })).series || []);
    let bad = 0;
    for (const chip of series) {
        const rows = [];
        for (const alias of chip.aliases) rows.push(...await listing(brand, category, alias));
        const click = new Set(rows.map(p => p.id)).size;
        const row = `${brand}\t${category}\t${chip.code}${chip.aliases.length > 1 ? `[${chip.aliases.join('+')}]` : ''}\ttile=${chip.count}\tclick=${click}`;
        if (chip.count !== click) { bad++; fails.push(row); console.log(`FAIL\t${row}`); }
        const partner = PARTNER_TYPE[category];
        if (partner && rows.length && rows.every(p => p.product_type === partner)) {
            bad++; crossType.push(row); console.log(`CROSS-TYPE\t${row}\t(every row is ${partner})`);
        }
    }
    summary.push(`${brand}/${category}: ${series.length} tiles, ${bad} wrong`);
    console.error(`  ${brand}/${category}: ${series.length} tiles, ${bad} wrong`);
}

function report() {
    console.log(`\n# ${summary.length} brand/category pairs measured, ${calls} GETs`);
    for (const s of summary) console.log(`#   ${s}`);
    console.log(`# CROSS-TYPE (toner/drums tile whose rows are all the other type): ${crossType.length}`);
    console.log(`# FAIL (tile ≠ click): ${fails.length}`);
}

const [onlyBrand, onlyCategory] = process.argv.slice(2);
let brands = onlyBrand ? [onlyBrand] : null;
if (!brands) {
    const res = await fetch(`${API}/api/brands`);
    const body = await res.json().catch(() => null);
    brands = Array.isArray(body?.data) ? body.data.map(b => b.slug).filter(Boolean) : [];
    if (!brands.length) { console.error('STOPPED: /api/brands gave no brands — nothing measured (not a pass).'); process.exit(2); }
    console.error(`  ${brands.length} brands from /api/brands`);
}
for (const brand of brands) {
    for (const category of onlyCategory ? [onlyCategory] : CATEGORIES) {
        await probe(brand, category);
    }
}
report();
process.exit(fails.length || crossType.length ? 1 : 0);
