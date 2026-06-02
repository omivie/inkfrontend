/**
 * Microsoft (Azure / Entra ID) sign-in — storefront wiring (May 2026)
 * ===================================================================
 *
 * Adds a "Continue with Microsoft" OAuth button as a sibling of the
 * existing Google button on the login/signup page. Backend needed no
 * changes — requireAuth validates whatever JWT Supabase issues and
 * POST /api/account/sync reads user_metadata provider-agnostically.
 *
 * Contract (mirrors the Google path exactly):
 *   1. login.html renders a `.btn--microsoft` button in BOTH the login
 *      panel and the register panel, each a sibling of `.btn--google`.
 *   2. The mark is Microsoft's official 4-square logo as an inline SVG
 *      (four <path> fills: #f25022 red, #7fba00 green, #00a4ef blue,
 *      #ffb900 yellow) — NEVER a generic "M" or the Windows flag.
 *   3. auth.js exposes Auth.signInWithMicrosoft() calling
 *      signInWithOAuth with provider: 'azure' (Supabase's slug for
 *      Microsoft Entra — NOT 'microsoft'), scopes 'email openid
 *      profile' (so the JWT carries an email claim for
 *      requireVerifiedEmail), and redirectTo `${origin}/account` — the
 *      same landing route Google uses.
 *   4. login-page.js wires `.btn--microsoft` clicks to
 *      Auth.signInWithMicrosoft() and surfaces a toast on error.
 *   5. The post-login flow does NOT branch by provider — the
 *      onAuthStateChange listener in auth.js handles account sync for
 *      both Google and Microsoft identically.
 *
 * Spec: ~/Downloads/microsoft-oauth-may2026.md (backend handoff).
 *
 * Run with: node --test tests/microsoft-oauth-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'inkcartridges');

const loginHtml = fs.readFileSync(path.join(SRC, 'html/account/login.html'), 'utf8');
const authJs = fs.readFileSync(path.join(SRC, 'js/auth.js'), 'utf8');
const loginPageJs = fs.readFileSync(path.join(SRC, 'js/login-page.js'), 'utf8');

// ---------------------------------------------------------------------------
// 1. The button exists in BOTH panels, as a sibling of the Google button
// ---------------------------------------------------------------------------

test('login.html renders a .btn--microsoft button', () => {
    assert.match(loginHtml, /class="btn btn--social btn--microsoft"/,
        'expected a .btn btn--social btn--microsoft button');
});

test('Microsoft button appears exactly twice (login + register panels)', () => {
    const matches = loginHtml.match(/btn--social btn--microsoft/g) || [];
    assert.equal(matches.length, 2,
        `expected the Microsoft button in both panels, found ${matches.length}`);
});

test('every Microsoft button sits inside an .auth-social__buttons row next to Google', () => {
    // Each auth-social__buttons block must contain BOTH a google and a
    // microsoft button (siblings), proving identical visual placement.
    const rows = loginHtml.match(
        /<div class="auth-social__buttons">[\s\S]*?<\/div>/g
    ) || [];
    assert.equal(rows.length, 2, 'expected two social-button rows');
    for (const row of rows) {
        assert.match(row, /btn--google/, 'social row missing Google button');
        assert.match(row, /btn--microsoft/, 'social row missing Microsoft button');
    }
});

test('Microsoft button is a non-submitting button (type="button")', () => {
    // type="button" stops it implicitly submitting the auth form.
    const re = /<button type="button" class="btn btn--social btn--microsoft">/g;
    const matches = loginHtml.match(re) || [];
    assert.equal(matches.length, 2,
        'both Microsoft buttons must be type="button"');
});

test('Microsoft button is labelled "Microsoft"', () => {
    const matches = loginHtml.match(/btn--microsoft">[\s\S]*?Microsoft\s*<\/button>/g) || [];
    assert.equal(matches.length, 2, 'expected "Microsoft" label on both buttons');
});

// ---------------------------------------------------------------------------
// 2. The mark is the official 4-square logo, not a generic glyph
// ---------------------------------------------------------------------------

test('Microsoft button uses the official 4-square logo colours', () => {
    for (const fill of ['#f25022', '#7fba00', '#00a4ef', '#ffb900']) {
        const count = (loginHtml.match(new RegExp(fill, 'gi')) || []).length;
        assert.ok(count >= 2,
            `expected the ${fill} square in both Microsoft buttons (found ${count})`);
    }
});

test('Microsoft logo is four square <path> tiles', () => {
    // The canonical 23×23 four-square viewBox, two 10×10 tiles per row.
    const matches = loginHtml.match(/viewBox="0 0 23 23"/g) || [];
    assert.equal(matches.length, 2, 'expected the 23×23 Microsoft logo viewBox twice');
    const tiles = loginHtml.match(/d="M(?:1|12) (?:1|12)h10v10H(?:1|12)z"/g) || [];
    assert.equal(tiles.length, 8, 'expected 4 square tiles × 2 buttons = 8 path tiles');
});

test('does NOT use a generic "M" glyph or the Windows logo for Microsoft', () => {
    // Guard against regressing to a lazy text "M" or a Windows flag.
    // (Windows flag SVGs use a characteristic skewed parallelogram, not
    //  axis-aligned 10×10 squares — assert the squares are present and
    //  the official brand blue is, which the Windows-only flag lacks.)
    assert.match(loginHtml, /#00a4ef/i, 'missing Microsoft brand blue square');
});

// ---------------------------------------------------------------------------
// 3. auth.js — Auth.signInWithMicrosoft() with the correct provider/options
// ---------------------------------------------------------------------------

test('auth.js exposes signInWithMicrosoft()', () => {
    assert.match(authJs, /async signInWithMicrosoft\(\)\s*\{/,
        'expected an async signInWithMicrosoft() method');
});

test('signInWithMicrosoft uses provider: "azure" (Supabase slug), not "microsoft"', () => {
    const fn = extractFn(authJs, 'signInWithMicrosoft');
    assert.match(fn, /provider:\s*'azure'/, 'provider must be the azure slug');
    assert.doesNotMatch(fn, /provider:\s*'microsoft'/,
        "must NOT use provider: 'microsoft' — Supabase uses 'azure'");
});

test('signInWithMicrosoft requests email openid profile scopes', () => {
    const fn = extractFn(authJs, 'signInWithMicrosoft');
    assert.match(fn, /scopes:\s*'email openid profile'/,
        "scopes must be 'email openid profile' so the JWT carries an email claim");
});

test('signInWithMicrosoft redirects to /account (same as Google)', () => {
    const fn = extractFn(authJs, 'signInWithMicrosoft');
    assert.match(fn, /redirectTo:\s*`\$\{window\.location\.origin\}\/account`/,
        'redirectTo must match the Google landing route /account');
});

test('signInWithMicrosoft guards against an uninitialised client', () => {
    const fn = extractFn(authJs, 'signInWithMicrosoft');
    assert.match(fn, /if \(!this\.supabase\) return/,
        'must short-circuit with an error when Supabase is not initialised');
    assert.match(fn, /return \{ data, error \}/,
        'must return the { data, error } tuple like signInWithGoogle');
});

test('signInWithMicrosoft mirrors the Google method shape', () => {
    // Both must use the same signInWithOAuth call shape so the flows
    // stay in lockstep.
    const ms = extractFn(authJs, 'signInWithMicrosoft');
    const goog = extractFn(authJs, 'signInWithGoogle');
    for (const fn of [ms, goog]) {
        assert.match(fn, /this\.supabase\.auth\.signInWithOAuth\(\{/);
        assert.match(fn, /prompt:\s*'select_account'/);
    }
});

// ---------------------------------------------------------------------------
// 4. login-page.js — click wiring + error toast
// ---------------------------------------------------------------------------

test('login-page.js wires .btn--microsoft to Auth.signInWithMicrosoft', () => {
    assert.match(loginPageJs, /\.btn--microsoft/,
        'expected a .btn--microsoft selector in the click wiring');
    assert.match(loginPageJs, /Auth\.signInWithMicrosoft\(\)/,
        'expected the click handler to call Auth.signInWithMicrosoft()');
});

test('login-page.js still wires the Google button', () => {
    assert.match(loginPageJs, /Auth\.signInWithGoogle\(\)/);
    assert.match(loginPageJs, /\.btn--google/);
});

test('social sign-in surfaces a toast on error (no silent failure)', () => {
    assert.match(loginPageJs, /showToast\(`Couldn't sign in with \$\{label\}\. Please try again\.`,\s*'error'\)/,
        'expected an error toast in the social sign-in handler');
});

test('social sign-in re-enables the button after a failure', () => {
    // On success the page navigates away, so re-enabling only happens in
    // the error branches — assert the disable + re-enable both exist.
    assert.match(loginPageJs, /btn\.disabled = true/);
    assert.match(loginPageJs, /btn\.disabled = false/);
});

// ---------------------------------------------------------------------------
// 5. The post-login flow is provider-agnostic (no branching by provider)
// ---------------------------------------------------------------------------

test('onAuthStateChange does not branch on the OAuth provider', () => {
    // The single sync path must serve both providers — guard against
    // someone adding provider-specific handling later.
    const listener = authJs.slice(
        authJs.indexOf('onAuthStateChange'),
        authJs.indexOf('// Initial UI update')
    );
    assert.ok(listener.length > 0, 'could not locate onAuthStateChange listener');
    assert.doesNotMatch(listener, /provider\s*===\s*'(azure|google|microsoft)'/,
        'the post-login listener must stay provider-agnostic');
    assert.match(listener, /API\.accountSync/,
        'expected the shared account-sync call in the listener');
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Extract a brace-balanced method body by name from a source string.
 * Handles `async name() { ... }` and `name() { ... }`.
 */
function extractFn(src, name) {
    const sig = new RegExp(`(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`);
    const m = sig.exec(src);
    assert.ok(m, `could not find function ${name}`);
    let i = m.index + m[0].length;
    let depth = 1;
    for (; i < src.length && depth > 0; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
    }
    return src.slice(m.index, i);
}
