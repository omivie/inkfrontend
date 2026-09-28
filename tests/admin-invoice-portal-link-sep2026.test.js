/**
 * Invoices — the portal link is shown, filtered and never silently dropped (ERR-286)
 * =================================================================================
 *
 * Backend, 2026-09-21: `POST /api/admin/invoices` no longer leaves an orphan.
 *   - an unsatisfiable `business_account_id` is refused BEFORE the RPC with
 *     `400 BUSINESS_ACCOUNT_NOT_FOUND`, so no numbered document is minted;
 *   - if the post-RPC link patch fails for an infrastructure reason the invoice
 *     EXISTS, so the answer is `201` with a `warnings[]` entry;
 *   - list rows carry `business_account_id` + `business_account_name`, so a
 *     Portal column and an "unlinked" filter are buildable.
 *
 * Measured 2026-09-25: every list row carries both keys (null on all 21 today),
 * and the list IGNORED every portal param we tried — so the filter was ours,
 * walking every page. The backend added `linked=true|false` on 2026-09-25
 * (BF-070 g) and made the list `strictQuery`. Measured 2026-09-28: linked=true
 * 0 + linked=false 21 = the whole list; `linked=maybe` and any unknown param
 * are 400. So the filter is the SERVER's now, and paginates normally.
 *
 * What would be invisibly wrong without these:
 *   - `createInvoice` returned `data.invoice` alone, so a 201 with warnings
 *     rendered as a clean green "saved" over a dropped portal link;
 *   - an ABSENT key rendered as "Unlinked" would be a claim nobody measured;
 *   - a page-only filter would say "no unlinked invoices" whenever they sat on
 *     page 2.
 *
 * Run with: node --test tests/admin-invoice-portal-link-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const API = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/admin/api.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/admin/pages/invoices.js'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() must exist`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}
// eslint-disable-next-line no-new-func
const load = (src, ...names) => new Function(`${names.map((n) => extractFunction(src, n)).join('\n')}; return { ${names.join(', ')} };`)();

const { withInvoiceWarnings } = load(API, 'withInvoiceWarnings');
const { portalLinkOf, linkedParam } = load(PAGE, 'portalLinkOf', 'linkedParam');

test('a 201 with warnings[] carries them — as a NON-enumerable field', () => {
  const inv = withInvoiceWarnings({ ok: true, data: { invoice: { id: 'i1', invoice_number: 3290 },
    warnings: ['business account link could not be saved', { code: 'LINK_PATCH_FAILED', message: 'link patch failed' }] } });
  assert.deepEqual([...inv._warnings], ['business account link could not be saved', 'link patch failed']);
  assert.ok(!Object.keys(inv).includes('_warnings'),
    'buildPayload/documentDrift spread and compare records — a warning must never look like a document field');
  assert.equal(JSON.stringify(inv), '{"id":"i1","invoice_number":3290}');
  // [CONTROL] no warnings = an empty list, not undefined, and the record is intact.
  const clean = withInvoiceWarnings({ ok: true, data: { invoice: { id: 'i2' } } });
  assert.equal(clean._warnings.length, 0);
  assert.equal(clean.id, 'i2');
  assert.equal(withInvoiceWarnings({ ok: true, data: null }), null);
});

test('create AND update both go through it', () => {
  const create = API.slice(API.indexOf('async createInvoice('), API.indexOf('async updateInvoice('));
  const update = API.slice(API.indexOf('async updateInvoice('), API.indexOf('async voidInvoice('));
  assert.match(create, /return withInvoiceWarnings\(resp\);/);
  assert.match(update, /return withInvoiceWarnings\(resp\);/, 'the same pre-flight runs on PUT');
});

test('the save surfaces every warning as a warning toast', () => {
  const persist = extractFunction(PAGE, 'persistDraft');
  assert.match(persist, /for \(const w of \(saved\._warnings \|\| \[\]\)\) \{\s*Toast\.warning\(/);
});

test('BUSINESS_ACCOUNT_NOT_FOUND says nothing was created, and names the trap', () => {
  // eslint-disable-next-line no-new-func
  const saveErrorMessage = new Function(`${extractFunction(PAGE, 'saveErrorMessage')}; return saveErrorMessage;`)();
  const msg = saveErrorMessage(Object.assign(new Error('Business account not found'), { code: 'BUSINESS_ACCOUNT_NOT_FOUND' }));
  assert.match(msg, /was NOT created/);
  assert.match(msg, /saved only on this device|business application/);
  assert.match(msg, /Business account not found/, "the server's own words are kept too");
  // [CONTROL] another error is untouched.
  assert.doesNotMatch(saveErrorMessage(new Error('boom')), /NOT created/);
});

test('portalLinkOf: absent, unlinked and linked are three different answers', () => {
  assert.equal(portalLinkOf({ id: 'x' }), null, 'a row without the key is UNKNOWN, not unlinked');
  assert.equal(portalLinkOf({ business_account_id: null, business_account_name: null }), false);
  assert.deepEqual({ ...portalLinkOf({ business_account_id: 'b1', business_account_name: 'BSW Architects' }) },
    { id: 'b1', name: 'BSW Architects' });
});

test('the Portal dropdown maps to linked=true|false, and "any" sends nothing', () => {
  assert.equal(linkedParam('linked'), 'true');
  assert.equal(linkedParam('unlinked'), 'false');
  assert.equal(linkedParam(''), '');
  assert.equal(linkedParam('bogus'), '', 'an unknown choice must never reach a strictQuery list');
});

test('the SERVER filters by portal link; the client-side page walk is gone', () => {
  const load = extractFunction(PAGE, 'loadData');
  assert.match(load, /linked: linkedParam\(_portalFilter\)/);
  assert.doesNotMatch(PAGE, /loadPortalFiltered|PORTAL_SCAN_|matchesPortalFilter|the server cannot filter by portal link/);
  const from = API.indexOf('async listInvoices(');
  const list = API.slice(from, API.indexOf('\n  },', from) + 4);
  assert.match(list, /if \(filters\.linked === 'true' \|\| filters\.linked === 'false'\) params\.set\('linked', filters\.linked\);/);
});

test('strictQuery: a refused list is an ERROR on the page, never "no invoices"', () => {
  const from = API.indexOf('async listInvoices(');
  const list = API.slice(from, API.indexOf('\n  },', from) + 4);
  assert.match(list, /if \(!resp \|\| resp\.ok === false\) throw invoiceError\(resp,/);
  // Every param listInvoices can emit, against the allow-list measured 2026-09-28
  // (page, limit, search, status, sort, order, linked all 200; `zz` is 400).
  const sent = [...list.matchAll(/params\.set\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(sent)].sort(), ['limit', 'linked', 'order', 'page', 'search', 'sort', 'status']);
  const load = extractFunction(PAGE, 'loadData');
  assert.ok(load.indexOf('data === null') > -1 && load.indexOf('data === null') < load.indexOf('_table.setData(rows'),
    'the failure branch runs before rows are painted');
  assert.match(load, /NOT an empty list/);
});

test('every sortable invoice column is a sort the server accepts', () => {
  // Measured 2026-09-28 under strictQuery: sort=invoice_number, issue_date and
  // total all 200. A column added here needs a measurement first.
  const cols = PAGE.slice(PAGE.indexOf('const COLUMNS = ['));
  const keys = [...cols.slice(0, cols.indexOf('\n];')).matchAll(/\{ key: '([a-z_]+)'[^\n]*sortable: true/g)].map((m) => m[1]);
  assert.ok(keys.length > 0);
  for (const k of keys) assert.ok(['invoice_number', 'issue_date', 'total'].includes(k), `sort=${k} is unmeasured`);
});
