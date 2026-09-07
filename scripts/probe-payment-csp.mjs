#!/usr/bin/env node
/**
 * Is PayPal still able to run on the payment page? (ERR-225)
 * ==========================================================
 *
 * Our own CSP was blocking the PayPal SDK on production. `script-src` allowed
 * the paypal.com ORIGIN, so the SDK downloaded and `payment-page.js` logged
 * "PayPal button initialized successfully" — and then the SDK's INLINE script
 * was refused by the same directive. An entire payment method was dead at the
 * last step of checkout, on every device, while the page reported success.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS PROBE
 * ------------------------------------------------
 * The fix is a SHA-256 hash of an inline script that PayPal controls. That is
 * fragile by construction: the day PayPal ships an SDK whose inline script
 * differs by one byte, the hash stops matching, PayPal breaks again — and
 * breaks the same silent way, with a success log and no error anywhere a
 * customer or an owner would look.
 *
 * WHAT THIS PROBE CANNOT DO, STATED PLAINLY
 * -----------------------------------------
 * It CANNOT verify the hash still matches. The blocked script is created by the
 * SDK at runtime, not carried in its body — measured: the SDK response is
 * ~100KB and contains no `<script` at all — so there is nothing to recompute
 * from outside a browser. Only a real browser can adjudicate that.
 *
 * So it does the two things that ARE checkable, and says so by name:
 *   §1 the DEPLOYED header still carries the hash (repo and production drift)
 *   §2 PayPal's SDK body still hashes to what it did when the fix was verified
 *      — a change there is the signal to re-verify in a browser
 * A change in §2 is a NOTE, not a failure: PayPal shipping a new SDK is normal
 * and usually harmless. It is reported so nobody has to notice it by accident.
 *
 * ── READ-ONLY. THE MODE IS PRINTED BEFORE ANY WORK. ─────────────────────────
 * Two GETs. No --record and no baseline file: the SDK hash lives in this source
 * as a committed constant, because a probe that can rewrite what it compares
 * against may be green only because it just overwrote it (sweep:b2b ate a
 * committed fixture, 2026-08-12).
 *
 * It lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel
 * output directory and is served publicly.
 *
 * Usage:  npm run probe:payment-csp
 * Exit:   0 = PayPal can still run
 *         1 = the deployed CSP no longer permits it
 *         2 = could not run (network). "We could not look" is never reported
 *             as "we looked and it was fine".
 */

import crypto from 'node:crypto';

const SITE = process.env.SITE_BASE || 'https://www.inkcartridges.co.nz';
const PAYPAL_INLINE_HASH = "'sha256-n8SeBQJ44hfg74TlDOKj4U2ORkgMfIj5ms8CC25yEBk='";
const CLIENT_ID = 'ASCSnoeTrj2EkqTuWH_JBnuCzYzGVcGk05BpeeTu46up60pJIBsbVN0Z6Prvj9Bjq6YXsGYNOOfKwHAG';
const SDK_URL = `https://www.paypal.com/sdk/js?client-id=${CLIENT_ID}&currency=NZD&disable-funding=card`;

/**
 * PayPal's SDK body sha256 on the day the CSP hash was verified in a browser.
 *
 * Computed BY THIS PROBE, with this probe's own fetch — not by hand with curl.
 * The first version of this constant was a curl-derived hash of the COMPRESSED
 * body (99,898 bytes) compared against fetch's DECOMPRESSED body (394,801), so
 * it could never match and the probe cried wolf on its very first run. **A
 * baseline computed by a different tool than the checker is not a baseline** —
 * it is a guaranteed false alarm, and a probe that always warns is a probe
 * everyone learns to ignore. Verified stable across three consecutive fetches.
 */
const SDK_BODY_SHA256_AT_VERIFICATION = '0d454d59b41c5a835231eedf222279e7';
const VERIFIED_ON = '2026-09-07';

let pass = 0;
const failures = [];
const notes = [];
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const cannotRun = (m) => { console.log(`\n\x1b[33m▲ probe could not run\x1b[0m — ${m}`); process.exit(2); };

console.log('\n\x1b[1mprobe:payment-csp — can PayPal still run on /payment? (ERR-225)\x1b[0m');
console.log('\x1b[36mMODE: READ-ONLY\x1b[0m — two GETs, no writes, no baseline file.');
console.log(`Site: ${SITE}\n`);

