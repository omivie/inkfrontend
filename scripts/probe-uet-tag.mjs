#!/usr/bin/env node
/**
 * Is the Microsoft UET tag actually alive on production? (ERR-278)
 * ================================================================
 *
 * The Microsoft Ads account held a UET tag (INKCART, id 97269770) in state
 * `Unverified`, which does not mean broken — it means NEVER INSTALLED. This
 * probe exists because of how the two previous tracking tags on this site
 * failed: SILENTLY, and for a reason no dashboard could show.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS PROBE
 * ------------------------------------------------
 * `bat.bing.com` has to be in BOTH `script-src` and `connect-src`, and the two
 * fail COMPLETELY DIFFERENTLY:
 *
 *   script-src  — blocks bat.js outright. Loud. Nothing works. Easy.
 *   connect-src — blocks ONLY the fetch/sendBeacon transport. And `img-src` is
 *                 'self' https: data:, so UET's PIXEL transport keeps working.
 *                 The tag looks completely healthy. Requests to bat.bing.com
 *                 appear in the network panel and return 200. Conversions just
 *                 quietly do not arrive.
 *
 * That second shape is ERR-260 exactly — `*.google.com` did not match
 * `www.google.co.nz`, and one of its three alibis was this very `img-src
 * https:` making the host look perfectly reachable. So §4 does not ask "did
 * anything reach Microsoft". It asks WHICH TRANSPORT CARRIED IT, by name. A
 * check that tells you something is wrong without naming it is one debugging
 * session away from being ignored.
 *
 * AND LOCAL RUNS PROVE NOTHING. serve.json sets no headers at all, so
 * localhost has NO CSP — every local run is green by construction. That was
 * ERR-260's third alibi and it cost three days. This probe targets production
 * and refuses to run against a host that serves no CSP.
 *
 * ── READ-ONLY with respect to OUR systems. THE MODE IS PRINTED BELOW. ───────
 * No --record, no baseline file, nothing written to this repo: a probe that can
 * rewrite what it compares against may be green only because it just overwrote
 * it (sweep:b2b ate a committed fixture, 2026-08-12).
 *
 * ⚠️  BUT §4 IS A BROWSER-DRIVEN WRITER, AND THAT IS NOT THE SAME THING.
 * Loading the real site in a real browser makes THE BROWSER fire a real UET
 * pageview into the live Microsoft Advertising account. It is one pageview per
 * run, it is indistinguishable from a visitor, and no source-grep guard can see
 * it — that is ERR-271 verbatim, where five probes wrote to production
 * analytics unseen by the guard built to stop exactly that. It is stated here
 * and printed at runtime so nobody has to discover it later.
 * §4 fires NO purchase: a conversion needs a real paid order.
 *
 * It lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel
 * output directory and is served publicly.
 *
 * Usage:  npm run probe:uet-tag
 *         SITE_BASE=https://…  to point elsewhere
 *         UET_SKIP_BROWSER=1   to run §0-§3 only (§4 reports NOT EXERCISED)
 * Exit:   0 = every check that RAN passed
 *         1 = a real failure
 *         2 = could not run. "We could not look" is never reported as
 *             "we looked and it was fine".
 */

const SITE = process.env.SITE_BASE || 'https://www.inkcartridges.co.nz';
const UET_HOST = 'https://bat.bing.com';
const BAT_JS = 'https://bat.bing.com/bat.js';
const TAG_ID = '97269770';

let failed = 0;
let notExercised = 0;

const ok = (msg) => console.log(`  \x1b[32mPASS\x1b[0m  ${msg}`);
const bad = (msg) => { failed++; console.log(`  \x1b[31mFAIL\x1b[0m  ${msg}`); };
const note = (msg) => console.log(`  ....  ${msg}`);
const skip = (msg) => { notExercised++; console.log(`  \x1b[33mNOT EXERCISED\x1b[0m  ${msg}`); };

function directives(csp) {
    const out = {};
    for (const part of String(csp).split(';')) {
        const t = part.trim().split(/\s+/).filter(Boolean);
        if (t.length) out[t[0]] = t.slice(1);
    }
    return out;
}

console.log('\nUET TAG PROBE — Microsoft Advertising (ERR-278)');
console.log(`  target: ${SITE}`);
console.log('  MODE:   READ-ONLY against this repo and our backend.');
console.log('          §4 loads the site in a real browser, which sends ONE real');
console.log('          UET pageview to the live Microsoft account (ERR-271).');
console.log('          No purchase is fired.\n');

/* ── §0 NEGATIVE CONTROL ─────────────────────────────────────────────────────
   The only reason to believe anything below. If the detector cannot report a
   host that is genuinely absent, then every PASS it prints is worthless —
   ERR-258, six guards that could not fail sitting inside a green suite. */
