/**
 * Page Copy editor — Jul 2026
 * ===========================
 *
 * The admin can now edit the prose on the seven static content pages
 * (#page-copy). This suite pins the properties that make that safe.
 *
 * THE ONE INVARIANT EVERYTHING ELSE SERVES
 * ----------------------------------------
 * An edit changes the SOURCE FILE in git, and nothing else. There is no
 * override table, no runtime read, no client-side injection — so a bot, a
 * browser and a `curl`-based compliance grep all receive the same bytes.
 *
 * That is the precise distinction from the CMS retired on 2026-07-14
 * (ERR-065 → ERR-069), which stored copy in `legal_content_overrides` and had
 * js/legal-page.js inject it at RENDER time. Served HTML then disagreed with
 * the rendered DOM = cloaking, the charge under appeal with Google Ads. §7
 * below re-asserts, from this side, that none of that came back.
 *
 * WHAT IS BEING GUARDED, IN ORDER
 *   §1 module placement and the owner gate
 *   §2 canonical form — the property that keeps real diffs one line long
 *   §3 idempotence — the property that stops the files degrading over time
 *   §4 splice fidelity — an edit touches its own section and nothing else
 *   §5 the save guards — XSS, bindings, business facts, banned claims, phrases
 *   §6 manifest integrity — a new section is read-only until someone decides
 *   §7 the retired CMS is still retired
 *
 * Run: node --test tests/page-copy-editor-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// legal-config.js is an IIFE that assigns to the global — the same way
// tests/legal-cms-retired-jul2026.test.js loads it. Requiring it populates
// globalThis.LegalConfig, which is what the guards read at call time.
require(path.join(SITE, 'js/legal-config.js'));
const LegalConfig = globalThis.LegalConfig;

// The feature modules are ESM; this file is CJS. Load them once, lazily.
let M;   // page-copy-model
let R;   // page-copy-regions
let G;   // page-copy-guards
test.before(async () => {
    M = await import(path.join(SITE, 'js/admin/utils/page-copy-model.js'));
    R = await import(path.join(SITE, 'js/admin/utils/page-copy-regions.js'));
    G = await import(path.join(SITE, 'js/admin/utils/page-copy-guards.js'));
});

const DOCS = ['about', 'terms', 'privacy', 'returns', 'shipping', 'faq', 'genuine-vs-compatible'];
const docHtml = (slug) => read(`inkcartridges/${R.getDoc(slug).path}`);

/** Every section of every doc, as { slug, id, section, src, blocks }. */
function allRegions() {
    const out = [];
    for (const slug of DOCS) {
        const html = docHtml(slug);
        for (const section of M.findSections(html)) {
            const src = M.regionSource(html, section)
                .replace(/^\n/, '')
                .replace(/\n[ \t]*$/, '');
            out.push({ slug, id: section.id, section, html, src, blocks: M.parseRegion(src) });
        }
    }
    return out;
}

const squeeze = (s) => s.replace(/\s+/g, ' ').trim();

// ─────────────────────────────────────────────────────────────────────────────
// §1 Module placement and the owner gate
// ─────────────────────────────────────────────────────────────────────────────

test('§1 the editor module exists, and the retired CMS module still does not', () => {
    assert.ok(exists('inkcartridges/js/admin/pages/page-copy.js'),
        'js/admin/pages/page-copy.js must exist');
    assert.ok(!exists('inkcartridges/js/admin/pages/legal-content.js'),
        'js/admin/pages/legal-content.js was deleted on 2026-07-14 and must stay deleted — '
        + 'this feature is a different surface with a different mechanism, not its return');
});

test('§1 #page-copy is registered in NAV_ITEMS as owner-only', () => {
    const app = read('inkcartridges/js/admin/app.js');
    assert.match(app, /\{\s*key:\s*'page-copy',[^}]*ownerOnly:\s*true[^}]*\}/,
        'NAV_ITEMS must carry page-copy with ownerOnly: true, so isOwnerOnlyRoute() gates it');
    assert.match(app, /\{\s*section:\s*'Content'\s*\}/,
        'the Content sidebar group must exist');
});

