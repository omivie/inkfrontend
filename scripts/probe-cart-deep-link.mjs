#!/usr/bin/env node
/**
 * Would /cart?add=SKU:QTY actually deliver a shopper's reorder?
 * =============================================================================
 * ERR-269.
 *
 * The backend's reorder/refill emails emit `/cart?add=…` for guest recipients.
 * `js/cart-deep-link.js` reads it, resolves each SKU to a product UUID via
 * `API.getProduct`, and adds through the normal add-to-cart call.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS PROBE
 * -------------------------------------------------
 * tests/cart-add-deep-link-sep2026.test.js drives the whole handler, but it
 * drives it against a STUBBED catalogue. It proves the orchestration is right;
 * it cannot prove that the SKUs our emails actually contain still resolve. A
 * discontinued line, a SKU respelled in a supplier feed, or a getProduct
 * regression would leave every test green while real reorder links quietly
 * delivered a partial cart — and the shopper would be told so by the summary
 * toast, which is the ONLY place that failure is visible today.
 *
 * §3's --write arm is the only end-to-end proof that a guest session can add at
 * all, which is the exact population this feature exists for (~99 guests per
 * send; account holders already had a signed backend link).
 *
 * ── READ-ONLY BY DEFAULT. THE MODE IS PRINTED BEFORE ANY WORK. ──────────────
 *   npm run probe:cart-deep-link              read-only: resolves SKUs only
 *   npm run probe:cart-deep-link -- --write   adds AND removes one guest line
 *
 * The --write arm OWNS its safety. It adds one line to a brand-new guest cart
 * (never an existing session), touches nothing else, and removes it in a
 * `finally` — then proves the removal BOTH ways: the line must be readable
 * first, and gone after. An empty cart is only evidence of cleanup if it was
 * non-empty a moment ago.
 *
 * That two-way check is not belt-and-braces; it is the whole lesson. This
 * probe's first draft invented its own guest id, sent it as X-Guest-Session,
 * and read the cart back with it. The add landed somewhere the read-back could
 * not see, the read-back was empty and always would have been — and the probe
 * printed "cleanup verified". (We first wrote that the server "ignores a
 * client-invented id and mints its own". The backend corrected that on
 * 2026-09-21: it ACCEPTS a well-formed UUID and mints one only when the header
 * is absent or malformed, echoing the resolved id either way; the invented id
 * matched no `guest_sessions` row. Either way the lesson stands: address the
 * session the SERVER echoes, not the one you meant.) It was green while leaking a line
 * it could not see and could not remove. ERR-257 is the same shape: a probe
 * that borrows its rollback rather than owning it, including its ROLLBACK'S
 * ADDRESS (ERR-262). A failed or unverifiable cleanup now exits 1 and says
 * exactly what is left behind, and where.
 *
 * Exit: 0 = the chain holds
 *       1 = a real finding, or a failed cleanup
 *       2 = could not run (network / cold start). "We could not look" is never
 *           reported as "we looked and it was fine".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.PROBE_API || 'https://ink-backend-zaeq.onrender.com';
const ORIGIN = 'https://www.inkcartridges.co.nz';
const ARGS = new Set(process.argv.slice(2));
const WRITE = ARGS.has('--write');

let pass = 0;
const failures = [];
const notes = [];
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const cannotRun = (m) => { console.log(`\n\x1b[33m▲ probe could not run\x1b[0m — ${m}`); process.exit(2); };

console.log('\n\x1b[1mprobe:cart-deep-link — /cart?add=SKU:QTY (ERR-269)\x1b[0m');
console.log(WRITE
    ? '\x1b[33m  MODE: --write. Adds AND removes one line under a THROWAWAY guest session.\x1b[0m'
    : '\x1b[2m  MODE: READ-ONLY. Resolves SKUs only. Pass --write to exercise the add.\x1b[0m');
console.log(`\x1b[2m  api ${API}\x1b[0m\n`);

/** The ONE transport function. A second one means this is no longer one probe. */
async function req(method, url, { guest = null, body = null } = {}) {
    const headers = { Accept: 'application/json', Origin: ORIGIN };
    if (body) headers['Content-Type'] = 'application/json';
    if (guest) headers['X-Guest-Session'] = guest;
    const res = await fetch(`${API}${url}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    const text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    // The server MINTS the guest session and returns it here; a client-invented
    // id is ignored. Every later call in a write run must carry THIS value or it
    // is addressing a different, empty cart. See §3.
    return {
        status: res.status, ok: res.ok, json, text, headers: res.headers,
        guestSession: res.headers.get('x-guest-session') || null,
    };
}

// ── §1 — the parser this repo will actually run ─────────────────────────────
// Read the REAL module rather than re-implementing its rules here. ERR-231's
// probe was certifying a replica of the escaper it was meant to check, and the
// two agreed perfectly while both were wrong.
console.log('\x1b[1m§1 the shipped parser, loaded from source\x1b[0m');
let DeepLink;
try {
    const mod = await import(`file://${path.join(ROOT, 'inkcartridges', 'js', 'cart-deep-link.js')}`);
    DeepLink = mod.default || mod;
    if (!DeepLink || typeof DeepLink.parseAddParam !== 'function') {
        throw new Error('cart-deep-link.js exported no parseAddParam');
    }
    ok(`loaded js/cart-deep-link.js (max ${DeepLink.MAX_ENTRIES} entries, qty ${DeepLink.MIN_QTY}-${DeepLink.MAX_QTY})`);
} catch (err) {
    cannotRun(`could not load the deep-link module — ${err.message}`);
}

// ── §2 — do real catalogue SKUs resolve? ────────────────────────────────────
// The SKUs a reorder email would carry. Override with a real send's list:
//   PROBE_SKUS=C73NM:1,GLC3333M:2 npm run probe:cart-deep-link
console.log('\n\x1b[1m§2 do the SKUs a reorder email carries still resolve?\x1b[0m');
let sampleLink = process.env.PROBE_SKUS || null;

if (!sampleLink) {
    // No list given: take a few real SKUs off the live catalogue so the probe
    // tests something true rather than something hard-coded and rotting.
    try {
        const r = await req('GET', '/api/products?limit=4');
        // Live shape, verified 2026-09-20: { ok, data: { products: [...] } }.
        // The two looser readings are kept as fallbacks, but the nested one is
        // checked FIRST — reading `data` as the array is how this probe first
        // sampled nothing and said so (correctly, with exit 2) instead of
        // quietly testing an empty list.
        const payload = r.json && (r.json.data || r.json);
        const rows = (payload && Array.isArray(payload.products)) ? payload.products
            : (Array.isArray(payload) ? payload : []);
        const skus = rows.map((p) => p && p.sku).filter(Boolean).slice(0, 3);
        if (!skus.length) cannotRun('could not sample any SKU from /api/products (cold start? shape change?)');
        sampleLink = skus.map((s) => `${s}:1`).join(',');
        console.log(`\x1b[2m  sampled from the live catalogue: ${sampleLink}\x1b[0m`);
    } catch (err) {
        cannotRun(`could not sample the catalogue — ${err.message}`);
    }
}

const parsed = DeepLink.parseAddParam(sampleLink);
if (parsed.invalid.length) {
    bad('every sampled SKU parses', `the parser rejected ${parsed.invalid.join(', ')}`);
}
if (!parsed.entries.length) cannotRun(`nothing to resolve from "${sampleLink}"`);

const resolved = [];
for (const { sku, qty } of parsed.entries) {
    try {
        const r = await req('GET', `/api/products/${encodeURIComponent(sku)}`);
        const data = r.json && (r.json.data || r.json);
        const id = data && data.id;
        if (r.status === 200 && id) {
            resolved.push({ sku, qty, id });
            ok(`${sku} -> ${id}`);
        } else if (r.status === 404) {
            bad(`${sku} resolves`, 'HTTP 404 — a reorder link naming this SKU would deliver a PARTIAL cart');
        } else {
            soft(`${sku} resolves`, `HTTP ${r.status} — could not tell; not counted either way`);
        }
    } catch (err) {
        soft(`${sku} resolves`, `request failed — ${err.message}`);
    }
}

if (!resolved.length) {
    bad('at least one SKU resolved', 'nothing could be added; the --write arm has nothing to exercise');
}

// ── §3 — the add itself, under a throwaway guest session ────────────────────
console.log('\n\x1b[1m§3 can a GUEST actually add? (the population this feature is for)\x1b[0m');
if (!WRITE) {
    soft('guest add not exercised',
        'read-only run. `npm run probe:cart-deep-link -- --write` mints a throwaway guest '
        + 'session, adds one line and removes it again with a verified cleanup.');
} else if (!resolved.length) {
    soft('guest add not exercised', 'no SKU resolved above, so there is nothing safe to add');
} else {
    const target = resolved[0];
    // The session the SERVER mints, adopted from the add's response header.
    //
    // This probe's first draft invented its own id, sent it as X-Guest-Session,
    // and then read the cart back with the same invented id. The add answered
    // 201, the read-back answered an EMPTY cart, and the cleanup check reported
    // "verified — the throwaway cart is empty again". It was empty because the
    // id addressed no `guest_sessions` row (backend, 2026-09-21: a well-formed
    // UUID is ACCEPTED, not replaced — the server mints only when the header is
    // absent or malformed, and echoes the resolved id in x-guest-session either
    // way, which is why api.js re-reads it after every request).
    // The line it actually added was orphaned in a session the probe had thrown
    // away — a write it could not see and could not roll back. That is ERR-257's
    // shape exactly, reached through a different door, and it passed green.
    //
    // So: adopt the server's id, and PROVE THE LINE IS THERE before claiming to
    // have removed it. An empty cart is only evidence of cleanup if it was
    // non-empty a moment ago.
    let guest = null;
    let added = false;
    try {
        const add = await req('POST', '/api/cart/items', {
            body: { product_id: target.id, quantity: 1 },
        });
        guest = add.guestSession;
        if (add.ok) {
            added = true;
            ok(`guest add accepted for ${target.sku} (HTTP ${add.status})`);
            const line = add.json && (add.json.data || add.json);
            if (line && line.quantity != null) {
                ok(`server echoed quantity ${line.quantity} (the LINE TOTAL — ERR-223, not the delta)`);
            }
            // ERR-286: the add response carries the raw product_type (+ pack_type)
            // so GA4's add_to_cart can categorise without the caller's help.
            // Report WHERE it sits — cart.js reads both spots.
            const where = (k) => (line && k in line ? `data.${k}=${JSON.stringify(line[k])}`
                : line?.product && k in line.product ? `data.product.${k}=${JSON.stringify(line.product[k])}` : null);
            for (const k of ['product_type', 'pack_type']) {
                if (where(k)) ok(`add response carries ${where(k)}`);
                else soft(`add response has no ${k}`, 'GA4 add_to_cart falls back to the caller-supplied category');
            }
            if (guest) console.log(`\x1b[2m  server-minted guest session: ${guest}\x1b[0m`);
            else {
                bad('the add returned no x-guest-session header',
                    `${target.sku} (${target.id}) was added to a session this probe cannot address, `
                    + 'so it cannot be removed. Nothing else will report this line.');
            }
        } else {
            bad('guest add accepted', `HTTP ${add.status} ${add.text.slice(0, 160)}`);
        }
    } catch (err) {
        soft('guest add', `request failed — ${err.message}`);
    } finally {
        // OWN the rollback, and VERIFY it in BOTH directions (ERR-257/262).
        if (added && guest) {
            const linesFor = async () => {
                const r = await req('GET', '/api/cart', { guest });
                const items = (r.json && (r.json.data?.items || r.json.items)) || [];
                return items.filter((i) => (i.product_id || i.product?.id || i.id) === target.id);
            };
            let presentBefore = false;
            try {
                presentBefore = (await linesFor()).length > 0;
            } catch { presentBefore = false; }
            // ERR-286 shape report, read from the SAME session: the per-line
            // volume figures and the summary's row accounting. Absent is reported
            // as absent — cart.js keeps its fallback for exactly that case.
            try {
                const r = await req('GET', '/api/cart', { guest });
                const d = r.json && (r.json.data || r.json);
                const item = (d?.items || []).find((i) => (i.product_id || i.product?.id) === target.id);
                const sum = d?.summary || {};
                for (const k of ['rows_on_file', 'rows_dropped_inactive']) {
                    if (k in sum) ok(`summary.${k} = ${JSON.stringify(sum[k])}`);
                    else soft(`summary.${k} absent`, 'the empty-cart guard keeps its pre-ERR-286 behaviour');
                }
                const VOL = ['line_total_after_discount', 'volume_unit_price', 'volume_line_savings', 'volume_next_break'];
                const have = item ? VOL.filter((k) => k in item) : [];
                if (item && have.length === VOL.length) ok(`cart line carries ${VOL.join(', ')}`);
                else soft('cart line volume figures', `present: ${have.join(', ') || 'none'} — the cart falls back to price × qty`);
            } catch (err) {
                soft('ERR-286 shape report', `could not read the cart — ${err.message}`);
            }

            if (!presentBefore) {
                bad('CANNOT VERIFY CLEANUP',
                    `the add reported 201 but ${target.sku} (${target.id}) is not readable in guest `
                    + `session ${guest}. An empty cart here proves nothing — the line may be orphaned `
                    + 'in a session this probe cannot address. Do not read this run as clean.');
            } else {
                ok('the added line is readable — the cleanup check below is not vacuous');
                let removed = false;
                try {
                    const del = await req('DELETE', `/api/cart/items/${encodeURIComponent(target.id)}`, { guest });
                    removed = del.ok;
                } catch { removed = false; }
                try {
                    if ((await linesFor()).length === 0) {
                        ok('cleanup verified — the line is gone from the session it was added to');
                    } else {
                        bad('CLEANUP FAILED',
                            `guest session ${guest} still holds ${target.sku} (${target.id}). `
                            + 'Remove it before trusting another run of this probe.');
                    }
                } catch (err) {
                    bad('CLEANUP UNVERIFIED',
                        `could not re-read guest session ${guest} to confirm removal of ${target.sku} `
                        + `(${target.id}) — ${err.message}. Treat the line as still present.`);
                }
                if (!removed) soft('remove returned non-2xx', 'the verification read above is the authority');
            }
        }
    }
}

// ── §4 — enrolment: is the module even loaded on /cart? ─────────────────────
console.log('\n\x1b[1m§4 enrolment — a feature nobody loads is a feature nobody has\x1b[0m');
try {
    const html = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'html', 'cart.html'), 'utf8');
    if (/src="\/js\/cart-deep-link\.js/.test(html)) ok('html/cart.html loads cart-deep-link.js');
    else bad('cart.html loads the deep link', 'the script tag is missing — the feature is inert (ERR-214)');
} catch (err) {
    soft('enrolment check', `could not read cart.html — ${err.message}`);
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n\x1b[1mSummary\x1b[0m');
console.log(`  passed: ${pass}   failed: ${failures.length}   notes: ${notes.length}`);
console.log(`  mode: ${WRITE ? '--write (added and removed one guest line)' : 'READ-ONLY'}`);
if (notes.length) {
    console.log('\n  Notes (not failures):');
    notes.forEach((n) => console.log(`    ~ ${n.split('\n')[0]}`));
}
if (failures.length) {
    console.log('\n\x1b[31m  FAILURES\x1b[0m');
    failures.forEach((f) => console.log(`    ✗ ${f.split('\n')[0]}`));
    process.exit(1);
}
console.log('\n\x1b[32m  OK\x1b[0m — a reorder deep link would deliver what it names.\n');
