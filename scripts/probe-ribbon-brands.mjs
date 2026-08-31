#!/usr/bin/env node
/**
 * probe-ribbon-brands.mjs — can a shopper actually see a brand's ribbons?  (ERR-193)
 * ==================================================================================
 *
 * On 2026-08-29 10:38 UTC the backend revoked `cost_price`, `profit_ex_gst` and
 * `margin_pct` from the `anon` role. That revoke was right and is staying. But
 * `get_ribbons_by_brand` — the RPC the ribbon brand pages call DIRECTLY with the
 * anon key — was `RETURNS SETOF products` over a `SELECT p.*` body, and under
 * PostgreSQL column privileges a star projection touching a revoked column fails
 * WHOLESALE:
 *
 *     SELECT p.*  →  42501 permission denied for table products  →  PostgREST 401
 *
 * All 63 ribbon brand pages rendered "No ribbons found … Check back soon!" for
 * about 44 hours. `GET /api/ribbons` was healthy the whole time, so no alert
 * fired and no error rate moved. It was found by someone looking at the page.
 *
 * WHAT THIS PROBE IS FOR. Reading route code would never have caught it — the
 * fault was in a database grant, one layer below anything the repo contains.
 * The only way to know the brand pages work is to ask them, as a signed-out
 * visitor, which is what this does.
 *
 * ── READ-ONLY, WITH NO WRITE PATH AT ALL ────────────────────────────────────
 * Every request is a GET or an RPC read. There is no --record, no baseline, no
 * fixture and no write verb of any kind, and the mode is printed on every run.
 * A probe that can record is a probe that can pass because it just overwrote
 * what it was comparing against — that is how `sweep:b2b` ate a committed
 * fixture on 2026-08-12. It needs no credentials: everything here is what a
 * signed-out shopper can see, which is exactly the population that was broken.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly.
 *
 * Usage:  npm run probe:ribbon-brands
 *         npm run probe:ribbon-brands -- --fast     (no inter-request pacing)
 * Exit:   0 = every check passed
 *         1 = a real finding
 *         2 = the probe could not run — deliberately NOT 1, because "we could
 *             not look" must never be reported as "we looked and it was fine".
 */

const ARGS = process.argv.slice(2);
const FAST = ARGS.includes('--fast');

const SUPABASE = process.env.SUPABASE_URL || 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';
const API_BASE = process.env.API_BASE || 'https://ink-backend-zaeq.onrender.com';

