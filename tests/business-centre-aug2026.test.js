/**
 * BUSINESS CENTRE — /business (Aug 2026)
 * ======================================
 *
 * An approved B2B customer gets one page: what their business account has saved
 * them, what they've spent, what they reorder, and their invoices — so they can
 * look an invoice up on the site instead of digging through their inbox.
 *
 * The failure modes these tests exist to prevent, in order of how badly they'd
 * bite:
 *
 *   1. A DIRECTORY named `business`. Four parity walkers skip one by name
 *      (navbar-parity:55, mobile-parity:50, mobile-ux-audit:48,
 *      admin-header-link:50). Build html/business/ and those sweeps score the
 *      page zero and report green — the page drifts and nothing says so.
 *   2. An outage rendered as a verdict. Business.getStatus() folds "not a
 *      business account" and "backend unreachable" into one inactive shape.
 *      Telling a paying customer they're not a business account because of a
 *      500 is ERR-139 exactly. Both the header button and the page gate must
 *      read _statusDegraded.
 *   3. Absence rendered as zero (ERR-063/068/073/075/076). A failed fetch must
 *      never produce the empty state, and a null figure must never render $0.00.
 *   4. Supplier cost leaking onto a customer surface. On an invoice
 *      `unit_cost_excl_gst` is the SELL price but `supplier_cost_excl_gst` is
 *      what WE paid — one word apart, in the risky direction.
 *
 * Run: node --test tests/business-centre-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');
const JS = (rel) => read(path.join('js', rel));

const PAGE = read('html/business.html');
const PAGE_JS = JS('business-page.js');
const PDF_JS = JS('business-invoice-pdf.js');
const CHART_JS = JS('savings-chart.js');
const PERF_JS = JS('business-chart.js');
const LOYALTY_PAGE = read('html/account/loyalty.html');
const BUSINESS_JS = JS('business.js');
const LAYOUT_CSS = read('css/layout.css');
const PAGES_CSS = read('css/pages.css');
const VERCEL = read('vercel.json');
const SERVE = read('serve.json');

/** Strip comments so a literal inside a comment can't satisfy an assertion. */
const codeOnly = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * BusinessChart under a bare context. A plain `{innerHTML}` stand-in has no DOM,
 * so the emitted markup IS the contract — which is the point: the module must be
 * able to say everything it needs to say in the markup alone.
 */
function loadPerfChart() {
    const ctx = vm.createContext({ window: {}, module: { exports: {} }, console });
    ctx.globalThis = ctx;
    vm.runInContext(PERF_JS, ctx, { filename: 'business-chart.js' });
    return ctx.window.BusinessChart;
}

function extractBlock(html, openTag, closeTag) {
    const s = html.indexOf(openTag);
    if (s === -1) return null;
    const e = html.indexOf(closeTag, s);
    if (e === -1) return null;
    return html.slice(s, e + closeTag.length);
}

// ═════════════════════════════════════════════════════════════════════════════
// §1 — the page is a FLAT file, and shares the site chrome exactly
// ═════════════════════════════════════════════════════════════════════════════

test('§1 /business is a flat file, never a directory the parity walkers skip', () => {
    assert.ok(fs.existsSync(path.join(INK, 'html/business.html')),
        'html/business.html must exist');
    assert.ok(!fs.existsSync(path.join(INK, 'html/business')),
        'html/business/ must NOT exist — navbar-parity, mobile-parity, mobile-ux-audit and ' +
        'admin-header-link all skip a directory named `business` by name, so a folder would ' +
        'silently exempt this page from every header and mobile sweep');
});

test('§1 the header and footer blocks are byte-identical to a donor page', () => {
    const donor = read('html/account/loyalty.html');
    for (const [open, close, what] of [
        ['<header class="site-header">', '</header>', 'header'],
        ['<footer class="site-footer">', '</footer>', 'footer'],
    ]) {
        const mine = extractBlock(PAGE, open, close);
        const theirs = extractBlock(donor, open, close);
        assert.ok(mine, `business.html has no ${what} block`);
        assert.equal(hash(mine), hash(theirs),
            `business.html's ${what} diverged from the shared one — navbar-parity/footer-redesign ` +
            `hash these across every page and fail on a single byte`);
    }
});

