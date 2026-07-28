/**
 * ERR numbering integrity (Jul 2026)
 * ==================================
 *
 * There are two error logs and they are one log with two audiences:
 *
 *   errors.md                  narrative postmortems, for humans   — COMMITTED
 *   .claude/memory/errors.md   compact agent-facing index          — GITIGNORED, local only
 *
 * They were numbered independently through ERR-113…ERR-123, so in that range the
 * same number is a DIFFERENT incident depending on which file you read
 * (ERR-119 = "dashboard reload had no signal" in one, "order line-items table
 * invisible" in the other; ERR-120 likewise). From ERR-124 the two converged onto
 * a single allocator: one number, one title, written to both files.
 *
 * History is deliberately NOT renumbered. Source comments cite ERR numbers
 * directly (js/account.js, js/legal-config.js, js/cart.js, several tests), so
 * renumbering would silently rot every one of them. The fork is documented in
 * both files' headers instead, and this test stops a THIRD fork from starting.
 *
 * PORTABILITY. `.claude/` is gitignored, so the memory log does not exist in a
 * fresh clone or in CI. The cross-file checks therefore SKIP cleanly when it is
 * absent rather than failing — a test that cannot run on a clean checkout is
 * worse than one that admits what it could not check. Everything that can be
 * verified from the committed file alone is asserted unconditionally.
 *
 * Run with: node --test tests/err-numbering-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_LOG = path.join(ROOT, 'errors.md');
const MEMORY_LOG = path.join(ROOT, '.claude', 'memory', 'errors.md');

/**
 * The first number allocated under the shared scheme by a single author writing
 * to both files. Below this is history, and history is not renumbered.
 *
 * Why 126 and not 124: ERR-124 exists in both files but with different wording
 * (the two logs legitimately phrase things differently — one is a postmortem,
 * one is an index), and ERR-125 was written to the memory log only. 124-125 are
 * transitional. 126 is the first pair authored together, so it is the first
 * number this test can hold to the rule without rewriting someone else's entry.
 */
const SHARED_FROM = 126;

/** Parse `## ERR-123 — title` / `### ERR-123: title` headings. */
function parseEntries(file) {
    const src = fs.readFileSync(file, 'utf8');
    const out = [];
    const re = /^#{2,3}\s*ERR-(\d+)\s*[—:-]\s*(.+)$/gm;
    let m;
    while ((m = re.exec(src)) !== null) {
        out.push({ num: Number(m[1]), title: m[2].trim() });
    }
    return out;
}

/** Rough title comparison — enough to catch two different incidents sharing a number. */
function titleKey(title) {
    return title
        .toLowerCase()
        .replace(/\(\d{4}-\d{2}-\d{2}\)/g, '')
        .replace(/—.*$/, '')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
}

const memoryLogExists = fs.existsSync(MEMORY_LOG);

test('the committed log parses and has entries', () => {
    // Guards the regex, not the content: if the heading format changes, every
    // other assertion here would silently pass against an empty list.
    const entries = parseEntries(PUBLIC_LOG);
    assert.ok(entries.length >= 40, `expected 40+ ERR entries, parsed ${entries.length}`);
});

test('no ERR number is reused from the shared allocator onward', () => {
    // Scoped forward on purpose. There IS one historical duplicate — ERR-035 was
    // used for two unrelated 2026-05-22 incidents (the analytics 42501 grant, and
    // clean-URL 404s in local dev). It is NOT renumbered, for the same reason the
    // 113-123 fork is not: source comments and tests cite these numbers, and
    // renaming them rots those references silently. It is documented in the
    // header instead, and the test below proves the documentation is there.
    const seen = new Map();
    const dupes = [];
    for (const e of parseEntries(PUBLIC_LOG)) {
        if (e.num < SHARED_FROM) continue;
        if (seen.has(e.num)) dupes.push(`ERR-${e.num}: "${seen.get(e.num)}" vs "${e.title}"`);
        else seen.set(e.num, e.title);
    }
    assert.deepEqual(dupes, [], 'duplicate ERR numbers in errors.md:\n  ' + dupes.join('\n  '));
});

