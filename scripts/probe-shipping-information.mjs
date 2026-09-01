#!/usr/bin/env node
/**
 * probe-shipping-information.mjs — is the Shipping Information contract really
 * live, and what does the DATA behind it actually look like?
 * =============================================================================
 *
 * The hand-off (readfirst/shipping-information-section-FE-handoff-sep2026.md) was
 * accurate — measured before a line was written, every endpoint and field was
 * there. That is not the interesting part. The interesting part is the data:
 *
 *   1. Is the carrier registry live, and does it still hold every code the
 *      frontend can render? A carrier removed server-side becomes a dropdown
 *      option that 400s.
 *   2. `email.send_count` IS A FLOOR. On the day this shipped, 4 of the 13
 *      shipped orders reported `send_count: 0` with `last_status: null` while
 *      being shipped — and dispatch emails the customer automatically. Those
 *      sends predate the log. This probe COUNTS them and reports the figure as a
 *      floor, never as a zero (ERR-180 shipped that bug one page over).
 *   3. Does `GET /orders/:id` still return `email: null` while
 *      `GET /orders/:id/shipping` returns a real count for the SAME order? That
 *      pair is the whole reason the panel fetches twice.
 *   4. Is any `tracking_number` actually a pasted URL? Order 20260809000002 is,
 *      and its derived link — `…/tracking/item/https%3A%2F%2F…` — has been in a
 *      real customer's order page since 10 August. The frontend now warns on
 *      input; this catches the next one, and reports any that already exist.
 *   5. `tracking_url_source: 'operator'` had never once rendered in production.
 *      Reported when it finally does, so the branch stops being untested.
 *   6. THE ERROR CONTRACT, without writing anything — see below.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * There is no --record mode and this writes nothing, anywhere. The mode is
 * PRINTED before any work so it can never be assumed (sweep:b2b ate a committed
 * fixture on 2026-08-12 because its read-only mode was the opt-in one).
 *
 * §6 needs care, and gets it. The four documented 400s are all PRE-WRITE
 * rejections, so issuing them proves the error contract without mutating an
 * order — but "the backend told me it validates first" is a citation, not a
 * measurement. So every probe request is bracketed: the order's shipping block is
 * read before and after, and the two must be byte-identical. If a request this
 * probe issued ever changes an order, the run FAILS and says which field moved.
 *
 * It NEVER sends `send_email` or `mark_shipped`, and never calls
 * .../shipping/send-email. Those email a real customer.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly. A file here that reads .env must never be one
 * URL away from the internet.
 *
 * Usage:  npm run probe:shipping-info   (needs ADMIN_EMAIL / ADMIN_PASSWORD in .env)
 * Exit:   0 = every hard check passed, 1 = at least one failed, 2 = could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

/** Every field the FE reads off a carrier. A missing one silently disables a rule. */
const CARRIER_FIELDS = ['code', 'name', 'number_label', 'requires_product_code', 'builds_tracking_url', 'supports_live_tracking'];
/** Every field the panel reads off a shipping block. */
const SHIPPING_FIELDS = [
    'carrier', 'carrier_code', 'tracking_number', 'tracking_number_label',
    'ticket_product_code', 'tracking_url', 'tracking_url_override', 'tracking_url_source',
    'requires_product_code', 'builds_tracking_url', 'supports_live_tracking',
    'shipped_at', 'is_shipped', 'can_send_email', 'email',
];
const ORDER_LIMIT = 200;

let pass = 0;
const failures = [];
const notes = [];
const ok = (name, detail) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name, detail) => {
    failures.push(`${name} — ${detail}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${String(detail).split('\n').join('\n      ')}`);
};
/**
 * A real gap worth reporting that the frontend already handles correctly, so it
 * must NOT redden the exit code. If a soft note could fail the run, the run gets
 * ignored — and then a hard failure gets ignored with it.
 */
const soft = (name, detail) => {
    notes.push(`${name} — ${detail}`);
    console.log(`  \x1b[33m~\x1b[0m ${name}\n      ${String(detail).split('\n').join('\n      ')}`);
};
/** A check that DECLINED TO RUN says so by name. A skip is not a pass. */
const skip = (name, why) => {
    notes.push(`SKIPPED: ${name} — ${why}`);
    console.log(`  \x1b[90m⊘ SKIPPED\x1b[0m ${name}\n      ${why}`);
};