test('§1 head carries what the page-sweep tests require of a private page', () => {
    assert.match(PAGE, /<meta name="robots" content="noindex, nofollow">/,
        'a logged-in B2B page must be noindex');
    assert.ok(!/rel="canonical"/.test(PAGE),
        'no canonical — account pages omit it, and adding one opts the page into ' +
        "fe-audit's hreflang-exactly-once check");
    assert.match(PAGE, /<meta name="theme-color" content="#267FB5">/);
    assert.match(PAGE, /<meta name="color-scheme" content="light">/);
    assert.match(PAGE, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(PAGE, /hreflang="en-NZ" id="hreflang-en"/);
    assert.match(PAGE, /hreflang="x-default" id="hreflang-default"/);
});

test('§1 script order: legal-config before footer, and every dependency present', () => {
    const idx = (f) => PAGE.indexOf(`/js/${f}?`);
    for (const f of ['config.js', 'security.js', 'utils.js', 'api.js', 'auth.js',
        'business.js', 'main.js', 'order-totals.js', 'business-chart.js',
        'business-invoice-pdf.js', 'business-page.js']) {
        assert.ok(idx(f) > -1, `business.html must load /js/${f}`);
    }
    assert.ok(idx('legal-config.js') < idx('footer.js'),
        'legal-config.js must precede footer.js — `defer` preserves document order');
    assert.ok(idx('business-chart.js') < idx('business-page.js'),
        'business-chart.js must precede business-page.js — the controller calls BusinessChart.render()');

    // savings-chart.js was this page's chart until the Performance overview
    // replaced it. Shipping it here now would be a dead request, and the
    // ordering assertion above would be asserting a reason that isn't true.
    assert.ok(!/savings-chart\.js/.test(PAGE),
        'business.html no longer draws with SavingsChart — drop the script tag');
    // ...but the module is NOT dead: the Loyalty page still draws with it, and a
    // future reader must not read the line above as permission to delete it.
    assert.match(LOYALTY_PAGE, /\/js\/savings-chart\.js\?/,
        'the loyalty page still draws with SavingsChart — it is frozen, not retired');
    assert.ok(idx('order-totals.js') < idx('business-page.js'),
        'order-totals.js must precede business-page.js — OrderTotals.format() renders every nullable figure');
    assert.ok(!/auth-redirect\.js/.test(PAGE),
        'auth-redirect.js parses location.hash for access_token and would fight the tab router');
});

test('§1 routing is declared in BOTH configs (ERR-092: works live, 404s locally)', () => {
    assert.match(VERCEL, /\{ "source": "\/business", "destination": "\/html\/business" \}/,
        'vercel.json needs the rewrite — leading slash, no .html (cleanUrls)');
    assert.match(SERVE, /\{ "source": "business", "destination": "\/html\/business\.html" \}/,
        'serve.json needs it too — no leading slash, .html required, or local dev 404s');
});

test('§1 the retired Business Accounts surface is not resurrected', () => {
    // tests/legal-pages.test.js §7 bans these outright.
    assert.ok(!/\/business\/apply/.test(PAGE), 'the /business/apply URL is retired');
    assert.ok(!/\/business\/apply/.test(VERCEL), 'no /business/apply route may reappear in vercel.json');
    assert.ok(!/href="\/contact\?subject=Business/i.test(PAGE));
    assert.ok(!/href="\/html\//.test(PAGE), 'link to /business, never /html/business');
});

test('§1 every element id the controller reaches for exists in the page', () => {
    // A typo'd id is the quietest possible bug: the section just never fills in
    // and nothing throws.
    const ids = new Set();
    for (const m of codeOnly(PAGE_JS).matchAll(/\$\('([a-z0-9-]+)'\)/g)) ids.add(m[1]);
    for (const m of codeOnly(PAGE_JS).matchAll(/show\('([a-z0-9-]+)'/g)) ids.add(m[1]);
    const missing = [...ids].filter((id) => !PAGE.includes(`id="${id}"`));
    assert.deepEqual(missing, [],
        `business-page.js reaches for ids that business.html does not ship: ${missing.join(', ')}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// §2 — the header button
// ═════════════════════════════════════════════════════════════════════════════

test('§2 every page with a site-header loads business.js (the button rides on it)', () => {
    // The whole zero-lines-in-main.js approach rests on this, and it currently
    // holds by accident. Pin it.
    const offenders = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === 'admin' || e.name === 'node_modules') continue;
                walk(p);
            } else if (e.name.endsWith('.html')) {
                const html = fs.readFileSync(p, 'utf8');
                if (html.includes('<header class="site-header">') && !html.includes('/js/business.js')) {
                    offenders.push(path.relative(INK, p));
                }
            }
        }
    };
    walk(INK);
    assert.deepEqual(offenders, [],
        'these pages ship the header but not business.js, so the Business button can never appear on them');
});

test('§2 the button is JS-injected as the FIRST action item, styled like Admin', () => {
    const code = codeOnly(BUSINESS_JS);
    assert.match(code, /initHeaderLink\(\)/, 'business.js must define initHeaderLink()');
    assert.match(code, /_headerInited/, 'initHeaderLink must be idempotent');
    assert.match(code, /querySelector\('\.header-actions'\)/,
        'the button belongs in the right-hand .header-actions cluster');
    assert.match(code, /insertBefore\(a, actions\.firstElementChild\)/,
        'it must LEAD the cluster. The two privileged shortcuts bracket the customer ones: ' +
        'Business first, Admin appended last (main.js#initAdminHeaderLink).');
    assert.match(code, /id = 'header-business-link'/);
    assert.match(code, /header-actions__item--business/);
    assert.match(code, /a\.href = '\/business'/);
    assert.match(code, /aria-label', 'Business Centre'/);
    // The visible label is the single word "Business" (Aug 2026). Two forces:
    //   WIDTH — "Business Centre" on one line measures ~124px against ~67px for
    //   the widest single-word label, which overflows the cluster's grid track
    //   and collides with the centred logo (measured: 27px into the tagline at
    //   1512px). "Business" is ~60px, narrower than "Favourites".
    //   HEIGHT — the earlier fix stacked it on two lines via a <br>, which cured
    //   the width but made this the tallest item in the cluster and forced the
    //   whole row to top-align, parking the other icons ~9px above the white
    //   bar's centre line. One word is one line is uniform height.
    // The aria-label asserted above carries the full name for assistive tech.
    assert.match(code, /<span>Business<\/span>/,
        'the header label must be the single word "Business" — "Business Centre" on one line ' +
        'overflows the action cluster into the logo, and stacking it on two lines makes this ' +
        'item taller than its siblings and forces the cluster off the bar\'s centre line.');
    assert.ok(!/<br>/.test(code),
        'do not re-stack the label with a <br>: it reintroduces the taller item and the ' +
        'top-alignment override that lifted Account / Favourites / Cart off centre');
    assert.ok(!/\.header-actions \{[^}]*align-items: flex-start/.test(LAYOUT_CSS),
        'the labelled cluster must NOT top-align any more — every item is one line tall now, ' +
        'so it inherits align-items: center and sits on the white bar\'s centre line');

    // No page may ship it statically: the header is byte-identical across 30
    // pages, so a static fourth item would mean editing all 30 in lockstep.
    assert.ok(!/id="header-business-link"/.test(PAGE),
        'the button must be injected, not shipped in markup');

    assert.match(LAYOUT_CSS, /\.header-actions__item--admin,\s*\n\.header-actions__item--business \{\s*\n\s*color: var\(--color-primary\)/,
        'Admin and Business must share ONE colour rule so they can never drift apart');
});

test('§2 exactly one auth listener, and it resets BEFORE re-evaluating', () => {
    const code = codeOnly(BUSINESS_JS);
    const listeners = (code.match(/onAuthStateChange\(/g) || []).length;
    assert.equal(listeners, 1,
        'two listeners would work only by registration order; the moment they are reordered the ' +
        'header re-evaluates against the stale memoised status and can show one user’s button to the next');
    assert.match(code, /onAuthStateChange\(\s*\(\)\s*=>\s*\{[\s\S]{0,200}?this\.reset\(\)[\s\S]{0,200}?this\._evaluateHeaderLink\(\)/,
        'reset() must run before _evaluateHeaderLink() inside the one callback');
});

test('§2 a degraded status leaves the button alone instead of removing it', () => {
    const code = codeOnly(BUSINESS_JS);
    assert.match(code, /if \(this\._statusDegraded\) return;/,
        '_evaluateHeaderLink must bail on a non-answer — an outage must not silently ' +
        'take a working surface away (ERR-139)');
    assert.match(code, /_statusDegraded = true/,
        'getStatus() must record when it returned a non-answer rather than a real "no"');
});

// ═════════════════════════════════════════════════════════════════════════════
// §3 — the gate: degraded is not denied
// ═════════════════════════════════════════════════════════════════════════════

test('§3 the page renders three distinct gate states, and never redirects a signed-in user', () => {
    for (const id of ['business-loading', 'business-denied', 'business-unavailable', 'business-main']) {
        assert.ok(PAGE.includes(`id="${id}"`), `business.html must ship #${id}`);
    }
    const code = codeOnly(PAGE_JS);
    assert.match(code, /if \(Business\._statusDegraded\)[\s\S]{0,160}business-unavailable/,
        'a degraded status must render "couldn\'t confirm", NOT "you are not a business account"');
    assert.match(code, /if \(!status\.active\)[\s\S]{0,120}business-denied/);

    // NOBODY is redirected off this page — not even a guest.
    const redirects = code.match(/window\.location\.href\s*=\s*'([^']+)'/g) || [];
    assert.deepEqual(redirects, [],
        'business-page.js must not redirect anyone. Bouncing a signed-in user off their own page ' +
        'on a 500 makes a shared link look broken; bouncing a GUEST to /account/login made the ' +
        'page unreachable for the only audience that needed it (see the guest-gate test below)');
});

test('§3 a GUEST gets the explainer, never a login wall', () => {
    // The discovery gap this page exists to close: every other B2B surface —
    // PDP ladders, card overlays, cart nudges, the account panel — renders only
    // for a signed-in APPROVED account. So a prospective business customer had
    // no way to learn that volume pricing exists at all.
    //
    // /business is the answer, and it was redirecting guests to
    // /account/login?redirect=/business — a sign-in form that explains nothing,
    // reached from a footer link whose entire purpose was to explain. The gate
    // copy is not account-specific, so guests see it like anyone else.
    const code = codeOnly(PAGE_JS);
    assert.doesNotMatch(code, /account\/login\?redirect=\/business['"]\s*;/,
        'a guest must not be redirected to the login page');
    assert.match(code, /isAuthenticated\(\)\)\s*\{[\s\S]{0,900}?show\('business-denied',\s*true\)/,
        'an unauthenticated visitor must be shown #business-denied');
    assert.match(code, /markGuest\(\)/, 'the guest path must add the sign-in route');

    // The gate's own copy must carry the real intake, and must not promise an
    // application flow that has no endpoint behind it (ERR-138).
    const gate = PAGE.slice(PAGE.indexOf('id="business-denied"'), PAGE.indexOf('id="business-unavailable"'));
    assert.match(gate, /href="\/quote"/, 'the gate must route intent to /quote, the real intake');
    assert.ok(!/<form/i.test(gate), 'the gate must not grow an application form');

    // And the sign-in route is injected, not shipped — a signed-in-but-
    // unapproved user must never be offered a sign-in link they already used.
    assert.ok(!PAGE.includes('data-guest-signin'),
        'the sign-in link is injected by markGuest() for guests only, never shipped in the HTML');
});

// ═════════════════════════════════════════════════════════════════════════════
// §4 — absence is never rendered as zero
// ═════════════════════════════════════════════════════════════════════════════

test('§4 nullable money renders through OrderTotals.format, not formatPrice', () => {
    const code = codeOnly(PAGE_JS);
    assert.match(code, /OrderTotals\.format/,
        'OrderTotals.format renders `—` for null; formatPrice(null) returns an empty string, ' +
        'which reads as "nothing here" rather than "not reported"');
    assert.ok(!/\bformatPrice\(/.test(code),
        'business-page.js must not call formatPrice directly on nullable invoice/series money');
});

test('§4 a failed fetch shows an error + Retry, never the empty state', () => {
    const code = codeOnly(PAGE_JS);
    // Each loader must, on failure, hide the empty state and show the error.
    for (const [empty, error] of [
        ['perf-empty', 'perf-error'],
        ['top-products-empty', 'top-products-error'],
        ['recent-invoices-empty', 'recent-invoices-error'],
        ['invoices-empty', 'invoices-error'],
    ]) {
        const re = new RegExp(`show\\('${empty}', false\\);[\\s\\S]{0,80}show\\('${error}', true\\)`);
        assert.match(code, re,
            `a failed fetch must hide #${empty} and show #${error} — "you have none" and ` +
            '"we couldn\'t load them" are different sentences');
    }
    const retries = (PAGE.match(/data-retry="/g) || []).length;
    assert.ok(retries >= 4, `every failable section needs a Retry control, found ${retries}`);
});

test('§4 the outstanding balance is READ, never summed from a paginated list', () => {
    const code = codeOnly(PAGE_JS);
    assert.match(code, /outstanding_balance/,
        'the headline must come from the summary endpoint');
    assert.ok(!/\.reduce\(/.test(code),
        'summing the invoice list would understate the debt with total confidence — it is paginated');
});

test('§4 invoice filters go to the SERVER, not applied to a fetched page', () => {
    const code = codeOnly(PAGE_JS);
    for (const p of ['status', 'from', 'to']) {
        assert.match(code, new RegExp(`p\\.append\\('${p}'`),
            `the ${p} filter must be a query parameter — filtering page 1 of a paginated list ` +
            'in the browser produces a confidently wrong result set');
    }
});

test('§4 a null series bucket is a visible GAP, not a dropped one and not a zero', () => {
    // This test used to pin the literal `.filter((p) => p.v !== null)` while its
    // own message asked for a gap — because the old chart plotted on epoch time
    // and could only DROP an unknown bucket, quietly shortening the series.
    // BusinessChart plots categorically, so the bucket keeps its slot and the
    // absence gets a mark of its own. Dropping is now the wrong answer.
    const code = codeOnly(PAGE_JS);
    assert.ok(!/\.filter\(\(p\) => p\.v !== null\)/.test(code),
        'a dropped bucket silently shortens the series — the slot must survive');
    assert.ok(!/points\s*:\s*pts\.filter/.test(code),
        'the raw points go to the chart; it is the chart that decides how to show a gap');
    assert.match(code, /points:\s*pts/,
        'nulls must reach BusinessChart intact so it can mark them as not recorded');
});

test('§4 the window figures are READ off the chart, never re-added by the page', () => {
    // The page may read a payload field, compare two scalars and label. It may
    // not fold a collection — that is how "the outstanding balance is summed
    // from page 1" happens. All folding lives in the chart module, which folds
    // only the window the server actually sent.
    const code = codeOnly(PAGE_JS);
    assert.match(code, /seam\.totals\.b2b/,
        'the "In this range" line reads the chart’s own totals');
    assert.match(code, /sumOrNull/,
        'the one derived tile gets a named helper, so the null rule is stated once');
    assert.ok(!/lifetime_b2b_savings\s*\)?\s*\|\|\s*0|\|\|\s*0\s*\)\s*\+/.test(code),
        '`|| 0` on a nullable component turns "not reported" into a confident total');
});

// ═════════════════════════════════════════════════════════════════════════════
// §5 — the chart module stays pure and dependency-free
// ═════════════════════════════════════════════════════════════════════════════

test('§5 SavingsChart does no I/O and pulls in no library', () => {
    const code = codeOnly(CHART_JS);
    for (const banned of [/API\./, /fetch\(/, /localStorage/, /sessionStorage/, /cdn\./, /import\(/]) {
        assert.ok(!banned.test(code), `savings-chart.js must stay pure — found ${banned}`);
    }
    assert.match(code, /preserveAspectRatio="none"/);
    assert.match(code, /role="img"/);
    assert.match(code, /aria-label=/);
});

test('§5 an empty series draws NO line (absence must not become a flat zero)', () => {
    const ctx = vm.createContext({ window: {}, module: { exports: {} }, console });
    ctx.globalThis = ctx;
    vm.runInContext(CHART_JS, ctx, { filename: 'savings-chart.js' });
    const Chart = ctx.window.SavingsChart;

    const host = { innerHTML: '' };
    const out = Chart.render(host, {
        blockClass: 'business-chart',
        series: [
            { modifier: 'b2b', points: [{ t: 1000, v: 5 }, { t: 2000, v: 5 }] },
            { modifier: 'other', points: [] },
        ],
    });
    assert.equal(out.rendered, true);
    const polylines = (host.innerHTML.match(/<polyline/g) || []).length;
    assert.equal(polylines, 1, 'the empty series must not draw a zero line');
    assert.match(host.innerHTML, /business-chart__line--b2b/);
    assert.ok(!/business-chart__line--other/.test(host.innerHTML));

    // Nothing at all -> rendered:false, and the CALLER owns the empty state,
    // because only it knows whether that means "no orders" or "fetch failed".
    const host2 = { innerHTML: '' };
    const none = Chart.render(host2, { series: [{ modifier: 'b2b', points: [] }] });
    assert.equal(none.rendered, false);
    assert.equal(host2.innerHTML, '');
});

test('§5 pages.css declares a colour for every series the page draws', () => {
    // Every series is drawn FOUR ways — line, bar, hover marker and legend
    // swatch — and a series that is one colour in the chart and another in the
    // legend is worse than no legend at all.
    for (const mod of ['b2b', 'other', 'spend', 'orders']) {
        assert.match(PAGES_CSS, new RegExp(`\\.business-chart__line--${mod} \\{ stroke:`),
            `a series with no stroke colour renders invisible — missing --${mod}`);
        assert.match(PAGES_CSS, new RegExp(`\\.business-chart__bar--${mod} \\{ fill:`),
            `per-period mode draws bars — missing a fill for --${mod}`);
        assert.match(PAGES_CSS, new RegExp(`\\.business-chart__swatch--${mod}`),
            `the legend chip for --${mod} needs the same colour as its series`);
    }
    // The loyalty page passes blockClass 'loyalty-chart' to SavingsChart.
    for (const mod of ['accrued', 'savings']) {
        assert.match(PAGES_CSS, new RegExp(`\\.loyalty-chart__line--${mod}`),
            `the extraction must not have orphaned the loyalty chart's --${mod} colour`);
    }
});

// ═════════════════════════════════════════════════════════════════════════════
// §5b — the Performance overview module
// ═════════════════════════════════════════════════════════════════════════════

test('§5b BusinessChart does no I/O and pulls in no library', () => {
    const code = codeOnly(PERF_JS);
    for (const banned of [/API\./, /fetch\(/, /localStorage/, /sessionStorage/, /cdn\./, /import\(/, /Math\.random/, /\bconsole\./]) {
        assert.ok(!banned.test(code), `business-chart.js must stay pure — found ${banned}`);
    }
    assert.match(code, /role="img"/);
    assert.match(code, /aria-label=/);
    // Deliberately NOT savings-chart.js's `preserveAspectRatio="none"`: a chart
    // with gridline labels, tick labels and round hover markers cannot survive a
    // non-uniform scale. The viewBox is the MEASURED width instead.
    assert.ok(!/preserveAspectRatio="none"/.test(code),
        'non-uniform scaling stretches every glyph and turns the hover markers into ellipses');
    assert.match(code, /clientWidth/, 'the viewBox width must come from the measured host');
});

test('§5b nulls survive as marks and gaps, and never as zero', () => {
    const Chart = loadPerfChart();
    const host = { innerHTML: '' };
    const out = Chart.render(host, {
        blockClass: 'business-chart',
        width: 800,
        points: [
            { period_start: '2026-01-01', spend_incl_gst: 1200, b2b_savings: 60, other_savings: 0, orders: 4 },
            { period_start: '2026-02-01', spend_incl_gst: 1500, b2b_savings: null, other_savings: 5, orders: 5 },
            { period_start: '2026-03-01', spend_incl_gst: 1800, b2b_savings: 90, other_savings: 8, orders: 6 },
        ],
    });
    assert.equal(out.rendered, true);
    assert.equal(out.buckets, 3);

    // A bar mode gap must be a POSITIVE mark: a missing bar and a $0 bar are the
    // same pixels, so absence has to be drawn, not left out.
    assert.equal((host.innerHTML.match(/__nodata"/g) || []).length, 1,
        'the unrecorded bucket needs exactly one not-recorded mark');
    // ...and a measured zero still draws, or "we looked and it was zero" and
    // "we never looked" become the same picture from the other direction.
    assert.equal((host.innerHTML.match(/__bar /g) || []).length, 8,
        '3 spend + 2 b2b (one unrecorded) + 3 other, including the $0 one');

    // A total that skipped the unknown would be a confident wrong number.
    assert.equal(out.totals.b2b, null);
    assert.equal(out.nulls.b2b, 1);
    assert.equal(out.totals.spend, 4500);
    assert.equal(out.nulls.spend, 0);
});

test('§5b a running total BREAKS at the first unknown and stays broken', () => {
    const Chart = loadPerfChart();
    const host = { innerHTML: '' };
    const out = Chart.render(host, {
        blockClass: 'business-chart',
        mode: 'cumulative',
        width: 800,
        points: [
            { period_start: '2026-01-01', spend_incl_gst: 100, b2b_savings: 10, other_savings: 1, orders: 1 },
            { period_start: '2026-02-01', spend_incl_gst: 100, b2b_savings: null, other_savings: 1, orders: 1 },
            { period_start: '2026-03-01', spend_incl_gst: 100, b2b_savings: 10, other_savings: 1, orders: 1 },
        ],
    });
    // Carrying the total across the gap would understate it by an unknown amount
    // while looking complete — the failure mode the old chart had.
    assert.equal(out.breakIndex.b2b, 1);
    assert.equal(out.breakIndex.spend, null);
    assert.match(host.innerHTML, /__unknown/,
        'the unknowable tail must be marked, not left as a line that merely stops');
});

test('§5b each band scales independently, and money axes include zero', () => {
    const Chart = loadPerfChart();
    const small = { innerHTML: '' };
    const huge = { innerHTML: '' };
    const base = { period_start: '2026-01-01', b2b_savings: 50, other_savings: 10, orders: 3 };
    Chart.render(small, { blockClass: 'business-chart', width: 800, points: [{ ...base, spend_incl_gst: 1000 }] });
    Chart.render(huge, { blockClass: 'business-chart', width: 800, points: [{ ...base, spend_incl_gst: 100000 }] });

    // Money ticks are emitted band by band: five for spend, then five for
    // savings. A hundredfold jump in SPEND must move the first five and leave
    // the second five untouched — that is the entire reason the bands exist
    // rather than one shared axis with savings smeared along the baseline.
    // Axis ticks only — the screen-reader table below the chart is full of money
    // too, and counting that would make this test measure the wrong thing.
    const ticks = (html) => (html.match(/class="business-chart__tick"[^>]*>([^<]*)</g) || [])
        .map((s) => s.slice(s.lastIndexOf('>') + 1, -1))
        .filter((t) => t.startsWith('$'));
    const a = ticks(small.innerHTML);
    const b = ticks(huge.innerHTML);
    assert.equal(a.length, 10, 'five money ticks per money band');
    assert.notDeepEqual(a.slice(0, 5), b.slice(0, 5), 'the spend band must have rescaled');
    assert.deepEqual(a.slice(5), b.slice(5), 'the savings band must NOT have moved');
    for (const t of [a, b]) {
        assert.ok(t.includes('$0'), 'a money axis that omits zero exaggerates every wiggle');
    }
});

test('§5b hiding a series removes it from the plot and the legend says so', () => {
    const Chart = loadPerfChart();
    const host = { innerHTML: '' };
    const out = Chart.render(host, {
        blockClass: 'business-chart',
        width: 800,
        hidden: ['other'],
        points: [
            { period_start: '2026-01-01', spend_incl_gst: 100, b2b_savings: 10, other_savings: 1, orders: 1 },
            { period_start: '2026-02-01', spend_incl_gst: 120, b2b_savings: 12, other_savings: 2, orders: 2 },
        ],
    });
    assert.ok(!/__bar--other/.test(host.innerHTML), 'a hidden series must not draw');
    assert.match(host.innerHTML, /data-series="other"[^>]*aria-pressed="false"/,
        'the chip has to say which state it is in, for a screen reader too');
    // ...but the figures the PAGE prints must not move: a legend click is a view
    // preference, not a change to what the server reported.
    assert.equal(out.totals.other, 3);
});

test('§5b the markup is deterministic, escaped and reachable without a mouse', () => {
    const Chart = loadPerfChart();
    const pts = [{ period_start: '2026-01-01', spend_incl_gst: 100, b2b_savings: 10, other_savings: 1, orders: 1 }];
    const a = { innerHTML: '' };
    const b = { innerHTML: '' };
    Chart.render(a, { blockClass: 'business-chart', width: 800, points: pts });
    Chart.render(b, { blockClass: 'business-chart', width: 800, points: pts });
    assert.equal(a.innerHTML, b.innerHTML, 'identical input must give identical markup');

    // The chart is not the only way to read the numbers.
    // The DIV is load-bearing: `.visually-hidden` clips with `overflow:hidden`,
    // which does not apply to a table box — the class on the <table> itself left
    // the whole page scrolling sideways on a phone.
    assert.match(a.innerHTML, /<div class="visually-hidden"><table>/,
        'a screen reader gets the buckets as a table, and the table must be clipped by a div');
    assert.match(a.innerHTML, /aria-live="polite"/,
        'arrow-key navigation needs somewhere to announce itself');
    assert.match(a.innerHTML, /tabindex="0"/, 'the chart must be reachable by keyboard');

    // A hostile label must not become markup.
    const evil = { innerHTML: '' };
    Chart.render(evil, {
        blockClass: 'business-chart', width: 800, points: pts,
        ariaLabel: '"><script>x</script>',
    });
    assert.ok(!/<script>/.test(evil.innerHTML), 'every label goes through Security.escapeHtml');
});

test('§5b an empty series draws nothing, and the CALLER owns the empty state', () => {
    const Chart = loadPerfChart();
    const host = { innerHTML: 'stale' };
    const out = Chart.render(host, { blockClass: 'business-chart', points: [] });
    assert.equal(out.rendered, false);
    assert.equal(host.innerHTML, '');
    // Only the page knows whether "nothing" means "no orders yet", "nothing in
    // this range" or "the fetch failed", and they are three different sentences.
    assert.equal(out.totals, undefined);
});

// ═════════════════════════════════════════════════════════════════════════════
// §6 — the PDF: the file we serve is the file we emailed
// ═════════════════════════════════════════════════════════════════════════════

test('§6 the stored PDF is preferred, and the fallback is NARROW', () => {
    const code = codeOnly(PDF_JS);
    assert.match(code, /\/api\/business\/invoices\/\$\{encodeURIComponent\(id\)\}\/pdf/,
        'it must fetch the stored file the admin tool uploaded');
    assert.match(code, /res\.status === 404 \|\| res\.status === 409/,
        'a local re-render is allowed ONLY on an explicit no-stored-file signal; falling back on ' +
        'any failure hands the customer a document that differs from the one we emailed while ' +
        'they believe it is the same file');
    assert.match(code, /res\.status === 403/, 'someone else’s invoice must say so, not 404');
    assert.match(code, /Reproduced from your account/,
        'a generated copy must be stamped as a copy');
});

test('§6 the loader keeps order-receipt.js’s discipline, and one jsPDF generation sitewide', () => {
    const code = codeOnly(PDF_JS);
    const receipt = JS('order-receipt.js');
    for (const lib of ['jspdf@2.5.2', 'jspdf-autotable@3.8.4']) {
        assert.ok(code.includes(lib) && receipt.includes(lib),
            `${lib} must match order-receipt.js — one jsPDF generation across the site`);
    }
    assert.match(code, /cdn\.jsdelivr\.net/, 'jsdelivr is the only CDN in the CSP allowlist');
    assert.match(code, /LOAD_TIMEOUT_MS = 12000/,
        'onerror never fires on a stalled connection, which would strand the button on "Preparing…"');
    assert.match(code, /_libPromise = null/, 'a failed load must permit a retry');
    assert.match(code, /return false/, 'ensureLib resolves false rather than throwing at the user');
});

test('§6 the generated copy avoids buildInvoiceDoc’s two documented bugs', () => {
    const code = codeOnly(PDF_JS);
    assert.match(code, /const ensure = \(h\) =>/,
        'every writer must ask for room first — the admin builder’s unbounded cursor writes off-page');
    assert.match(code, /doc\.setPage\(doc\.internal\.getNumberOfPages\(\)\)/,
        're-anchor after autoTable or the totals land on page 1 underneath the table');
    assert.match(code, /FOOTER_RESERVE/);
    assert.match(code, /ascii\(/, 'jsPDF built-in fonts are WinAnsi — everything drawn goes through ascii()');
});

test('§6 supplier cost can never reach a customer surface', () => {
    // `unit_cost_excl_gst` is the SELL price; `supplier_cost_excl_gst` is what
    // WE paid. One word apart, in the risky direction.
    const banned = /supplier_?[Cc]ost|cost_source|profit_excl_gst|margin_percent/;
    for (const [name, src] of [['business.html', PAGE], ['business-page.js', PAGE_JS], ['business-invoice-pdf.js', PDF_JS]]) {
        assert.ok(!banned.test(codeOnly(src)),
            `${name} must never reference supplier cost or margin — that is internal-only`);
    }
});

// ═════════════════════════════════════════════════════════════════════════════
// §7 — the Aug-2026 backend response (business-centre-backend-response-aug2026)
//
// All six endpoints went live. Verifying that document against production found
// six defects and one piece of copy the document itself made false (ERR-141),
// and proved the invoice→portal link is unreachable from any client (ERR-142).
// These pin the fixes.
// ═════════════════════════════════════════════════════════════════════════════

test('§7 error codes are read FLAT, never res.error.code', () => {
    // The wire format really is {ok:false, error:{code,message}} — the backend
    // note is right about that. But api.js normalises it before any caller sees
    // it, and on an error envelope `res.error` is a MESSAGE STRING. Reading
    // `.code` off a string yields undefined and sends every error down the
    // wrong branch, silently.
    const api = codeOnly(JS('api.js'));
    assert.match(api, /err\.code\s*:\s*data\.code/,
        'api.js must keep unwrapping error.code into a flat top-level code');

    for (const [name, src] of [
        ['business-page.js', PAGE_JS],
        ['business.js', BUSINESS_JS],
        ['business-invoice-pdf.js', PDF_JS],
    ]) {
        assert.ok(!/res\.error\.code|\berror\.code\b/.test(codeOnly(src)),
            `${name} must read the FLAT res.code — api.js already unwrapped error.code, ` +
            'and res.error is a string on the failure path');
    }
});

test('§7 each loader owns its own tiles — they race under allSettled', () => {
    const code = codeOnly(PAGE_JS);
    const summary = code.slice(code.indexOf('async loadSummary()'), code.indexOf('async loadSeries()'));
    assert.ok(summary.length > 100, 'loadSummary must still exist ahead of loadSeries');

    // saved/spend belong to /analytics/series. loadSummary writing them means a
    // slow summary failure overwrites two correct lifetime figures with
    // "Unavailable just now" — whichever call loses the race wins the tile.
    for (const owned of ['stat-saved-value', 'stat-spend-value', 'stat-saved-sub', 'stat-spend-sub',
        'stat-other-value', 'stat-other-sub', 'stat-total-saved-value', 'stat-total-saved-sub']) {
        assert.ok(!summary.includes(owned),
            `loadSummary must not write #${owned} — that tile is fed by /analytics/series`);
    }
    assert.match(summary, /stat-outstanding-value/, 'loadSummary owns the outstanding tile');
    assert.match(code, /setSeriesTiles\(null\)/,
        'a failed series call must set its OWN tiles to an explicit unknown');
});

test('§7 a lifetime tile is never un-set by a later range click', () => {
    // These four figures are ALL TIME. Once a real number is on one, a failed
    // refetch caused by changing the chart's range must not replace it with
    // "Unavailable just now" — a lifetime figure cannot become unknown because
    // somebody asked to see six months.
    const code = codeOnly(PAGE_JS);
    const fn = code.slice(code.indexOf('setSeriesTiles(payload) {'), code.indexOf('wirePerfControls() {'));
    assert.ok(fn.length > 200, 'setSeriesTiles must still exist');
    assert.match(fn, /if \(this\._tilesSet\) return;/,
        'the unknown branch must bail once a real figure has been written');
    assert.match(fn, /this\._tilesSet = true;/, 'a successful write must latch');
});

test('§7 a slow response for the old range cannot repaint the new one', () => {
    // Click 6m then 2y quickly and the 6m answer may land last. Without a token
    // it wins the chart AND the "showing…" label, so the page would draw six
    // months of data under a two-year heading.
    const code = codeOnly(PAGE_JS);
    const fn = code.slice(code.indexOf('async loadSeries()'), code.indexOf('setSeriesTiles(payload) {'));
    assert.match(fn, /const req = \+\+this\._seriesSeq;/, 'each request takes a token');
    assert.ok(fn.indexOf('if (req !== this._seriesSeq) return;') > fn.indexOf('await this.get'),
        'the token must be re-checked AFTER the await and before anything is written');
});

test('§7 the axis is labelled with what the SERVER SERVED, and a mismatch is loud', () => {
    const code = codeOnly(PAGE_JS);
    // The window on screen comes from the response, never from the request —
    // labelling a chart with the range you asked for is how a silently-ignored
    // parameter stays invisible for months.
    const served = code.slice(code.indexOf('renderServed(d, seam, servedGrain) {'),
        code.indexOf('renderWindowTotals(seam) {'));
    assert.match(served, /seam\.window\.from/, 'the label reads the plotted window');
    assert.ok(!/this\._perfRange|this\.perfWindow\(\)/.test(served),
        'the label must not be built from the range we requested');

    assert.match(code, /servedGrain !== this\._perfGrain/,
        'the granularity echo has to be compared, not assumed');
    assert.match(code, /didn't apply the/,
        'a server that ignored the bucket width must say so on the page');
    assert.match(code, /checkWindowAgainstLifetime/,
        'the window sums and the lifetime totals are both ours — a disagreement is reported, never hidden');
});

test('§7 the tiles say their scope in the MARKUP, so a failure cannot strip it', () => {
    // The tiles are lifetime and the chart is windowed. Without the scope on the
    // tile the two look like they should reconcile and don't — and a scope
    // written by the loader would vanish on exactly the failure path where the
    // reader most needs to know what they are looking at.
    for (const id of ['stat-saved', 'stat-other', 'stat-total-saved', 'stat-spend']) {
        const tile = extractBlock(PAGE, `<div class="business-stat" id="${id}"`, '</div>')
            || extractBlock(PAGE, `id="${id}"`, '</div>');
        assert.ok(tile && /business-stat__scope/.test(tile),
            `#${id} is a lifetime figure and must carry its scope chip in the HTML`);
    }
    const code = codeOnly(PAGE_JS);
    assert.ok(!/business-stat__scope/.test(code),
        'the scope chip is markup, not something a loader writes');
});

test('§7 a nullable count is never rendered as "Nothing outstanding"', () => {
    const code = codeOnly(PAGE_JS);
    assert.ok(!/Number\((?:d|res)\.\w*(?:overdue|unpaid)\w*\)\s*\|\|\s*0/.test(code),
        '`Number(x) || 0` turns "not reported" into a confident zero (ERR-063 family)');
    const summary = code.slice(code.indexOf('async loadSummary()'), code.indexOf('async loadSeries()'));
    assert.match(summary, /overdue !== null/,
        'the overdue count must be distinguished from null before it is believed');
});

test('§7 nothing on this surface claims a saving the payload omits', () => {
    // Waived shipping is deliberately NOT part of other_savings — the backend
    // can't reconstruct it and leaves it out rather than guessing. The legend
    // labels now live in the chart module's SERIES table, so the ban has to
    // cover that too or it just moved somewhere the test wasn't looking.
    const series = codeOnly(PERF_JS).slice(codeOnly(PERF_JS).indexOf('const SERIES = ['));
    const legend = series.slice(0, series.indexOf('];'));
    assert.match(legend, /Coupons & loyalty/, 'the series labels are the legend');
    assert.ok(!/shipping/i.test(legend),
        'the legend must not name shipping — other_savings does not contain it');

    const code = codeOnly(PAGE_JS);
    const saved = code.slice(code.indexOf('savedSub.textContent'), code.indexOf('savedSub.textContent') + 300);
    assert.ok(!/shipping/i.test(saved),
        'the saved-tile sub-line must not name shipping either');
    assert.ok(!/shipping/i.test(code.slice(code.indexOf('renderWindowTotals(seam) {'), code.indexOf('renderCaveat(cov)'))),
        'the "in this range" line must not name shipping either');
});

test('§7 an account with measurably no orders gets the empty state, not a flat $0 line', () => {
    const code = codeOnly(PAGE_JS);
    assert.match(code, /orders_counted/,
        'a new account gets twelve buckets of REAL zeros; plotted, that is a flat line ' +
        'pinned to the axis, which looks like data');
    assert.match(code, /nothingToChart/,
        'the measured-zero case must be named and routed to the empty state');
    // ...but a real flat line still has to be possible: ordered-but-saved-nothing
    // is a genuine result and must NOT be suppressed.
    assert.match(code, /num\(cov\.orders_counted\) === 0/,
        'only orders_counted === 0 suppresses the chart — not "all values are zero"');

    // A range control makes "nothing in the window you picked" the COMMON empty
    // case, and it is a different sentence from "you haven't ordered yet".
    // first_order_at is what tells them apart.
    assert.match(code, /totals\.first_order_at\s*\n?\s*\?/,
        'the two empty states must be chosen by first_order_at, not merged');
    assert.match(code, /No orders in this date range/);
});

test('§7 the invoice list is paged, and the cap announces itself', () => {
    const code = codeOnly(PAGE_JS);
    assert.match(code, /pagination/, 'the pager reads pagination.total from the response');
    assert.match(code, /Showing \$\{this\._invoiceShown\}/,
        'a truncated list must say how much of itself is on screen');
    assert.match(code, /_invoiceShown < total/,
        'Load more appears only while there is provably more');
    assert.match(PAGE, /id="invoices-more"/);
    assert.match(PAGE, /id="invoices-summary"/);
    assert.match(code, /p\.append\('status'/, 'paging must not have displaced server-side filtering');
});

test('§7 a locally reproduced PDF says so ON THE PAGE, not only inside the file', () => {
    const code = codeOnly(PAGE_JS);
    assert.match(code, /out\.source === 'generated'/,
        'the narrow fallback exists to be honest about a substitution; showing the note only ' +
        'when !out.ok means the one case it was built for is the one that says nothing');
    // And the fallback itself must stay narrow.
    assert.match(codeOnly(PDF_JS), /res\.status === 404 \|\| res\.status === 409/);
});

test('§7 overdue is derived the way the backend derives it, and never from a Date', () => {
    const code = codeOnly(PAGE_JS);
    assert.match(code, /const isOverdue =/, 'one helper, not a repeated inline comparison');
    assert.match(code, /'unpaid'/, 'overdue is unpaid AND past due — status is half of it');
    assert.match(code, /todayISO\(\)/,
        'due_date is date-only; parsing it to a Date makes it UTC midnight, which reads as ' +
        '"yesterday" all morning in NZ and would brand a same-day invoice overdue');

    // The filter must offer exactly the values the server accepts. Drafts are
    // never returned to a customer, so there must be no Draft option.
    const select = PAGE.slice(PAGE.indexOf('id="invoice-filter-status"'), PAGE.indexOf('</select>'));
    for (const v of ['unpaid', 'overdue', 'paid', 'void']) {
        assert.match(select, new RegExp(`value="${v}"`), `the status filter must offer ${v}`);
    }
    assert.ok(!/value="draft"/.test(select),
        'drafts are never returned to a customer — offering the filter implies they might be');
});

test('§7 the §4 detail payload is displayed, under the customer-facing name', () => {
    const code = codeOnly(PAGE_JS);
    for (const f of ['bill_to', 'payment_terms', 'emailed_at', 'po_number', 'unit_price_excl_gst']) {
        assert.ok(code.includes(f), `the detail panel must render ${f} — it was fetched and shown nowhere`);
    }
    assert.ok(!/unit_cost_excl_gst/.test(code),
        'unit_cost_excl_gst is the INTERNAL name and sits one word from supplier_cost_excl_gst');
    assert.match(code, /'lines'\)/,
        'a detail response with no `lines` array is MALFORMED, not an empty invoice');

    // The R2 ban re-run over everything §7 added.
    const banned = /supplier_?[Cc]ost|cost_source|profit_excl_gst|margin_percent/;
    for (const [name, src] of [['business.html', PAGE], ['business-page.js', PAGE_JS], ['business-invoice-pdf.js', PDF_JS]]) {
        assert.ok(!banned.test(codeOnly(src)), `${name} must never reference supplier cost or margin`);
    }
});

test('§7 today’s reorder price comes from the live pricing path, never from history', () => {
    const code = codeOnly(PAGE_JS);
    assert.match(code, /Business\.getPricing/,
        '/top-products carries no price on purpose — a March figure is not today’s price');
    assert.match(code, /Business\.describeLadder/, 'the ladder interpreter is the one authority');
    assert.ok(!/\*\s*retail|retail\s*\*|\/\s*1\.15|\*\s*0\.\d/.test(code),
        'the frontend must not compute a business price — ERR-139');
    assert.match(code, /price unavailable/,
        'a SKU the pricing call could not answer for renders an explicit unknown, not a guess');
});
