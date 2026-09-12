'use strict';

/**
 * tests/helpers/strip-comments.js — the guard on the guard (ERR-253)
 * =============================================================================
 *
 * Fifty-one suites hand their source through `stripComments` before asserting
 * on it. That makes it the single most load-bearing line of test code in the
 * repo: anything it deletes is something no assertion downstream of it can
 * see, and a `doesNotMatch` over a deleted region passes by construction.
 *
 * It was broken for months. Every copy removed block comments first, so a line
 * comment containing a starred path opened a block comment and swallowed
 * everything to the next terminator — measured at HEAD on 2026-09-12 as 22,251
 * characters of live code across 35 suites, 15,059 of them in `search.js` and
 * 2,465 in `security.js`, which is where the XSS escaping fences live.
 *
 * So this file exists to make that class of failure loud. The important test is
 * the last one: it is a POSITIVE CONTROL against every shipped source file,
 * and it is the one that would have caught the original bug.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const JS_ROOT = path.join(ROOT, 'inkcartridges', 'js');

/** Every .js file the site ships, recursively. */
function allSources(dir = JS_ROOT, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) allSources(p, out);
        else if (entry.name.endsWith('.js')) out.push(p);
    }
    return out;
}

/** The two-regex version every copy used to carry. Kept ONLY as a control. */
function naiveStripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The bug itself
// ─────────────────────────────────────────────────────────────────────────────

test('§1 a line comment containing a star-path does not eat the rest of the file', () => {
    const src = [
        'const keep = 1;',
        '// the cache rule now matches /api/search/* which is the whole point',
        'const alsoKeep = 2;',
        '/* a genuine block comment */',
        'const stillHere = 3;',
    ].join('\n');

    const out = stripComments(src);
    assert.match(out, /const keep = 1;/);
    assert.match(out, /const alsoKeep = 2;/, 'the line AFTER the star-path comment must survive');
    assert.match(out, /const stillHere = 3;/);
    assert.doesNotMatch(out, /whole point/, 'the comment itself must still be removed');
    assert.doesNotMatch(out, /genuine block comment/);

    // NEGATIVE CONTROL — the old implementation really does fail this. Without
    // it, §1 could pass against a stripper that does nothing at all.
    const naive = naiveStripComments(src);
    assert.doesNotMatch(naive, /const alsoKeep = 2;/,
        'control: the two-regex version must still be broken, or this test proves nothing');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Strings are not comments
// ─────────────────────────────────────────────────────────────────────────────

test('§2 a URL inside a string is not a comment', () => {
    const src = "const u = 'https://api.inkcartridges.co.nz/api/search/smart'; // gone";
    const out = stripComments(src);
    assert.match(out, /https:\/\/api\.inkcartridges\.co\.nz\/api\/search\/smart/,
        'the URL is string content and must survive intact');
    assert.doesNotMatch(out, /gone/);
});

test('§2 a block-comment opener inside a string is not a comment', () => {
    const src = 'const glob = "/api/search/*"; const after = 1;';
    assert.match(stripComments(src), /const after = 1;/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Template literals: the string is data, the interpolation is code
// ─────────────────────────────────────────────────────────────────────────────

test('§3 comments inside a ${...} interpolation ARE stripped', () => {
    const src = [
        'const html = `<ul>${rows.map(r => {',
        '    // this is real code and a real comment',
        '    return `<li>${r.n}</li>`;',
        '}).join("")}</ul>`;',
    ].join('\n');
    const out = stripComments(src);
    assert.doesNotMatch(out, /real comment/,
        'an interpolation is code — order-detail-page.js builds its whole item list this way');
    assert.match(out, /<li>\$\{r\.n\}<\/li>/, 'the nested literal must survive');
    assert.match(out, /<ul>/);
});

test('§3 a lookalike comment in the literal TEXT is left alone', () => {
    const src = 'const s = `see //example.com and /*not a comment*/ here`; const after = 1;';
    const out = stripComments(src);
    assert.match(out, /see \/\/example\.com/, 'literal text is data, not code');
    assert.match(out, /const after = 1;/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The positive control — the test that would have caught the original bug
// ─────────────────────────────────────────────────────────────────────────────

test('§4 across every shipped source file, the stripper never removes MORE than the naive one', () => {
    // The only thing a single-pass scanner could plausibly get wrong that the
    // regex pair gets right is an unescaped slash inside a regex character
    // class. If one ever lands in this codebase, this goes red here rather
    // than by silently deleting a chunk of somebody's module.
    const files = allSources();
    assert.ok(files.length > 100, `sanity: expected the js tree to be populated, found ${files.length}`);

    const overDeleted = [];
    for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');
        if (stripComments(src).length < naiveStripComments(src).length) {
            overDeleted.push(path.relative(ROOT, file));
        }
    }
    assert.deepEqual(overDeleted, [],
        'the shared stripper must never delete something the old one kept');
});

test('§4 and it demonstrably recovers live code the naive one was deleting', () => {
    // Not a tautology: this is the measurement that made ERR-253 a defect
    // rather than a tidy-up. If it ever drops to zero, either every starred
    // path has left the comments (fine — say so here) or someone has quietly
    // reinstated the old behaviour (not fine).
    const recovered = allSources().reduce((sum, file) => {
        const src = fs.readFileSync(file, 'utf8');
        return sum + Math.max(0, stripComments(src).length - naiveStripComments(src).length);
    }, 0);
    assert.ok(recovered > 10000,
        `expected the shared stripper to preserve materially more live code than the two-regex `
        + `version; recovered ${recovered} characters`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. One owner
// ─────────────────────────────────────────────────────────────────────────────

test('§5 no test file carries its own copy of stripComments', () => {
    // ERR-187/192: a hardcoded rule reached six copies in this repo, and
    // relocating it instead of sharing it left a stale duplicate behind. This
    // one reached fifty-one, and every copy carried the same defect.
    const offenders = fs.readdirSync(__dirname)
        .filter((f) => f.endsWith('.test.js'))
        .filter((f) => /^\s*function stripComments\s*\(\s*src\s*\)/m.test(
            fs.readFileSync(path.join(__dirname, f), 'utf8')));
    assert.deepEqual(offenders, [],
        'require tests/helpers/strip-comments.js instead of redefining it');
});