console.log('§0 negative control — can this probe detect an absent host at all?');
let CSP;
try {
    const res = await fetch(SITE, { redirect: 'follow' });
    CSP = res.headers.get('content-security-policy');
    if (!CSP) {
        console.log('  \x1b[31mABORT\x1b[0m  that host serves NO CSP header.');
        console.log('         localhost serves none, so a run there is green by construction');
        console.log('         and proves nothing (ERR-260, alibi #3). Point at production.');
        process.exit(2);
    }
    const d = directives(CSP);
    const bogus = 'https://uet-probe-negative-control.invalid';
    if (d['script-src'].includes(bogus)) {
        bad('a host that cannot exist was reported present — the parser is broken');
    } else {
        ok('a known-absent host is correctly reported absent');
    }
    if (!d['script-src'].includes("'self'")) {
        bad("the parser failed to find 'self' in script-src — it is not reading the policy");
    } else {
        ok("the parser finds a token it must find ('self')");
    }
} catch (err) {
    console.log(`  \x1b[31mABORT\x1b[0m  could not fetch ${SITE}: ${err.message}`);
    process.exit(2);
}

/* ── §1 THE DEPLOYED POLICY ────────────────────────────────────────────────── */
console.log('\n§1 the DEPLOYED CSP (not the repo copy — they drift)');
{
    const d = directives(CSP);
    if (d['script-src'].includes(UET_HOST)) ok('script-src carries bat.bing.com');
    else bad('script-src is MISSING bat.bing.com — bat.js cannot load at all');

    if (d['connect-src'].includes(UET_HOST)) {
        ok('connect-src carries bat.bing.com  <- the half that fails invisibly');
    } else {
        bad('connect-src is MISSING bat.bing.com. THE TAG WILL STILL LOOK ALIVE: ' +
            "img-src is 'self' https: data: so the pixel transport works. " +
            'Conversions will simply not arrive. This is ERR-260.');
    }
}

/* ── §2 MICROSOFT'S SCRIPT IS SERVABLE ─────────────────────────────────────── */
console.log('\n§2 bat.js is reachable and is really JavaScript');
try {
    const res = await fetch(BAT_JS);
    const type = res.headers.get('content-type') || '';
    if (!res.ok) bad(`${BAT_JS} returned ${res.status}`);
    else if (!/javascript|ecmascript/i.test(type)) bad(`bat.js served as "${type}", not JavaScript`);
    else ok(`bat.js 200 (${type.split(';')[0]})`);
} catch (err) {
    skip(`could not reach bat.bing.com: ${err.message} — network, not a verdict`);
}