const run = async () => {
    // ── §1 ────────────────────────────────────────────────────────────────
    console.log('\x1b[1m§1 — the DEPLOYED header still permits PayPal\x1b[0m');
    let csp = '';
    try {
        const res = await fetch(`${SITE}/payment`, { redirect: 'follow' });
        csp = res.headers.get('content-security-policy') || '';
        if (!csp) {
            bad('no CSP header on /payment',
                'the page is being served without a Content-Security-Policy at all — either the '
                + 'header config was dropped or this is not the production host.');
        } else {
            ok(`/payment answers ${res.status} with a CSP header`);
            const script = csp.split(';').map(s => s.trim()).find(s => s.startsWith('script-src '));
            if (!script) {
                bad('no script-src directive', 'the CSP exists but does not constrain scripts');
            } else if (script.includes(PAYPAL_INLINE_HASH)) {
                ok("script-src carries PayPal's inline-script hash");
            } else {
                bad('THE PAYPAL HASH IS NOT IN THE DEPLOYED CSP',
                    'the SDK will download and then be refused execution — PayPal is dead at the '
                    + 'last step of checkout, and the page still logs "PayPal button initialized '
                    + 'successfully". Repo and production have drifted, or the fix was reverted.');
            }
            if (script && script.includes("'unsafe-inline'")) {
                bad("script-src now carries 'unsafe-inline'",
                    'this unblocks PayPal and every other injected script on the payment page. '
                    + 'It is not the fix.');
            }
            for (const need of ['https://js.stripe.com', 'https://challenges.cloudflare.com']) {
                if (script && script.includes(need)) ok(`script-src still allows ${need}`);
                else bad(`script-src no longer allows ${need}`,
                    need.includes('stripe') ? 'card payment would be dead' : 'guests cannot pay without Turnstile');
            }
        }
    } catch (e) {
        cannotRun(`${SITE}/payment unreachable: ${e.message}`);
    }

    // ── §2 ────────────────────────────────────────────────────────────────
    console.log('\n\x1b[1m§2 — has PayPal changed the SDK the hash was verified against?\x1b[0m');
    try {
        const res = await fetch(SDK_URL);
        if (res.status !== 200) {
            soft('PayPal SDK did not return 200', `status ${res.status} — cannot compare`);
        } else {
            const body = await res.text();
            const sha = crypto.createHash('sha256').update(body).digest('hex').slice(0, 32);
            console.log(`    SDK body sha256(32): ${sha}  ·  ${body.length} bytes`);
            if (sha === SDK_BODY_SHA256_AT_VERIFICATION) {
                ok(`unchanged since the hash was verified in a browser on ${VERIFIED_ON}`);
            } else {
                soft('PAYPAL HAS SHIPPED A NEW SDK — RE-VERIFY IN A REAL BROWSER',
                    `body hash is ${sha}, was ${SDK_BODY_SHA256_AT_VERIFICATION} on ${VERIFIED_ON}. `
                    + 'This is usually harmless, and it is NOT a failure. But the CSP fix is a hash of '
                    + "an inline script PayPal controls, so a new SDK is the one event that can silently "
                    + 'invalidate it. Open /payment on the live site as a guest and confirm the PayPal '
                    + 'button renders; if it does not, the console names the new hash to allowlist.');
            }
        }
    } catch (e) {
        soft('PayPal SDK unreachable', `${e.message} — §2 not checked this run`);
    }

    // ── §3 ────────────────────────────────────────────────────────────────
    console.log('\n\x1b[1m§3 — what this probe did NOT check\x1b[0m');
    soft('THE HASH ITSELF IS UNVERIFIED BY THIS RUN',
        'the blocked script is built by the SDK at runtime and is not in its body, so it cannot be '
        + 'recomputed outside a browser. A green §1 means the CSP still ALLOWS the hash we recorded — '
        + 'not that PayPal still PRODUCES it. A skip is not a pass.');

    console.log(`\n\x1b[1mResult:\x1b[0m ${pass} passed, ${failures.length} failed, ${notes.length} noted.`);
    if (notes.length) { console.log('\nNoted:'); notes.forEach(n => console.log(`  ~ ${n}`)); }
    if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log(`  ✗ ${f}`)); process.exit(1); }
    console.log('\x1b[32mThe deployed CSP still permits PayPal to run.\x1b[0m\n');
};

run().catch((e) => { console.error('\nProbe crashed:', e); process.exit(2); });
