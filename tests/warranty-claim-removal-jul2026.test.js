/**
 * Compliance — the 12-month compatible-cartridge warranty claim is GONE (ERR-078)
 * ==============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The business does NOT offer a 12-month replacement warranty on compatible
 * cartridges. The storefront claimed it across /about, /returns, /faq,
 * /genuine-vs-compatible, and the compatible-PDP disclaimer — a live
 * misrepresentation, the same class of issue behind the May/Jul 2026 Google Ads
 * suspensions. The backend dev's hand-off
 * (FE-ACTION-REQUIRED-warranty-claim-removal-jul2026.md) retired the claim on
 * both sides; compatibles are covered by the 30-day satisfaction guarantee +
 * statutory NZ Consumer Guarantees Act 1993 rights. Genuine cartridges still
 * carry the original manufacturer warranty (unchanged, still true).
 *
 * The claim was NOT API-driven: the storefront never read
 * trust_signals.warranty.compatible_months. It came from a local constant
 * (legal-config.js) + hardcoded prose across five pages. A single-file "fix"
 * would leave the rest live — which is exactly how the OEM-warranty claim
 * shipped past two "fixed" reports (ERR-063/065-069). So this walks the tree.
 *
 * WHAT IS PINNED
 *   §1  The retired claim is gone from every policy page; the true 30-day
 *       guarantee is present.
 *   §2  No customer-facing page anywhere carries the exact retired phrasings.
 *   §3  The compatible-PDP disclaimer carries the true 30-day + CGA sentence and
 *       never the retired warranty claim (byte-identical to the backend
 *       prerender = no cloaking).
 *   §4  The local constant + data-legal-bind were removed at the source.
 *
 * Run: node --test tests/warranty-claim-removal-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const READ = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');

// The four hand-authored policy pages that carried the claim.
const POLICY_PAGES = [
    'html/about.html',
    'html/returns.html',
    'html/faq.html',
    'html/genuine-vs-compatible.html',
];

// ─────────────────────────────────────────────────────────────────────────
// §1. Each policy page states the true cover and none of the retired claim.
//
// The retired framing always paired "12-month" (ASCII hyphen/space) with a
// warranty/guarantee. The legitimate CGA sentence "typically 12–24 months from
// manufacture" uses an EN DASH and is >1 token from "month", so /12[- ]month/i
// cannot match it — that copy stays.
// ─────────────────────────────────────────────────────────────────────────
for (const page of POLICY_PAGES) {
    test(`§1 ${page}: retired 12-month claim gone, 30-day guarantee present`, () => {
        const src = READ(page);
        assert.doesNotMatch(src, /12[- ]month/i,
            `${page} still contains a "12-month" claim (retired, ERR-078)`);
        assert.doesNotMatch(src, /replacement warranty/i,
            `${page} still frames compatible cover as a "replacement warranty" (retired)`);
        assert.doesNotMatch(src, /data-legal-bind="compatible-warranty"/,
            `${page} still binds the retired compatible-warranty token`);
        assert.match(src, /30-day satisfaction guarantee/,
            `${page} must state the true 30-day satisfaction guarantee`);
    });
}

// ─────────────────────────────────────────────────────────────────────────
// §2. Walk EVERY customer-facing HTML file (admin excluded) for the exact
// retired phrasings. Specific enough to never flag legitimate copy.
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

const RETIRED_PHRASINGS = [
    /12-month replacement warranty/i,
    /replacement warranty on compatible/i,
    /12[- ]month compatible/i,
    /warranty on compatible cartridges/i,
];

test('§2 no customer-facing HTML carries the retired compatible-warranty claim', () => {
    const offenders = [];
    for (const abs of customerFacingHtml()) {
        const src = fs.readFileSync(abs, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
        for (const rx of RETIRED_PHRASINGS) {
            const m = src.match(rx);
            if (m) offenders.push(`${path.relative(ROOT, abs)} → ${rx} matched "${m[0]}"`);
        }
    }
    assert.deepEqual(offenders, [],
        'These pages still assert the retired 12-month compatible-cartridge warranty:\n  '
        + offenders.join('\n  '));
});

// ─────────────────────────────────────────────────────────────────────────
// §3. The compatible-PDP disclaimer mirrors the backend prerender.
// ─────────────────────────────────────────────────────────────────────────
test('§3 PDP disclaimer carries the 30-day + CGA sentence, not the retired claim', () => {
    const src = READ('js/product-detail-page.js');
    // Isolate the rendered template so we don't scan surrounding comments.
    const start = src.indexOf('id="compat-disclaimer"');
    const panel = src.slice(start, src.indexOf('</div>`', start));
    assert.ok(start !== -1 && panel, 'compat-disclaimer template must be present');

    assert.match(panel, /Supplied by Office Consumables Ltd, trading as InkCartridges\.co\.nz\./);
    assert.match(panel, /Compatible cartridges are covered by our 30-day satisfaction guarantee\./,
        'the panel must state the true 30-day satisfaction guarantee');
    assert.match(panel, /Your statutory rights under the New Zealand Consumer Guarantees Act 1993 are unaffected\./,
        'the panel must carry the CGA-unaffected sentence (parity with the prerender)');
    assert.doesNotMatch(panel, /12[- ]month|replacement warranty/i,
        'the retired 12-month replacement-warranty claim must not reappear in the panel');
});

// ─────────────────────────────────────────────────────────────────────────
// §4. Killed at the source — constant + binding, not just the page copy.
// A live constant is how a "fixed" claim silently comes back.
// ─────────────────────────────────────────────────────────────────────────
test('§4 legal-config.js has no compatibleWarrantyMonths constant', () => {
    assert.doesNotMatch(READ('js/legal-config.js'), /compatibleWarrantyMonths:\s*\d/);
});

test('§4 legal-page.js has no compatible-warranty binding', () => {
    assert.doesNotMatch(READ('js/legal-page.js'), /'compatible-warranty':\s*String/);
});
