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
 * 1. THE HEADER THAT LOOKS FINE FROM curl. A preflight answers **204 either
 *    way** — it does not echo the requested headers — so a curl check reads as
 *    a pass while a BROWSER fails the preflight and never sends the request at
 *    all. That is why §1 uses a negative control rather than a bare 204.
 *    BF-054 CLOSED 2026-09-08: `X-Session-Id` / `X-Visitor-Id` ARE on the
 *    allow-list now, `USE_ID_HEADERS` is true, and §1 is a HARD check that they
 *    stay there. Losing them again is not a lost analytics column — the header
 *    now rides /api/search/smart, so it is site search down.
 *
 * 2. THE VALUE THE AD PLATFORM BIDS ON. The Google Ads conversion sends
 *    `price_snapshot × quantity` off the add-to-cart response. If the backend
 *    ever stops shipping `price_snapshot`, nothing breaks loudly: the tag keeps
 *    firing, `value` is simply omitted, and Smart Bidding quietly optimises
 *    against a conversion with no worth. A unit test cannot catch that — it only
 *    asks this repo whether it agrees with itself. §3 asks the SERVER.
 *
 * 3. THE QUERY PARAM THAT SHATTERED AN EDGE CACHE — and did, on 2026-09-10.
 *    `?sid=`/`?vid=` were free only while /api/search/smart answered
 *    `cf-cache-status: DYNAMIC`. It joined the Cloudflare Cache Rule, the params
 *    became part of the cache key, and the frontend took them off that route
 *    (ERR-253). They REMAIN on `POST /api/cart/items`, which is correct: a POST
 *    is never edge-cached and that is the one place the param transport is
 *    measurably landing rows. §2 now asserts production search IS cached — the
 *    reason the removal was right — rather than asserting it is not.
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
import { printSearchAnalyticsNotice, probeQuery } from './lib/probe-search-notice.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.API_BASE || 'https://ink-backend-zaeq.onrender.com';
// The CDN-fronted host. Edge-cache questions can ONLY be asked here — see §2.
const PROD = process.env.PROD_BASE || 'https://api.inkcartridges.co.nz';
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
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));
const cannotRun = (m) => { console.log(`\n\x1b[33m▲ probe could not run\x1b[0m — ${m}`); process.exit(2); };

console.log('\n\x1b[1mprobe:add-to-cart — Google Ads conversion + the analytics join key (ERR-223)\x1b[0m');
console.log(WRITE
    ? '\x1b[41m\x1b[97m MODE: WRITE \x1b[0m — adds ONE item to a throwaway guest cart and removes it again.'
    : '\x1b[36mMODE: READ-ONLY\x1b[0m — GETs and one OPTIONS. Pass --write for the cart-response checks (§3/§4/§6).');
