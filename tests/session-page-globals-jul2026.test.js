/**
 * Every page must load the scripts its own scripts depend on (Jul 2026)
 * =====================================================================
 *
 * TWO LIVE BUGS PROMPTED THIS (ERR-126), both invisible until a rare branch ran:
 *
 *   1. html/account/reset-password.html loaded NEITHER security.js NOR utils.js,
 *      but js/reset-password-page.js calls `Security.escapeHtml()` to render the
 *      "Reset Link Invalid" message and `DebugLog.error()` in every catch. So an
 *      EXPIRED OR MALFORMED reset link threw a ReferenceError and the page
 *      rendered nothing — the user saw an unchanged password form and no
 *      explanation. The happy path never touched either global, which is exactly
 *      why it survived so long.
 *
 *   2. html/account/verify-email.html loaded auth.js WITHOUT utils.js, and
 *      auth.js calls `DebugLog` from its accountSync/init CATCH blocks — so a
 *      sync failure there threw a second ReferenceError that swallowed the first.
 *
 * THE INVARIANT IS DERIVED, NEVER AN ALLOWLIST. The test reads each page's own
 * script list, reads those scripts, and works out which globals they actually
 * reference. A hand-maintained list of "pages that need utils.js" is precisely
 * the failure mode that let banned copy ship twice (ERR-063) — a list that
 * forgets a file is worse than no list, because it looks like coverage.
 *
 * Guarded references (`typeof X !== 'undefined'`) are treated as OPTIONAL
 * dependencies and skipped: that is the codebase's deliberate idiom for a
 * soft dependency, and honouring it is what keeps this test free of noise.
 *
 * Run with: node --test tests/session-page-globals-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'inkcartridges');

/** global -> the file that defines it. */
const PROVIDERS = {
    Security: 'security.js',
    DebugLog: 'utils.js',
    Config: 'config.js',
    Auth: 'auth.js',
    API: 'api.js',
    OrderTotals: 'order-totals.js',
    OrderReceipt: 'order-receipt.js'
};

/**
 * Remove comments and quoted strings before scanning for globals.
 *
 * Template literals are deliberately LEFT INTACT. Stripping them wholesale hides
 * `${Security.escapeHtml(x)}` interpolations — which is where most of this
 * codebase's DOM rendering lives, and exactly the call that made
 * reset-password.html fail. Keeping them risks a false positive from prose
 * inside a template; missing them risks the false negative this test exists to
 * catch, so the trade goes this way on purpose.
 */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/** Collect every non-admin HTML page. */
function htmlPages() {
    const out = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'admin' || entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.html')) out.push(full);
        }
    };
    walk(path.join(ROOT, 'html'));
    const rootIndex = path.join(ROOT, 'index.html');
    if (fs.existsSync(rootIndex)) out.push(rootIndex);
    return out;
}