test('the known historical duplicate stays documented', () => {
    const src = fs.readFileSync(PUBLIC_LOG, 'utf8');
    assert.match(src, /ERR-035[\s\S]{0,400}?(twice|duplicate|two unrelated)/i,
        'the ERR-035 collision must be called out in the numbering header, or it reads as a typo');
});

test('the forked range is documented in the committed log', () => {
    // If this preamble is ever deleted, ERR-113..123 become silently ambiguous
    // again and someone will cite one without naming the file.
    const src = fs.readFileSync(PUBLIC_LOG, 'utf8');
    assert.match(src, /## Numbering/, 'errors.md must explain the numbering scheme');
    assert.match(src, /ERR-113/, 'the ambiguous range must be named explicitly');
    assert.match(src, /ERR-123/);
    assert.match(src, /\.claude\/memory\/errors\.md/, 'both files must be named');
    assert.match(src, /ONE shared allocator/i, 'the go-forward rule must be stated');
});

test('the numbering preamble is in the memory log too', { skip: !memoryLogExists }, () => {
    const src = fs.readFileSync(MEMORY_LOG, 'utf8');
    assert.match(src, /## Numbering/);
    assert.match(src, /ERR-113/);
    assert.match(src, /ONE shared allocator/i);
});

test(`ERR-${SHARED_FROM}+ appears in BOTH logs`, { skip: !memoryLogExists }, () => {
    const pub = parseEntries(PUBLIC_LOG).filter((e) => e.num >= SHARED_FROM);
    const mem = parseEntries(MEMORY_LOG).filter((e) => e.num >= SHARED_FROM);
    const pubNums = new Set(pub.map((e) => e.num));
    const memNums = new Set(mem.map((e) => e.num));

    const missingFromMem = [...pubNums].filter((n) => !memNums.has(n));
    const missingFromPub = [...memNums].filter((n) => !pubNums.has(n));

    assert.deepEqual(missingFromMem, [],
        `in errors.md but not .claude/memory/errors.md: ${missingFromMem.map((n) => 'ERR-' + n).join(', ')}`);
    assert.deepEqual(missingFromPub, [],
        `in .claude/memory/errors.md but not errors.md: ${missingFromPub.map((n) => 'ERR-' + n).join(', ')}`);
});

test(`ERR-${SHARED_FROM}+ describes a recognisably similar incident in both logs`, { skip: !memoryLogExists }, () => {
    // The point of the shared allocator: a number must mean ONE thing. But the
    // two logs serve different readers and legitimately word things differently
    // (postmortem prose vs compact index), so this looks for meaningful word
    // overlap rather than string equality — enough to catch two genuinely
    // different incidents sharing a number, without policing phrasing.
    const mem = new Map(parseEntries(MEMORY_LOG).filter((e) => e.num >= SHARED_FROM).map((e) => [e.num, e.title]));
    const mismatches = [];
    const STOP = new Set(['the', 'a', 'an', 'and', 'was', 'were', 'is', 'in', 'on', 'of', 'to', 'for', 'it', 'its', 'that', 'with', 'not']);
    const words = (s) => new Set(titleKey(s).split(' ').filter((w) => w.length > 3 && !STOP.has(w)));

    for (const e of parseEntries(PUBLIC_LOG).filter((x) => x.num >= SHARED_FROM)) {
        if (!mem.has(e.num)) continue;   // covered by the presence test above
        const a = words(e.title);
        const b = words(mem.get(e.num));
        const shared = [...a].filter((w) => b.has(w)).length;
        if (shared < 2) {
            mismatches.push(`ERR-${e.num}:\n      public: ${e.title}\n      memory: ${mem.get(e.num)}`);
        }
    }
    assert.deepEqual(mismatches, [],
        'same number, apparently different incident — the fork is restarting:\n    ' + mismatches.join('\n    '));
});

test('history below the shared allocator is NOT renumbered', { skip: !memoryLogExists }, () => {
    // Guards against a well-meaning cleanup: source comments reference these
    // numbers, so "fixing" the fork by renumbering rots them silently.
    const pubNums = new Set(parseEntries(PUBLIC_LOG).map((e) => e.num));
    for (const n of [113, 114, 115, 116, 117, 118, 119, 120]) {
        assert.ok(pubNums.has(n), `ERR-${n} must remain in errors.md — history is not renumbered`);
    }
});
