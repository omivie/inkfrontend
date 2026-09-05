/**
 * "REMEMBER ME" — LIVE BROWSER VERIFICATION (ERR-209)
 *
 * This is the only place the feature can actually be proved. A unit test cannot
 * observe a cookie's expiry (JavaScript cannot read max-age) or a browser
 * restart, and those are exactly the two things that separate the modes — which
 * is why the original bug measured as "byte-identical persistence".
 *
 * NOT a probe. Every `probe:*` script in this repo is read-only; this performs a
 * REAL sign-in, which mints a real refresh token on the auth server. That side
 * effect is unavoidable rather than opt-in, so it is registered as
 * `npm run verify:remember-me` and the mode is printed below.
 *
 *   BASE_URL=http://localhost:3000 E2E_EMAIL=... E2E_PASSWORD=... \
 *   npm run verify:remember-me
 *
 * Uses the `playwright` library directly — `@playwright/test` is not a
 * dependency of this repo.
 */

import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'https://www.inkcartridges.co.nz';
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const P = 'sb-lmdlgldjgcanknsjrcxh-auth-token';

console.log('MODE: LIVE SIGN-IN — creates a real session. Writes nothing to this repo.');
console.log(`TARGET: ${BASE_URL}\n`);

// A SKIP IS NOT A PASS: name the script and the missing input, and exit non-zero.
if (!EMAIL || !PASSWORD) {
    console.error('SKIPPED verify-remember-me: E2E_EMAIL and E2E_PASSWORD are required.');
    console.error('NOTHING WAS VERIFIED.');
    process.exit(2);
}

const results = [];
const check = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? `  — ${detail}` : ''}`);
};

async function signIn(page, remember) {
    await page.goto(`${BASE_URL}/account/login`);
    await page.locator('#login-email').fill(EMAIL);
    await page.locator('#login-password').fill(PASSWORD);
    if (remember) await page.locator('#remember-me').check();
    else await page.locator('#remember-me').uncheck();
    await page.locator('#login-form button[type="submit"]').click();
    // NOT waitForURL(/\/account/) — that matches /account/login and returns
    // instantly, reading storage before sign-in has written anything. Wait for
    // a real session on a page that is not the login page.
    await page.waitForFunction(
        () => !!window.Auth?.session && !location.pathname.startsWith('/account/login'),
        { timeout: 30000 }
    );
    return page.evaluate(p => ({
        mode: localStorage.getItem('ic_auth_persist'),
        local: Object.keys(localStorage).filter(k => k.startsWith(p)),
        session: Object.keys(sessionStorage).filter(k => k.startsWith(p)),
        sg: Object.keys(localStorage).filter(k => k.startsWith('sg-auth'))
    }), P);
}

/**
 * A browser restart is exactly: drop sessionStorage, drop session cookies, keep
 * localStorage and persistent cookies. storageState() serialises localStorage and
 * cookies but NOT sessionStorage, so filtering out session cookies reproduces a
 * restart precisely — without restarting anything.
 */
async function afterRestart(browser, context) {
    const state = await context.storageState();
    const restarted = await browser.newContext({
        storageState: { cookies: state.cookies.filter(c => c.expires > 0), origins: state.origins }
    });
    const page = await restarted.newPage();
    await page.goto(`${BASE_URL}/account`);
    // Give auth.js a moment to hydrate (or fail to) before judging.
    await page.waitForTimeout(1500);
    const signedIn = await page.evaluate(() => !!window.Auth?.session);
    const url = page.url();
    await restarted.close();
    return { url, signedIn };
}

const browser = await chromium.launch();
try {
    // ── A. the default ────────────────────────────────────────────────────
    let ctx = await browser.newContext();
    let page = await ctx.newPage();
    await page.goto(`${BASE_URL}/account/login`);
    check('A. checkbox defaults to TICKED', await page.locator('#remember-me').isChecked());
    await ctx.close();

    // ── B. ticked ─────────────────────────────────────────────────────────
    ctx = await browser.newContext();
    page = await ctx.newPage();
    let s = await signIn(page, true);
    check('B1. ticked → mode "local"', s.mode === 'local', `mode=${s.mode}`);
    check('B2. ticked → token in localStorage', s.local.length === 1 && s.session.length === 0,
        `local=${s.local.length} session=${s.session.length}`);
    check('B3. ticked → site-guard stashed nothing', s.sg.length === 0, `sg-auth keys=${s.sg.length}`);
    let cookie = (await ctx.cookies(BASE_URL)).find(c => c.name === '__ink_auth');
    const days = cookie && cookie.expires > 0 ? (cookie.expires * 1000 - Date.now()) / 86400000 : null;
    check('B4. ticked → persistent 7-day cookie', days !== null && days > 6 && days < 8,
        days === null ? 'session cookie' : `${days.toFixed(2)} days`);
    let r = await afterRestart(browser, ctx);
    check('B5. ticked → SURVIVES a browser restart', r.signedIn, r.url);
    await ctx.close();

    // ── C. unticked ───────────────────────────────────────────────────────
    ctx = await browser.newContext();
    page = await ctx.newPage();
    s = await signIn(page, false);
    check('C1. unticked → mode "session"', s.mode === 'session', `mode=${s.mode}`);
    check('C2. unticked → NOTHING left in localStorage', s.local.length === 0 && s.session.length === 1,
        `local=${s.local.length} session=${s.session.length}`);
    check('C3. unticked → site-guard stashed nothing', s.sg.length === 0, `sg-auth keys=${s.sg.length}`);
    cookie = (await ctx.cookies(BASE_URL)).find(c => c.name === '__ink_auth');
    check('C4. unticked → SESSION cookie (no expiry)', !!cookie && cookie.expires === -1,
        cookie ? `expires=${cookie.expires}` : 'absent');

    // The false-positive guard: an implementation that never persists anything
    // would pass every other check here while being useless.
    await page.reload();
    await page.waitForTimeout(2500);
    check('C5. unticked → STILL signed in after a same-tab reload',
        await page.evaluate(() => !!window.Auth?.session));

    r = await afterRestart(browser, ctx);
    check('C6. unticked → GONE after a browser restart', !r.signedIn, r.url);
    await ctx.close();

    // ── D. no resurrection ────────────────────────────────────────────────
    // Sign in unticked, then plant a stale token on disk exactly as an earlier
    // remembered login would have left it.
    //
    // MEASURED: this check survives EITHER layer being removed on its own — the
    // init-time purge and getItem's blindness each hold the line alone, and it
    // only fails when both go. So read it as pinning the END-TO-END PROPERTY
    // ("a session the user ended cannot come back"), not any one mechanism.
    // The mechanisms are pinned individually by the unit tests: §1c for
    // getItem's missing fallback, §1g for the purge.
    ctx = await browser.newContext();
    page = await ctx.newPage();
    s = await signIn(page, false);
    check('D1. unticked login leaves nothing on disk', s.local.length === 0, `local=${s.local.length}`);

    const planted = await page.evaluate(async p => {
        const live = sessionStorage.getItem(p);
        localStorage.setItem(p, live);          // a stale copy, as a prior remembered login would have left
        return !!live;
    }, P);
    check('D2. a stale on-disk token was planted', planted);

    r = await afterRestart(browser, ctx);
    check('D3. no resurrection: stale on-disk token cannot revive the session', !r.signedIn, r.url);
    await ctx.close();

} finally {
    await browser.close();
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
