#!/usr/bin/env node
/**
 * probe-chip-counts.mjs
 * =====================
 * Does every "Select a Product Code" tile on /shop say the number of products
 * it opens? (ERR-337, owner 2026-10-15: Brother toner DR2415 said 5, opened 4.)
 *
 * For every brand × category it reads the tile list (/api/shop?brand&category),
 * then for every tile computes what the click shows, by the storefront's rules
 * (shop-page.js, ERR-358/361): `?code=X` over the OWN category, plus — toner ⇄
 * drums only — partner-type rows of the related category that share ≥1 printer
 * (`compatible_printer_slugs`, else the 2-printer sample). Three numbers:
 *
 *   backend  `series[].count` as the API ships it (pairs by CODE, BF-102)
 *   tile     what the storefront shows: the backend count outside toner/drums,
 *            else own walk rows carrying the code + their printer partners
 *   click    distinct rows the click shows
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
const PAIR = { toner: ['toner_cartridge', 'drum_unit'], drums: ['drum_unit', 'toner_cartridge'] }; // shop-page.js PRINTER_PAIR
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

// shop-page.js _printerPartners, verbatim rule.
const slugsOf = (p) => (Array.isArray(p.compatible_printer_slugs) ? p.compatible_printer_slugs
    : (Array.isArray(p.compatible_printers) ? p.compatible_printers : []).map(c => c && c.slug)).filter(Boolean);
let sampleFallbacks = 0;
function partners(category, ownRows, relatedRows) {
    const [own, partner] = PAIR[category];
    const slugs = new Set(ownRows.filter(p => p.product_type === own).flatMap(slugsOf));
    if (!slugs.size) return [];
    return relatedRows.filter(p => p.product_type === partner && slugsOf(p).some(s => slugs.has(s)));
}

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
    const series = (await shop({ brand, category })).series || [];
    let ownRows = null;
    let relatedRows = null;
    if (RELATED[category]) {
        ownRows = await walk(brand, category);
        relatedRows = await walk(brand, RELATED[category]);
        sampleFallbacks += [...ownRows, ...relatedRows].filter(p => !Array.isArray(p.compatible_printer_slugs)).length;
    }

    let bad = 0;
    let shown = 0;
    for (const chip of series) {
        let tile = chip.count;
        if (ownRows) {
            const own = ownRows.filter(p => carries(p, chip.code));
            tile = new Set([...own, ...partners(category, own, relatedRows)].map(p => p.id)).size;
            if (tile === 0) continue; // storefront drops it — opens nothing, shows nothing
        }
        shown++;
        const clickRows = (await shop({ brand, category, code: chip.code, limit: PAGE })).products;
        const ids = new Set(clickRows.map(p => p.id));
        if (relatedRows) for (const p of partners(category, clickRows, relatedRows)) ids.add(p.id);
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
    console.log(`# toner/drum rows WITHOUT compatible_printer_slugs (sample fallback, loud): ${sampleFallbacks}`);
    console.log(`# BACKEND-DRIFT (series count ≠ click; negative control — backend pairs by code until option (b)): ${drift.length}`);
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
