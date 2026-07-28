/**
 * Asset cache-busting — the durable invariant
 * ===========================================
 *
 * WHY THIS FILE REPLACES ~9 OTHER ASSERTIONS
 * ------------------------------------------
 * This repo has no build tooling, so every `<script src>` / `<link href>` carries a
 * hand-written `?v=<token>`. Bump it or deployed clients keep the cached file —
 * the classic "works local, not live" bug.
 *
 * Nine separate test files each pinned that token to *their own era's literal*:
 *
 *     retail-wording      →  footer.js must be `v=retail-may2026`
 *     newsletter-jun2026  →  footer.js must be `v=newsletter-copy-fix-jun2026`
 *     ia-reorg-jul2026    →  footer.js must be `v=ia-reorg-jul2026`
 *     …
 *
 * Every one of those is an assertion that the token *stopped moving* — about a value
 * whose entire purpose is to move. They are mutually contradictory: the moment a new
 * feature bumps the token, every older pin fails forever. All nine were red, which is
 * how the suite ended up permanently broken, and a permanently-red suite is why banned
 * Google-Ads copy shipped through two "fixed" reports (ERR-063). A test that cannot
 * ever be green is worse than no test: it launders real failures into expected noise.
 *
 * So we assert what actually protects users, and nothing else:
 *
 *   §1  CONSISTENCY — a given asset resolves to exactly ONE token across every page.
 *       This is the real bug. If /shop loads pages.css?v=A and /faq loads
 *       pages.css?v=B, someone bumped one reference and missed the others, and half
 *       the site serves stale CSS. Era-literals never caught this; this does.
 *
 *   §2  COVERAGE — every local /js/ + /css/ reference is versioned at all. An
 *       un-versioned asset can never be busted.
 *
 *   §3  FRESHNESS — if a JS/CSS file's *content* changed relative to HEAD but its
 *       token did not, the change will not reach cached clients. This is the one the
 *       era-pins were groping toward, and it's checkable only by diffing against git.
 *       Skips cleanly on a clean tree or outside a repo.
 *
 * Run: node --test tests/asset-cache-tokens.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');

function allHtml(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules') continue;
            allHtml(abs, out);
        } else if (e.name.endsWith('.html')) {
            out.push(abs);
        }
    }
    return out;
}

const REF_RX = /(?:src|href)="\/((?:js|css)\/[A-Za-z0-9_.\-/]+\.(?:js|css))(\?v=([^"]*))?"/g;

/** asset → Map<token, [pages]>, for a given set of HTML files. */
function tokenIndex(files) {
    const idx = new Map();
    for (const abs of files) {
        const src = fs.readFileSync(abs, 'utf8');
        for (const m of src.matchAll(REF_RX)) {
            const [, asset, , token] = m;
            if (!idx.has(asset)) idx.set(asset, new Map());
            const byTok = idx.get(asset);
            const key = token === undefined ? '<NONE>' : token;
            if (!byTok.has(key)) byTok.set(key, []);
            byTok.get(key).push(path.relative(ROOT, abs));
        }
    }
    return idx;
}

// The storefront and the admin console are versioned independently (admin has its
// own APP_VERSION), so they're checked as separate universes — an admin token and a
// storefront token for the same file are not a contradiction.
const STOREFRONT = allHtml(INK).filter((f) => !f.includes(`${path.sep}admin${path.sep}`));
const ADMIN = allHtml(INK).filter((f) => f.includes(`${path.sep}admin${path.sep}`));

// ─────────────────────────────────────────────────────────────────────────
// §1. CONSISTENCY — one token per asset, sitewide. The real "works local,
//     not live" guard: it catches the page someone forgot to bump.
// ─────────────────────────────────────────────────────────────────────────
for (const [label, files] of [['storefront', STOREFRONT], ['admin', ADMIN]]) {
    test(`§1 ${label}: every asset resolves to exactly ONE cache token`, () => {
        const offenders = [];
        for (const [asset, byTok] of tokenIndex(files)) {
            if (byTok.size <= 1) continue;
            const detail = [...byTok.entries()]
                .map(([tok, pages]) => `      v=${tok}  ←  ${pages.length} page(s): ${pages.slice(0, 3).join(', ')}${pages.length > 3 ? ', …' : ''}`)
                .join('\n');
            offenders.push(`  ${asset} — ${byTok.size} different tokens:\n${detail}`);
        }
        assert.deepEqual(offenders, [],
            'These assets are referenced with DIFFERENT cache tokens on different pages. '
            + 'Someone bumped one reference and missed the others, so those pages will serve '
            + 'a stale file to returning visitors:\n' + offenders.join('\n'));
    });
}

