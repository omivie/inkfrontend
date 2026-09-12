/**
 * ERR-254 — our "read-only" probes have been writing to production analytics
 * ==========================================================================
 *
 * `logSearchAnalytics()` writes a `search_analytics` row on every GET to
 * `/api/search/*`, server-side and fire-and-forget. A script in `scripts/` that
 * reads those endpoints is therefore a WRITER to the backend's database, no
 * matter how read-only it is with respect to this repository.
 *
 * MEASURED 2026-09-12 from the live admin analytics endpoint: the last 7 days of
 * top-search-terms contained `zzqqxnotaproduct9987` six times. That is the
 * zero-result control query in probe-search-value-pack-ranking.mjs. Six of the
 * site's searches that week were ours, and every banner on every one of those
 * scripts said the script could not write anything.
 *
 * WHY THIS IS A TEST AND NOT A NOTE IN A README
 * ---------------------------------------------
 * This repo has already learned twice that "every surface does X" is a list
 * nobody maintains (ERR-150/160: the same feature vanished silently twice, and
 * the fix was to put enrolment in a test). A ninth probe added next month will
 * copy an existing banner, inherit the false claim, and nothing will notice —
 * which is exactly how the first eight happened.
 *
 * It also matters more than a normal hygiene rule, because these rows are
 * EVIDENCE. ERR-237 was argued to the backend on `search_analytics` row counts.
 * A dataset we quietly contribute to is a dataset we cannot cite, and the repo
 * already knows this shape from the other direction: "a probe that records may
 * be green because it has just overwritten the thing it was comparing against"
 * (sweep:b2b ate a committed fixture, 2026-08-12).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Comments explain; only code counts when asserting something is not SPELLED.
// §4 below scans for a literal that this suite's own explanatory comments also
// contain — and it failed on exactly that the first time it ran, which is the
// ERR-253 shape arriving in the test that was written to avoid it.
const stripComments = require('./helpers/strip-comments');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

/** The read endpoints that cause a `search_analytics` row to be written. */
const LOGGING_ENDPOINTS = /\/api\/search\/(smart|suggest|autocomplete)/;

/**
 * POST /api/search/click writes `search_clicks`, a DIFFERENT table, and is not
 * a read of the endpoints above. It is excluded deliberately and by name rather
 * than by the regex happening to miss it — a script that only posts a click is
 * not making the false claim this suite is about.
 */
const NOT_A_SEARCH_READER = new Set(['audit-search-click-beacon.mjs']);

/**
 * Scripts that read the logging endpoints but do not yet carry the notice,
 * because another session holds them in the working tree as of 2026-09-12.
 *
 * THIS LIST MAY ONLY SHRINK. It is asserted exactly, so adding a new unenrolled
 * probe fails, and so does leaving a stale entry here after its file is fixed.
 * If you are here because you just enrolled one of these, delete its line.
 */
const PENDING_OTHER_SESSION = new Set([
    'probe-data-capture.mjs',
    'probe-edge-cache.mjs',
    'probe-add-to-cart-tracking.mjs',
    'probe-admin-only-product.mjs',
]);

const files = fs.readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => !NOT_A_SEARCH_READER.has(f));

const readers = files.filter((f) =>
    LOGGING_ENDPOINTS.test(fs.readFileSync(path.join(SCRIPTS, f), 'utf8')));

/**
 * Enrolled means PRINTED, not imported.
 *
 * The first version of this asked `src.includes('SEARCH_ANALYTICS_NOTICE')`,
 * and the red-proof exposed it immediately: deleting the print left the import
 * line behind, the identifier was still in the file, and the suite stayed green
 * over a probe that had gone silent. A banner nobody prints is the exact thing
 * this ERR is about — so the import line is stripped before looking.
 */
function printsTheNotice(file) {
    const src = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
    const withoutImports = stripComments(src).replace(/^\s*import[^;]*;\s*$/gm, '');
    return withoutImports.includes('SEARCH_ANALYTICS_NOTICE');
}

test('§1 the scan finds the search-reading scripts at all', () => {
    // A suite that silently matched nothing would pass every assertion below.
    assert.ok(readers.length >= 5,
        `only ${readers.length} scripts matched — the endpoint regex has probably drifted, `
        + 'and an enrolment test that scans nothing enrols nothing');
});

