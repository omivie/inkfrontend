/**
 * The legal-content CMS is RETIRED — and must stay that way
 * =========================================================
 *
 * WHAT THIS FILE REPLACES
 * -----------------------
 * `tests/legal-content-cms.test.js` (25 tests) asserted the CMS *existed*: the
 * `window.LegalContent` surface, the `legal_content_overrides` REST read, the admin
 * editor's upsert/delete paths, the Settings tab. On 2026-07-14 the owner retired the
 * CMS, so every one of those assertions inverted. This file asserts the inverse, plus
 * the thing the old file never checked: that killing the CMS didn't take the legitimate
 * trust-signal bindings down with it.
 *
 * WHY THE CMS WAS RETIRED RATHER THAN REPAIRED (ERR-065 → ERR-069)
 * ---------------------------------------------------------------
 * `js/legal-page.js` used to read admin-authored rows from Supabase and write them into
 * `.policy-section` via innerHTML. It never worked: `js/config.js` declares `const Config`,
 * which — unlike `var` — is NOT a property of `window`, so the `window.Config` guard always
 * returned null and the read short-circuited. Five authored rows never rendered; the owner's
 * edits vanished silently.
 *
 * The tempting fix — "just point it at the bare global" — is the dangerous one. The backend's
 * bot prerender does not read that table. An override that renders in a browser but not in the
 * prerendered HTML makes bot copy differ from human copy on /terms and /about. That is
 * **cloaking**: the exact charge under appeal with Google Ads. AdsBot executes JavaScript, so
 * a `curl` of the static HTML cannot even see the divergence.
 *
 * So the CMS is gone on both sides — the reader (legal-page.js) and the writer (the admin
 * editor). Legal copy now has exactly ONE source per page: the page's HTML, plus
 * legal-config.js for the facts.
 *
 * §1 asserts the reader is gone. §2 asserts it does no network I/O at all. §3 asserts the
 * writer, its Settings tab, and its route are gone. §4 sweeps the WHOLE tree for the table
 * name — deliberately not an allowlist, because a hand-maintained FILES_TO_SCAN list is
 * precisely why banned copy shipped through two "fixed" reports (ERR-063). §5 guards the
 * half we KEPT, so a future cleanup can't quietly delete the bindings too.
 *
 * Run: node --test tests/legal-cms-retired-jul2026.test.js
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK  = path.join(ROOT, 'inkcartridges');
const READ = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');

const PAGE_JS   = READ('js/legal-page.js');
const ADMIN_APP = READ('js/admin/app.js');
const SETTINGS  = READ('js/admin/pages/settings.js');

// Every page that loads legal-page.js.
const LEGAL_PAGES = [
    'terms.html', 'privacy.html', 'returns.html', 'shipping.html',
    'about.html', 'faq.html', 'contact.html', 'genuine-vs-compatible.html',
];

// ─────────────────────────────────────────────────────────────────────────────
// §1 — The reader is gone from legal-page.js
//
// This is the backend's own acceptance check, run in CI instead of by hand:
//     curl -s .../js/legal-page.js | grep -Eic "legal_content_overrides|fetchOverrides|getSupabaseConfig"
// It must print 0. (Before the retirement it printed 7.)
// ─────────────────────────────────────────────────────────────────────────────

const RETIRED_SYMBOLS = [
    'legal_content_overrides',   // the Supabase table
    'fetchOverrides',            // the REST read
    'getSupabaseConfig',         // the (broken) window.Config guard — ERR-065
    'applyOverrides',            // the apply step
    'LegalContent',              // the window.* surface the admin editor poked
    'siteFactsApply',            // the LegalConfig mutation path
    'pageContentApply',          // the .policy-section innerHTML sinks
    'rejectIfBanned',            // the guard that screened overrides — nothing left to screen
    'violatesBannedClaims',
    'detectPageSlug',
];

for (const sym of RETIRED_SYMBOLS) {
    test(`§1 legal-page.js contains no trace of \`${sym}\``, () => {
        assert.ok(!PAGE_JS.includes(sym),
            `js/legal-page.js still mentions \`${sym}\`. The legal-content CMS was retired on `
            + '2026-07-14 — the override read path must be gone entirely, not merely disabled. '
            + 'A disabled fetch is one edit away from being a live cloaking vector. See ERR-069.');
    });
}

test('§1 the backend\'s grep acceptance check prints 0', () => {
    // Mirrors `grep -Eic "legal_content_overrides|fetchOverrides|getSupabaseConfig"` — a
    // COUNT OF MATCHING LINES, which is what the backend actually runs against the deployed
    // file. Comments count too: if a comment explains the mechanism by name, the backend's
    // check fails and the retirement looks incomplete. Describe it without naming it.
    const re = /legal_content_overrides|fetchOverrides|getSupabaseConfig/i;
    const hits = PAGE_JS.split('\n').filter((line) => re.test(line));
    assert.deepEqual(hits, [],
        'The backend verifies this retirement with a grep whose output must be 0. These lines '
        + 'in js/legal-page.js still match it (code OR comment):\n  ' + hits.join('\n  '));
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — legal-page.js performs NO network I/O
//
// The stronger invariant, and the one that actually protects us: it isn't that this
// one table is unreachable, it's that the file has no way to pull copy off the network
// at all. Legal copy that a bot can't see is the whole problem.
// ─────────────────────────────────────────────────────────────────────────────

test('§2 legal-page.js makes no network call of any kind', () => {
    const NETWORK = [
        [/\bfetch\s*\(/,          'fetch()'],
        [/XMLHttpRequest/,        'XMLHttpRequest'],
        [/\bsupabase\b/i,         'Supabase'],
        [/SUPABASE_(URL|ANON)/,   'SUPABASE_* config'],
        [/\/rest\/v1\//,          'a Supabase REST path'],
        [/navigator\.sendBeacon/, 'sendBeacon'],
        [/\bimport\s*\(/,         'a dynamic import()'],
    ];
    const found = NETWORK.filter(([re]) => re.test(PAGE_JS)).map(([, label]) => label);
    assert.deepEqual(found, [],
        'js/legal-page.js must not talk to the network. It renders vetted static HTML and binds '
        + 'facts from legal-config.js — nothing else. Remote-sourced legal copy renders for '
        + 'browsers but not for the bot prerender, which is cloaking (ERR-065/ERR-069). Found: '
        + found.join(', '));
});

test('§2 legal-page.js never writes a remotely-sourced value into innerHTML', () => {
    // The retired CMS's two sinks were `hero.innerHTML = value` and `sec.innerHTML = value`,
    // where `value` came off the wire. The innerHTML writes that REMAIN are all built from
    // LegalConfig (`cfg.*`) and escaped — that's fine and must keep working (see §5). What
    // must never come back is a bare assignment of an unescaped free variable.
    const sinks = [...PAGE_JS.matchAll(/\.innerHTML\s*=\s*([A-Za-z_$][\w$]*)\s*;/g)].map((m) => m[1]);
    assert.deepEqual(sinks, [],
        'js/legal-page.js assigns a bare variable to .innerHTML: ' + sinks.join(', ')
        + '. Every innerHTML write here must be constructed inline from LegalConfig and passed '
        + 'through escapeHtml(). A bare assignment is how the CMS injected unvetted copy.');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — The writer is gone: admin module, Settings tab, and route
//
// Deleting the reader alone would have been WORSE than doing nothing. The admin editor
// would have kept upserting rows and reporting "Saved. Live on next page-load." into a
// table that nothing on earth reads. That is the ERR-065 silent-vanish trap, preserved
// forever. Kill the write path with the read path.
// ─────────────────────────────────────────────────────────────────────────────

test('§3 the admin Legal Content editor module is deleted', () => {
    assert.ok(!fs.existsSync(path.join(INK, 'js/admin/pages/legal-content.js')),
        'js/admin/pages/legal-content.js must not exist. It upserted into the retired overrides '
        + 'table and told the owner "Saved. Live on next page-load." — which was never true, and '
        + 'with the read path gone can never become true.');
});

test('§3 the Settings hub registers no Legal Content tab', () => {
    assert.ok(!/id:\s*'legal'/.test(SETTINGS),
        "settings.js must not register a tab with id 'legal'");
    assert.ok(!SETTINGS.includes('legal-content.js'),
        'settings.js must not import ./legal-content.js — the module is deleted, so mounting the '
        + 'tab would throw "Error Loading Page".');
});

test('§3 no admin route resolves to a legal-content page module', () => {
    // The legacy `#legal-content` hash is deliberately KEPT as a redirect so an old bookmark
    // lands on the Settings hub rather than an error screen — but it must not point at the
    // deleted tab, and no route may load the deleted module.
    assert.ok(!/'legal-content':\s*'settings\?tab=legal'/.test(ADMIN_APP),
        "app.js must not redirect legal-content to 'settings?tab=legal' — that tab is gone. "
        + "Point it at the bare 'settings' hub.");
    assert.match(ADMIN_APP, /'legal-content':\s*'settings'/,
        "app.js should still redirect the legacy 'legal-content' hash to the Settings hub, so an "
        + 'old bookmark lands somewhere sane instead of "Error Loading Page".');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — Tree-wide sweep. NOT an allowlist.
//
// ERR-063: the previous banned-copy guard scanned a hand-maintained FILES_TO_SCAN list.
// The list was missing a file, so banned copy shipped through two "fixed" reports while the
// suite stayed green. Never again: walk the tree, scan everything shipped.
// ─────────────────────────────────────────────────────────────────────────────

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs, out);
        else if (/\.(js|html|css|sql|json)$/.test(e.name)) out.push(abs);
    }
    return out;
}

test('§4 nothing shipped to users mentions the retired overrides table', () => {
    const offenders = walk(INK)
        .filter((abs) => /legal_content_overrides/i.test(fs.readFileSync(abs, 'utf8')))
        .map((abs) => path.relative(ROOT, abs));
    assert.deepEqual(offenders, [],
        'The legal_content_overrides table is retired and empty; the backend will drop it. No '
        + 'shipped file may still read it, write it, or carry its CREATE TABLE DDL:\n  '
        + offenders.join('\n  '));
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — The half we KEPT still works.
//
// legal-page.js does two unrelated jobs; the retirement removed one. This section exists so
// that a future "finish the cleanup" pass can't quietly take the other one with it. Every
// assertion below covers a user-visible surface on a live compliance page.
// ─────────────────────────────────────────────────────────────────────────────

test('§5 legal-page.js still binds every data-legal-bind key used in the HTML', () => {
    // Crawl the real pages for the keys they actually use, then assert legal-page.js implements
    // each one. Derived from the HTML rather than a hardcoded list, so adding a binding to a page
    // without implementing it fails here instead of silently rendering placeholder text.
    const used = new Set();
    for (const f of walk(INK).filter((p) => p.endsWith('.html'))) {
        for (const m of fs.readFileSync(f, 'utf8').matchAll(/data-legal-bind="([^"]+)"/g)) {
            used.add(m[1]);
        }
    }
    assert.ok(used.size > 0, 'sanity: the HTML must use data-legal-bind at all');

    // A key is implemented either as an entry in the `bindings` map (`'free-threshold': …`)
    // or as a dedicated selector block (`$$('[data-legal-bind="map"]')`) for the ones that
    // build a table/iframe rather than substitute a scalar. Accept both spellings.
    const missing = [...used].filter((key) =>
        !PAGE_JS.includes(`'${key}'`) && !PAGE_JS.includes(`data-legal-bind="${key}"`)
    ).sort();
    assert.deepEqual(missing, [],
        'These data-legal-bind keys are used in the HTML but not implemented by legal-page.js '
        + 'applyBindings(), so they render as un-substituted placeholder text on a legal page: '
        + missing.join(', '));
});

test('§5 the trust-signal binder, TOC, and FAQ accordions survive', () => {
    for (const fn of ['applyBindings', 'buildTOC', 'wireFAQ', 'escapeHtml']) {
        assert.match(PAGE_JS, new RegExp(`function\\s+${fn}\\s*\\(`),
            `legal-page.js must keep ${fn}() — it is the legitimate half of this file and is `
            + 'unrelated to the retired CMS.');
    }
    // The binder must run on load, or every page ships raw placeholders.
    assert.match(PAGE_JS, /function\s+renderStatic\s*\(\)\s*\{[\s\S]*applyBindings\(\)/,
        'renderStatic() must call applyBindings()');
    assert.match(PAGE_JS, /DOMContentLoaded/,
        'legal-page.js must still render on DOMContentLoaded');
});

test('§5 every legal page still loads legal-page.js, cache-busted', () => {
    for (const p of LEGAL_PAGES) {
        const src = READ(path.join('html', p));
        // Assert the token EXISTS, never its literal value — a token is md5(content)[:8] and
        // pinning it writes a test that can only ever go red (ERR-067). Sitewide consistency
        // and freshness are owned by tests/asset-cache-tokens.test.js.
        assert.match(src, /\/js\/legal-page\.js\?v=[^"]+/,
            `${p} must load legal-page.js with a cache token`);
    }
});

test('§5 BANNED_CLAIM_PATTERNS survives the retirement', () => {
    // The CMS guard was one of its consumers, and it's gone — but the compliance source sweep
    // (google-ads-compliance + genuine-vs-compatible-warranty) still imports this list. Deleting
    // it as "CMS collateral" would silently disarm the banned-copy sweep that ERR-063 was about.
    require(path.join(INK, 'js', 'legal-config.js'));
    const { BANNED_CLAIM_PATTERNS } = globalThis.LegalConfig;
    assert.ok(Array.isArray(BANNED_CLAIM_PATTERNS) && BANNED_CLAIM_PATTERNS.length > 0,
        'LegalConfig.BANNED_CLAIM_PATTERNS must remain — the compliance test sweep consumes it. '
        + 'It is not CMS code, even though the CMS used to be one of its callers.');
    assert.ok(BANNED_CLAIM_PATTERNS.some((re) => re.test('does not void your warranty')),
        'sanity: the banned-claim list must still catch the copy that suspended the Ads account');
});