// ─────────────────────────────────────────────────────────────────────────
// §2. COVERAGE — an unversioned asset can never be cache-busted at all.
// ─────────────────────────────────────────────────────────────────────────
test('§2 every local js/css reference carries a ?v= token', () => {
    const offenders = [];
    for (const [label, files] of [['storefront', STOREFRONT], ['admin', ADMIN]]) {
        for (const [asset, byTok] of tokenIndex(files)) {
            const pages = byTok.get('<NONE>');
            if (pages) offenders.push(`  [${label}] ${asset} — unversioned on: ${pages.join(', ')}`);
        }
    }
    assert.deepEqual(offenders, [],
        'Unversioned assets cannot be cache-busted; a future change will not reach '
        + 'returning visitors:\n' + offenders.join('\n'));
});

// ─────────────────────────────────────────────────────────────────────────
// §3. FRESHNESS — the guard the era-pins were actually reaching for.
//
// If you edit js/footer.js but leave every `footer.js?v=…` untouched, returning
// visitors keep the cached copy and your change is invisible in production while
// working perfectly on localhost. A static literal can't detect that; a diff can.
// ─────────────────────────────────────────────────────────────────────────
function gitShow(rev, relPath) {
    try {
        return execFileSync('git', ['show', `${rev}:${relPath}`], {
            cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch {
        return null;   // new file, or not tracked
    }
}

/**
 * STAGED changes only — deliberately.
 *
 * An unstaged edit means "still working"; nagging about it would leave the suite
 * permanently red while someone is mid-feature, and a permanently-red suite is the
 * disease we are curing here (ERR-063), not the cure. A STAGED edit means "about to
 * commit", which is exactly the moment the token must already be correct.
 *
 * So: `git add` your asset change, run the suite, and this tells you if you forgot
 * the bump — before it ships, not after a user reports "it works for me".
 */
function stagedAssets() {
    try {
        const out = execFileSync('git', ['diff', '--cached', '--name-only', 'HEAD', '--', 'inkcartridges/js', 'inkcartridges/css'], {
            cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.split('\n').filter(Boolean);
    } catch {
        return null;   // not a git repo / git unavailable
    }
}

test('§3 a staged js/css change must also have its cache token bumped', (t) => {
    const changed = stagedAssets();
    if (changed === null) return t.skip('not a git checkout');
    if (changed.length === 0) return t.skip('no staged asset changes — nothing to check');

    const nowIdx = tokenIndex([...STOREFRONT, ...ADMIN]);
    const offenders = [];

    for (const file of changed) {
        // "inkcartridges/js/footer.js" → the asset key used in HTML refs ("js/footer.js")
        const assetKey = file.replace(/^inkcartridges\//, '');
        const nowToks = nowIdx.get(assetKey);
        if (!nowToks) continue;                       // not referenced from HTML (e.g. a module import)

        // Rebuild the token this asset had at HEAD, from HEAD's HTML.
        const headToks = new Set();
        for (const pages of nowToks.values()) {
            for (const page of pages) {
                const headHtml = gitShow('HEAD', page);
                if (!headHtml) continue;
                for (const m of headHtml.matchAll(REF_RX)) {
                    if (m[1] === assetKey) headToks.add(m[3] === undefined ? '<NONE>' : m[3]);
                }
            }
        }
        if (headToks.size === 0) continue;            // asset wasn't referenced at HEAD

        const unchanged = [...nowToks.keys()].filter((tok) => headToks.has(tok));
        if (unchanged.length === [...nowToks.keys()].length) {
            offenders.push(
                `  ${file} was modified but its cache token is still v=${unchanged.join(', v=')} — `
                + 'returning visitors will keep the cached copy and your change will be invisible '
                + 'in production while working fine on localhost.'
            );
        }
    }

    assert.deepEqual(offenders, [],
        'Changed asset(s) without a cache-token bump:\n' + offenders.join('\n'));
});

// ─────────────────────────────────────────────────────────────────────────
// §4  MODULE IDENTITY — a given ES module is imported under exactly ONE URL.
//
//     §1 asserts this for HTML <script src>/<link href>. The same hazard
//     exists on the ES-module axis and was completely unguarded: a module's
//     identity in the browser IS its URL, so `./api.js` and `./api.js?v=x`
//     are two DIFFERENT modules — both fetched, both evaluated, exports not
//     identical. Found 2026-07-28 (ERR-124): AdminAPI was loaded twice
//     (app.js tokened vs pages/planner.js bare), components/table.js twice
//     (27 bare importers vs one tokened), rich-text-editor.js twice.
//
//     Today that costs duplicate bytes and parse time. It becomes a
//     correctness bug the moment a module gains shared state or anything
//     does an `instanceof` across the two copies.
//
//     Note this asserts CONSISTENCY, not the absence of tokens — the file's
//     whole thesis is that pinning a literal is what made the suite
//     permanently red. Tokens on static imports are allowed, as long as
//     every importer of that module agrees on the spelling.
// ─────────────────────────────────────────────────────────────────────────

function allJs(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) allJs(abs, out);
        else if (e.name.endsWith('.js')) out.push(abs);
    }
    return out;
}

// Static `import … from '<relative path>.js[?…]'`. Only local relative
// specifiers — bare/CDN specifiers have no cache-token axis.
const IMPORT_RX = /\bfrom\s+['"](\.{1,2}\/[A-Za-z0-9_.\-/]+\.js)(\?[^'"]*)?['"]/g;

test('§4 every local ES module is imported under exactly one URL', () => {
    const spellings = new Map();   // resolved module path -> Map(spelling -> [importers])

    for (const file of allJs(path.join(INK, 'js'))) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(IMPORT_RX)) {
            const [, spec, query] = m;
            // Resolve so '../components/table.js' and './table.js' compare equal.
            const resolved = path.relative(INK, path.resolve(path.dirname(file), spec));
            const spelling = query === undefined ? '<no token>' : query;
            if (!spellings.has(resolved)) spellings.set(resolved, new Map());
            const bySpelling = spellings.get(resolved);
            if (!bySpelling.has(spelling)) bySpelling.set(spelling, []);
            bySpelling.get(spelling).push(path.relative(ROOT, file));
        }
    }

    const offenders = [];
    for (const [module, bySpelling] of spellings) {
        if (bySpelling.size < 2) continue;
        const detail = [...bySpelling.entries()]
            .map(([spelling, importers]) => `      ${spelling}  <- ${importers.join(', ')}`)
            .join('\n');
        offenders.push(
            `  ${module} is imported under ${bySpelling.size} different URLs, so the browser `
            + `loads and evaluates it ${bySpelling.size} times and its exports are not identical:\n${detail}`
        );
    }

    assert.deepEqual(offenders, [],
        'ES modules imported under more than one URL:\n' + offenders.join('\n'));
});

test('§4 the lazily-loaded admin page modules still go through APP_VERSION', () => {
    // The counterpart to the rule above: static imports are bare, and the ONE
    // place a token belongs is the dynamic page import, where it is built from
    // a single constant rather than hand-written per call site. Deleting this
    // would leave the admin SPA's lazy chunks with no busting mechanism at all.
    const app = fs.readFileSync(path.join(INK, 'js', 'admin', 'app.js'), 'utf8');
    assert.match(app, /const APP_VERSION = '[^']+';/,
        'admin/app.js must declare APP_VERSION');
    assert.match(app, /import\(`\.\/pages\/\$\{name\}\.js\?v=\$\{APP_VERSION\}`\)/,
        'admin page modules must be imported with ?v=${APP_VERSION} — one constant, not per-call-site literals');
});