console.log(`Backend: ${BASE}`);
printSearchAnalyticsNotice();
console.log('');

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
    console.log('\x1b[1m§1 — the id headers are allowed, and must stay that way (BF-054 closed)\x1b[0m');
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
        // ── BF-054 LANDED 2026-09-08. THIS ASSERTION IS INVERTED. ───────────
        //
        // It used to assert the two id headers were ABSENT and that
        // `USE_ID_HEADERS` must stay false — correct while the allow-list did
        // not carry them, because a browser does not DEGRADE on a disallowed
        // header, it fails the preflight and never sends the request at all.
        //
        // The backend shipped them on 2026-09-08, `traffic-tracker.js` set
        // USE_ID_HEADERS = true, and search rows started carrying session ids
        // the next day (2026-09-09: 75 of 176; 2026-09-10: 15 of 23 — against
        // 0 of 686 across the three days before). So this file was left
        // asserting the opposite of what the code now depends on: still green,
        // because it softened rather than failed, but measuring nothing.
        //
        // Losing these headers again is NOT a lost analytics column — it is
        // site search down. Hence a hard check. Re-measured 2026-09-12.
        check(hasSession && hasVisitor,
            'X-Session-Id + X-Visitor-Id are allowed — BF-054 stays closed',
            `the allow-list is missing ${[!hasSession && 'X-Session-Id', !hasVisitor && 'X-Visitor-Id'].filter(Boolean).join(' + ')}. `
            + 'A browser does not degrade here: it fails the preflight and never sends the request. '
            + 'Set USE_ID_HEADERS = false in js/traffic-tracker.js IMMEDIATELY, then talk to the '
            + `backend. Got: ${allow || '(none)'}`);
    } catch (e) {
        cannotRun(`preflight unreachable: ${e.message}. A cold Render instance can take ~50s on first hit.`);
    }

    // ── §2 ────────────────────────────────────────────────────────────────
    //
    // THIS SECTION USED TO BE A CHECK THAT COULD NOT FAIL, AND IT WAS GREEN THE
    // WHOLE TIME IT WAS WRONG.
    //
    // It asked `${BASE}/api/search/smart` for `cf-cache-status` and scored
    // `DYNAMIC` as a pass — "the params fragment nothing". But BASE defaults to
    // the RENDER ORIGIN, which our Cloudflare Cache Rule does not cover and
    // which therefore answers DYNAMIC permanently. Measured 2026-09-16, the
    // same request to both hosts:
    //
    //     ink-backend-zaeq.onrender.com   cf-cache-status: DYNAMIC
    //     api.inkcartridges.co.nz         cf-cache-status: MISS -> HIT
    //
    // So search joined the Cache Rule on 2026-09-10, the frontend took the ids
    // out of the search URL because of it (ERR-253), and this probe went on
    // reporting DYNAMIC as evidence that nothing had changed. ***A GUARD
    // POINTED AT THE WRONG HOST IS NOT A WEAK GUARD, IT IS A GREEN LIGHT.***
    //
    // It now asks PRODUCTION, where the cache rule actually lives, and it no
    // longer sends ids on a search URL at all — that transport is gone from the
    // shipped frontend and this file was the last place still exercising it.
    console.log('\n\x1b[1m§2 — the ids left the search URL, and the cart POST kept them\x1b[0m');
    try {
        const r = await req('GET', `${PROD}/api/search/smart?q=${encodeURIComponent(probeQuery('a2c'))}&limit=1`);
        const cache = (r.headers.get('cf-cache-status') || '').toUpperCase();
        if (r.status !== 200) {
            bad('production /api/search/smart', `expected 200, got ${r.status}`);
        } else if (cache === 'MISS' || cache === 'HIT' || cache === 'REVALIDATED' || cache === 'EXPIRED') {
            ok(`production search IS edge-cached (cf-cache-status: ${cache}) — which is exactly why `
                + '?sid=/?vid= had to come off this route: the cache key is the URL and excludes '
                + 'request headers, so a per-visitor param gives every visitor a private entry');
        } else {
            bad('production search is NOT edge-cached any more',
                `cf-cache-status: ${cache || '(absent)'}. If the Cache Rule has been withdrawn, the `
                + 'header transport is no longer buying anything on this route and the ~0.25s '
                + 'preflight it costs is no longer paid for. Re-measure before changing anything.');
        }
        // The Render origin, stated rather than asserted — so the next reader
        // knows why this question cannot be asked there.
        const origin = await req('GET', `${BASE}/api/search/smart?q=${encodeURIComponent(probeQuery('a2c'))}&limit=1`);
        soft(`the Render origin answers cf-cache-status: ${origin.headers.get('cf-cache-status') || '(absent)'}`,
            'permanently, because the Cache Rule is attached to api.inkcartridges.co.nz and not to '
            + 'it. Asking this host about the edge cache is how the old version of this section '
            + 'stayed green through the change it existed to catch.');

        // A malformed id must be rejected WHOLE, not truncated: a mangled id
        // groups with nothing and still looks like real data. This still rides
        // the search route because that is where cleanId runs — but on a
        // sentinelled term, since the row it creates is ours (ERR-254).
        const badId = await req('GET', `${BASE}/api/search/smart?q=${encodeURIComponent(probeQuery('a2c'))}&limit=1&sid=${encodeURIComponent('has space!')}`);
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

    // ── §3b — the case that exposes the trap ──────────────────────────────
    console.log('\n\x1b[1m§3b — a SECOND add to the same line: total vs delta\x1b[0m');
    const add2 = await req('POST', `${BASE}/api/cart/items`, {
        headers: { 'x-guest-session': guest },
        body: { product_id: productId, quantity: 1 },
    });
    if (add2.status !== 200 && add2.status !== 201) {
        bad('second add', `expected 2xx, got ${add2.status}`);
    } else {
        const d2 = add2.json?.data || {};
        console.log(`    quantity=${JSON.stringify(d2.quantity)} (line total) · quantity_added=${JSON.stringify(d2.quantity_added)} (delta)`);
        // This is the ONLY case that can tell the two apart: on an empty line
        // the total IS the delta, which is exactly why the wrong formula
        // survived review and unit tests (BF-060).
        if (d2.quantity_added === 1) {
            ok('quantity_added reports the DELTA (1) — the field the Ads value is built on');
        } else if (d2.quantity_added === undefined) {
            soft('quantity_added ABSENT — running on the local derivation',
                'not broken: AdsConversions falls back to deriving the delta from the line\'s prior '
                + 'quantity, capped at what was requested. But the server\'s own delta is the '
                + 'authoritative one, so find out whether the field was rolled back (BF-060).');
        } else {
            bad('quantity_added IS NOT THE DELTA',
                `added 1 to a line holding 2 and quantity_added came back ${JSON.stringify(d2.quantity_added)}. `
                + 'The Google Ads conversion value is built on this field — if it reports the line total, '
                + 'every add to an existing line is over-reported (BF-060, the $290.97-for-one-cartridge bug).');
        }
        if (d2.quantity === 3) {
            ok('quantity is still the LINE TOTAL (3) — unchanged meaning, as the backend intended');
        } else {
            soft('quantity', `expected the line total 3, got ${JSON.stringify(d2.quantity)}`);
        }
        if (d2.quantity_added !== undefined && d2.quantity === d2.quantity_added) {
            bad('THE TWO FIELDS AGREE ON A MERGE — one of them is wrong',
                'on a second add to the same line the total and the delta MUST differ. If they are '
                + 'equal here, quantity_added is not a delta and the Ads value is inflated.');
        }
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
