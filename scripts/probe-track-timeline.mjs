#!/usr/bin/env node
/**
 * probe-track-timeline.mjs — what does the customer's progress stepper ACTUALLY
 * say today?
 * =============================================================================
 *
 * The pathway on /track-order and /account/track-order is entirely the backend's.
 * `buildTimeline()` in js/track-order-page.js maps over `data.timeline[]` and
 * renders `step.label` verbatim — it does not know the step names, the step count,
 * or the order they come in, and a test pins it against ever learning them. So
 * there is no assertion the frontend can make about this pathway. Grepping the
 * repo for "Order Confirmed" or "Processing" returns nothing; the only place the
 * truth exists is the live response.
 *
 * That is exactly the shape of thing this repo keeps getting wrong: a change is
 * agreed in a hand-off, the hand-off is accurate, and nobody counts the rows. So
 * this probe asks the SERVER what it sends, rather than asking a document what it
 * promised.
 *
 * Sep 2026 (ERR-213): the pathway went from five steps to three —
 *
 *     BEFORE  Order Placed → Order Confirmed → Processing → Shipped — In Transit → Delivered
 *     AFTER   Order Placed → Shipped — In Transit → Delivered
 *
 * `Order Confirmed` fired NINE SECONDS after `Order Placed` (it is the `paid`
 * transition) and `Processing` carried `date: null` on every order, because no
 * `processing_at` column exists. Two steps that cost the stepper 40% of its width
 * and told the customer nothing.
 *
 * `status_label` moved with them: a `paid` or `processing` order now reads
 * "Preparing for dispatch". BOTH are mapped deliberately — 160 live orders carry
 * one of those two statuses, and a legacy `processing` row must never surface the
 * word "Processing" to a customer just because it predates the change.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * There is no --record mode. This sends exactly one POST /api/orders/track-lookup
 * per order, which is a LOOKUP: it writes nothing and mails nobody. (The browser
 * fires a track-request afterwards on an unshipped order; this probe never does.)
 * The mode is PRINTED before any work so it cannot be assumed.
 *
 * ── WHY THE ORDER COMES FROM THE ENVIRONMENT ────────────────────────────────
 * The lookup needs a real order number AND the customer's email. That email is a
 * real person's, so it is not committed. Set them in .env or the environment:
 *
 *     TRACK_PROBE_ORDER=2026090301
 *     TRACK_PROBE_EMAIL=someone@example.com
 *     TRACK_PROBE_CANCELLED_ORDER= / _EMAIL=   (optional, for the cancelled path)
 *
 * WITHOUT THEM THIS PROBE SKIPS, LOUDLY, BY NAME — it never reports green on a
 * pathway it did not look at. A skip is not a pass.
 *
 * The 5-step payload is kept below as a POSITIVE CONTROL. Every assertion is run
 * against it too and MUST fail. A probe whose checks have quietly stopped
 * checking reports green forever; this one cannot.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly.
 *
 * Usage:  npm run probe:track-timeline
 * Exit:   0 = every hard check passed, 1 = at least one failed, 2 = could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://ink-backend-zaeq.onrender.com';

/** The pathway, as agreed. Step KEYS — the labels are the backend's to word. */
const EXPECTED_STEPS = ['placed', 'shipped', 'delivered'];
/** The two that were removed. Matched on key AND label, because either would show. */
const RETIRED = /confirm|processing/i;
/** What a customer must never read on the badge again. */
const RETIRED_LABEL = /order\s*confirmed|processing/i;

let pass = 0;
const failures = [];
const notes = [];
const ok = (name, detail) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name, detail) => {
    failures.push(`${name} — ${detail}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${String(detail).split('\n').join('\n      ')}`);
};
/** A real gap the frontend already survives. Must NOT redden the exit code. */
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
 * THE POSITIVE CONTROL — the exact payload production returned on 2026-09-06,
 * before the change. Every assertion below runs against this too and must FAIL
 * on it. If this ever passes, the assertions have stopped asserting.
 */
const FIVE_STEP_CONTROL = Object.freeze({
    order_number: '(positive control)',
    status: 'shipped',
    status_label: 'Shipped — In Transit',
    timeline: [
        { step: 'placed', label: 'Order Placed', completed: true, date: '2026-09-03T01:17:50.871965+00:00' },
        { step: 'confirmed', label: 'Order Confirmed', completed: true, date: '2026-09-03T01:17:59.195+00:00' },
        { step: 'processing', label: 'Processing', completed: true, date: null },
        { step: 'shipped', label: 'Shipped — In Transit', completed: true, date: '2026-09-04T14:39:31.483+00:00' },
        { step: 'delivered', label: 'Delivered', completed: false, date: null },
    ],
});

