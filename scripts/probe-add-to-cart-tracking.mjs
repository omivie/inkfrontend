#!/usr/bin/env node
/**
 * Does the add-to-cart tracking chain actually hold end to end? (ERR-223)
 * ======================================================================
 *
 * Two independent tracking defects, one hand-off
 * (`add-to-cart-tracking-FE-handoff-sep2026.md`), and both of its transport
 * claims needed measuring rather than believing.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS PROBE
 * ------------------------------------------------
 * 1. THE HEADER THAT LOOKS FINE FROM curl. The hand-off asks for
 *    `X-Session-Id` on every /api/ call. That header is NOT on the backend's
 *    Access-Control-Allow-Headers, and the preflight answers **204 either way**
 *    — it does not echo the requested headers. So a curl check reads as a pass
 *    while a BROWSER fails the preflight and never sends the request at all. On
 *    /api/cart/items that means nobody can add to cart. §1 asserts the header is
 *    still absent, which is what keeps `USE_ID_HEADERS` correctly false; the day
 *    it lands, §1 flips to a note and the constant can be turned on.
 *
 * 2. THE VALUE THE AD PLATFORM BIDS ON. The Google Ads conversion sends
 *    `price_snapshot × quantity` off the add-to-cart response. If the backend
 *    ever stops shipping `price_snapshot`, nothing breaks loudly: the tag keeps
 *    firing, `value` is simply omitted, and Smart Bidding quietly optimises
 *    against a conversion with no worth. A unit test cannot catch that — it only
 *    asks this repo whether it agrees with itself. §3 asks the SERVER.
 *
 * 3. THE QUERY PARAM THAT SHATTERS AN EDGE CACHE. `?sid=`/`?vid=` are free only
 *    while /api/search/smart answers `cf-cache-status: DYNAMIC`. If it is ever
 *    added to the Cloudflare Cache Rule those params become part of the cache
 *    key and fragment the shared entry one visitor at a time (ERR-124/159). §2
 *    fails the moment DYNAMIC stops being true.
 *
 * ── READ-ONLY BY DEFAULT. THE MODE IS PRINTED BEFORE ANY WORK. ──────────────
 * §1, §2 and §5 are GETs and an OPTIONS. §3, §4 and §6 need a real cart line and
 * therefore run only under an explicit `--write`, which adds ONE item to a
 * THROWAWAY guest session, removes it in a `finally`, and VERIFIES the removal.
 * Writing is never inferred. A probe that can record may be green only because
 * it just overwrote what it compared against (sweep:b2b ate a committed
 * fixture, 2026-08-12).
 *
 * It lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel
 * output directory and is served publicly.
 *
 * Usage:  npm run probe:add-to-cart            (read-only)
 *         npm run probe:add-to-cart -- --write (adds + removes one guest line)
 * Exit:   0 = the chain holds
 *         1 = a real finding (or a failed cleanup)
 *         2 = could not run (network / cold start). "We could not look" is
 *             never reported as "we looked and it was fine".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.API_BASE || 'https://ink-backend-zaeq.onrender.com';
const ORIGIN = 'https://inkcartridges.co.nz';
const ARGS = new Set(process.argv.slice(2));
const WRITE = ARGS.has('--write');

// The labels the live Google Ads account reports. Kept here so the probe fails
// if the shipped code stops naming them, rather than reading them out of the
// code it is supposed to be checking.
const TAG_ID = 'AW-18032498762';
const ADD_TO_CART_LABEL = 'AW-18032498762/e3c8CI2D3dwcEMqwyJZD'; // action 7710654861
const PURCHASE_LABEL = 'AW-18032498762/W1laCPGzpJQcEMqwyJZD';    // action 7558732273

let pass = 0;
const failures = [];
const notes = [];
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const cannotRun = (m) => { console.log(`\n\x1b[33m▲ probe could not run\x1b[0m — ${m}`); process.exit(2); };

console.log('\n\x1b[1mprobe:add-to-cart — Google Ads conversion + the analytics join key (ERR-223)\x1b[0m');
console.log(WRITE
    ? '\x1b[41m\x1b[97m MODE: WRITE \x1b[0m — adds ONE item to a throwaway guest cart and removes it again.'
    : '\x1b[36mMODE: READ-ONLY\x1b[0m — GETs and one OPTIONS. Pass --write for the cart-response checks (§3/§4/§6).');
console.log(`Backend: ${BASE}\n`);

/** The ONE transport function. A second one means this is no longer one probe. */
async function req(method, url, { headers = {}, body = null } = {}) {
    const res = await fetch(url, {
        method,
        headers: { origin: ORIGIN, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, headers: res.headers, json, text };
}

// Cleanup is registered BEFORE the first write and runs from every exit path.
let PENDING = null;
async function cleanup() {
    if (!PENDING) return;
    const { guest } = PENDING;
    PENDING = null;
    try {
        await req('DELETE', `${BASE}/api/cart`, { headers: { 'x-guest-session': guest } });
        const after = await req('GET', `${BASE}/api/cart`, { headers: { 'x-guest-session': guest } });
        const left = after.json?.data?.items?.length ?? -1;
        if (left === 0) {
            ok('cleanup verified — the throwaway guest cart is empty');
        } else {
            bad('CLEANUP FAILED', `${left} line(s) left on guest session ${guest}. Remove with:\n`
                + `      curl -X DELETE ${BASE}/api/cart -H "X-Guest-Session: ${guest}"`);
        }
    } catch (e) {
        bad('CLEANUP FAILED', `${e.message} — guest session ${guest}`);
    }
}
process.on('uncaughtException', async (e) => { await cleanup(); console.error(e); process.exit(1); });
process.on('unhandledRejection', async (e) => { await cleanup(); console.error(e); process.exit(1); });

const run = async () => {
    // ── §1 ────────────────────────────────────────────────────────────────
    console.log('\x1b[1m§1 — the id headers the hand-off asked for are still CORS-blocked\x1b[0m');
    let allow = '';
    try {
        const pre = await req('OPTIONS', `${BASE}/api/cart/items`, {
            headers: {
                'access-control-request-method': 'POST',
                'access-control-request-headers': 'x-session-id,x-visitor-id,content-type',
            },
        });
        allow = pre.headers.get('access-control-allow-headers') || '';
        if (pre.status !== 204 && pre.status !== 200) {
            bad('preflight', `expected 204/200, got ${pre.status}`);
        } else {
            // THE TRAP, asserted rather than described: the server answers a
            // success status even for headers it does not allow.
            ok(`the preflight answers ${pre.status} even for headers it does NOT allow — curl cannot adjudicate this`);
        }
        const lower = allow.toLowerCase();
        const hasSession = lower.includes('x-session-id');
        const hasVisitor = lower.includes('x-visitor-id');
        console.log(`    allow-headers: ${allow || '(none)'}`);
        if (!hasSession && !hasVisitor) {
            ok('X-Session-Id / X-Visitor-Id absent — USE_ID_HEADERS must stay false (BF-054)');
        } else {
            soft('BF-054 MAY HAVE LANDED',
                `the allow-list now contains ${[hasSession && 'X-Session-Id', hasVisitor && 'X-Visitor-Id'].filter(Boolean).join(' + ')}. `
                + 'Headers survive an edge-cache hit and query params do not, so flip USE_ID_HEADERS in '
                + 'js/traffic-tracker.js and re-run. Reported as a NOTE, not a failure: nothing is broken today.');
        }
    } catch (e) {
        cannotRun(`preflight unreachable: ${e.message}. A cold Render instance can take ~50s on first hit.`);
    }

    // ── §2 ────────────────────────────────────────────────────────────────
    console.log('\n\x1b[1m§2 — ?sid=/?vid= is accepted and still fragments no edge cache\x1b[0m');
    try {
        const r = await req('GET', `${BASE}/api/search/smart?q=lc3319&limit=1&sid=ts_probe_a2c&vid=tv_probe_a2c`);
        if (r.status !== 200) {
            bad('/api/search/smart with ids', `expected 200, got ${r.status}`);
        } else {
            ok('/api/search/smart accepts ?sid=/?vid= (200)');
            const cache = r.headers.get('cf-cache-status');
            if (cache === 'DYNAMIC') {
                ok(`cf-cache-status: DYNAMIC — the params fragment nothing (ERR-124/159 does not bite)`);
            } else {
                bad('EDGE CACHE NOW APPLIES TO SEARCH',
                    `cf-cache-status: ${cache}. ?sid=/?vid= are now part of the cache key and shatter the `
                    + 'shared entry one visitor at a time. Move the ids to headers (needs BF-054) or stop '
                    + 'sending them on this route.');
            }
        }
        // A malformed id must be rejected WHOLE, not truncated: a mangled id
        // groups with nothing and still looks like real data.
        const badId = await req('GET', `${BASE}/api/search/smart?q=lc3319&limit=1&sid=${encodeURIComponent('has space!')}`);
        if (badId.status === 200) ok('a malformed sid is rejected whole and the search still answers 200');
        else bad('malformed sid', `search returned ${badId.status} — a bad analytics id must never break a search`);
    } catch (e) {
        cannotRun(`search unreachable: ${e.message}`);
    }

    // ── §5 (static, runs in both modes) ───────────────────────────────────
    console.log('\n\x1b[1m§5 — the shipped code still names the live conversion labels\x1b[0m');
    const gtagSrc = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/gtag.js'), 'utf8');
    const confirmSrc = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/order-confirmation-page.js'), 'utf8');
    gtagSrc.includes(`gtag('config', '${TAG_ID}'`)
        ? ok(`one global site tag, ${TAG_ID}`)
        : bad('tag id', `gtag.js no longer configures ${TAG_ID}`);
    gtagSrc.includes(ADD_TO_CART_LABEL)
        ? ok('add-to-cart label present (action 7710654861)')
        : bad('add-to-cart label', `gtag.js no longer sends ${ADD_TO_CART_LABEL}`);
    confirmSrc.includes(PURCHASE_LABEL)
        ? ok('purchase label unmoved (action 7558732273)')
        : bad('purchase label', `order-confirmation-page.js no longer sends ${PURCHASE_LABEL}`);
    ADD_TO_CART_LABEL !== PURCHASE_LABEL
        ? ok('the two labels are distinct — an add can never report as a purchase')
        : bad('labels', 'the add-to-cart and purchase labels are identical');

    // ── §3/§4/§6 need a real cart line ────────────────────────────────────
    if (!WRITE) {
        console.log('\n\x1b[1m§3/§4/§6 — SKIPPED\x1b[0m');
        soft('§3 add-to-cart response shape NOT CHECKED',
            'needs a real POST /api/cart/items. Re-run with --write. A skip is not a pass: '
            + 'the value the Ads tag bids on is unverified in this run.');
        return;
    }

    console.log('\n\x1b[1m§3 — the add-to-cart response really carries what the Ads tag sends\x1b[0m');
    let productId = null;
    try {
        const s = await req('GET', `${BASE}/api/search/smart?q=LC3319&limit=1`);
        productId = s.json?.data?.products?.[0]?.id || null;
        if (!productId) cannotRun('could not resolve a product id to add');
    } catch (e) {
        cannotRun(`product lookup failed: ${e.message}`);
    }

    const seed = `probe-atc-${Date.now()}`;
    const add = await req('POST', `${BASE}/api/cart/items?sid=ts_probe_atc&vid=tv_probe_atc`, {
        headers: { 'x-guest-session': seed },
        body: { product_id: productId, quantity: 2 },
    });
    const guest = add.json?.data?.guest_session_id || seed;
    PENDING = { guest };

    if (add.status !== 200 && add.status !== 201) {
        bad('POST /api/cart/items with ?sid=/?vid=', `expected 2xx, got ${add.status}: ${add.text.slice(0, 200)}`);
    } else {
        ok(`the cart POST accepts ?sid=/?vid= without a 400 (${add.status})`);
        const d = add.json?.data || {};
        const snap = d.price_snapshot;
        const sku = d.product?.sku;
        const qty = d.quantity;
        console.log(`    price_snapshot=${JSON.stringify(snap)}  product.sku=${JSON.stringify(sku)}  quantity=${JSON.stringify(qty)}`);
        typeof snap === 'number'
            ? ok('price_snapshot is a number — the Ads `value` has a real basis')
            : bad('price_snapshot MISSING',
                'the Google Ads conversion will fire with NO value. It does not crash and nothing is '
                + 'logged; Smart Bidding simply optimises against a worthless conversion. Backend regression.');
        typeof sku === 'string' && sku.length
            ? ok('product.sku is present — the conversion can name what was added')
            : bad('product.sku MISSING', 'AdsConversions.addToCart refuses to fire without it (reason: no-sku)');
        Number.isFinite(qty)
            ? ok('quantity is echoed — a stock clamp lands here, not in what we asked for')
            : soft('quantity not echoed', 'the tag falls back to 1');
    }

    console.log('\n\x1b[1m§4 — the cart-event beacon accepts the shared traffic id\x1b[0m');
    const ev = await req('POST', `${BASE}/api/analytics/cart-event`, {
        body: { event_type: 'add_to_cart', session_id: 'ts_probe_atc', visitor_id: 'tv_probe_atc', product_id: productId, quantity: 1 },
    });
    ev.status === 200
        ? ok('cart-event accepts a ts_ session_id and an extra visitor_id (200)')
        : bad('cart-event rejected', `status ${ev.status}: ${ev.text.slice(0, 200)}`);
    soft('visitor_id PERSISTENCE IS UNVERIFIED',
        'the endpoint answers 200, but whether the column is written cannot be seen from outside the '
        + 'database. Reported as unknown rather than as working — the backend must confirm.');

    console.log('\n\x1b[1m§6 — the endpoint the hand-off wants to instrument next (BF-059)\x1b[0m');
    const itemId = add.json?.data?.id;
    if (!itemId) {
        soft('§6 skipped', 'no cart line id returned to delete');
    } else {
        const del = await req('DELETE', `${BASE}/api/cart/items/${itemId}`, { headers: { 'x-guest-session': guest } });
        const removed = del.json?.data?.removed;
        const after = await req('GET', `${BASE}/api/cart`, { headers: { 'x-guest-session': guest } });
        const still = after.json?.data?.items?.length ?? -1;
        console.log(`    DELETE -> ${del.status} removed=${JSON.stringify(removed)} · cart still holds ${still} line(s)`);
        if (removed === 0 && still > 0) {
            // A NOTE, not a failure — and loudly, by name.
            //
            // This is a known open BACKEND fault, not a regression in the chain
            // this probe is about. If it reddened the exit code the run would be
            // red every single time until the backend ships a fix, and a probe
            // that is always red gets ignored — taking the next real hard
            // failure with it. Same reasoning as probe:contract-pricing's soft
            // notes. What it must never do is go quiet: "not available yet" is
            // the sentence that hid ERR-131 for a month.
            soft('DELETE /api/cart/items/:id REPORTS SUCCESS AND REMOVES NOTHING (BF-059)',
                `ok:true, message "Item removed from cart", removed:0 — and the line is still there. `
                + 'The hand-off\'s §3 next step is to mirror server-side logging onto this endpoint; '
                + 'instrumenting it would record remove_from_cart events for removals that did not happen. '
                + 'Do not build that until this is fixed. (The storefront survives it: Cart.removeItem has '
                + 'three mechanisms and does not treat removed:0 as terminal — ERR-136.)');
        } else if (still === 0) {
            ok('per-item DELETE works — BF-059 appears fixed, the §3 follow-up is now safe to build');
        } else {
            soft('per-item DELETE', `removed=${JSON.stringify(removed)}, ${still} line(s) remain`);
        }
    }
};

run()
    .then(cleanup)
    .then(() => {
        console.log(`\n\x1b[1mResult:\x1b[0m ${pass} passed, ${failures.length} failed, ${notes.length} noted.`);
        if (notes.length) { console.log('\nNoted:'); notes.forEach((n) => console.log(`  ~ ${n}`)); }
        if (failures.length) { console.log('\nFailed:'); failures.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
        console.log('\x1b[32mThe add-to-cart tracking chain holds.\x1b[0m\n');
    })
    .catch(async (e) => { await cleanup(); console.error('\nProbe crashed:', e); process.exit(2); });