// Lower than the 650 ms the credentialed probes use: these are unauthenticated
// public catalogue reads with no rate limiter in front of them, and there are 63.
const DELAY_MS = FAST ? 0 : Number(process.env.PROBE_DELAY_MS || 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
const notes = [];
const ok = (name) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); };
const bad = (name, detail) => {
    failures.push(`${name} — ${detail}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
};
/** A measured fact worth reporting that is not itself a failure. */
const soft = (name, detail) => {
    notes.push(`${name} — ${detail}`);
    console.log(`  \x1b[33m~\x1b[0m ${name}\n      ${detail}`);
};
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

async function getJson(url, init) {
    const res = await fetch(url, init);
    let json = null;
    const text = await res.text();
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    if (DELAY_MS) await sleep(DELAY_MS);
    return { status: res.status, json, text };
}

const rpc = (slug) => getJson(`${SUPABASE}/rest/v1/rpc/get_ribbons_by_brand`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ brand_slug: slug }),
});

const sb = (path) => getJson(`${SUPABASE}/rest/v1/${path}`, { headers: { apikey: ANON, Accept: 'application/json' } });
const api = (path) => getJson(`${API_BASE}${path}`);

/**
 * Every field `createRibbonCard()` / `normalizeRibbon()` read off a row. Checked
 * by NAME against a live payload rather than trusted: the hand-off said it had
 * gone through the card "field by field", and a field silently dropped from the
 * projection renders as a blank price or a missing image, not as an error.
 */
const CARD_FIELDS = [
    'id', 'sku', 'name', 'color', 'product_type', 'source',
    'image_url', 'retail_price', 'stock_quantity', 'stock_status',
];

/** Withheld on purpose. Their return is a security regression, not a convenience. */
const MUST_NOT_LEAK = [
    'cost_price', 'profit_ex_gst', 'margin_pct',
    'compatible_devices_html',   // service-role only; must never ride a bulk list
    'color_hex',                 // this path bypasses the genuine-row sanitiser
];

/** Zero ribbons mapped in product_ribbon_brands — correctly empty, not a bug. */
const KNOWN_EMPTY = [
    '3m', 'adler', 'calcomp', 'digital-equipment', 'hp',
    'philips', 'printronix', 'tally-gemicin', 'texas-instuments', 'unisys',
];

async function main() {
    console.log('\n\x1b[1mRibbon brand pages — live contract probe (ERR-193)\x1b[0m');
    console.log('\x1b[36mMODE: READ-ONLY\x1b[0m — every request is a read; this probe writes nothing, anywhere.');
    console.log('\x1b[2mSigned out, exactly like the visitors the outage hit.\x1b[0m\n');

    // ── 1. The taxonomy the page is built on ────────────────────────────────
    console.log('\x1b[1m1. ribbon_brands — the curated taxonomy\x1b[0m');
    const brandsRes = await sb('ribbon_brands?is_active=eq.true&order=sort_order.asc&select=id,name,slug');
    if (brandsRes.status !== 200 || !Array.isArray(brandsRes.json)) {
        bad('GET ribbon_brands', `HTTP ${brandsRes.status} — ${brandsRes.text.slice(0, 200)}`);
        return report();   // nothing below can run without the brand list
    }
    const brands = brandsRes.json;
    ok(`${brands.length} active ribbon brands readable with the anon key`);

    // ── 2. Can a signed-out visitor see each brand's ribbons? ───────────────
    console.log('\n\x1b[1m2. get_ribbons_by_brand — every brand, as an anonymous visitor\x1b[0m');
    const rows = new Map();          // slug -> rows
    const errored = [];
    for (const b of brands) {
        const res = await rpc(b.slug);
        if (res.status !== 200 || !Array.isArray(res.json)) {
            errored.push(`${b.slug} (HTTP ${res.status}${res.json?.code ? ' ' + res.json.code : ''})`);
            continue;
        }
        rows.set(b.slug, res.json);
    }
    check(errored.length === 0, `all ${brands.length} brands answered 200`,
        `these did not: ${errored.join(', ')}. THIS IS THE ERR-193 OUTAGE — the pages render `
        + `"No ribbons found … Check back soon!" and nothing else will say so.`);
    if (errored.length) return report();

    const populated = [...rows.entries()].filter(([, r]) => r.length > 0);
    const empty = [...rows.entries()].filter(([, r]) => r.length === 0).map(([s]) => s).sort();
    const totalRows = [...rows.values()].reduce((n, r) => n + r.length, 0);
    ok(`${populated.length} brands return rows, ${totalRows} rows in total`);

    // An outage looks EXACTLY like a catalogue gap from here, so the empty set is
    // pinned by name. A brand moving into this list is a merchandising change; a
    // brand appearing in it unexpectedly is the outage coming back for one slug.
    const unexpectedEmpty = empty.filter((s) => !KNOWN_EMPTY.includes(s));
    const nowPopulated = KNOWN_EMPTY.filter((s) => rows.has(s) && rows.get(s).length > 0);
    check(unexpectedEmpty.length === 0, `the empty brands are the ${KNOWN_EMPTY.length} known-empty ones`,
        `newly empty: ${unexpectedEmpty.join(', ')} — either ribbons were unmapped, or this brand is 401ing`);
    if (nowPopulated.length) {
        soft('a known-empty brand now has ribbons',
            `${nowPopulated.join(', ')} — good news; update KNOWN_EMPTY here and in errors.md ERR-193`);
    }

    // ── 3. The projection: what the RPC may and may not return ──────────────
    console.log('\n\x1b[1m3. Column safety — the projection that caused the outage\x1b[0m');
    const sample = populated[0][1][0];
    const keys = Object.keys(sample);
    const leaked = MUST_NOT_LEAK.filter((c) => keys.includes(c));
    check(leaked.length === 0, `none of the ${MUST_NOT_LEAK.length} withheld columns are in the payload`,
        `LEAKED: ${leaked.join(', ')} — cost/margin or service-role-only data is reaching the browser`);

    const missing = CARD_FIELDS.filter((f) => !keys.includes(f));
    check(missing.length === 0, `all ${CARD_FIELDS.length} fields the ribbon card reads are present`,
        `missing: ${missing.join(', ')} — these render as blanks on the card, never as an error`);
    console.log(`  \x1b[2m${keys.length} columns: ${keys.join(', ')}\x1b[0m`);

    // The revoke is the precondition for the whole incident. If it were rolled
    // back, the RPC would pass this probe while being untested against the thing
    // that breaks it — so its absence is itself worth reporting.
    const star = await sb('products?select=*&limit=1');
    if (star.status === 200) {
        soft('the anon star projection on products SUCCEEDS again',
            'cost_price/profit_ex_gst/margin_pct appear to be readable to anon once more. That is an '
            + 'ERR-170 security regression in its own right, AND it means this RPC is no longer being '
            + 'exercised against the condition that broke it.');
    } else {
        ok(`the cost columns are still revoked from anon (products?select=* → HTTP ${star.status})`);
    }

    // ── 4. FE-2 — is the volume ladder reachable for these SKUs? ────────────
    console.log('\n\x1b[1m4. Volume ladder coverage (FE-2)\x1b[0m');
    const all = await api('/api/ribbons?limit=200');
    const apiRows = all.json?.data?.ribbons;
    if (all.status !== 200 || !Array.isArray(apiRows)) {
        bad('GET /api/ribbons?limit=200', `HTTP ${all.status} — brand pages lose their ladder AND their brand names`);
    } else {
        const total = Number(all.json?.meta?.total);
        check(!(Number.isFinite(total) && total > apiRows.length),
            `the whole ribbon universe fits one request (${apiRows.length} rows)`,
            `${apiRows.length} of ${total} fetched — limit is capped at 200, so ladders are now missing for the tail`);

        const ladder = new Map(apiRows.map((r) => [r.sku, r]));
        const brandSkus = new Set();
        for (const rs of rows.values()) rs.forEach((r) => brandSkus.add(r.sku));
        const covered = [...brandSkus].filter((s) => Array.isArray(ladder.get(s)?.quantity_breaks));
        check(covered.length === brandSkus.size,
            `every brand-page SKU has a ladder (${covered.length}/${brandSkus.size})`,
            `${brandSkus.size - covered.length} of ${brandSkus.size} brand-page SKUs have no ladder available: `
            + `${[...brandSkus].filter((s) => !covered.includes(s)).slice(0, 8).join(', ')}. Those cards show retail only.`);

        const named = [...brandSkus].filter((s) => typeof ladder.get(s)?.brand === 'string' && ladder.get(s).brand);
        check(named.length === brandSkus.size,
            `every brand-page SKU resolves a brand NAME (${named.length}/${brandSkus.size})`,
            `${brandSkus.size - named.length} rows would keep data-product-brand="" on the favourites button`);

        // The hydration deliberately copies NOTHING but the ladder and the name.
        // This is the check that says whether that restraint is still warranted.
        const priceGaps = [];
        const stockGaps = [];
        for (const s of brandSkus) {
            const a = ladder.get(s);
            if (!a) continue;
            const r = [...rows.values()].flat().find((x) => x.sku === s);
            const rp = Number(r.retail_price);
            const ap = Number(a.sale_price != null ? a.sale_price : a.retail_price);
            if (Number.isFinite(rp) && Number.isFinite(ap) && Math.abs(rp - ap) > 0.005) priceGaps.push(`${s} ${rp}≠${ap}`);
            if (Number(r.stock_quantity) !== Number(a.stock_quantity)) stockGaps.push(s);
        }
        check(priceGaps.length === 0, 'the RPC and the API agree on price for every shared SKU',
            `DISAGREE: ${priceGaps.slice(0, 6).join(', ')} — the same ribbon is priced differently depending on `
            + `how the shopper arrived. The ladder is computed off the API's number; the card prints the RPC's.`);
        if (stockGaps.length) {
            soft('the two payloads disagree on stock for some SKUs',
                `${stockGaps.length} SKUs (${stockGaps.slice(0, 6).join(', ')}) — the card uses the RPC's, by design`);
        } else ok('the RPC and the API agree on stock for every shared SKU');
    }

    // ── 5. Decoy params — guarded in BOTH directions ───────────────────────
    console.log('\n\x1b[1m5. /api/ribbons query params — which ones actually filter\x1b[0m');
    const baseline = Number((await api('/api/ribbons?limit=1')).json?.meta?.total);
    if (!Number.isFinite(baseline)) {
        bad('baseline /api/ribbons total', 'could not read meta.total — the param checks below cannot be judged');
    } else {
        console.log(`  \x1b[2munfiltered total = ${baseline}\x1b[0m`);

        // These three answer 200 with the FULL unfiltered set. Nothing may call
        // them. Reported just as loudly if they START working, because that is the
        // day the frontend can be simplified — and the day a stale assumption in
        // this repo silently becomes wrong (ERR-151/173/190).
        for (const [q, why] of [
            ['ribbon_brand=brother', 'FE-4: the endpoint that would let brand pages leave the direct RPC'],
            ['type=typewriter_ribbon', 'documented in api.js getRibbons() for months'],
            ['search=ribbon', 'documented in api.js getRibbons() for months'],
        ]) {
            const t = Number((await api(`/api/ribbons?limit=1&${q}`)).json?.meta?.total);
            if (t === baseline) {
                ok(`?${q} is still IGNORED (${t} = unfiltered) — nothing calls it, correctly`);
            } else {
                soft(`?${q} NOW FILTERS (${t} of ${baseline})`,
                    `${why}. This is a capability the frontend does not yet use — see `
                    + `ribbon-brand-pages-FE-response-aug2026.md before wiring it up, and re-measure first.`);
            }
        }

        // And the ones the page DOES rely on. A decoy check is only half the job:
        // a param that silently stops filtering looks identical to one that never did.
        for (const [q, label] of [
            ['color=Black', 'color='],
            ['brand=Epson', 'brand='],
            ['printer_brand=brother', 'printer_brand='],
        ]) {
            const t = Number((await api(`/api/ribbons?limit=1&${q}`)).json?.meta?.total);
            check(Number.isFinite(t) && t > 0 && t < baseline, `?${label} still narrows the set (${t} of ${baseline})`,
                `?${q} returned ${t} against an unfiltered ${baseline} — it has stopped filtering, or matches nothing`);
        }

        const over = await api('/api/ribbons?limit=201');
        check(over.status === 400, 'limit=201 is a hard 400, not a silent clamp',
            `HTTP ${over.status} — if this now clamps silently, getRibbonLadders() may be fetching fewer rows than it thinks`);
    }

    // ── 6. The two answers to "which ribbons are Brother's" ────────────────
    console.log('\n\x1b[1m6. Taxonomy divergence — RPC vs the API route\x1b[0m');
    const sampleSlug = populated[0][0];
    const viaApi = await api(`/api/ribbons?limit=200&printer_brand=${encodeURIComponent(sampleSlug)}`);
    const apiCount = Number(viaApi.json?.meta?.total);
    const rpcCount = rows.get(sampleSlug).length;
    if (Number.isFinite(apiCount) && apiCount !== rpcCount) {
        soft(`"${sampleSlug}" has two different answers`,
            `RPC (curated ribbon_brands) = ${rpcCount}, API ?printer_brand= (printer-model brand) = ${apiCount}. `
            + `These are different questions, so FE-4 is NOT a one-line swap — the API route would drop rows.`);
    } else {
        ok(`"${sampleSlug}" agrees across both routes (${rpcCount})`);
    }

    // ── 7. Can the first-party tracker carry a failure event yet? ──────────
    console.log('\n\x1b[1m7. Failure telemetry — /api/analytics/traffic-event\x1b[0m');
    //
    // THIS DOES NOT WRITE, AND CANNOT. The body below omits `session_id`,
    // `visitor_id` and `path`, all of which are required, so the request is
    // rejected whatever the enum says — there is no value of `event_type` that
    // makes it persist. The validator runs with abortEarly off and reports every
    // offending field at once, so the presence or absence of an `event_type`
    // complaint is a clean read of the enum through a request that can never
    // become a row. That is the only reason this belongs in a read-only probe.
    const enumProbe = await getJson(`${API_BASE}/api/analytics/traffic-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: 'catalogue_load_failed' }),
    });
    const details = enumProbe.json?.error?.details;
    const typeComplaint = Array.isArray(details) && details.find((d) => d.field === 'event_type');
    if (enumProbe.status !== 400 || !Array.isArray(details)) {
        soft('could not read the traffic-event validator',
            `HTTP ${enumProbe.status} — ${enumProbe.text.slice(0, 160)}. The telemetry gap below is unverified either way.`);
    } else if (typeComplaint) {
        ok(`event_type is still ${(typeComplaint.message.match(/\[.*\]/) || ['[?]'])[0]} — a failure event cannot be recorded first-party`);
        console.log('  \x1b[2mribbons-page.js reportLoadFailure() sends GA only, on purpose. BF-053.\x1b[0m');
    } else {
        soft('event_type NOW ACCEPTS catalogue_load_failed',
            'BF-053 has shipped. Add the TrafficTracker.send back to reportLoadFailure() in '
            + 'js/ribbons-page.js — a catalogue outage can finally be seen in our own data, '
            + 'instead of only in GA.');
    }

    report();
}

function report() {
    console.log('');
    if (notes.length) console.log(`\x1b[33m${notes.length} note(s)\x1b[0m — measured facts, not failures.`);
    if (!failures.length) {
        console.log(`\x1b[32m${pass} check(s) passed.\x1b[0m A signed-out visitor can see every brand's ribbons.\n`);
        process.exit(0);
    }
    console.log(`\x1b[31m${failures.length} check(s) FAILED\x1b[0m (of ${failures.length + pass}):`);
    failures.forEach((f) => console.log(`  • ${f}`));
    console.log('');
    process.exit(1);
}

main().catch((e) => {
    console.error(`\n\x1b[31mCANNOT RUN\x1b[0m — ${e.message}\nNothing was verified. Do NOT read this as a pass.\n`);
    process.exit(2);
});