/** Ordered list of local /js/*.js filenames a page loads. */
function pageScripts(html) {
    const out = [];
    const re = /<script[^>]*\bsrc="\/js\/([^"?]+\.js)(?:\?[^"]*)?"/g;
    let m;
    while ((m = re.exec(html)) !== null) out.push(m[1]);
    return out;
}

const cache = new Map();
function readJs(name) {
    if (cache.has(name)) return cache.get(name);
    const full = path.join(ROOT, 'js', name);
    const src = fs.existsSync(full) ? codeOnly(fs.readFileSync(full, 'utf8')) : null;
    cache.set(name, src);
    return src;
}

/**
 * Globals `name` references WITHOUT a typeof guard.
 * `Foo.bar` / `Foo(` count; `typeof Foo` anywhere in the file marks it optional.
 */
function hardDeps(jsName) {
    const src = readJs(jsName);
    if (src === null) return [];
    const deps = [];
    for (const [global, provider] of Object.entries(PROVIDERS)) {
        if (provider === jsName) continue;                       // defines it itself
        if (new RegExp(`typeof\\s+${global}\\b`).test(src)) continue;  // guarded => optional
        if (new RegExp(`\\b${global}\\s*[.(]`).test(src)) deps.push({ global, provider });
    }
    return deps;
}

const PAGES = htmlPages();

test('sanity: the page sweep actually found pages and scripts', () => {
    // A derivation that silently collapses to zero would pass every assertion
    // below while checking nothing at all.
    assert.ok(PAGES.length >= 30, `expected 30+ non-admin pages, found ${PAGES.length}`);
    const withScripts = PAGES.filter((p) => pageScripts(fs.readFileSync(p, 'utf8')).length > 0);
    assert.ok(withScripts.length >= 30, `expected 30+ pages loading local JS, found ${withScripts.length}`);
});

/**
 * PRESENCE, not order.
 *
 * Document order only matters for references that execute AT LOAD TIME. Nearly
 * every global reference in this codebase sits inside a function body that runs
 * on DOMContentLoaded or later, by which point all deferred scripts have
 * executed — so `config.js` mentioning DebugLog while utils.js loads after it is
 * perfectly fine. An order assertion here reports ~40 pages, all false, and a
 * test that cries wolf is a test people learn to skip.
 *
 * What is NEVER fine is the module being absent from the page entirely. That is
 * a guaranteed ReferenceError the moment the branch runs, and it is exactly what
 * both ERR-126 bugs were. Ordering is asserted only in the specific, verified
 * cases below.
 */
test('every page loads the modules its own scripts hard-depend on', () => {
    const failures = [];

    for (const page of PAGES) {
        const rel = path.relative(ROOT, page);
        const scripts = pageScripts(fs.readFileSync(page, 'utf8'));
        if (!scripts.length) continue;

        for (const script of scripts) {
            for (const { global, provider } of hardDeps(script)) {
                if (!scripts.includes(provider)) {
                    failures.push(
                        `${rel}: loads ${script}, which uses \`${global}\` unguarded, ` +
                        `but never loads ${provider}`
                    );
                }
            }
        }
    }

    assert.deepEqual(failures, [],
        'Pages are missing a module their own scripts require:\n  ' + failures.join('\n  '));
});

// ─────────────────────────────────────────────────────────────────────────────
// The two specific regressions, spelled out so the intent survives a refactor
// ─────────────────────────────────────────────────────────────────────────────

test('reset-password.html loads Security and DebugLog before its controller', () => {
    const scripts = pageScripts(
        fs.readFileSync(path.join(ROOT, 'html/account/reset-password.html'), 'utf8')
    );
    const at = (n) => scripts.indexOf(n);
    assert.notEqual(at('security.js'), -1, 'Security.escapeHtml() renders the invalid-link message');
    assert.notEqual(at('utils.js'), -1, 'DebugLog is used in every catch block');
    // Order IS asserted here specifically: reset-password-page.js does its work in
    // a DOMContentLoaded handler that can reference Security synchronously on the
    // very first branch, so it must not be the first script on the page.
    assert.ok(at('security.js') < at('reset-password-page.js'), 'security.js must come first');
    assert.ok(at('utils.js') < at('reset-password-page.js'), 'utils.js must come first');
});

test('reset-password.html deliberately does NOT load auth.js', () => {
    // Not an oversight, and not something to "fix" later. auth.js creates a
    // Supabase client with detectSessionInUrl, which would race this page for the
    // recovery tokens in the URL hash and could consume them before the handler
    // reads them — breaking password reset outright. The account sync it would
    // trigger is unnecessary here: a password reset is for an EXISTING account,
    // and the user's next navigation fires the sync anyway.
    const html = fs.readFileSync(path.join(ROOT, 'html/account/reset-password.html'), 'utf8');
    assert.equal(pageScripts(html).includes('auth.js'), false,
        'auth.js on this page would race the recovery hash — see the comment in the HTML');
    assert.match(html, /detectSessionInUrl/,
        'the reason must stay documented in the page, or someone will "fix" this');
});

test('verify-email.html loads DebugLog, which auth.js uses in its catch blocks', () => {
    const scripts = pageScripts(
        fs.readFileSync(path.join(ROOT, 'html/account/verify-email.html'), 'utf8')
    );
    assert.notEqual(scripts.indexOf('utils.js'), -1);
    assert.ok(scripts.indexOf('utils.js') < scripts.indexOf('auth.js'),
        'utils.js must precede auth.js — defer runs in document order');
});

test('auth.js really does use DebugLog unguarded (the premise of the two tests above)', () => {
    // If auth.js ever starts guarding DebugLog, the requirement above becomes
    // soft and these tests should be revisited rather than blindly satisfied.
    const src = readJs('auth.js');
    assert.match(src, /DebugLog\s*\./, 'auth.js calls DebugLog');
    assert.doesNotMatch(src, /typeof\s+DebugLog\b/, 'and does not guard it');
});

test('reset-password-page.js really does use Security and DebugLog unguarded', () => {
    const src = readJs('reset-password-page.js');
    assert.match(src, /Security\s*\./);
    assert.match(src, /DebugLog\s*\./);
    assert.doesNotMatch(src, /typeof\s+Security\b/);
    assert.doesNotMatch(src, /typeof\s+DebugLog\b/);
});

// ─────────────────────────────────────────────────────────────────────────────
// The new order modules
// ─────────────────────────────────────────────────────────────────────────────

test('both order surfaces load order-totals.js before their controller and the receipt', () => {
    const cases = [
        ['html/order-confirmation.html', 'order-confirmation-page.js'],
        ['html/account/order-detail.html', 'order-detail-page.js']
    ];
    for (const [page, controller] of cases) {
        const scripts = pageScripts(fs.readFileSync(path.join(ROOT, page), 'utf8'));
        const at = (n) => scripts.indexOf(n);
        assert.notEqual(at('order-totals.js'), -1, `${page} must load order-totals.js`);
        assert.notEqual(at('order-receipt.js'), -1, `${page} must load order-receipt.js`);
        assert.ok(at('order-totals.js') < at('order-receipt.js'),
            `${page}: order-receipt.js reads window.OrderTotals`);
        assert.ok(at('order-totals.js') < at(controller),
            `${page}: ${controller} reads window.OrderTotals`);
    }
});