test('§1 the owner gate is documented as UI-only, not the real control', () => {
    const page = read('inkcartridges/js/admin/pages/page-copy.js');
    assert.match(page, /AdminAuth\.isOwner\(\)/,
        'the page must gate on AdminAuth.isOwner()');
    assert.match(page, /UI gating only|never a control|backend endpoints do their own owner check/i,
        'the code must record that the browser check is a convenience and the backend '
        + 'endpoint is the authority — a future reader must not mistake it for the control');
});

test('§1 the editor is never reachable from a storefront page', () => {
    const htmlDir = path.join(SITE, 'html');
    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.html')) continue;
            if (full.includes(`${path.sep}admin${path.sep}`)) continue;
            if (/page-copy/.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
        }
    };
    walk(htmlDir);
    assert.deepEqual(offenders, [],
        'no storefront page may reference the page-copy editor');
});

test('§1 the storefront runtime gains nothing — legal-page.js is untouched by this feature', () => {
    const legalPage = read('inkcartridges/js/legal-page.js');
    assert.ok(!/page-copy/.test(legalPage),
        'js/legal-page.js must not reference the editor — the editor is admin-side only, and any '
        + 'new code in this file risks §1/§2 of tests/legal-cms-retired-jul2026.test.js');
    assert.ok(!/data-editable/.test(legalPage),
        'js/legal-page.js must not learn about editable regions');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 Canonical form
//
// This is the property that keeps a copy edit's diff down to the sentence that
// changed. The editor writes by serializing the block model, so if the file on
// disk is not already in canonical form, the owner's FIRST edit reflows the
// whole section and the diff becomes unreviewable — indistinguishable from a
// markup-mangling bug.
// ─────────────────────────────────────────────────────────────────────────────

test('§2 every editable region is already in canonical form on disk', () => {
    const drifted = [];
    for (const r of allRegions()) {
        if (!R.isSectionEditable(r.slug, r.id)) continue;
        assert.notEqual(r.blocks, null, `${r.slug}#${r.id} must parse`);
        if (M.serializeRegion(r.blocks, r.section.indent) !== r.src) drifted.push(`${r.slug}#${r.id}`);
    }
    assert.deepEqual(drifted, [],
        'run: node inkcartridges/scripts/canonicalise-page-copy.mjs');
});

test('§2 canonicalising changes no prose and no bound facts', () => {
    for (const r of allRegions()) {
        if (r.blocks === null) continue;
        const after = M.parseRegion(M.serializeRegion(r.blocks, r.section.indent));
        assert.notEqual(after, null, `${r.slug}#${r.id} must re-parse`);
        assert.equal(squeeze(M.blocksText(after)), squeeze(M.blocksText(r.blocks)),
            `${r.slug}#${r.id}: canonicalisation must not change a single word a reader sees`);
        assert.deepEqual(M.collectBindings(after), M.collectBindings(r.blocks),
            `${r.slug}#${r.id}: canonicalisation must not add, drop or reorder a binding`);
    }
});

test('§2 entities survive a round trip through the editor, in both directions', () => {
    // The file writes `&rsquo;`; contentEditable hands back a literal `’`. Both
    // must converge on the entity, or the same sentence would serialize
    // differently depending on whether the owner happened to touch it — and
    // tests/genuine-vs-compatible-warranty.test.js matches on `&rsquo;`.
    const fromFile = M.parseRegion(`<p>we can&rsquo;t &mdash; &ldquo;really&rdquo; &sect;2</p>`);
    const fromEditor = M.parseRegion(`<p>we can’t — “really” §2</p>`);
    const a = M.serializeRegion(fromFile, 0);
    const b = M.serializeRegion(fromEditor, 0);
    assert.equal(a, b, 'file-sourced and editor-sourced text must serialize identically');
    assert.equal(a, '<p>we can&rsquo;t &mdash; &ldquo;really&rdquo; &sect;2</p>',
        'the canonical form is the named entity, not the literal character');
});

test('§2 a non-breaking space is preserved, not collapsed into a plain space', () => {
    // `\s` matches U+00A0 in JavaScript, so a careless whitespace collapse would
    // silently delete every deliberate non-breaking space on the site.
    const blocks = M.parseRegion('<p>10&nbsp;kg</p>');
    assert.equal(M.serializeRegion(blocks, 0), '<p>10&nbsp;kg</p>');
});

test('§2 an ampersand in text is encoded exactly once', () => {
    const blocks = M.parseRegion('<p>Refund &amp; Return</p>');
    assert.equal(M.serializeRegion(blocks, 0), '<p>Refund &amp; Return</p>',
        'a double-encoded &amp;amp; would render as literal "&amp;" on the page');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 Idempotence — the defence against death by a thousand saves
// ─────────────────────────────────────────────────────────────────────────────

test('§3 parse(serialize(parse(x))) === parse(x) for every region', () => {
    for (const r of allRegions()) {
        if (r.blocks === null) continue;
        const once = M.serializeRegion(r.blocks, r.section.indent);
        const twice = M.serializeRegion(M.parseRegion(once), r.section.indent);
        assert.equal(twice, once,
            `${r.slug}#${r.id}: repeated edits must converge, not drift`);
    }
});

test('§3 the model fails CLOSED on markup it cannot express', () => {
    for (const bad of [
        '<p>unclosed',
        '<p>text</div>',
        'loose text at block level',
        '<section><p>a</p></section>',
        '<p>a</p><!-- comment -->',
        '<p><table><tr><td>x</td></tr></table></p>',
        '<div class="something-unknown"><p>x</p></div>',
        '<p class="not-on-the-allowlist">x</p>',
    ]) {
        assert.equal(M.parseRegion(bad), null,
            `must refuse rather than guess: ${bad}`);
    }
});

test('§3 structured blocks round-trip byte-exactly and are marked read-only', () => {
    const withTable = allRegions().find(r => r.blocks?.some(b => b.type === 'verbatim'));
    assert.ok(withTable, 'at least one region must contain a verbatim block');
    for (const b of withTable.blocks.filter(x => x.type === 'verbatim')) {
        assert.equal(M.isBlockEditable(b), false, 'a verbatim block must not be editable');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 Splice fidelity — an edit must touch its own section and nothing else
// ─────────────────────────────────────────────────────────────────────────────

test('§4 splicing one section changes only that section', () => {
    const html = docHtml('returns');
    const target = M.findSections(html).find(s => s.id === 'lost');
    const blocks = M.parseRegion(M.regionSource(html, target));
    blocks[0] = M.parseRegion('<p>Rewritten sentence.</p>')[0];
    const out = M.spliceRegion(html, 'lost', blocks);

    const scripts = (s) => (s.match(/<script[^>]*>/g) || []).join('\n');
    const heads = (s) => (s.match(/<h2>[\s\S]*?<\/h2>/g) || []).join('\n');
    const ids = (s) => (s.match(/id="[a-z0-9-]+"/g) || []).join(',');
    const head = (s) => s.slice(0, s.indexOf('</head>'));

    assert.equal(scripts(out), scripts(html), 'every <script src=…?v=…> line must be untouched');
    assert.equal(heads(out), heads(html), 'every <h2> must be untouched (buildTOC reads them)');
    assert.equal(ids(out), ids(html), 'every id must be untouched (public deep links)');
    assert.equal(head(out), head(html), '<head>, meta, canonical and hreflang must be untouched');

    // Every OTHER section must be byte-identical.
    for (const s of M.findSections(html)) {
        if (s.id === 'lost') continue;
        const before = M.regionSource(html, s);
        const after = M.regionSource(out, M.findSections(out).find(x => x.id === s.id));
        assert.equal(after, before, `section #${s.id} must not be touched by an edit to #lost`);
    }
});

test('§4 splicing preserves the per-page data-legal-bind multiset', () => {
    for (const slug of DOCS) {
        const html = docHtml(slug);
        const editable = M.findSections(html).filter(s => R.isSectionEditable(slug, s.id));
        if (!editable.length) continue;
        const target = editable[0];
        const blocks = M.parseRegion(M.regionSource(html, target));
        const out = M.spliceRegion(html, target.id, blocks);
        const count = (s) => (s.match(/data-legal-bind="[^"]*"/g) || []).sort().join('|');
        assert.equal(count(out), count(html), `${slug}: bindings must survive a splice`);
    }
});

test('§4 the FAQ JSON-LD block is never disturbed', () => {
    // faq.html duplicates its visible Q&A in a FAQPage JSON-LD block. Editing one
    // without the other makes the structured data disagree with the page — the
    // same class of problem as cloaking. Every FAQ section is therefore locked.
    const html = docHtml('faq');
    for (const s of M.findSections(html)) {
        assert.equal(R.isSectionEditable('faq', s.id), false,
            `faq#${s.id} must stay locked while the JSON-LD is maintained by hand`);
    }
    assert.match(html, /"@type":\s*"FAQPage"/, 'faq.html must still carry its FAQPage JSON-LD');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 Save guards
//
// This writes into a shipped page, so it is a stored-XSS sink with a permanent
// payload. Every case below must be a hard REJECT, never a silent strip: a
// silent sanitise teaches the owner that something saved when part of it did
// not, which is the ERR-069 trap in a different costume.
// ─────────────────────────────────────────────────────────────────────────────

/** A parsed section to use as the "before" side of an edit. */
function baseline(slug = 'returns', id = 'change-of-mind') {
    const html = docHtml(slug);
    const section = M.findSections(html).find(s => s.id === id);
    return { slug, id, indent: section.indent, blocks: M.parseRegion(M.regionSource(html, section)) };
}

/** Run the guard with `after` swapped in for the section's first block. */
function checkWith(afterInlineHtml, base = baseline()) {
    const parsed = M.parseRegion(afterInlineHtml);
    const after = parsed === null ? null : [...parsed, ...base.blocks.slice(1)];
    if (after === null) return { ok: false, errors: [{ code: 'UNPARSEABLE' }] };
    return G.checkRegionEdit({
        slug: base.slug, sectionId: base.id, before: base.blocks, after,
        indent: base.indent, legalConfig: LegalConfig,
    });
}

test('§5 an unchanged section passes every guard', () => {
    for (const r of allRegions()) {
        if (!R.isSectionEditable(r.slug, r.id) || r.blocks === null) continue;
        const res = G.checkRegionEdit({
            slug: r.slug, sectionId: r.id, before: r.blocks, after: r.blocks,
            indent: r.section.indent, legalConfig: LegalConfig,
        });
        assert.equal(res.ok, true,
            `${r.slug}#${r.id} rejects its own current content: `
            + res.errors.map(e => `${e.code} ${e.message}`).join(' | '));
    }
});

test('§5 script-bearing and event-handler markup is rejected', () => {
    // Two layers: the model refuses to parse a <script>, and checkMarkup refuses
    // it again if a tampered client POSTs the block JSON straight to the backend.
    for (const [label, name, attrs] of [
        ['<script>', 'script', []],
        ['<iframe>', 'iframe', [{ name: 'src', value: 'https://evil.test' }]],
        ['<img onerror>', 'img', [{ name: 'onerror', value: 'steal()' }]],
        ['<object>', 'object', []],
    ]) {
        const errors = [];
        G.checkMarkup([{
            type: 'paragraph', className: '', inline: [
                { type: 'element', name, attrs, children: [{ type: 'text', raw: 'x' }] },
            ],
        }], errors);
        assert.ok(errors.length > 0, `${label} must be rejected by the guard layer, not only by the parser`);
        assert.equal(errors[0].code, 'DISALLOWED_TAG');
    }
});

test('§5 disallowed attributes are rejected', () => {
    for (const [attr, code] of [['onclick', 'DISALLOWED_ATTR'], ['style', 'DISALLOWED_ATTR'], ['id', 'DISALLOWED_ATTR'], ['class', 'DISALLOWED_ATTR']]) {
        const errors = [];
        G.checkMarkup([{
            type: 'paragraph', className: '', inline: [
                { type: 'element', name: 'span', attrs: [{ name: attr, value: 'x' }], children: [] },
            ],
        }], errors);
        assert.equal(errors[0]?.code, code, `${attr}= must be rejected on an inline element`);
    }
});

test('§5 only safe link schemes are accepted', () => {
    for (const good of ['https://example.test/x', 'mailto:a@b.test', 'tel:+6421', '/shipping', '#anchor']) {
        assert.equal(G.isSafeHref(good), true, `${good} must be allowed`);
    }
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.test/x', 'http://evil.test', '', ' ']) {
        assert.equal(G.isSafeHref(bad), false, `${bad} must be refused`);
    }
});

test('§5 a deleted, duplicated or invented binding is rejected', () => {
    const base = baseline();
    const deleted = checkWith('<p>Return it within 30 days of delivery, provided:</p>', base);
    assert.ok(deleted.errors.some(e => e.code === 'BINDING_CHANGED'),
        'retyping a bound value as plain text must be refused — it would stop updating with settings');

    const duped = checkWith('<p>Within <span data-legal-bind="return-window-change">30</span> and '
        + '<span data-legal-bind="return-window-change">30</span> days.</p>', base);
    assert.ok(duped.errors.some(e => e.code === 'BINDING_CHANGED'), 'a duplicated binding must be refused');

    const invented = checkWith('<p>Within <span data-legal-bind="return-window-change">30</span> days, '
        + 'ref <span data-legal-bind="not-a-real-key">x</span>.</p>', base);
    assert.ok(invented.errors.some(e => e.code === 'BINDING_CHANGED'),
        'an invented key must be refused — §5 of the retired-CMS suite asserts every key in the '
        + 'HTML is implemented by legal-page.js, so inventing one is as fatal as deleting one');
});

test('§5 a business fact typed as plain prose is rejected', () => {
    const base = baseline();
    for (const [label, text] of [
        ['NZBN', `We are NZBN ${LegalConfig.nzbn}.`],
        ['GST number', `GST ${LegalConfig.gstNumber} applies.`],
        ['phone', `Call ${LegalConfig.phoneDisplay}.`],
        ['email', `Email ${LegalConfig.email}.`],
        ['street address', `Visit ${LegalConfig.address.street}.`],
    ]) {
        const res = checkWith(`<p>${text} Within <span data-legal-bind="return-window-change">30</span> days.</p>`, base);
        assert.ok(res.errors.some(e => e.code === 'FACT_INLINED'),
            `${label} typed as prose must be refused — a second copy of a fact drifts from the `
            + `backend's src/utils/trustSignals.js`);
    }
});

test('§5 the same fact INSIDE its binding is fine', () => {
    // The bound span legitimately contains the fact as placeholder text; only
    // unbound prose is checked. Getting this backwards would make every page
    // unsavable.
    const r = allRegions().find(x => x.slug === 'returns' && x.id === 'address');
    assert.ok(r, 'returns#address must exist');
    assert.ok(!G.unboundText(r.blocks).includes(LegalConfig.nzbn),
        'text inside a data-legal-bind element must be excluded from the fact check');
});

test('§5 banned OEM-warranty claims are caught, however they are written', () => {
    const base = baseline();
    const tail = ' Within <span data-legal-bind="return-window-change">30</span> days.';
    for (const claim of [
        'This does not void your printer warranty.',
        'This does&nbsp;not&nbsp;void your warranty.',      // entity-obfuscated
        'It won’t void your warranty.',                      // typographic apostrophe
        'They cannot refuse to honour it.',
        'Your warranty remains intact.',
    ]) {
        const res = checkWith(`<p>${claim}${tail}</p>`, base);
        assert.ok(res.errors.some(e => e.code === 'BANNED_CLAIM'),
            `must be refused: ${claim}`);
    }
});

test('§5 the banned-claim list is the real one, never a copy', () => {
    const guards = read('inkcartridges/js/admin/utils/page-copy-guards.js');
    assert.match(guards, /BANNED_CLAIM_PATTERNS/,
        'the guard must read LegalConfig.BANNED_CLAIM_PATTERNS');
    assert.ok(!/does\\s\+not\\s\+void|\/does\\s/.test(guards),
        'the guard must not re-declare the patterns — ONE list, so the sweep in '
        + 'tests/google-ads-compliance-may2026.test.js and the save-time ban cannot drift');
    assert.ok(Array.isArray(LegalConfig.BANNED_CLAIM_PATTERNS) && LegalConfig.BANNED_CLAIM_PATTERNS.length > 0);
});

test('§5 a missing banned-claim list FAILS LOUD rather than passing the edit', () => {
    // An absent list must never read as "no violations found" (ERR-063/068/075).
    const base = baseline();
    const res = G.checkRegionEdit({
        slug: base.slug, sectionId: base.id, before: base.blocks, after: base.blocks,
        indent: base.indent, legalConfig: { address: {} },
    });
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => e.code === 'GUARD_UNAVAILABLE'),
        'an unusable config must refuse the save, not silently skip the check');
});

test('§5 deleting a compliance-pinned sentence is rejected', () => {
    const html = docHtml('genuine-vs-compatible');
    const section = M.findSections(html).find(s => s.id === 'warranty');
    const before = M.parseRegion(M.regionSource(html, section));
    const vetted = R.requiredPhrases('genuine-vs-compatible', 'warranty');
    assert.ok(vetted.length >= 2, 'the two sentences supplied by legal must be pinned');

    const after = before.filter(b => !G.allText([b]).includes('30-day satisfaction guarantee, and your statutory'));
    const res = G.checkRegionEdit({
        slug: 'genuine-vs-compatible', sectionId: 'warranty', before, after,
        indent: section.indent, legalConfig: LegalConfig,
    });
    assert.ok(res.errors.some(e => e.code === 'MISSING_PHRASE'),
        'removing a sentence legal supplied for the Google Ads appeal must be refused at save '
        + 'time, not discovered later by CI');
});

test('§5 every requiredPhrase is actually present in the page it is pinned on', () => {
    // A phrase that never matched would be a guard that can never pass — the
    // owner would find the section permanently unsavable.
    for (const r of allRegions()) {
        const phrases = R.requiredPhrases(r.slug, r.id);
        if (!phrases.length || r.blocks === null) continue;
        const text = G.allText(r.blocks);
        for (const p of phrases) {
            assert.ok(text.includes(G.readableText(p)),
                `${r.slug}#${r.id} pins a phrase it does not contain: "${p}"`);
        }
    }
});

test('§5 a locked section cannot be saved, whatever the payload claims', () => {
    const base = baseline();
    for (const [slug, id] of [
        ['returns', 'address'], ['faq', 'cartridges'], ['about', 'business-details'],
        ['returns', 'no-such-section'], ['not-a-doc', 'whatever'],
    ]) {
        const res = G.checkRegionEdit({
            slug, sectionId: id, before: base.blocks, after: base.blocks,
            indent: 28, legalConfig: LegalConfig,
        });
        assert.equal(res.ok, false, `${slug}#${id} must not be savable`);
        assert.equal(res.errors[0].code, 'LOCKED_SECTION');
    }
});

test('§5 read-only blocks inside an editable section cannot be altered', () => {
    const html = docHtml('privacy');
    const section = M.findSections(html).find(s => s.id === 'what');
    const before = M.parseRegion(M.regionSource(html, section));
    const withVerbatim = allRegions().find(r =>
        R.isSectionEditable(r.slug, r.id) && r.blocks?.some(b => b.type === 'verbatim'));
    if (!withVerbatim) return;   // no editable section currently contains one

    const after = withVerbatim.blocks.map(b =>
        b.type === 'verbatim' ? { ...b, raw: b.raw.replace(/<td>/, '<td data-hacked="1">') } : b);
    const res = G.checkRegionEdit({
        slug: withVerbatim.slug, sectionId: withVerbatim.id,
        before: withVerbatim.blocks, after, indent: withVerbatim.section.indent,
        legalConfig: LegalConfig,
    });
    assert.ok(res.errors.some(e => e.code === 'VERBATIM_CHANGED'),
        'a table or address inside an editable section must still be immutable');
    assert.ok(before, 'privacy#what must parse');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 Manifest integrity — fail closed
//
// ERR-063's lesson is that an allowlist in front of a compliance SCANNER fails
// open. This manifest is the opposite: an authoring GATE that fails closed. A
// section nobody listed cannot be edited, and this test goes red until somebody
// makes a deliberate decision about it.
// ─────────────────────────────────────────────────────────────────────────────

test('§6 every section in every file is accounted for in the manifest', () => {
    const unlisted = [];
    for (const slug of DOCS) {
        const doc = R.getDoc(slug);
        for (const s of M.findSections(docHtml(slug))) {
            if (!Object.prototype.hasOwnProperty.call(doc.sections, s.id)) unlisted.push(`${slug}#${s.id}`);
        }
    }
    assert.deepEqual(unlisted, [],
        'a new section is read-only until it is listed in js/admin/utils/page-copy-regions.js. '
        + 'Add it there with a deliberate state — do NOT make unlisted sections default to editable');
});

test('§6 every manifest entry names a section that exists', () => {
    const phantom = [];
    for (const slug of DOCS) {
        const ids = M.findSections(docHtml(slug)).map(s => s.id);
        for (const id of Object.keys(R.getDoc(slug).sections)) {
            if (!ids.includes(id)) phantom.push(`${slug}#${id}`);
        }
    }
    assert.deepEqual(phantom, [], 'the manifest must not describe sections that were removed');
});

test('§6 an unknown doc or section is reported locked, with a reason', () => {
    for (const [slug, id] of [['returns', 'invented'], ['no-such-doc', 'x']]) {
        const rule = R.getSectionRule(slug, id);
        assert.equal(rule.state, 'locked');
        assert.ok(rule.reason && rule.reason.length > 10,
            'a locked section must carry a human-readable reason, so the screen never looks broken');
    }
});

test('§6 every locked section explains itself', () => {
    for (const slug of DOCS) {
        const doc = R.getDoc(slug);
        for (const [id, rule] of Object.entries(doc.sections)) {
            if (rule.state === 'editable') continue;
            assert.equal(rule.state, 'locked', `${slug}#${id}: state must be 'editable' or 'locked'`);
            assert.ok(rule.reason && rule.reason.length > 10,
                `${slug}#${id} is locked with no reason — the owner would just see a section they `
                + `cannot touch and no explanation`);
        }
    }
});

test('§6 every editable section actually contains something editable', () => {
    for (const r of allRegions()) {
        if (!R.isSectionEditable(r.slug, r.id)) continue;
        assert.notEqual(r.blocks, null, `${r.slug}#${r.id} is marked editable but does not parse`);
        assert.ok(r.blocks.some(M.isBlockEditable),
            `${r.slug}#${r.id} is marked editable but every block in it is read-only — it should `
            + `be locked with a reason instead`);
    }
});

test('§6 the doc order lists every doc exactly once', () => {
    assert.deepEqual([...R.PAGE_COPY_DOC_ORDER].sort(), [...DOCS].sort());
    assert.equal(new Set(R.PAGE_COPY_DOC_ORDER).size, R.PAGE_COPY_DOC_ORDER.length);
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 The retired CMS is still retired
//
// tests/legal-cms-retired-jul2026.test.js asserts this from the other side.
// These assertions exist so that a change to THIS feature cannot quietly walk
// the old mechanism back in.
// ─────────────────────────────────────────────────────────────────────────────

test('§7 nothing in this feature names the retired override table', () => {
    const files = [
        'inkcartridges/js/admin/pages/page-copy.js',
        'inkcartridges/js/admin/utils/page-copy-model.js',
        'inkcartridges/js/admin/utils/page-copy-regions.js',
        'inkcartridges/js/admin/utils/page-copy-guards.js',
        'inkcartridges/scripts/canonicalise-page-copy.mjs',
        'page-copy-editor-backend-brief.md',
    ];
    for (const f of files) {
        if (!exists(f)) continue;
        assert.ok(!/legal_content_overrides/i.test(read(f)),
            `${f} must not name the retired override table, in code or in a comment — there is no `
            + `table in this design, the write target is a git blob`);
    }
});

test('§7 the legacy #legal-content redirect still points at the Settings hub', () => {
    const app = read('inkcartridges/js/admin/app.js');
    assert.match(app, /'legal-content':\s*'settings'/,
        "ROUTE_REDIRECTS['legal-content'] must stay 'settings' — §3 of the retired-CMS suite is an "
        + 'equality assertion, so repointing it at page-copy would turn that suite red');
    assert.ok(!/'legal-content':\s*'page-copy'/.test(app),
        'do not repoint the retired route at this feature');
});

test('§7 the editor writes files, and holds no runtime override path', () => {
    const page = read('inkcartridges/js/admin/pages/page-copy.js');
    assert.match(page, /spliceRegion/, 'the editor must write by splicing the source file');

    // Comments are stripped first, on purpose. The header explains WHY the old
    // Supabase-backed CMS was retired, and that explanation is the most valuable
    // text in the file — a test that banned the word would delete the institutional
    // memory it exists to protect. What must not exist is executable code that
    // reads or writes copy through a database.
    const code = page
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert.ok(!/supabase/i.test(code),
        'the editor must not touch Supabase in code — the write target is a git blob');
    assert.ok(!/\.from\(\s*['"`]/.test(code),
        'no table reads: the source of truth is the file in the repo');
});

test('§7 the editor never reports a save it did not make', () => {
    const page = read('inkcartridges/js/admin/pages/page-copy.js');
    assert.match(page, /publishUnavailable/,
        'there must be an explicit "nothing was published" path');
    assert.match(page, /Nothing was published|not published/i,
        'an unavailable endpoint must say so in those words — the retired CMS said '
        + '"Saved. Live on next page-load." into a table nothing read (ERR-069)');
});
