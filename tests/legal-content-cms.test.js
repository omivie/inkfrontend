/**
 * Legal Content CMS contract — May 2026
 * =====================================
 *
 * Pins the admin Legal Content tool: spec doc, Supabase override table,
 * legal-page.js fetch + apply step, admin nav wiring, and the editor
 * page. The CMS edits prose on /about /terms /privacy /returns
 * /shipping /faq /contact and the LegalConfig "site facts" used by
 * every data-legal-bind.
 *
 * Run with: node --test tests/legal-content-cms.test.js
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML = (rel) => path.join(ROOT, 'inkcartridges', 'html', rel);
const JS   = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const READ = (p)   => fs.readFileSync(p, 'utf8');

const SPEC      = path.join(ROOT, 'readfirst', 'legal-content-cms-may2026.md');
const PAGE_JS   = READ(JS('legal-page.js'));
const ADMIN_APP = READ(JS('admin/app.js'));
const ADMIN_LC  = READ(JS('admin/pages/legal-content.js'));

const LEGAL_PAGES = ['terms.html', 'privacy.html', 'returns.html', 'shipping.html', 'about.html', 'faq.html', 'contact.html'];
const SLUGS       = ['terms',      'privacy',      'returns',      'shipping',      'about',      'faq',      'contact'];

// ─────────────────────────────────────────────────────────────────────────────
// §1 — Spec exists and documents the migration + override-key format
// ─────────────────────────────────────────────────────────────────────────────

test('§1 spec doc exists at readfirst/legal-content-cms-may2026.md', () => {
    assert.ok(fs.existsSync(SPEC), 'spec must live at readfirst/legal-content-cms-may2026.md');
});

test('§1 spec contains the SQL migration (table + RLS + indexes)', () => {
    const src = READ(SPEC);
    assert.match(src, /CREATE TABLE[\s\S]*public\.legal_content_overrides/i, 'spec must include the CREATE TABLE block');
    assert.match(src, /ENABLE ROW LEVEL SECURITY/i,                          'spec must enable RLS');
    assert.match(src, /Public read legal_content_overrides[\s\S]*FOR SELECT USING \(true\)/i,
        'spec must declare a public-read RLS policy');
    assert.match(src, /Authenticated write legal_content_overrides/i,        'spec must declare an authenticated-write RLS policy');
    assert.match(src, /legal_content_overrides_updated_at_idx/i,             'spec must include the updated_at index');
});

test('§1 spec documents all three override-key namespaces', () => {
    const src = READ(SPEC);
    assert.match(src, /<page>\.hero/,                  'spec must describe the <page>.hero namespace');
    assert.match(src, /<page>\.section\.<sectionId>/,  'spec must describe the section namespace');
    assert.match(src, /site_facts\.<configKey>/,       'spec must describe the site_facts namespace');
});

test('§1 spec lists every recognised site-fact configKey', () => {
    const src = READ(SPEC);
    const required = [
        'tradingName', 'legalEntity', 'gstNumber', 'nzbn',
        'phoneDisplay', 'phoneE164', 'email',
        'hoursDisplay', 'responseSLA',
        'freeShippingThreshold', 'policyEffectiveDate', 'policyVersion',
        'address.street', 'address.suburb', 'address.city', 'address.postcode', 'address.country',
        'privacyOfficerName', 'privacyOfficerEmail',
    ];
    for (const k of required) {
        assert.ok(src.includes(k), `spec must list ${k} as an editable site_facts key`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — legal-page.js exposes the override fetch + apply entrypoint
// ─────────────────────────────────────────────────────────────────────────────

test('§2 legal-page.js exposes window.LegalContent with fetch/apply/detect', () => {
    assert.match(PAGE_JS, /window\.LegalContent\s*=\s*\{/, 'legal-page.js must expose window.LegalContent');
    assert.match(PAGE_JS, /fetchOverrides\s*:\s*fetchOverrides/, 'must expose fetchOverrides');
    assert.match(PAGE_JS, /applyOverrides\s*:\s*applyOverrides/, 'must expose applyOverrides');
    assert.match(PAGE_JS, /detectPageSlug\s*:\s*detectPageSlug/, 'must expose detectPageSlug');
});

test('§2 legal-page.js fetches from the legal_content_overrides table via REST', () => {
    assert.match(PAGE_JS, /\/rest\/v1\/legal_content_overrides/,
        'legal-page.js must read from the legal_content_overrides REST endpoint');
    assert.match(PAGE_JS, /select=key,value/,
        'legal-page.js must select only key,value columns');
});

test('§2 legal-page.js gates fetch behind Config.SUPABASE_URL + anon key', () => {
    assert.match(PAGE_JS, /Config\.SUPABASE_URL/,      'must reference Config.SUPABASE_URL');
    assert.match(PAGE_JS, /Config\.SUPABASE_ANON_KEY/, 'must reference Config.SUPABASE_ANON_KEY');
});

test('§2 legal-page.js fail-opens (catch block returns []) when fetch errors', () => {
    // Pinning the contract: a Supabase outage must NEVER break the page.
    assert.match(PAGE_JS, /\.catch\s*\([^)]*\)\s*\{[\s\S]*return\s*\[\]/,
        'legal-page.js must catch fetch errors and return [] (fail-open)');
});

test('§2 legal-page.js applies site_facts.* before applyBindings()', () => {
    // Order matters: site_facts mutate LegalConfig; applyBindings reads it.
    const idxApplyOverrides = PAGE_JS.indexOf('applyOverrides(rows)');
    const idxApplyBindings  = PAGE_JS.indexOf('applyBindings()');
    assert.ok(idxApplyOverrides !== -1, 'applyOverrides must be called inside init');
    assert.ok(idxApplyBindings  !== -1, 'applyBindings must be called inside init');
    assert.ok(idxApplyOverrides < idxApplyBindings,
        'applyOverrides() must run BEFORE applyBindings() so site_facts are in place');
});

test('§2 legal-page.js section selector is sanitised against injection', () => {
    // The override key arrives from Supabase; never trust it for direct
    // selector building. We have a cssEscape helper that strips to alnum/-/_.
    assert.match(PAGE_JS, /function\s+cssEscape\s*\(/, 'legal-page.js must define cssEscape()');
    assert.match(PAGE_JS, /\[\^a-zA-Z0-9_-\]/,         'cssEscape must drop everything outside alnum/_/-');
});

test('§2 legal-page.js detectPageSlug recognises every legal slug', () => {
    for (const slug of SLUGS) {
        // The slug must be present in the LEGAL_SLUGS array literal.
        const re = new RegExp("'" + slug + "'");
        assert.match(PAGE_JS, re, `legal-page.js LEGAL_SLUGS must include '${slug}'`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — Admin nav and router wire the legal-content route
// ─────────────────────────────────────────────────────────────────────────────

test('§3 admin app.js registers Legal Content in NAV_ITEMS as owner-only', () => {
    assert.match(ADMIN_APP, /key:\s*'legal-content'/,                                     'NAV_ITEMS must include legal-content');
    assert.match(ADMIN_APP, /key:\s*'legal-content'[\s\S]{0,120}ownerOnly:\s*true/,       'legal-content must be ownerOnly');
    assert.match(ADMIN_APP, /key:\s*'legal-content'[\s\S]{0,120}label:\s*'Legal Content'/, 'legal-content label must be "Legal Content"');
});

test('§3 admin router gates legal-content behind ownerPages allowlist', () => {
    const m = /ownerPages\s*=\s*\[([^\]]+)\]/.exec(ADMIN_APP);
    assert.ok(m, 'admin app.js must declare ownerPages array');
    assert.ok(/'legal-content'/.test(m[1]),
        `ownerPages must list 'legal-content', got: ${m[1]}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — Admin Legal Content page module is well-formed
// ─────────────────────────────────────────────────────────────────────────────

test('§4 admin/pages/legal-content.js exists and exports a default with init/destroy', () => {
    assert.ok(fs.existsSync(JS('admin/pages/legal-content.js')), 'admin page module must exist');
    assert.match(ADMIN_LC, /export\s+default\s*\{/,           'must export a default object');
    assert.match(ADMIN_LC, /title:\s*'Legal Content'/,         'must set title');
    assert.match(ADMIN_LC, /async\s+init\s*\(/,                'must export async init()');
    assert.match(ADMIN_LC, /destroy\s*\(/,                     'must export destroy()');
});

test('§4 admin page declares all 7 page tabs (about/terms/privacy/returns/shipping/faq/contact)', () => {
    for (const slug of SLUGS) {
        const re = new RegExp("slug:\\s*'" + slug + "'");
        assert.match(ADMIN_LC, re, `PAGE_TABS must include slug ${slug}`);
    }
});

test('§4 admin page declares a Site Facts tab and references every editable LegalConfig key', () => {
    assert.match(ADMIN_LC, /SITE_FACT_FIELDS/,                          'must define SITE_FACT_FIELDS');
    const required = [
        'tradingName', 'legalEntity', 'gstNumber', 'nzbn',
        'phoneDisplay', 'phoneE164', 'email',
        'hoursDisplay', 'responseSLA',
        'freeShippingThreshold', 'policyEffectiveDate', 'policyVersion',
        'address.street', 'address.suburb', 'address.city', 'address.postcode', 'address.country',
        'privacyOfficerName', 'privacyOfficerEmail',
    ];
    for (const k of required) {
        const re = new RegExp("key:\\s*'" + k.replace(/\./g, '\\.') + "'");
        assert.match(ADMIN_LC, re, `SITE_FACT_FIELDS must include key ${k}`);
    }
});

test('§4 admin page reads/writes the legal_content_overrides table via Supabase', () => {
    assert.match(ADMIN_LC, /TABLE\s*=\s*'legal_content_overrides'/, 'must target legal_content_overrides table');
    assert.match(ADMIN_LC, /\.from\(TABLE\)\.upsert/,               'save path must use Supabase upsert');
    assert.match(ADMIN_LC, /\.from\(TABLE\)\.delete\(\)/,           'reset path must delete the row');
});

test('§4 admin page guards write paths behind owner role', () => {
    assert.match(ADMIN_LC, /AdminAuth\.isOwner\(\)/,
        'admin page must check AdminAuth.isOwner() before exposing writes');
});

test('§4 admin page surfaces SQL migration when the table is missing', () => {
    // If a legacy admin opens the page before running the migration, the
    // page must show the SQL inline (mirrors site-lock.js setup pattern).
    assert.match(ADMIN_LC, /CREATE TABLE IF NOT EXISTS public\.legal_content_overrides/i,
        'admin page must paste the migration SQL when the table is missing');
});

test('§4 editor pre-fills with live content (override OR default) — never empty', () => {
    // The "blank textarea + leave empty for default" UX was confusing.
    // Editor must open populated with whatever the visitor sees right
    // now so the admin edits in place, not from scratch.
    assert.match(ADMIN_LC, /const\s+liveHtml\s*=\s*hasOverride\s*\?\s*overrideHtml\s*:\s*defaultHtml/,
        'renderEditorCard must compute liveHtml = override || default and pre-fill the editor with it');
    // Both panes (visual + source) get the same pre-fill on first render.
    const cardSrc = ADMIN_LC.slice(ADMIN_LC.indexOf('renderEditorCard'), ADMIN_LC.indexOf('function renderFactsTab'));
    assert.match(cardSrc, /class="lc-visual"[\s\S]*>\$\{liveHtml\}<\/div>/,
        'visual pane must be pre-filled with liveHtml');
    assert.match(cardSrc, /class="lc-source"[\s\S]*>\$\{esc\(liveHtml\)\}<\/textarea>/,
        'source pane must be pre-filled with the same liveHtml (escaped)');
});

test('§4 editor exposes Visual + Source HTML mode toggle', () => {
    assert.match(ADMIN_LC, /class="lc-mode__btn[^"]*"\s+data-mode="visual"/,
        'card must offer a Visual mode button');
    assert.match(ADMIN_LC, /class="lc-mode__btn[^"]*"\s+data-mode="source"/,
        'card must offer a Source HTML mode button');
    assert.match(ADMIN_LC, /role="tablist"/, 'mode buttons must be marked up as a tablist for a11y');
});

test('§4 visual mode is contentEditable, not a static preview', () => {
    assert.match(ADMIN_LC, /class="lc-visual"\s+contenteditable="true"/,
        'visual pane must be contentEditable so the admin can edit text directly');
});

test('§4 mode-switch syncs content across panes (no edit loss)', () => {
    // When flipping Visual → Source, source.value must inherit
    // visual.innerHTML; the reverse must also hold. Otherwise the admin
    // loses unsaved edits on every mode flip.
    assert.match(ADMIN_LC, /source\.value\s*=\s*visual\.innerHTML/,
        'flipping to Source must copy visual.innerHTML into source.value');
    assert.match(ADMIN_LC, /visual\.innerHTML\s*=\s*source\.value/,
        'flipping to Visual must copy source.value into visual.innerHTML');
});

test('§4 save deletes the row when content matches default (no dupe override)', () => {
    // Saving "the default copy unchanged" must NEVER create an override
    // row — that would make the table look dirty for no reason and would
    // mask a future edit to the source HTML.
    assert.match(ADMIN_LC, /normalizeHtml\s*\(/,
        'admin page must normalize HTML before comparing to default');
    assert.match(ADMIN_LC, /isEffectivelyDefault[\s\S]{0,200}resetOverride/,
        'when content equals default, the save path must call resetOverride() to drop the row');
});

test('§4 reset reloads default into BOTH editor panes', () => {
    // After Reset, the editor must reflect what visitors will see (the
    // default), in both Visual and Source modes — not leave a stale
    // override in the textarea.
    const handlerSrc = ADMIN_LC.slice(ADMIN_LC.indexOf('resetBtn.addEventListener'), ADMIN_LC.indexOf('// Save —'));
    assert.match(handlerSrc, /visual\.innerHTML\s*=\s*defaultHtml/,
        'reset must repopulate the visual pane with defaultHtml');
    assert.match(handlerSrc, /source\.value\s*=\s*defaultHtml/,
        'reset must repopulate the source pane with defaultHtml');
});

test('§4 dirty tracker shows when editor diverges from initial value', () => {
    assert.match(ADMIN_LC, /data-dirty/, 'card must include a data-dirty element');
    assert.match(ADMIN_LC, /function\s+markDirty\s*\(/,
        'admin page must implement a markDirty() helper');
    assert.match(ADMIN_LC, /\binput\b[\s\S]{0,40}markDirty/,
        'visual.input + source.input listeners must call markDirty');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — Cache-bust pin: every legal page loads the new legal-page.js version
// ─────────────────────────────────────────────────────────────────────────────

test('§5 every legal page loads legal-page.js with the legal-cms-may2026 cache-bust', () => {
    for (const p of LEGAL_PAGES) {
        const src = READ(HTML(p));
        assert.match(src, /\/js\/legal-page\.js\?v=legal-cms-may2026/,
            `${p} must load legal-page.js?v=legal-cms-may2026 (cache-bust for the override-fetch addition)`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — Smoke: ship a stub LegalContent runtime check
// ─────────────────────────────────────────────────────────────────────────────

test('§6 legal-page.js exports a runnable LegalContent surface (smoke via vm)', () => {
    // We don't have a full DOM, but we can verify the IIFE parses and the
    // window assignment line is present without syntax errors. node --check
    // already covers parse; this test pins the public surface contract.
    const surfaceMatch = /window\.LegalContent\s*=\s*\{[\s\S]*?\};/m.exec(PAGE_JS);
    assert.ok(surfaceMatch, 'window.LegalContent must be assigned a literal object');
    const block = surfaceMatch[0];
    assert.match(block, /fetchOverrides/,  'public surface includes fetchOverrides');
    assert.match(block, /applyOverrides/,  'public surface includes applyOverrides');
    assert.match(block, /detectPageSlug/,  'public surface includes detectPageSlug');
});