test('§2 every search-reading script says that reading writes a row', () => {
    const missing = readers
        .filter((f) => !PENDING_OTHER_SESSION.has(f))
        .filter((f) => !printsTheNotice(f));
    assert.deepEqual(missing, [],
        'these GET /api/search/* — which writes a search_analytics row server-side — and do not '
        + "say so. Import SEARCH_ANALYTICS_NOTICE from './lib/probe-search-notice.mjs' and print "
        + 'it under the MODE banner. A probe is not more read-only for staying quiet about it.');
});

test('§3 the pending list is exactly the files still owed a notice', () => {
    const stillPending = [...PENDING_OTHER_SESSION].filter((f) => !printsTheNotice(f));
    assert.deepEqual(stillPending.sort(), [...PENDING_OTHER_SESSION].sort(),
        'an entry here has been enrolled — delete its line. A pending list that outlives its '
        + 'reason is how an exception becomes the rule.');

    const unknown = [...PENDING_OTHER_SESSION].filter((f) => !readers.includes(f));
    assert.deepEqual(unknown, [],
        'this names a file that no longer reads /api/search/* (or no longer exists)');
});

test('§4 the sentinel has exactly one owner', () => {
    // Six type vocabularies happened here once (npm run audit:types). A second
    // hand-rolled prefix would make the backend's exclusion rule wrong without
    // making any test fail.
    const offenders = files.filter((f) => {
        const code = stripComments(fs.readFileSync(path.join(SCRIPTS, f), 'utf8'));
        return /zzprobe_/.test(code);
    });
    assert.deepEqual(offenders, [],
        'the literal `zzprobe_` belongs in scripts/lib/probe-search-notice.mjs only; call '
        + 'probeQuery() instead of spelling the prefix');
});

test('§5 the notice module states the prefix and both kinds of query', () => {
    const src = fs.readFileSync(path.join(SCRIPTS, 'lib', 'probe-search-notice.mjs'), 'utf8');
    assert.match(src, /PROBE_QUERY_PREFIX = 'zzprobe_'/,
        'the backend excludes on this exact string');
    // The distinction is the whole design: a real product term CANNOT be
    // prefixed without measuring something else, so the notice has to admit
    // that some of our rows are indistinguishable from organic traffic.
    assert.match(src, /SYNTHETIC/, 'the module must name the kind that can be sentinelled');
    assert.match(src, /REAL/, 'and the kind that cannot');
    assert.match(src, /zzqqxnotaproduct9987/,
        'keep the measurement that started this — six live rows, 2026-09-12 — or the next '
        + 'reader has only an assertion');
});

test('§6 the confirmed polluter no longer spells the old term', () => {
    const src = fs.readFileSync(path.join(SCRIPTS, 'probe-search-value-pack-ranking.mjs'), 'utf8');
    const code = stripComments(src);
    assert.doesNotMatch(code, /zzqqxnotaproduct9987/,
        'the term measured in production must not still be issued as a query');
    assert.match(code, /probeQuery\(/, 'it must ask the shared helper for its control term');
    // Positive control: the control query still exists. A probe whose "can this
    // endpoint say no?" check was deleted would also pass the line above.
    assert.match(code, /nonsense query returns zero rows/,
        'the zero-result positive control must survive the rename');
});

test('§7 POSITIVE CONTROL: importing the notice without printing it is not enrolment', () => {
    // The red-proof for §2 initially passed against a probe whose print had been
    // deleted, because the import line still spelled the identifier. This asserts
    // the detector itself, on a synthetic source, so the hole cannot reopen.
    const importOnly = "import { SEARCH_ANALYTICS_NOTICE } from './lib/probe-search-notice.mjs';\nconsole.log('hi');\n";
    const stripped = stripComments(importOnly).replace(/^\s*import[^;]*;\s*$/gm, '');
    assert.ok(!stripped.includes('SEARCH_ANALYTICS_NOTICE'),
        'an import-only file must not read as enrolled');

    const printed = importOnly + 'console.log(SEARCH_ANALYTICS_NOTICE);\n';
    const strippedPrinted = stripComments(printed).replace(/^\s*import[^;]*;\s*$/gm, '');
    assert.ok(strippedPrinted.includes('SEARCH_ANALYTICS_NOTICE'),
        'and a file that prints it must — or §2 would pass by never matching anything');
});
