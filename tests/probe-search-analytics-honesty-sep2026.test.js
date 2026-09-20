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
const FE_JS = path.join(__dirname, '..', 'inkcartridges', 'js');

/**
 * The read endpoints that cause a `search_analytics` row to be written — matched
 * only where one is being BUILT INTO A URL, never where it is merely named.
 *
 * ⚠️ THE NAIVE PATTERN IS WRONG IN BOTH DIRECTIONS AT ONCE, AND THIS WAS MEASURED
 * RATHER THAN REASONED (2026-09-20).
 *
 *   FALSE POSITIVE. probe-lookalike-rows.mjs contains the sentence "…falls back to
 *   /api/search/smart…" inside a REPORT STRING — prose about a different file's
 *   behaviour. Stripping comments does not remove it, because it is a string
 *   literal, so the probe read as a writer and §2 demanded a notice it has nothing
 *   to disclose. An enrolment list with a wrong entry is one nobody trusts.
 *
 *   FALSE NEGATIVE, and this is the one that matters. probe-search-escaping.mjs
 *   builds `${API}/api/search/${ep}?…` — the endpoint NAME is a variable. The
 *   literal `/api/search/smart` appears in that file ONLY in console.log headings.
 *   So the naive pattern was matching a real reader BY ACCIDENT, via its own
 *   section titles, and the obvious fix for the false positive above (requiring a
 *   URL boundary before the path) silently dropped it.
 *
 * ***A DETECTOR TIGHTENED TO REMOVE A FALSE POSITIVE CAN TAKE A TRUE POSITIVE WITH
 * IT, AND THE SUITE STAYS GREEN EITHER WAY*** — the reader set is an input to every
 * assertion below, so shrinking it enrols fewer files and fails nothing. The set
 * was diffed before and after this change, both ways, and is byte-identical to the
 * pre-existing ten. §12 pins both directions.
 *
 * So: the path must start at a URL boundary (quote, backtick, `}` from `${API}`,
 * or `/`), and the segment after it may be a template expression.
 */
const LOGGING_ENDPOINTS = /(?<=[`'"}\/])\/api\/search\/(?:smart|suggest|autocomplete|\$\{)/;

/**
 * THE SECOND DOOR — a probe can write a `search_analytics` row without its source
 * ever naming the endpoint (ERR-271).
 *
 * The detector below `LOGGING_ENDPOINTS` greps script SOURCE. Five Playwright
 * probes drive the REAL search box or navigate to the site's own `/search?q=`
 * page, so the BROWSER issues the GET and the backend writes the row — while the
 * script text contains no `/api/search/` at all. They were invisible: §1 never
 * counted them, §2 never asked them for a notice, and every one of them printed
 * a MODE banner claiming to be read-only. probe-qty-typing.mjs's said "no Add to
 * Cart is ever clicked, no cart is written", which is true, and about a different
 * database.
 *
 * ***THIS IS THE THIRD TIME THIS FILE'S OWN DETECTOR HAS BEEN WRONG IN THE SAME
 * DIRECTION.*** The docstring on ENROLMENT_FORMS records the first two, and its
 * conclusion — A GUARD CANNOT SEE WHAT IT DOES NOT SPELL — was about the
 * enrolment side. It was equally true of the reader side, one function up, and
 * nobody looked there. A mechanism with two ways in needs two doorbells.
 *
 * WHY THE `/search?q=` PATTERN CARRIES A LOOKBEHIND. Written as a bare
 * `/\/search\?q=/` it also matches `${API}/api/printers/search?q=…` in
 * probe-printer-canonicals.mjs — a DIFFERENT endpoint that writes nothing. That
 * false positive would have enrolled a probe that does not need it, which is how
 * an enrolment list stops meaning anything. The lookbehind requires the path to
 * begin at a string or template boundary, so only a site-relative `/search?q=`
 * counts. Pinned by §10.
 */
const BROWSER_SEARCH_FORMS = [
    /(?<=['"`}])\/search\?q=/,   // navigating to the site's search results page
    /#search-input/,             // typing into the header search box
    /#error-search-input/,       // ...or the 404 page's copy of it
    /\.search-input/,            // ...or the class-based selector for either
];

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
    // EMPTY, 2026-09-16 — every script that reads the logging endpoints now
    // prints the notice. Kept rather than deleted because the machinery around
    // it (§3) is what stops an exception quietly becoming the rule: a new probe
    // that skips enrolment fails §2 and cannot be waved through without adding
    // a line here, in front of a reviewer.
]);