function readEnv() {
    const f = path.join(ROOT, '.env');
    if (!fs.existsSync(f)) return {};
    return Object.fromEntries(
        fs.readFileSync(f, 'utf8').split('\n')
            .filter(l => l.includes('=') && !l.trim().startsWith('#'))
            .map(l => [l.slice(0, l.indexOf('=')).trim(),
                       l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
    );
}

/**
 * Load the SHIPPED derivation rather than re-implementing it.
 *
 * A probe that re-writes the rule it is checking agrees with itself and with
 * nothing else. This runs the real utils/shipping-info.js, so if the module's
 * idea of "has the customer been emailed" drifts from what live data supports,
 * this run says so.
 */
function loadShippingModule() {
    const dir = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'utils');
    const strip = (src) => src
        .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
        .replace(/^\s*import\s+\{[\s\S]*?\}\s+from\s+'[^']+';\s*$/gm, '')
        .replace(/export\s+(const|let|var|function|class)\s+/gm, '$1 ');
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        Math, Number, Object, Array, String, Boolean, JSON, Date, RegExp, Error, URL,
        DebugLog: { warn() {}, log() {}, error() {} },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    try {
        vm.runInContext(strip(fs.readFileSync(path.join(dir, 'send-history.js'), 'utf8')), sandbox, { filename: 'send-history.js' });
        vm.runInContext(strip(fs.readFileSync(path.join(dir, 'shipping-info.js'), 'utf8')), sandbox, { filename: 'shipping-info.js' });
    } catch { return null; }
    return typeof sandbox.emailState === 'function' ? sandbox : null;
}

async function main() {
    console.log('\n\x1b[1mprobe-shipping-information\x1b[0m — is the shipping contract live, and what is behind it?');
    console.log('\x1b[36mMODE: READ-ONLY\x1b[0m  (GETs, plus four requests the backend must reject BEFORE writing —');
    console.log('\x1b[36m               every one is bracketed by a read and asserted to have changed nothing.\x1b[0m');
    console.log('\x1b[36m               No --record mode exists. send_email / mark_shipped are never sent.)\x1b[0m\n');

    const env = readEnv();
    const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
    if (!email || !password) {
        console.error('\x1b[31mCANNOT RUN\x1b[0m — ADMIN_EMAIL / ADMIN_PASSWORD not set (.env or environment).');
        console.error('These must be a super_admin or order_manager — the shipping endpoints 403 for anyone else.');
        console.error('Nothing was verified. Do NOT read this as a pass.\n');
        process.exit(2);
    }

    const auth = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: ANON, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const session = await auth.json();
    if (!session.access_token) {
        console.error(`\x1b[31mCANNOT RUN\x1b[0m — admin sign-in failed (${auth.status}). Nothing was verified.\n`);
        process.exit(2);
    }
    const H = { apikey: ANON, Authorization: `Bearer ${session.access_token}` };
    const req = async (method, p, body) => {
        const res = await fetch(BASE + p, {
            method,
            headers: body ? { ...H, 'content-type': 'application/json' } : H,
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON (gateway HTML) */ }
        return { status: res.status, json, text };
    };
    const get = (p) => req('GET', p);
    console.log(`Signed in as ${email}\n`);

    const SHIP = loadShippingModule();
    if (!SHIP) soft('shipped derivation not loaded', 'utils/shipping-info.js could not be evaluated; §3 falls back to raw field checks.');

    /* ---- 1. Is the carrier registry live, and complete? ---- */
    console.log('\x1b[1m1. Is the carrier registry live, and does it still hold every code?\x1b[0m');
    const reg = await get('/api/admin/shipping/carriers');
    let carriers = [];
    if (reg.status !== 200) {
        bad('GET /api/admin/shipping/carriers', `HTTP ${reg.status} — the dropdown is server-driven, so this is the whole feature. ${reg.text.slice(0, 160)}`);
    } else {
        carriers = reg.json?.data?.carriers || [];
        if (!Array.isArray(carriers) || carriers.length === 0) {
            bad('carrier registry', 'returned 200 with no carriers — the dropdown would be empty');
        } else {
            ok('carrier registry live', `${carriers.length} carriers: ${carriers.map(c => c.code).join(', ')}`);
            const incomplete = carriers.filter(c => CARRIER_FIELDS.some(f => !(f in c)));
            if (incomplete.length) {
                bad('carrier fields', `${incomplete.length} carrier(s) missing one of ${CARRIER_FIELDS.join('/')} — a missing flag silently disables a rule: ${incomplete.map(c => c.code).join(', ')}`);
            } else {
                ok('every carrier carries all six fields the frontend reads');
            }
            const nzc = carriers.find(c => c.code === 'nz_couriers');
            if (!nzc) bad('nz_couriers', 'absent from the registry — the carrier this whole feature exists for');
            else if (nzc.requires_product_code !== true || nzc.number_label !== 'Ticket number') {
                bad('nz_couriers flags', `requires_product_code=${nzc.requires_product_code}, number_label=${JSON.stringify(nzc.number_label)} — the FE drives the ticket-code field and its label off these`);
            } else ok('nz_couriers requires a product code and is labelled "Ticket number"');

            const noUrl = carriers.filter(c => c.builds_tracking_url === false).map(c => c.code);
            ok('carriers that build no tracking URL', `${noUrl.join(', ') || 'none'} — for these the operator's pasted URL is the only link the customer gets`);
        }
    }

    /* ---- 2. The orders, and what their shipping blocks say ---- */
    console.log('\n\x1b[1m2. What do live shipping blocks actually contain?\x1b[0m');
    const list = await get(`/api/admin/orders?limit=${ORDER_LIMIT}`);
    if (list.status !== 200) {
        console.error(`\x1b[31mCANNOT CONTINUE\x1b[0m — GET /api/admin/orders returned ${list.status}. Nothing further was verified.\n`);
        process.exit(2);
    }
    // `/api/admin/orders` returns `data` as a BARE ARRAY; other admin endpoints
    // do not (ERR-176). Normalise the way the page does rather than assuming.
    const rows = Array.isArray(list.json?.data) ? list.json.data : (list.json?.data?.orders || []);
    const shipped = rows.filter(o => ['shipped', 'completed'].includes(String(o.status).toLowerCase()));
    ok('orders fetched', `${rows.length} rows, ${shipped.length} shipped/completed`);
    if (!shipped.length) {
        skip('every shipping-block check', 'no shipped orders exist, so there is no block to read. This is not a pass.');
    }

    const blocks = [];
    for (const o of shipped) {
        const r = await get(`/api/admin/orders/${o.id}/shipping`);
        if (r.status !== 200) { bad(`GET /orders/${o.order_number}/shipping`, `HTTP ${r.status}`); continue; }
        const s = r.json?.data?.shipping;
        if (!s) { bad(`shipping block for ${o.order_number}`, 'data.shipping absent'); continue; }
        blocks.push({ order: o, s });
    }
    if (blocks.length) {
        const missing = SHIPPING_FIELDS.filter(f => !(f in blocks[0].s));
        if (missing.length) bad('shipping block fields', `missing: ${missing.join(', ')}`);
        else ok('every field the panel reads is present on the block');
    }

    /* ---- 3. THE HEADLINE: send_count is a FLOOR ---- */
    console.log('\n\x1b[1m3. Is send_count a total, or a floor?\x1b[0m');
    if (!blocks.length) {
        skip('send-count regime', 'no shipping blocks were readable. Nothing was measured.');
    } else {
        const zero = blocks.filter(b => b.s.email && Number(b.s.email.send_count) === 0);
        const counted = blocks.filter(b => b.s.email && Number(b.s.email.send_count) > 0);
        const nullEmail = blocks.filter(b => !b.s.email);
        if (zero.length) {
            // NOT a failure: the frontend handles it, and it is a fact about the
            // log, not a defect. But it MUST be visible, because the obvious gate
            // renders these as "never sent" and prompts a duplicate email.
            soft('send_count is a FLOOR, not a total',
                `${zero.length} of ${blocks.length} shipped orders report send_count: 0 while being shipped — ` +
                `dispatch emails the customer automatically, so these predate the send log:\n` +
                zero.map(b => `  ${b.order.order_number}  shipped ${String(b.s.shipped_at).slice(0, 10)}`).join('\n') +
                `\nThe panel must say "no recorded sends", never "never sent".`);
        } else {
            ok('every shipped order has at least one logged send', `${counted.length}/${blocks.length}`);
        }
        if (nullEmail.length) {
            bad('email block absent on the dedicated endpoint',
                `${nullEmail.length} order(s) — /orders/:id/shipping is the endpoint that is supposed to know: ${nullEmail.map(b => b.order.order_number).join(', ')}`);
        }
        if (SHIP && zero.length) {
            const st = SHIP.emailState(zero[0].s);
            if (st.state !== 'unlogged') {
                bad('the shipped module disagrees with live data',
                    `emailState() called ${zero[0].order.order_number} "${st.state}"; a shipped order with 0 logged sends must be "unlogged".`);
            } else if (/never/i.test(`${st.phrase} ${st.detail}`)) {
                bad('the shipped copy says "never"', `for ${zero[0].order.order_number}: ${st.phrase} / ${st.detail}`);
            } else {
                ok('the shipped emailState() reads these as UNLOGGED', `"${st.phrase}" — ${st.detail.slice(0, 60)}…`);
            }
        }
    }

    /* ---- 4. The two endpoints disagree about `email`, BY DESIGN ---- */
    console.log('\n\x1b[1m4. Does the order-detail payload still report email: null?\x1b[0m');
    if (!blocks.length) {
        skip('detail-vs-dedicated comparison', 'no shipped orders to compare.');
    } else {
        const probeOrder = blocks[0];
        const detail = await get(`/api/admin/orders/${probeOrder.order.id}`);
        const si = detail.json?.data?.order?.shipping_information;
        if (si === undefined) {
            bad('shipping_information on GET /orders/:id', 'absent — the panel paints its first frame from this');
        } else if (si === null) {
            bad('shipping_information on GET /orders/:id', 'null for a shipped order');
        } else if (si.email === null || si.email === undefined) {
            const dedicated = probeOrder.s.email;
            ok('the detail payload reports email: null while the dedicated one reports a count',
                `${probeOrder.order.order_number}: detail email=null, /shipping send_count=${dedicated?.send_count}. ` +
                'This is why the panel fetches twice and opens saying "send history not loaded".');
        } else {
            soft('the detail payload now carries a real email block',
                `send_count=${si.email.send_count}. The hand-off said this endpoint skips the query. ` +
                'Harmless — the FE treats a present block as authoritative — but the second fetch may now be redundant.');
        }
    }

    /* ---- 5. Dirty data: a URL where a number should be; the operator branch ---- */
    console.log('\n\x1b[1m5. Is any tracking number actually a pasted URL?\x1b[0m');
    if (!blocks.length) {
        skip('dirty-data scan', 'no shipping blocks were readable.');
    } else {
        const urlish = blocks.filter(b => /^(https?:)?\/\/|^www\./i.test(String(b.s.tracking_number || '')));
        if (urlish.length) {
            soft('a tracking number that is a URL builds a link that cannot resolve',
                urlish.map(b => `  ${b.order.order_number}: ${String(b.s.tracking_number).slice(0, 60)}…\n` +
                                `    → ${String(b.s.tracking_url).slice(0, 90)}…`).join('\n') +
                '\nThe backend cannot refuse this (a tracking reference has no universal grammar), and the ' +
                'frontend now warns on input. Existing rows need an operator to retype them — this is DATA, not code.');
        } else {
            ok('no tracking number parses as a URL');
        }

        const sources = {};
        for (const b of blocks) sources[b.s.tracking_url_source] = (sources[b.s.tracking_url_source] || 0) + 1;
        const operator = sources.operator || 0;
        if (operator === 0) {
            soft('tracking_url_source: "operator" has still never rendered in production',
                `all ${blocks.length} shipped orders are ${Object.entries(sources).map(([k, v]) => `${k}=${v}`).join(', ')}. ` +
                'The branch exists and is unit-tested; it has no live exercise. (ERR-180: count the live rows before believing a feature works.)');
        } else {
            ok('the operator-override branch has live rows', `${operator} of ${blocks.length}`);
        }
    }

    /* ---- 6. The error contract, proven WITHOUT writing ---- */
    console.log('\n\x1b[1m6. Does the backend refuse what it documents — before writing?\x1b[0m');
    if (!blocks.length) {
        skip('the error contract', 'needs one shipped order to bracket. Nothing was verified.');
    } else {
        const target = blocks[0];
        const snapshot = async () => {
            const r = await get(`/api/admin/orders/${target.order.id}/shipping`);
            return r.status === 200 ? JSON.stringify(r.json?.data?.shipping) : null;
        };
        const before = await snapshot();
        if (!before) {
            skip('the error contract', 'could not read a baseline to bracket the requests with. Refusing to send them.');
        } else {
            // `accept` lists every answer the frontend is built to handle. The
            // tracking_url case has TWO, and that is the measurement: the
            // hand-off's §6 documents `INVALID_TRACKING_URL`, but production
            // rejects the URL in the schema layer first and answers
            // VALIDATION_FAILED with details[0].field === 'tracking_url'. The FE
            // reads details[] as well as the code for exactly this reason, so
            // either answer is a pass — and a THIRD answer is a real failure.
            const cases = [
                ['unknown carrier', { carrier: 'zzz_not_a_carrier' }, ['UNKNOWN_CARRIER', 'VALIDATION_FAILED'], null],
                ['http:// tracking url', { tracking_url: 'http://insecure.example/track' }, ['INVALID_TRACKING_URL', 'VALIDATION_FAILED'], 'tracking_url'],
                ['both number spellings', { tracking_number: 'AAA111', ticket_number: 'BBB222' }, ['CONFLICTING_TRACKING_NUMBER', 'VALIDATION_FAILED'], null],
                ['nz_couriers without a product code', { carrier: 'nz_couriers', tracking_number: '16025241', ticket_product_code: '' }, ['TICKET_PRODUCT_CODE_REQUIRED', 'VALIDATION_FAILED'], null],
            ];
            for (const [label, body, accept, wantField] of cases) {
                const r = await req('PUT', `/api/admin/orders/${target.order.id}/shipping`, body);
                const code = r.json?.error?.code;
                const details = r.json?.error?.details;
                if (r.status !== 400) {
                    bad(`${label} → expected 400`, `got HTTP ${r.status}. ${String(r.text).slice(0, 160)}`);
                    continue;
                }
                if (!accept.includes(code)) {
                    bad(`${label} → unhandled error code`,
                        `got ${code}; the frontend handles ${accept.join(' or ')}. It would show the operator raw backend prose and mark no field.`);
                    continue;
                }
                if (code === 'VALIDATION_FAILED') {
                    // The substance is in details[]. Without a field name there is
                    // nothing to mark, and the operator gets a Joi sentence.
                    const fields = Array.isArray(details) ? details.map(d => d?.field).filter(Boolean) : [];
                    if (!fields.length) {
                        bad(`${label} → VALIDATION_FAILED with no field named`,
                            'details[] is where the offending field lives; without it the FE cannot mark an input.');
                        continue;
                    }
                    if (wantField && !fields.includes(wantField)) {
                        bad(`${label} → VALIDATION_FAILED names the wrong field`, `expected ${wantField}, got ${fields.join(', ')}`);
                        continue;
                    }
                    ok(`${label}`, `400 ${code}, field(s) ${fields.join(', ')} — rejected before any write`);
                } else {
                    ok(`${label}`, `400 ${code} — rejected before any write`);
                }
            }
            const after = await snapshot();
            if (after === null) {
                bad('post-check read failed', 'could not confirm the order is unchanged. Treat this run as having possibly written.');
            } else if (after !== before) {
                bad('A PROBE REQUEST CHANGED AN ORDER',
                    `${target.order.order_number} differs before/after. These requests were expected to be refused pre-write.\n` +
                    `  before: ${before.slice(0, 200)}\n  after:  ${after.slice(0, 200)}`);
            } else {
                ok('the order is byte-identical before and after', `${target.order.order_number} — the refusals really do happen before the write`);
            }
        }
    }

    /* ---- 7. Not checked here ---- */
    console.log('\n\x1b[1m7. Not checked here\x1b[0m');
    console.log('  • The shipping EMAIL itself (labels, ticket-product-code row, the Track button URL).');
    console.log('    Sending one emails a real customer, so it is verified by reading the order the');
    console.log('    operator sends, never by this probe.');
    console.log('  • `mark_shipped` and the state machine. Flipping a live order\'s status is a write.');
    console.log('  • Whether the poller actually returns scan events for supports_live_tracking carriers.');

    /* ---- summary ---- */
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`\x1b[1mMODE: READ-ONLY\x1b[0m — nothing was written by this run (§6 asserts it).`);
    console.log(`${pass} passed, ${failures.length} failed, ${notes.length} note(s).`);
    if (notes.length) {
        console.log('\nNotes (do not fail the run):');
        for (const n of notes) console.log(`  ~ ${n.split('\n')[0]}`);
    }
    if (failures.length) {
        console.log('\n\x1b[31mFailures:\x1b[0m');
        for (const f of failures) console.log(`  ✗ ${f.split('\n')[0]}`);
        process.exit(1);
    }
    console.log('\n\x1b[32mAll hard checks passed.\x1b[0m\n');
    process.exit(0);
}

main().catch((e) => { console.error('Probe could not run:', e.message); process.exit(2); });
