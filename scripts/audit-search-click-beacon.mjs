#!/usr/bin/env node
/**
 * audit-search-click-beacon.mjs — assert the LIVE POST /api/search/click contract
 * ==============================================================================
 *
 * The unit suite pins what the frontend SENDS. Nothing in it can notice that the
 * endpoint stopped accepting it — and this is the one feature on the storefront
 * where that failure is completely invisible:
 *
 *   • The beacon is fire-and-forget. There is no UI, no error state, no retry.
 *   • `navigator.sendBeacon()` returns `true` as long as the request was QUEUED.
 *     It tells you nothing about the response, so a 400 or a CORS rejection
 *     looks exactly like a success from the browser.
 *   • Measured 2026-08-12: a body sent as `text/plain` (what sendBeacon does
 *     with a bare string instead of a typed Blob) makes the endpoint answer
 *     `400 VALIDATION_FAILED  "q" is required` — the body is never parsed.
 *
 * So a broken beacon reports nothing, breaks nothing, and silently stops
 * producing the CTR data the search-quality report is built on. This script is
 * the only thing that would catch it.
 *
 * ERR-153's lesson is the reason the CORS section exists: a route can be live,
 * correct and curl-verified while being unreachable from a browser, because
 * curl does no preflight. `application/json` is not a CORS-safelisted content
 * type, so every beacon forces an OPTIONS preflight first. If the allow-list
 * ever drops POST or Content-Type, every click silently stops being recorded.
 *
 * WRITE-FREE AND CREDENTIAL-FREE BY DESIGN. Every payload below is deliberately
 * malformed so the endpoint rejects it at validation and stores nothing — this
 * script must never inject fake clicks into the production CTR data it exists to
 * protect. That is also why there is no success-path (204) probe here.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly.
 *
 * Usage:  npm run audit:searchclick  [--json]
 * Exit:   0 = every check passed, 1 = at least one failed
 */

const PROD_API = 'https://api.inkcartridges.co.nz';
const RENDER_API = 'https://ink-backend-zaeq.onrender.com';
const PATHNAME = '/api/search/click';

// Config.API_URL resolves to PROD_API on the apex/www origins and to RENDER_API
// everywhere else (localhost included), so both host/origin pairs must work.
const TRANSPORTS = [
    { host: PROD_API, origin: 'https://inkcartridges.co.nz', label: 'production apex' },
    { host: PROD_API, origin: 'https://www.inkcartridges.co.nz', label: 'production www' },
    { host: RENDER_API, origin: 'http://localhost:3000', label: 'local dev (npm run dev)' },
];

const JSON_OUT = process.argv.includes('--json');

let pass = 0;
const failures = [];
const notes = [];

const say = (s) => { if (!JSON_OUT) console.log(s); };
const ok = (name) => { pass++; say(`  \x1b[32m✓\x1b[0m ${name}`); };
const bad = (name, detail) => {
    failures.push(`${name} — ${detail}`);
    say(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
};
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));
const note = (s) => { notes.push(s); say(`  \x1b[36mi\x1b[0m ${s}`); };

async function preflight(host, origin) {
    const res = await fetch(host + PATHNAME, {
        method: 'OPTIONS',
        headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type',
        },
    });
    return {
        status: res.status,
        allowOrigin: res.headers.get('access-control-allow-origin'),
        allowMethods: res.headers.get('access-control-allow-methods') || '',
        allowHeaders: res.headers.get('access-control-allow-headers') || '',
    };
}