/* ── §3 THE DEPLOYED TAG ID ────────────────────────────────────────────────── */
console.log('\n§3 the deployed gtag.js carries the real tag id');
try {
    const home = await fetch(SITE).then((r) => r.text());
    const m = home.match(/src="(\/js\/gtag\.js(?:\?v=[a-f0-9]+)?)"/);
    if (!m) {
        bad('the homepage does not load /js/gtag.js — UET has no host file');
    } else {
        const raw = await fetch(new URL(m[1], SITE)).then((r) => r.text());
        // STRIP COMMENTS BEFORE ASKING ANYTHING ABOUT THE CODE.
        // The first production run of this probe reported "a UET consent
        // default is declared" — against a file that declares none. What it
        // matched was the COMMENT explaining why we deliberately do not call
        // that API, which necessarily spells the call out. A comment that NAMES
        // a thing is not that thing (ERR-276, where prose satisfied an
        // assertion four times in one change; here it fails one instead).
        // A probe that reddens on a benign condition is red for ever and gets
        // ignored, taking the next real failure with it.
        const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (!src.includes(`'${TAG_ID}'`)) {
            bad(`deployed gtag.js does not contain tag id ${TAG_ID} — repo/production drift, ` +
                'or the id was emptied. An empty id ships a tag that silently does nothing.');
        } else ok(`deployed gtag.js carries tag id ${TAG_ID}`);
        if (/uetq\.push\(\s*'consent'/.test(src)) {
            bad('a UET consent default is declared on production (ERR-227 shape) — ' +
                'ad_storage is granted by deliberate omission for Google; diverging for ' +
                'Microsoft alone restricts it for 100% of visitors with no symptom');
        } else ok('no UET consent default is declared (deliberate — see gtag.js)');
    }
} catch (err) {
    skip(`could not read the deployed gtag.js: ${err.message}`);
}

/* ── §4 THE WIRE ───────────────────────────────────────────────────────────── */
console.log('\n§4 a real browser: does bat.js load, and WHICH TRANSPORT reaches Microsoft?');
if (process.env.UET_SKIP_BROWSER) {
    skip('UET_SKIP_BROWSER=1 — the only section that can see a connect-src block did not run');
} else {
    let chromium;
    try {
        ({ chromium } = await import('playwright'));
    } catch {
        skip('playwright is not installed — §1-§3 cannot see a connect-src block, only §4 can');
    }
    if (chromium) {
        let browser;
        try {
            browser = await chromium.launch();
            // NO ctx.route() ANYWHERE IN THIS FILE. An interception handler
            // bypasses the browser's own CORS and CSP enforcement, so a probe
            // that registers one is no longer measuring the transport it claims
            // to be measuring.
            const ctx = await browser.newContext();
            const page = await ctx.newPage();

            const refusals = [];
            const hits = [];
            page.on('console', (msg) => {
                const t = msg.text();
                if (/Content Security Policy|violates the following/i.test(t) && /bat\.bing|bing/i.test(t)) {
                    refusals.push(t);
                }
            });
            page.on('requestfailed', (req) => {
                if (/bat\.bing\.com/.test(req.url())) {
                    refusals.push(`${req.resourceType()} ${req.url()} :: ${req.failure()?.errorText}`);
                }
            });
            page.on('request', (req) => {
                if (/bat\.bing\.com/.test(req.url())) hits.push({ type: req.resourceType(), url: req.url() });
            });

            await page.goto(SITE, { waitUntil: 'networkidle', timeout: 45000 });
            await page.waitForTimeout(3000);

            const loaded = await page.evaluate(() =>
                typeof window.uetq !== 'undefined' && !Array.isArray(window.uetq));

            const script = hits.find((h) => /bat\.js/.test(h.url));
            if (script) ok(`bat.js was requested (${script.type})`);
            else bad('bat.js was never requested — the tag did not initialise');

            // "Nothing was refused" is only evidence when something was
            // ATTEMPTED. Reporting a clean CSP on a page that never asked for
            // bat.js is a check passing because nothing happened — a skip
            // wearing a pass's clothes, and the exact shape that lets the next
            // real refusal through unnoticed.
            if (refusals.length) {
                for (const r of refusals) bad(`REFUSED: ${r}`);
            } else if (!hits.length) {
                skip('no bing-bound request was attempted, so "nothing was refused" ' +
                     'proves nothing about the CSP');
            } else {
                ok('nothing bing-bound was refused by the CSP');
            }

            if (loaded) ok('window.uetq is a live UET object — bat.js ran');
            else bad('window.uetq is still the queue array — bat.js did not execute');

            // THE NAMED TRANSPORT CHECK. Not "did anything reach Microsoft".
            const beacons = hits.filter((h) => !/bat\.js/.test(h.url));
            if (!beacons.length && !loaded) {
                // Already reported above; do not describe a beacon failure as
                // though the script had run. A probe that misdescribes the
                // state it found teaches people to distrust it.
                skip('no beacon — bat.js never executed, so there was nothing to send');
            } else if (!beacons.length) {
                bad('bat.js executed but no beacon left the page — it reported nothing');
            } else {
                const byType = [...new Set(beacons.map((b) => b.type))].join(', ');
                ok(`${beacons.length} beacon(s) to bat.bing.com, transport: ${byType}`);
                if (!beacons.some((b) => /fetch|xhr/.test(b.type))) {
                    note('all beacons were IMAGE/pixel. That is normal for a pageview — but');
                    note('it is also exactly what a connect-src block looks like, because');
                    note('img-src https: lets pixels through. §1 is what distinguishes them.');
                }
            }
        } catch (err) {
            skip(`browser run could not complete: ${err.message}`);
        } finally {
            if (browser) await browser.close();
        }
    }
}

/* ── VERDICT ───────────────────────────────────────────────────────────────── */
console.log('\n─────────────────────────────────────────────────────────');
if (failed) {
    console.log(`  \x1b[31m${failed} FAILED\x1b[0m${notExercised ? `, ${notExercised} not exercised` : ''}`);
    process.exit(1);
}
if (notExercised) {
    // A green sentence covering a gap is worse than a yellow one, because it is
    // the line people read instead of the log.
    console.log(`  \x1b[33mno failures, but ${notExercised} check(s) DID NOT RUN\x1b[0m — not a clean bill of health`);
    process.exit(0);
}
console.log('  \x1b[32mall checks passed\x1b[0m');
console.log('  NOTE: this cannot verify a PURCHASE conversion — that needs a real');
console.log('        paid order. Confirm the first live order in Microsoft Ads.');
process.exit(0);