async function lookup(orderNumber, email) {
    const res = await fetch(`${BASE}/api/orders/track-lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://inkcartridges.co.nz' },
        body: JSON.stringify({ order_number: orderNumber, email }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON — reported by the caller */ }
    return { status: res.status, body };
}

/**
 * The whole ruleset, as a pure function of a payload, so the live response and
 * the positive control go through IDENTICAL code. A control checked by a second
 * copy of the rules proves only that the copies agree.
 *
 * @returns {string[]} one sentence per violation; empty means the payload is
 *   the three-step pathway.
 */
function violations(data) {
    const out = [];
    const tl = data?.timeline;

    if (!Array.isArray(tl)) {
        out.push(`timeline is ${tl === undefined ? 'absent' : JSON.stringify(tl)}, not an array`);
        return out;
    }

    const keys = tl.map(s => s?.step);
    const cancelled = keys.includes('cancelled');

    if (cancelled) {
        // The cancelled path is its own shape and always was: [placed, cancelled].
        if (keys.join(',') !== 'placed,cancelled') {
            out.push(`cancelled order returned [${keys.join(', ')}], expected [placed, cancelled]`);
        }
    } else {
        if (tl.length !== EXPECTED_STEPS.length) {
            out.push(`${tl.length} steps, expected ${EXPECTED_STEPS.length} — [${keys.join(', ')}]`);
        }
        if (keys.join(',') !== EXPECTED_STEPS.join(',')) {
            out.push(`steps are [${keys.join(', ')}], expected [${EXPECTED_STEPS.join(', ')}] in that order`);
        }
    }

    for (const s of tl) {
        if (RETIRED.test(String(s?.step ?? ''))) out.push(`retired step key still sent: "${s.step}"`);
        if (RETIRED.test(String(s?.label ?? ''))) out.push(`retired step label still sent: "${s.label}"`);
    }

    if (RETIRED_LABEL.test(String(data?.status_label ?? ''))) {
        out.push(`status_label still reads "${data.status_label}" (status: ${data.status})`);
    }

    return out;
}

async function main() {
    console.log('\n\x1b[1mprobe-track-timeline — the customer pathway, measured\x1b[0m');
    console.log('\x1b[36mMODE: READ-ONLY.\x1b[0m One POST /api/orders/track-lookup per order. It is a');
    console.log('lookup: nothing is written and no email is sent. There is no --record mode.\n');

    const env = { ...readEnv(), ...process.env };

    /* ---- 1. The positive control must FAIL ---- */
    console.log('\x1b[1m1. Positive control — the pre-change payload must be rejected\x1b[0m');
    {
        const v = violations(FIVE_STEP_CONTROL);
        if (v.length === 0) {
            bad('the 5-step control is rejected',
                'the assertions PASSED the old five-step payload. They have stopped checking anything —\n'
                + 'treat every green below as meaningless until this is fixed.');
        } else {
            ok('the 5-step control is rejected', `${v.length} violation(s), as it should be: ${v[0]}`);
        }
        // And the shape we expect must survive its own rules.
        const clean = {
            status: 'shipped', status_label: 'Shipped — In Transit',
            timeline: [
                { step: 'placed', label: 'Order Placed', completed: true, date: '2026-09-03T01:17:50Z' },
                { step: 'shipped', label: 'Shipped — In Transit', completed: true, date: '2026-09-04T14:39:31Z' },
                { step: 'delivered', label: 'Delivered', completed: false, date: null },
            ],
        };
        const cv = violations(clean);
        if (cv.length) bad('the 3-step shape passes its own rules', `NEGATIVE control failed: ${cv.join('; ')}`);
        else ok('the 3-step shape passes its own rules', 'the ruleset accepts the pathway it describes');
    }

    /* ---- 2. The live pathway ---- */
    console.log('\n\x1b[1m2. The live pathway\x1b[0m');
    const orderNumber = env.TRACK_PROBE_ORDER;
    const email = env.TRACK_PROBE_EMAIL;

    if (!orderNumber || !email) {
        skip('the live timeline shape',
            'TRACK_PROBE_ORDER and/or TRACK_PROBE_EMAIL are not set, so NO LIVE RESPONSE WAS READ.\n'
            + 'The step count, the step labels and status_label were NOT verified against production.\n'
            + 'Set both in .env (the email is a real customer\'s, which is why it is not committed).');
    } else {
        const { status, body } = await lookup(orderNumber, email);
        if (status === 404) {
            bad('the order is lookup-able', `${orderNumber} returned the generic 404. Wrong number, or the email does not match it.`);
        } else if (status === 429) {
            skip('the live timeline shape', 'rate-limited (429). Nothing was verified — wait a minute and re-run.');
        } else if (!body?.ok || !body?.data) {
            bad('the order is lookup-able', `HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);
        } else {
            const data = body.data;
            const keys = (data.timeline || []).map(s => s?.step);
            console.log(`  order ${data.order_number} · status ${data.status} · badge "${data.status_label}"`);
            console.log(`  timeline: [${keys.join(' → ')}]`);
            for (const s of data.timeline || []) {
                console.log(`      ${String(s?.completed ? '●' : '○')} ${String(s?.step).padEnd(11)} "${s?.label}"  ${s?.date ?? '(no date)'}`);
            }

            const v = violations(data);
            if (v.length === 0) {
                ok('the live pathway is three steps', `[${keys.join(' → ')}] with no retired step or label`);
            } else {
                for (const line of v) bad('the live pathway', line);
            }

            // A step that is `completed` but dateless is what made `Processing`
            // worth removing — report it wherever it survives, without failing:
            // `delivered` legitimately has no date until it is delivered.
            const datelessDone = (data.timeline || []).filter(s => s?.completed && !s?.date);
            if (datelessDone.length) {
                soft('a completed step carries no date',
                    `${datelessDone.map(s => s.step).join(', ')} — the stepper lights the dot and prints nothing under it.`);
            }
        }
    }

    /* ---- 3. The cancelled path ---- */
    console.log('\n\x1b[1m3. The cancelled path — still its own shape\x1b[0m');
    {
        const cOrder = env.TRACK_PROBE_CANCELLED_ORDER;
        const cEmail = env.TRACK_PROBE_CANCELLED_EMAIL || email;
        if (!cOrder || !cEmail) {
            skip('the cancelled timeline',
                'TRACK_PROBE_CANCELLED_ORDER (and an email for it) are not set — the [placed, cancelled]\n'
                + 'shape was NOT verified. 19 orders in the event log have reached `cancelled`, so this is testable.');
        } else {
            const { status, body } = await lookup(cOrder, cEmail);
            if (!body?.ok || !body?.data) {
                skip('the cancelled timeline', `lookup returned HTTP ${status} — nothing verified.`);
            } else {
                const keys = (body.data.timeline || []).map(s => s?.step);
                const v = violations(body.data);
                if (body.data.status !== 'cancelled') {
                    skip('the cancelled timeline', `order ${cOrder} is "${body.data.status}", not cancelled — nothing verified.`);
                } else if (v.length === 0) {
                    ok('the cancelled timeline', `[${keys.join(' → ')}]`);
                } else {
                    for (const line of v) bad('the cancelled timeline', line);
                }
            }
        }
    }

    /* ---- 4. Not checked here ---- */
    console.log('\n\x1b[1m4. Not checked here\x1b[0m');
    console.log('  • The `paid` badge reading "Preparing for dispatch". That needs an order that is');
    console.log('    paid-and-not-shipped, which is a state orders leave; point TRACK_PROBE_ORDER at');
    console.log('    one and §2 checks it (the retired-label rule covers it either way).');
    console.log('  • The paid → shipped EDGE. Flipping a live order is a write and it emails the');
    console.log('    customer. `npm run probe:shipping-info` §7 reads what the machine has already');
    console.log('    done out of order_events instead.');
    console.log('  • How the stepper LOOKS. buildTimeline() renders whatever arrives; the CSS is');
    console.log('    pinned by tests/tracking-inline-lookup-jun2026.test.js.');

    /* ---- summary ---- */
    console.log(`\n\x1b[1m${'─'.repeat(70)}\x1b[0m`);
    console.log(`\x1b[1m${pass} passed, ${failures.length} failed, ${notes.length} note(s)\x1b[0m`);
    if (notes.length) {
        console.log('\nNotes:');
        for (const n of notes) console.log(`  • ${n}`);
    }
    if (failures.length) {
        console.log('\n\x1b[31mFailures:\x1b[0m');
        for (const f of failures) console.log(`  • ${f}`);
        process.exit(1);
    }
    process.exit(0);
}

main().catch((e) => {
    console.error(`\n\x1b[31mCould not run:\x1b[0m ${e?.stack || e}`);
    process.exit(2);
});