async function send(host, body, contentType = 'application/json') {
    const res = await fetch(host + PATHNAME, {
        method: 'POST',
        headers: { 'Content-Type': contentType, Origin: 'https://inkcartridges.co.nz' },
        body,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* 204 and friends have no body */ }
    return { status: res.status, json };
}

// The validation error for a given field, if the response reported one.
function fieldError(json, field) {
    const details = json && json.error && json.error.details;
    if (!Array.isArray(details)) return null;
    const hit = details.find((d) => d && d.field === field);
    return hit ? String(hit.message || '') : null;
}

async function main() {
    say('\n\x1b[1mSearch click beacon — live contract\x1b[0m');

    // ── 1. The transport (the ERR-153 check) ────────────────────────────────
    say('\n\x1b[1m1. CORS preflight — application/json forces one on every beacon\x1b[0m');
    for (const t of TRANSPORTS) {
        const label = `${t.label} → ${t.host}`;
        try {
            const p = await preflight(t.host, t.origin);
            check(p.status === 204 || p.status === 200, `${label}: preflight answered`,
                `expected 204/200, got ${p.status} — every beacon from this origin is dropped pre-dispatch`);
            check(/\bPOST\b/i.test(p.allowMethods), `${label}: POST allowed`,
                `Access-Control-Allow-Methods = "${p.allowMethods}" — no POST means BF-021 all over again`);
            check(/content-type/i.test(p.allowHeaders), `${label}: Content-Type allowed`,
                `Access-Control-Allow-Headers = "${p.allowHeaders}" — without it the typed Blob cannot be sent`);
            check(p.allowOrigin === t.origin || p.allowOrigin === '*', `${label}: origin echoed`,
                `Access-Control-Allow-Origin = "${p.allowOrigin}", expected "${t.origin}"`);
        } catch (err) {
            bad(`${label}: preflight`, `request failed outright — ${err.message}`);
        }
    }
    note('Vercel PREVIEW origins are not on the allow-list (403 measured 2026-08-12), so');
    note('beacons only land from production and localhost. Not a regression — do not "fix".');

    // ── 2. The content-type trap ────────────────────────────────────────────
    say('\n\x1b[1m2. The text/plain trap — why the Blob must carry a type\x1b[0m');
    try {
        const r = await send(PROD_API, JSON.stringify({ q: 'audit-probe', sku: 'AUDIT-PROBE' }), 'text/plain');
        // If this EVER starts returning 204, the server began parsing text/plain
        // and the trap is gone — worth knowing, but it must not silently pass as
        // if nothing changed, because the whole Blob rationale rests on it.
        check(r.status === 400 && fieldError(r.json, 'q') !== null,
            'a text/plain body is still not parsed (400, "q is required")',
            `got ${r.status} ${JSON.stringify(r.json)} — if this is now 204 the server started accepting text/plain; `
            + 'update the comment in js/search-click-beacon.js, do not remove the typed Blob');
    } catch (err) {
        bad('text/plain probe', err.message);
    }

    // ── 3. The schema the frontend is written against ───────────────────────
    say('\n\x1b[1m3. Validation contract (malformed payloads only — nothing is written)\x1b[0m');
    const cases = [
        {
            name: 'q and sku are both required',
            body: '{}',
            expect: (r) => r.status === 400 && fieldError(r.json, 'q') && fieldError(r.json, 'sku'),
        },
        {
            name: 'sku is required',
            body: JSON.stringify({ q: 'audit-probe' }),
            expect: (r) => r.status === 400 && fieldError(r.json, 'sku'),
        },
        {
            name: 'q is required',
            body: JSON.stringify({ sku: 'AUDIT-PROBE' }),
            expect: (r) => r.status === 400 && fieldError(r.json, 'q'),
        },
        {
            name: 'position must be a number (the FE never sends a string)',
            body: JSON.stringify({ q: 'audit-probe', sku: 'AUDIT-PROBE', position: 'two' }),
            expect: (r) => r.status === 400 && /number/i.test(fieldError(r.json, 'position') || ''),
        },
        {
            name: 'q is capped at 200 chars (MAX_Q_LENGTH in the beacon)',
            body: JSON.stringify({ q: 'a'.repeat(201), sku: 'AUDIT-PROBE' }),
            expect: (r) => r.status === 400 && /200/.test(fieldError(r.json, 'q') || ''),
        },
        {
            name: 'sku is capped at 100 chars (MAX_SKU_LENGTH in the beacon)',
            body: JSON.stringify({ q: 'audit-probe', sku: 'S'.repeat(101) }),
            expect: (r) => r.status === 400 && /100/.test(fieldError(r.json, 'sku') || ''),
        },
    ];
    for (const c of cases) {
        try {
            const r = await send(PROD_API, c.body);
            check(c.expect(r), c.name, `got ${r.status} ${JSON.stringify(r.json)}`);
        } catch (err) {
            bad(c.name, err.message);
        }
    }

    // ── Report ──────────────────────────────────────────────────────────────
    if (JSON_OUT) {
        console.log(JSON.stringify({ pass, failed: failures.length, failures, notes }, null, 2));
    } else {
        console.log(`\n\x1b[1m${pass} passed, ${failures.length} failed\x1b[0m`);
        if (failures.length) {
            console.log('\nFailures:');
            for (const f of failures) console.log(`  • ${f}`);
            console.log('\nA failure here means search-result clicks are silently NOT being recorded.');
            console.log('See js/search-click-beacon.js and project_search_click_beacon_aug2026.\n');
        } else {
            console.log('The click beacon\'s transport and contract both still hold.\n');
        }
    }
    process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
    console.error('audit-search-click-beacon: unexpected failure —', err);
    process.exit(1);
});