const files = fs.readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => !NOT_A_SEARCH_READER.has(f));

/**
 * Comments are stripped before BOTH detectors, so a file counts as a reader for
 * what it DOES, never for what it says. This matters more than it looks: the
 * notices added to the five browser-driven probes explain the mechanism and
 * therefore contain the literal `/api/search/*`. Left unstripped, those comments
 * would satisfy LOGGING_ENDPOINTS, BROWSER_SEARCH_FORMS would never be
 * load-bearing, and deleting it would not fail a single test. That is §4's
 * hazard (a suite scanning for a literal its own prose contains) arriving in the
 * reader detector instead. Verified before the change: stripping comments leaves
 * the pre-existing set of 10 endpoint readers byte-identical.
 */
function codeOf(file) {
    return stripComments(fs.readFileSync(path.join(SCRIPTS, file), 'utf8'));
}

const endpointReaders = files.filter((f) => LOGGING_ENDPOINTS.test(codeOf(f)));
const browserReaders = files.filter((f) => {
    const code = codeOf(f);
    return BROWSER_SEARCH_FORMS.some((re) => re.test(code));
});
const readers = [...new Set([...endpointReaders, ...browserReaders])].sort();

/**
 * Enrolled means PRINTED, not imported — and there are TWO ways to print it.
 *
 * THIS DETECTOR HAS NOW BEEN WRONG TWICE, IN THE SAME DIRECTION BOTH TIMES.
 *
 * First version asked `src.includes('SEARCH_ANALYTICS_NOTICE')` over the whole
 * file. The red-proof caught it: deleting the print left the import line, the
 * identifier was still there, and the suite stayed green over a probe that had
 * gone silent. Fixed by stripping imports first.
 *
 * Second version still asked for that one literal — and
 * `scripts/lib/probe-search-notice.mjs` also exports
 * `printSearchAnalyticsNotice()`, a wrapper written so the wording would have
 * exactly one owner. **`printSearchAnalyticsNotice` does not contain the string
 * `SEARCH_ANALYTICS_NOTICE`** (camelCase vs upper-snake), so two probes that
 * enrolled through the convenience helper read as un-enrolled for four days,
 * and §3 below — whose whole job is "an entry here has been enrolled, delete
 * its line" — passed because it could not see the enrolment it was checking.
 *
 * ***A GUARD CANNOT SEE WHAT IT DOES NOT SPELL.*** The mechanism grew a second
 * front door and the doorbell was only wired to the first. Both forms count
 * now, and §8 pins that so a third door cannot open silently.
 */
const ENROLMENT_FORMS = [
    'SEARCH_ANALYTICS_NOTICE',      // the constant, printed by the caller
    'printSearchAnalyticsNotice(',  // the wrapper that prints it for you
];

function printsTheNotice(file) {
    const src = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
    const withoutImports = stripComments(src).replace(/^\s*import[^;]*;\s*$/gm, '');
    return ENROLMENT_FORMS.some((form) => withoutImports.includes(form));
}

