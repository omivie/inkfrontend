/**
 * Google Ads re-appeal — the OEM-warranty claim class
 * ===================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The ad account was suspended for asserting things about the *printer
 * manufacturer's* warranty. On 2026-07-13 the backend re-checked production
 * and found this still live on /genuine-vs-compatible:
 *
 *     "Using a quality compatible cartridge does not void your printer's
 *      warranty in New Zealand. A printer manufacturer cannot refuse to
 *      honour a printer warranty simply because you used third-party ink or
 *      toner, unless they can show the cartridge actually caused the fault."
 *
 * It had been reported fixed TWICE (Jul 7, Jul 12) and was not. The reason is
 * the whole point of this file:
 *
 *   - google-ads-compliance-may2026.test.js banned the phrase "won't void"
 *     but NOT "does not void", and its FILES_TO_SCAN allowlist did not
 *     include html/genuine-vs-compatible.html at all.
 *   - reappeal-disclaimers-jul2026.test.js had the right assertion but
 *     pointed it at js/product-detail-page.js only.
 *
 * So the guards were green while the violation shipped. Two independent
 * blind spots, same root cause: a hand-maintained list of what to look at.
 *
 * WHAT IS PINNED HERE
 *   §1  The literal acceptance contract the backend will run (a bare `void`
 *       grep over the page must print NOTHING).
 *   §2  The legally-vetted replacement copy is present, verbatim.
 *   §3  The claim class is gone from every customer-facing page, not just
 *       the one the backend happened to notice.
 *   §4  legal-page.js refuses a CMS override carrying a banned claim — the
 *       hole a curl-based acceptance test structurally cannot see.
 *   §5  Regression guards for the two hand-off items that had none:
 *       NZ Company Number on /terms, and www-host canonical/hreflang.
 *
 * Run: node --test tests/genuine-vs-compatible-warranty.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const READ = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');

require(path.join(INK, 'js', 'legal-config.js'));
const { BANNED_CLAIM_PATTERNS } = globalThis.LegalConfig;

const GVC = 'html/genuine-vs-compatible.html';

// ─────────────────────────────────────────────────────────────────────────
// §1. The backend's literal acceptance contract.
//
//   curl -sL ".../genuine-vs-compatible" | grep -io "void\|refuse to honou[r]\?"
//
// must print nothing. Note the bare `void` also matches "avoid", so the page
// may contain neither. This is intentionally stricter than the semantic
// patterns: it is the exact command that gates the appeal filing.
// ─────────────────────────────────────────────────────────────────────────
test('§1 genuine-vs-compatible.html contains ZERO occurrences of "void"', () => {
    const html = READ(GVC);
    const hits = html.match(/void/gi) || [];
    assert.deepEqual(hits, [],
        `The backend's acceptance grep must print nothing, but found ${hits.length} `
        + `occurrence(s) of "void" (this also matches "avoid"). The appeal cannot be `
        + `filed while this is non-empty.`);
});

test('§1 genuine-vs-compatible.html contains no "refuse to honour"', () => {
    assert.doesNotMatch(READ(GVC), /refuse\s+to\s+honou?r/i);
});

// ─────────────────────────────────────────────────────────────────────────
// §2. The vetted replacement copy — legally reviewed, "do not reword".
// ─────────────────────────────────────────────────────────────────────────
test('§2 the legally-vetted warranty copy is present, verbatim', () => {
    // Collapse whitespace: the copy is line-wrapped in the source.
    const text = READ(GVC).replace(/\s+/g, ' ').replace(/&rsquo;/g, "'");

    assert.match(text, /Compatible cartridges from us are covered by our own 12-month replacement warranty, and your statutory rights under the New Zealand Consumer Guarantees Act 1993 apply to everything we sell\./,
        'the vetted first sentence must appear exactly as legal supplied it');
    assert.match(text, /If you have questions about your printer's manufacturer warranty, check the manufacturer's warranty terms\./,
        'the vetted second sentence must appear exactly as legal supplied it');
});

test('§2 the warranty section still exists and is CMS-addressable', () => {
    // The section id is the CMS override key (genuine-vs-compatible.section.warranty)
    // and the anchor target. Losing it would silently orphan both.
    assert.match(READ(GVC), /<section class="policy-section" id="warranty">/);
});

test('§2 the printer-damage indemnity is gone', () => {
    // The vetted rewrite deliberately drops "if a compatible cartridge ever
    // damages your printer … we stand behind what we sell" — we do not
    // promise to repair printers.
    const text = READ(GVC).replace(/\s+/g, ' ');
    assert.doesNotMatch(text, /damages? your printer/i);
    assert.doesNotMatch(text, /stand behind what we sell/i);
    // Same claim class was also live in the FAQ.
    assert.doesNotMatch(READ('html/faq.html').replace(/\s+/g, ' '), /damaged your printer/i);
});

// ─────────────────────────────────────────────────────────────────────────
// §3. The claim class is gone SITE-WIDE.
//
// The backend hand-off said "exactly one thing". It was wrong: an identical
// claim was also live in html/index.html's FAQ. Never trust a single-site
// report again — walk the tree.
// ─────────────────────────────────────────────────────────────────────────
function customerFacingHtml(dir = INK) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'admin' || entry.name === 'node_modules') continue;
            out.push(...customerFacingHtml(abs));
        } else if (entry.isFile() && entry.name.endsWith('.html')) {
            out.push(abs);
        }
    }
    return out;
}

test('§3 no customer-facing page asserts anything about the OEM warranty', () => {
    const offenders = [];
    for (const abs of customerFacingHtml()) {
        const src = fs.readFileSync(abs, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
        for (const rx of BANNED_CLAIM_PATTERNS) {
            const m = src.match(rx);
            if (m) offenders.push(`${path.relative(ROOT, abs)} → ${rx} matched "${m[0]}"`);
        }
    }
    assert.deepEqual(offenders, [],
        'These pages assert something about the printer manufacturer\'s warranty — the '
        + 'exact claim class that suspended the ad account:\n  ' + offenders.join('\n  '));
});

test('§3 the banned-claim patterns actually catch the copy that shipped', () => {
    // Guard the guard. If someone loosens BANNED_CLAIM_PATTERNS, these two
    // real strings — the ones that were live in production — must still trip.
    const shipped = [
        "Using a quality compatible cartridge does not void your printer's warranty in New Zealand.",
        'A printer manufacturer cannot refuse to honour a printer warranty simply because you used third-party ink or toner.',
        'No. Under New Zealand consumer law, using compatible cartridges does not void your printer warranty. '
            + 'Printer manufacturers cannot require you to use only their branded cartridges.',
    ];
    for (const s of shipped) {
        assert.ok(BANNED_CLAIM_PATTERNS.some((rx) => rx.test(s)),
            `BANNED_CLAIM_PATTERNS no longer catches copy that was live in production: "${s}"`);
    }
});

test('§3 the patterns do NOT ban legitimate warranty language', () => {
    // Over-broad patterns get deleted by the next dev in a hurry. These must
    // all pass — they are true, legal, and load-bearing.
    const legitimate = [
        "If you have questions about your printer's manufacturer warranty, check the manufacturer's warranty terms.",
        "Genuine cartridges carry the printer manufacturer's own warranty.",
        'Compatible cartridges from us are covered by our own 12-month replacement warranty.',
        'Your statutory rights under the New Zealand Consumer Guarantees Act 1993 are unaffected.',
        'Void',                 // admin invoice status
        'void content.offsetHeight',  // landing.js reflow idiom
    ];
    for (const s of legitimate) {
        const hit = BANNED_CLAIM_PATTERNS.find((rx) => rx.test(s));
        assert.equal(hit, undefined,
            `BANNED_CLAIM_PATTERNS is over-broad — it rejects legitimate copy: "${s}" (matched ${hit})`);
    }
});

// ─────────────────────────────────────────────────────────────────────────
// §4. The CMS bypass — now closed by REMOVAL, not by a guard.
//
// legal-page.js used to overwrite .policy-section innerHTML from the Supabase
// `legal_content_overrides` table. A row keyed
// `genuine-vs-compatible.section.warranty` would render in a BROWSER (and to
// AdsBot, which executes JS) while a curl of the static HTML showed clean —
// a hole the backend's acceptance grep structurally could not see.
//
// This section used to assert a runtime guard (`rejectIfBanned`) screened every
// such row. On 2026-07-14 the owner RETIRED the CMS outright, so the guard was
// deleted along with the fetch path it protected: there are no override rows to
// screen, and no code path that injects remote copy into a legal page at all.
// A removed mechanism beats a guarded one — there is nothing left to get wrong.
//
// The structural proof that the path is gone (and stays gone) lives in
// tests/legal-cms-retired-jul2026.test.js. What stays HERE is the claim that
// actually concerns this page: the banned-claim list must still recognise the
// exact paragraph that suspended the Ads account, wherever it might reappear.
// See ERR-065 → ERR-069.
// ─────────────────────────────────────────────────────────────────────────
test('§4 legal-page.js can no longer inject remote copy into a legal page', () => {
    const src = READ('js/legal-page.js');
    assert.ok(!/\bfetch\s*\(/.test(src) && !/legal_content_overrides/i.test(src),
        'legal-page.js must have no remote-content path at all. The banned-claim runtime guard '
        + 'was removed with it — if a fetch ever comes back, the guard does NOT, and this page '
        + 'is once again cloakable. Keep the mechanism deleted; see ERR-069.');
});

test('§4 the banned-claim list still recognises the exact paragraph that shipped', () => {
    // Behavioural, not textual. This is the copy that suspended the Google Ads account. It must
    // stay recognisable no matter which surface it turns up on, while a legitimate statement
    // about OUR OWN warranty must not trip the list.
    const violates = (value) => BANNED_CLAIM_PATTERNS.some((rx) => rx.test(value));

    const bannedCopy = '<h2>5. Warranty</h2><p>Using a quality compatible cartridge does not void '
        + "your printer's warranty in New Zealand.</p>";
    assert.ok(violates(bannedCopy),
        'the banned OEM-warranty paragraph must still be caught by BANNED_CLAIM_PATTERNS');

    const legitimateCopy = '<h2>5. Warranty</h2><p>Compatible cartridges from us are covered by '
        + 'our own 12-month replacement warranty.</p>';
    assert.ok(!violates(legitimateCopy),
        'a claim about OUR OWN guarantee is legitimate and must not be flagged — the list is a '
        + 'filter on OEM-warranty assertions, not a ban on the word "warranty"');
});

// ─────────────────────────────────────────────────────────────────────────
// §5. The hand-off items that shipped with no regression guard.
//
// Both were already correct on 2026-07-14 — but so was the warranty
// paragraph, twice, according to the people who reported it fixed.
// Unguarded facts rot.
// ─────────────────────────────────────────────────────────────────────────
test('§5 /terms carries the NZ Company Number alongside NZBN + GST', () => {
    const html = READ('html/terms.html');
    assert.match(html, /NZ Company Number <span data-legal-bind="company-number">1853414<\/span>/);
    assert.match(html, /data-legal-bind="nzbn">9429033934204</);
    assert.match(html, /data-legal-bind="gst-number">94-509-459</);
    // The binding must resolve from config, not stay a hardcoded literal.
    assert.equal(globalThis.LegalConfig.companyNumber, '1853414');
});

test('§5 every canonical / hreflang uses the www host, never the apex', () => {
    const offenders = [];
    for (const abs of customerFacingHtml()) {
        const src = fs.readFileSync(abs, 'utf8');
        const links = src.match(/<link[^>]*(rel="canonical"|hreflang)[^>]*>/gi) || [];
        for (const link of links) {
            const href = (link.match(/href="([^"]*)"/i) || [])[1];
            if (!href) continue;                            // runtime-filled PDP placeholders
            if (/^https:\/\/inkcartridges\.co\.nz/i.test(href)) {
                offenders.push(`${path.relative(ROOT, abs)} → ${href}`);
            }
        }
    }
    assert.deepEqual(offenders, [],
        'Canonical/hreflang must use https://www. — the apex host splits ranking signals '
        + 'and contradicts the backend prerender:\n  ' + offenders.join('\n  '));
});

test('§5 JS that builds canonicals at runtime uses the www host', () => {
    for (const f of ['js/seo-meta.js', 'js/product-detail-page.js', 'js/shop-page.js']) {
        const src = READ(f);
        assert.doesNotMatch(src, /['"`]https:\/\/inkcartridges\.co\.nz/,
            `${f} must not hardcode the apex host when building canonical URLs`);
    }
});

// ─────────────────────────────────────────────────────────────────────────
// §6. The route must stay live. Deleting or redirecting /genuine-vs-compatible
// is NOT an acceptable way to make §1 pass — Google needs the disclosure page
// to be crawlable, and merchant-center-readiness.test.js depends on it.
// ─────────────────────────────────────────────────────────────────────────
test('§6 /genuine-vs-compatible is still served (not "fixed" by deletion)', () => {
    const cfg = JSON.parse(READ('vercel.json'));
    const rewrite = (cfg.rewrites || []).find((r) => r.source === '/genuine-vs-compatible');
    assert.ok(rewrite, 'the page must remain reachable — do not fix compliance by hiding the page');
    assert.equal(rewrite.destination, '/html/genuine-vs-compatible');
    assert.ok(fs.existsSync(path.join(INK, GVC)), 'the page itself must still exist');
});
