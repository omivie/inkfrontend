/**
 * Negative keyword suggestions page — FE master checklist item 18 (ERR-313)
 * ========================================================================
 *
 * Owner, 7 Oct 2026: nothing may add a negative keyword to Google Ads without
 * the owner approving it first. Jobs FILE suggestions; Approve on
 * /admin#ads-negatives is the ONE action that writes to Google Ads.
 *
 * Pinned here:
 *   - owner-only nav entry (super_admin → 'owner'), APP_VERSION moved;
 *   - the three exact endpoints, through invoiceError so 409/502 carry `.code`;
 *   - Approve/Reject on PENDING rows only, no bulk approve;
 *   - 409 NOT_PENDING ⇒ "Already decided", 502 ADS_WRITE_FAILED ⇒ Google's reason;
 *   - a failed read is a loud error card, NEVER the empty-table message;
 *   - every server string escaped; evidence printed as sent (no unit guessed,
 *     absent ⇒ em dash, never 0).
 *
 * The page module is loaded for real: its imports are swapped for stubs and the
 * copy is imported from a temp dir, so the behaviour tests run the shipped code.
 *
 * Run with: node --test tests/admin-ads-negative-suggestions-oct2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stripComments } = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = path.join(ROOT, 'inkcartridges', 'js', 'admin');
const PAGE_PATH = path.join(ADMIN, 'pages', 'ads-negatives.js');
const PAGE_SRC = fs.readFileSync(PAGE_PATH, 'utf8');
const APP = stripComments(fs.readFileSync(path.join(ADMIN, 'app.js'), 'utf8'));
const API_SRC = stripComments(fs.readFileSync(path.join(ADMIN, 'api.js'), 'utf8'));

// ── Real-module loader ──────────────────────────────────────────────────────
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
globalThis.Security = { escapeHtml, escapeAttr: escapeHtml };

async function loadPage(stubs) {
    globalThis.__adn = stubs;
    const src = PAGE_SRC.replace(/^import [^;]+;$/gm, '');
    assert.ok(!/^import /m.test(src), 'every import line was swapped for a stub');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adn-'));
    const file = path.join(dir, 'ads-negatives.mjs');
    fs.writeFileSync(file, 'const { AdminAPI, FilterState, esc, DataTable, Modal, Toast } = globalThis.__adn;\n' + src);
    return import('file://' + file);
}

function fakeDom() {
    const els = {};
    const el = (id) => (els[id] ||= { id, hidden: false, innerHTML: '', listeners: {}, addEventListener(t, f) { this.listeners[t] = f; }, querySelector: (s) => el(s.replace('#', '')) });
    const container = {
        set innerHTML(v) { this._html = v; for (const k of Object.keys(els)) delete els[k]; },
        get innerHTML() { return this._html; },
        querySelector: (s) => el(s.replace('#', '')),
        querySelectorAll: () => [],
    };
    return { container, el };
}

function stubs(api) {
    const log = { toasts: [], confirms: [], tables: [] };
    class DataTable {
        constructor(container, config) { this.container = container; this.config = config; this.data = []; this.loading = 0; log.tables.push(this); }
        setData(rows) { this.data = rows; this.container.innerHTML = rows.length ? rows.map((r) => this.config.columns.map((c) => c.render(r)).join('|')).join('\n') : this.config.emptyMessage; }
        setLoading() { this.loading++; }
        destroy() {}
    }
    return {
        log,
        AdminAPI: { ads: api },
        FilterState: { showBar() {} },
        esc: escapeHtml,
        icon: () => '',
        DataTable,
        Modal: { confirm: (o) => log.confirms.push(o) },
        Toast: { success: (m) => log.toasts.push(['success', m]), error: (m) => log.toasts.push(['error', m]) },
    };
}

const PENDING = {
    id: 'a1', created_at: '2026-10-07T09:00:00Z', source: 'search-terms-job', scope: 'ad_group',
    target_label: 'Search - Consumables NZ / Ink NZ', keyword_text: 'free printer', match_type: 'PHRASE',
    reason: 'Spend with no conversions', evidence: { spend: 12.4, conversions: 0, paused_groups: ['Ink NZ'] },
    status: 'pending', decided_at: null, applied_at: null, error: null,
};
const APPLIED = { ...PENDING, id: 'a2', status: 'applied', decided_at: '2026-10-07T10:00:00Z', applied_at: '2026-10-07T10:00:01Z' };
const FAILED = { ...PENDING, id: 'a3', status: 'failed', error: 'DUPLICATE_KEYWORD' };
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── Wiring ──────────────────────────────────────────────────────────────────

test('nav: owner-only Marketing entry; APP_VERSION moved off the previous token', () => {
    assert.match(APP, /\{ key: 'ads-negatives', label: 'Negative Keywords', icon: 'search', ownerOnly: true \}/);
    const marketing = APP.slice(APP.indexOf("{ section: 'Marketing' }"));
    assert.ok(marketing.indexOf("key: 'ads-negatives'") < marketing.indexOf('{ section:', 10), 'sits inside the Marketing section');
    assert.match(APP, /const APP_VERSION = '2026\.10\.(0[89]|[12]\d|3[01])-[a-z0-9-]+';/, 'APP_VERSION bumped on or after the ERR-313 deploy');
});

test('api: the three exact endpoints; reads THROW (empty ≠ failed); writes go through invoiceError', () => {
    const ads = API_SRC.slice(API_SRC.indexOf('  ads: {'), API_SRC.indexOf('  controlCenter: {'));
    assert.ok(ads.length > 100, 'ads namespace found before controlCenter');
    assert.match(ads, /window\.API\.get\(`\/api\/admin\/ads\/negative-suggestions\?\$\{qs\}`\)/);
    assert.match(ads, /new URLSearchParams\(\{ status \}\)/);
    assert.match(ads, /throw invoiceError\(resp, 'Could not load negative keyword suggestions'\)/);
    assert.match(ads, /if \(!Array\.isArray\(rows\)\) throw/);
    assert.match(ads, /window\.API\.post\(`\/api\/admin\/ads\/negative-suggestions\/\$\{encodeURIComponent\(id\)\}\/approve`, \{\}\)/);
    assert.match(ads, /window\.API\.post\(`\/api\/admin\/ads\/negative-suggestions\/\$\{encodeURIComponent\(id\)\}\/reject`, \{\}\)/);
    assert.equal((ads.match(/throw invoiceError\(resp/g) || []).length, 3);
    assert.doesNotMatch(ads, /adminApiWarn|return null; \}/, 'no swallowed read');
});

test('page: imports ../app.js BARE (ERR-046), no bulk approve anywhere', () => {
    assert.match(PAGE_SRC, /from '\.\.\/app\.js';/);
    assert.doesNotMatch(PAGE_SRC, /app\.js\?v=/);
    assert.doesNotMatch(stripComments(PAGE_SRC), /bulk|selectable:\s*true/i);
});

// ── Behaviour (real module) ─────────────────────────────────────────────────

test('columns: Approve/Reject on a PENDING row only; history rows have no buttons', async () => {
    const mod = await loadPage(stubs({}));
    const actions = mod.COLUMNS.find((c) => c.key === '_actions');
    const p = actions.render(PENDING);
    assert.match(p, /data-id="a1" data-action="approve">Approve</);
    assert.match(p, /data-id="a1" data-action="reject"[^>]*>Reject</);
    for (const r of [APPLIED, FAILED, { ...PENDING, status: 'rejected' }, { ...PENDING, status: 'approved' }, { ...PENDING, status: undefined }]) {
        assert.equal(actions.render(r), '', `no buttons on ${r.status}`);
    }
    const status = mod.COLUMNS.find((c) => c.key === 'status');
    assert.match(status.render(FAILED), /admin-badge--failed">failed<.*DUPLICATE_KEYWORD/s);
    assert.match(status.render(APPLIED), /admin-badge--completed">applied<.*Applied /s);
    assert.deepEqual(mod.STATUS_TABS.map((t) => t.key).sort(), ['all', 'applied', 'approved', 'failed', 'pending', 'rejected']);
});

test('columns: every server string escaped (keyword, target, reason, source, error, evidence, id)', async () => {
    const mod = await loadPage(stubs({}));
    const X = '<img src=x onerror=alert(1)>';
    const hostile = { ...PENDING, id: '"><b>', keyword_text: X, target_label: X, reason: X, source: X, error: X, scope: X, match_type: X, evidence: { [X]: X } };
    const html = mod.COLUMNS.map((c) => c.render(hostile)).join('');
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /"><b>/);
});

test('evidence: printed as sent — no unit guessed, absent ⇒ em dash (never 0)', async () => {
    const mod = await loadPage(stubs({}));
    const html = mod.evidenceHtml(PENDING.evidence);
    assert.match(html, /Spend:<\/dt><dd[^>]*>12\.4</);
    assert.match(html, /Conversions:<\/dt><dd[^>]*>0</);
    assert.match(html, /Paused groups:<\/dt><dd[^>]*>Ink NZ</);
    assert.doesNotMatch(html, /\$/, 'no currency invented');
    for (const v of [null, undefined, {}, 'x']) assert.equal(mod.evidenceHtml(v), '—');
    assert.match(mod.evidenceHtml({ spend: null }), /Spend:<\/dt><dd[^>]*>—</, 'a null field is unknown, not 0');
});

test('load: rows reach the table; a FAILED read is a loud error card, not the empty message', async () => {
    const calls = [];
    const s = stubs({ listNegativeSuggestions: async (st) => { calls.push(st); return [PENDING]; } });
    const mod = await loadPage(s);
    const { container, el } = fakeDom();
    await mod.default.init(container);
    assert.deepEqual(calls, ['pending'], 'default tab = pending');
    assert.equal(s.log.tables[0].data.length, 1);
    assert.equal(el('adn-error').hidden, true);

    const s2 = stubs({ listNegativeSuggestions: async () => { throw Object.assign(new Error('Forbidden'), { code: 'FORBIDDEN' }); } });
    const mod2 = await loadPage(s2);
    const dom2 = fakeDom();
    await mod2.default.init(dom2.container);
    assert.equal(dom2.el('adn-error').hidden, false);
    assert.equal(dom2.el('adn-table').hidden, true);
    assert.match(dom2.el('adn-error').innerHTML, /Couldn't load the suggestions\..*not an empty list/s);
    assert.match(dom2.el('adn-error').innerHTML, /Forbidden/);
    assert.doesNotMatch(dom2.el('adn-table').innerHTML, /No suggestions/);
    mod.default.destroy(); mod2.default.destroy();
});

test('approve: confirm first, then ONE write; success, 409 NOT_PENDING and 502 ADS_WRITE_FAILED each reload', async () => {
    let lists = 0;
    const writes = [];
    let approveImpl = async (id) => { writes.push(['approve', id]); return { status: 'applied' }; };
    const s = stubs({
        listNegativeSuggestions: async () => { lists++; return [PENDING]; },
        approveNegativeSuggestion: (id) => approveImpl(id),
        rejectNegativeSuggestion: async (id) => { writes.push(['reject', id]); return { status: 'rejected' }; },
    });
    const mod = await loadPage(s);
    const { container, el } = fakeDom();
    await mod.default.init(container);
    const click = (action) => el('adn-table').listeners.click({ target: { closest: () => ({ dataset: { id: 'a1', action } }) }, stopPropagation() {} });

    click('approve');
    assert.equal(writes.length, 0, 'nothing written before the owner confirms');
    assert.equal(s.log.confirms.length, 1);
    assert.match(s.log.confirms[0].message, /"free printer" \(PHRASE\).*Search - Consumables NZ \/ Ink NZ/);
    await s.log.confirms[0].onConfirm();
    assert.deepEqual(writes, [['approve', 'a1']]);
    assert.deepEqual(s.log.toasts.at(-1), ['success', 'Added to Google Ads (applied)']);
    assert.equal(lists, 2, 'reloaded after the decision');

    approveImpl = async () => { throw Object.assign(new Error('Suggestion is not pending'), { code: 'NOT_PENDING' }); };
    click('approve');
    await s.log.confirms[1].onConfirm();
    assert.equal(s.log.toasts.at(-1)[0], 'error');
    assert.match(s.log.toasts.at(-1)[1], /^Already decided/);
    assert.equal(lists, 3);

    approveImpl = async () => { throw Object.assign(new Error('Keyword already exists in the ad group'), { code: 'ADS_WRITE_FAILED' }); };
    click('approve');
    await s.log.confirms[2].onConfirm();
    assert.match(s.log.toasts.at(-1)[1], /Google Ads refused the negative keyword: Keyword already exists in the ad group\. The suggestion is now marked failed\./);
    assert.equal(lists, 4);

    click('reject');
    await tick(); await tick();
    assert.deepEqual(writes.at(-1), ['reject', 'a1']);
    assert.match(s.log.toasts.at(-1)[1], /nothing was written to Google Ads/);
    mod.default.destroy();
});

test('a reply that lands after destroy() paints nothing (ERR-045)', async () => {
    let release;
    const s = stubs({ listNegativeSuggestions: () => new Promise((r) => { release = r; }) });
    const mod = await loadPage(s);
    const { container } = fakeDom();
    const p = mod.default.init(container);
    await tick();
    const table = s.log.tables[0];
    mod.default.destroy();
    release([PENDING]);
    await p;
    assert.equal(table.data.length, 0);
});