test('§1 the scan finds the search-reading scripts at all', () => {
    // A suite that silently matched nothing would pass every assertion below.
    assert.ok(readers.length >= 5,
        `only ${readers.length} scripts matched — the endpoint regex has probably drifted, `
        + 'and an enrolment test that scans nothing enrols nothing');

    // BOTH detectors must be finding something. A floor on the union alone would
    // stay green if BROWSER_SEARCH_FORMS silently stopped matching — which is the
    // state this file was in until 2026-09-20, with ten endpoint readers hiding
    // five browser-driven ones (ERR-271).
    assert.ok(endpointReaders.length >= 5,
        `only ${endpointReaders.length} scripts name /api/search/* in code`);
    assert.ok(browserReaders.length >= 4,
        `only ${browserReaders.length} scripts drive the real search box — BROWSER_SEARCH_FORMS `
        + 'has drifted, and the five probes it was written for would go unwatched again');
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

test('§8 POSITIVE CONTROL: the detector sees BOTH ways of printing the notice', () => {
    // §7 proves an import alone is not enrolment. This proves the inverse half:
    // that every form the module actually offers is recognised. The second form
    // existed for four days before this detector learned it, and nothing failed
    // in the meantime — §3 just quietly stopped meaning anything.
    const IMPORT = "import { SEARCH_ANALYTICS_NOTICE, printSearchAnalyticsNotice } from './lib/probe-search-notice.mjs';\n";
    const strip = (src) => stripComments(src).replace(/^\s*import[^;]*;\s*$/gm, '');

    for (const [label, body] of [
        ['the constant, printed by the caller', 'console.log(SEARCH_ANALYTICS_NOTICE);\n'],
        ['the wrapper that prints it for you', 'printSearchAnalyticsNotice();\n'],
    ]) {
        const stripped = strip(IMPORT + body);
        assert.ok(ENROLMENT_FORMS.some((f) => stripped.includes(f)),
            `${label}: this is a real enrolment and the detector must recognise it`);
    }

    // And the module must actually export every form the detector accepts —
    // otherwise this list could drift into recognising something that does not
    // exist, which is a guard that passes on a typo.
    const mod = fs.readFileSync(path.join(SCRIPTS, 'lib', 'probe-search-notice.mjs'), 'utf8');
    for (const form of ENROLMENT_FORMS) {
        const name = form.replace(/\($/, '');
        assert.match(mod, new RegExp(`export (const|function) ${name}\\b`),
            `${name} is accepted as enrolment but is not exported — the detector would be `
            + 'recognising something nothing can call');
    }
});

test('§9 POSITIVE CONTROL: the browser detector sees a driven search, and only a real one', () => {
    // §7 and §8 red-proof the ENROLMENT side. This is the same treatment for the
    // READER side, which is where the hole actually was (ERR-271): the detector
    // that decides who gets asked for a notice had no control of its own, so it
    // could — and did — silently match nothing for a whole class of probe.
    const sees = (src) => BROWSER_SEARCH_FORMS.some((re) => re.test(stripComments(src)));

    for (const [label, src] of [
        ['navigating to the search page',  "const U = '/search?q=lc531';\nawait page.goto(BASE + U);\n"],
        ['a template-literal navigation',  'await page.goto(`${BASE}/search?q=lc57`);\n'],
        ['typing into the header box',     "await page.locator('#search-input').fill('lc');\n"],
        ['typing into the 404 page box',   "await page.locator('#error-search-input').fill('lc');\n"],
        ['the class-based selector',       "page.locator('.search-input').first();\n"],
    ]) {
        assert.ok(sees(src), `${label}: this drives a real search and must be detected`);
    }

    // ── THE FALSE POSITIVE THAT NEARLY GOT IN ──────────────────────────────
    // A bare /\/search\?q=/ also matches `${API}/api/printers/search?q=…`, which
    // is a DIFFERENT endpoint and writes nothing. Enrolling that probe would have
    // put a notice on a script with nothing to disclose, and an enrolment list
    // with a wrong entry in it is one nobody trusts. The lookbehind is what
    // stops it, so the lookbehind gets a control.
    assert.ok(!sees("const res = await fetch(`${API}/api/printers/search?q=${q}`);\n"),
        '/api/printers/search is not the logging endpoint and must NOT enrol a probe');
    assert.ok(!sees("await fetch(`${API}/api/admin/orders/search?q=${q}`);\n"),
        'nor any other …/search?q= route that happens to end that way');

    // And prose must never enrol anything: comments are stripped first.
    assert.ok(!sees("// this probe does not touch /search?q= or #search-input at all\n"),
        'a comment describing the mechanism is not the mechanism');

    // The five probes this section exists for. Named, because the failure mode is
    // the detector quietly matching FEWER files, and a count cannot tell you which.
    for (const f of ['probe-404-search-dropdown.mjs', 'probe-search-dropdown-columns.mjs',
                     'probe-qty-typing.mjs', 'probe-mobile-ux.mjs',
                     'probe-shop-source-columns.mjs']) {
        assert.ok(browserReaders.includes(f),
            `${f} drives the real search box — it must be detected as a writer`);
        assert.ok(printsTheNotice(f), `${f} must print the notice`);
    }
});

test('§10 the browser-driven probes are found by the BROWSER detector, not the endpoint one', () => {
    // If one of these ever starts naming /api/search/ in code too, it would be
    // caught by LOGGING_ENDPOINTS and this suite would keep passing with
    // BROWSER_SEARCH_FORMS dead. That is the exact way the enrolment detector went
    // blind for four days (see ENROLMENT_FORMS). Asserting WHICH detector found
    // each one keeps the two doorbells independently wired.
    for (const f of ['probe-404-search-dropdown.mjs', 'probe-search-dropdown-columns.mjs',
                     'probe-qty-typing.mjs', 'probe-mobile-ux.mjs',
                     'probe-shop-source-columns.mjs']) {
        assert.ok(!endpointReaders.includes(f),
            `${f} is expected to be invisible to the endpoint detector — if it now names `
            + '/api/search/ in code, move it off this list so the browser detector keeps a subject');
    }
    // probe-printer-canonicals.mjs greps as a near-miss and must stay out of BOTH.
    assert.ok(!readers.includes('probe-printer-canonicals.mjs'),
        'it reads /api/printers/search, which writes no search_analytics row');
});

// ─────────────────────────────────────────────────────────────────────────
// §11  THE SITE ITSELF — the polluter that is not a probe at all
// ─────────────────────────────────────────────────────────────────────────

test('§11 no front-end file issues a HARDCODED search term', () => {
    // Everything above is about scripts/. This is the same defect on the storefront,
    // and it would have been larger than every probe combined: js/landing.js called
    // `API.smartSearch('ink cartridge', 8)` to fill a "featured products" rail, on a
    // page that loads for every visitor. Each of those GETs makes the backend write a
    // `search_analytics` row, so the literal would have become a top search term the
    // site authored about itself.
    //
    // ***AND IT IS THE ONE KIND OF POLLUTION THAT CANNOT BE FILTERED.*** A probe term
    // can carry `zz`. "ink cartridge" is what a real shopper types, so excluding it
    // would delete real demand — the same argument that keeps `test` unfiltered on the
    // backend's side. The only fix is not to send it, which is why landing.js now reads
    // /api/products/popular instead.
    //
    // It was INERT when found (no HTML in this repo has #featured-products-grid, so the
    // call was unreachable). That is why this test exists rather than just the fix: the
    // next person to add that markup re-arms it, and nothing would connect the two.
    const files = fs.readdirSync(FE_JS).filter((f) => f.endsWith('.js'));
    assert.ok(files.length > 40, `only ${files.length} front-end files scanned — the path has drifted`);

    const offenders = [];
    for (const f of files) {
        const code = stripComments(fs.readFileSync(path.join(FE_JS, f), 'utf8'));
        // A quoted first argument is a literal. A variable is a real shopper's query.
        const re = /\b(?:smartSearch|searchSuggest)\s*\(\s*['"`]/g;
        if (re.test(code)) offenders.push(f);
    }
    assert.deepEqual(offenders, [],
        'these pass a hardcoded term to a search endpoint, so the site writes that term to '
        + '`search_analytics` on every page view. Use a non-search source — /api/products/popular '
        + 'for a featured rail (API.getPopularProducts) — or the term becomes an unfilterable '
        + 'entry in the live top-search-terms list.');

    // POSITIVE CONTROL: the pattern must actually match the shape it forbids, or this
    // assertion passes by never matching anything — §4's failure mode, one file over.
    for (const bad of ["API.smartSearch('ink cartridge', 8)", 'API.searchSuggest(`toner`)',
                       "API.smartSearch( 'x' )"]) {
        assert.match(bad, /\b(?:smartSearch|searchSuggest)\s*\(\s*['"`]/,
            `the detector must catch ${bad}`);
    }
    for (const good of ['API.smartSearch(this.state.search, 24)', 'API.searchSuggest(q)']) {
        assert.doesNotMatch(good, /\b(?:smartSearch|searchSuggest)\s*\(\s*['"`]/,
            `a real shopper query must not be flagged: ${good}`);
    }
});

test('§11 the featured rail reads the popular endpoint, not the search one', () => {
    // Naming the replacement, not just forbidding the original. Without this, the fix
    // could be "delete the rail", and the next person to want a featured rail starts
    // from the search endpoint again because nothing records which source is correct.
    const src = fs.readFileSync(path.join(FE_JS, 'landing.js'), 'utf8');
    const code = stripComments(src);
    assert.match(code, /API\.getPopularProducts\(/,
        'js/landing.js must fill the featured rail from /api/products/popular');
    assert.doesNotMatch(code, /API\.smartSearch\(/,
        'and must not search for products to feature');
    // No category is passed, deliberately — `consumable` resolves to NO filter rather
    // than drums (shop-page.js:1562), so a guessed category silently changes the shelf.
    assert.doesNotMatch(code, /getPopularProducts\(\s*\{[^}]*category/,
        'no category should be guessed here — bare popular is the whole-catalogue rail');
    assert.match(src, /ERR-254/, 'the reason must survive next to the call');
});

test('§12 the endpoint detector keys on a URL being BUILT, not on the endpoint being named', () => {
    // Both directions, because tightening this pattern to kill a false positive is
    // how a real reader gets dropped — and a smaller reader set fails nothing.
    const sees = (src) => LOGGING_ENDPOINTS.test(stripComments(src));

    // MUST match — these issue the request.
    for (const [label, src] of [
        ['a template URL',            'const url = `${API}/api/search/smart?q=${q}`;\n'],
        ['a variable endpoint name',  'const url = `${API}/api/search/${ep}?limit=8`;\n'],
        ['suggest',                   'await fetch(`${BASE}/api/search/suggest?q=x`);\n'],
        ['a quoted path',            "await fetch(API + '/api/search/autocomplete?q=x');\n"],
    ]) {
        assert.ok(sees(src), `${label}: this builds a logging URL and must be detected`);
    }

    // MUST NOT match — these only NAME the endpoint.
    for (const [label, src] of [
        ['prose in a report string',
         "report.push('product-detail-page.js falls back to /api/search/smart, so every…');\n"],
        ['a console.log heading',
         "console.log('§1  /api/search/smart — the injection the backend fixed');\n"],
        ['a comment',
         '// we deliberately do not call /api/search/smart here\n'],
    ]) {
        assert.ok(!sees(src), `${label}: naming an endpoint is not calling it`);
    }

    // The two files that forced this, by name, so the next edit to the pattern has
    // to keep answering for both.
    assert.ok(endpointReaders.includes('probe-search-escaping.mjs'),
        'probe-search-escaping.mjs builds /api/search/${ep} and IS a writer — it must not be '
        + 'dropped by a tightening aimed at prose');
    assert.ok(!readers.includes('probe-lookalike-rows.mjs'),
        'probe-lookalike-rows.mjs only quotes the endpoint in a report string — it writes nothing');
});
