/**
 * Orders page — customer/order-number search box (Aug 2026)
 * =========================================================
 *
 * The Orders list had a Status chip and date-range chips (both from the shared
 * global filter bar) but no way to type a customer's name — finding "Richie
 * Waugh" meant paging through 20-row server pages by eye.
 *
 * Everything behind the box already existed and was DEAD: `_search` was declared
 * and sent on every `AdminAPI.getOrders` call, and `onSearch()` synced
 * `#order-search` — an element that had never been rendered, called by nobody.
 * The only thing that ever set `_search` was the `#orders?focus=<order_number>`
 * deep-link from Tracking Requests, which meant an admin arriving that way saw a
 * silently filtered one-row list with nothing on screen saying why.
 *
 * THE BACKEND CONTRACT IS MEASURED, NOT ASSUMED. `npm run probe:orders-search`
 * (read-only) established against production on 2026-08-28:
 *
 *   search=Vieland     → 1 row, matched on the NAME field          ✓
 *   search=ichi        → 3 rows (case-insensitive SUBSTRING)       ✓
 *   search=zzqxnope    → 0 rows, not the unfiltered 50             ✓ (param honoured)
 *   search=20260827    → 3 rows (partial order number)             ✓
 *   search=X&status=Y  → composes; status filter survives          ✓
 *   search=<email>     → 0 rows. customer_email=<email> → 0 rows.  ✗ NOT SUPPORTED
 *
 * That last line is why the placeholder says "customer name or order #" and not
 * "email": `AdminAPI.getOrders` routes any query containing '@' to
 * `customer_email=`, a param that matches nothing. Promising email in the
 * placeholder would be a promise the backend cannot keep, so the tests below pin
 * the placeholder's wording as load-bearing, not cosmetic.
 *
 * Run with: node --test tests/admin-orders-search-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ORDERS_PAGE = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'pages', 'orders.js');
const src = fs.readFileSync(ORDERS_PAGE, 'utf8');

/** Body of a named function declaration, brace-matched. */
function fnBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in orders.js`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// ── 1. The input exists, and sits in the page header ────────────────────────
test('renderOrdersTab emits a search input with id="order-search"', () => {
  const body = fnBody(src, 'renderOrdersTab');
  assert.match(body, /id="order-search"/,
    'the input must carry id="order-search" — that is the id onSearch() already syncs');
  assert.match(body, /type="search"/, 'use type="search" so the browser paints a native clear affordance');
  assert.match(body, /admin-page-header__actions/,
    'the search belongs in the header actions row, beside New Order / Export');
});

test('the input uses the shared .admin-search wrapper, not a bespoke one', () => {
  const body = fnBody(src, 'renderOrdersTab');
  assert.match(body, /class="admin-search"/,
    '.admin-search + .admin-search__icon already exist in css/admin.css — a new wrapper would drift');
  assert.match(body, /admin-search__icon/, 'the magnifier goes in the shared icon slot');
  const css = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'css', 'admin.css'), 'utf8');
  assert.match(css, /\.admin-search\s*\{/, '.admin-search must exist in admin.css — no new CSS was added for this');
  assert.match(css, /\.admin-search__icon\s*\{/, '.admin-search__icon must exist in admin.css');
});

// ── 2. The placeholder promises only what the backend delivers ──────────────
test('the placeholder offers name + order #, and does NOT promise email', () => {
  const body = fnBody(src, 'renderOrdersTab');
  const m = body.match(/placeholder="([^"]*)"/);
  assert.ok(m, 'the search input needs a placeholder');
  const placeholder = m[1];
  assert.match(placeholder, /customer/i, 'say it searches the customer');
  assert.match(placeholder, /order/i, 'say it searches the order number');
  assert.doesNotMatch(placeholder, /e-?mail/i,
    'email search returns 0 rows for every address on GET /api/admin/orders '
    + '(probe:orders-search, 2026-08-28) — promising it in the placeholder is a lie');
});

test('an email-shaped query gets an empty state that names the reason', () => {
  const body = fnBody(src, 'loadOrders');
  assert.match(body, /looksLikeEmail\(_search\)/,
    'loadOrders must branch on an email-shaped query when choosing the empty message');
  assert.match(body, /emptyMessage/, 'the empty message must be set per-load, not fixed at construction');
  assert.match(body, /email/i,
    'the email empty state must say email is not searchable — a bare "No orders found" '
    + 'reads as "this customer has no orders", which is a different and false claim');
  // The check must only EXPLAIN the miss, never suppress the request: if the
  // backend gains email search the query must still go out and still work.
  const guard = /if\s*\(\s*looksLikeEmail[^)]*\)\s*(\{[^}]*)?return/;
  assert.doesNotMatch(body, guard, 'looksLikeEmail must not short-circuit the fetch');
});

test('a non-email query names the query in the empty state', () => {
  const body = fnBody(src, 'loadOrders');
  assert.match(body, /No orders match/,
    'an empty search result should name what was searched for');
});

// ── 3. Debounce is module-scoped so teardown can cancel it ──────────────────
test('the debounce timer is module-scoped, not trapped in a closure', () => {
  assert.match(src, /^let _searchDebounce = null;$/m,
    '_searchDebounce must be a module-level binding — a closure timer inside '
    + 'renderOrdersTab() cannot be cleared by destroyOrdersTab()');
});

test('destroyOrdersTab and destroy both cancel a pending keystroke', () => {
  const teardown = fnBody(src, 'destroyOrdersTab');
  assert.match(teardown, /clearTimeout\(_searchDebounce\)/,
    'switching to the Refunds tab tears down _table while the page stays mounted — '
    + 'a keystroke landing 300ms later would call loadOrders() against a dead table');
  const destroyIdx = src.indexOf('  destroy() {');
  assert.notEqual(destroyIdx, -1, 'the page module must export destroy()');
  const destroyBlock = src.slice(destroyIdx, destroyIdx + 700);
  assert.match(destroyBlock, /clearTimeout\(_searchDebounce\)/,
    'leaving the page entirely must cancel the timer too');
  assert.match(destroyBlock, /_search = ''/, 'destroy() must clear the query itself');
});

test('a settled keystroke resets to page 1 before reloading', () => {
  const body = fnBody(src, 'renderOrdersTab');
  const handler = body.slice(body.indexOf("#order-search"));
  assert.match(handler, /_page = 1/,
    'a new query must not keep the old page offset — page 3 of the previous result '
    + 'is very often past the end of the new one, which paints an empty table');
  assert.match(handler, /loadOrders\(\)/, 'the settled keystroke must reload from the server');
  assert.match(handler, /300\)/, '300ms matches Customers / Products / Invoices / Quick Order');
});

// ── 4. Search is SERVER-side — never a filter over the loaded page ──────────
test('the query is sent to the server, not applied to _table.data', () => {
  const body = fnBody(src, 'loadOrders');
  assert.match(body, /search:\s*_search/,
    '_search must travel to AdminAPI.getOrders — the table is paged 20-at-a-time, so '
    + 'an in-memory filter would search 20-of-N rows while looking like it searched all');
  const handler = fnBody(src, 'renderOrdersTab');
  assert.doesNotMatch(handler.slice(handler.indexOf('#order-search')), /_table\.data\.filter/,
    'never filter the loaded page in memory');
});

// ── 5. URL persistence, and the focus= regression it must not break ─────────
test('the query round-trips through the hash as ?q=', () => {
  const body = fnBody(src, 'renderOrdersTab');
  assert.match(body.slice(body.indexOf('#order-search')), /writeHashParams\(\{\s*q:\s*_search\s*\}\)/,
    'a search should survive a reload and be shareable');
  const init = src.slice(src.indexOf('  async init(container) {'), src.indexOf('FilterState.setVisibleFilters'));
  assert.match(init, /getHashParam\('q'\)/, 'init must seed _search from ?q=');
});

test('writeHashParams preserves params it does not own', () => {
  const body = fnBody(src, 'writeHashParams');
  assert.match(body, /new URLSearchParams\(/,
    'merge into the existing query — rebuilding it from scratch would drop the '
    + "global filter bar's period=/statuses= (the mirror of FilterState._OWN_KEYS)");
  assert.match(body, /params\.delete\(k\)/, 'an emptied search must remove the key, not leave q=');
  assert.match(body, /replaceState/, 'keystrokes must not each become a back-button entry');
});

test('focus= still wins over q= and still reaches the visible input', () => {
  const init = src.slice(src.indexOf('  async init(container) {'), src.indexOf('FilterState.setVisibleFilters'));
  assert.match(init, /const focusOrder = getHashParam\('focus'\)/,
    'the Tracking Requests deep-link must keep working');
  assert.match(init, /if \(focusOrder\) _search = focusOrder;\s*\n\s*else _search = getHashParam\('q'\)/,
    'focus= is a one-shot deep-link that also opens the drawer — it must take precedence over q=');
  // The regression this feature quietly fixes: the seeded query is now VISIBLE.
  const body = fnBody(src, 'renderOrdersTab');
  assert.match(body, /value="\$\{Security\.escapeAttr\(_search\)\}"/,
    'the input must render the seeded _search — a focus= arrival used to show a '
    + 'filtered one-row list with nothing on screen explaining why');
});

test('the seeded value is attribute-escaped', () => {
  const body = fnBody(src, 'renderOrdersTab');
  assert.match(body, /Security\.escapeAttr\(_search\)/,
    '_search comes from the URL hash — an unescaped " would break out of the value attribute');
});

// ── 6. onSearch() is no longer dead code ───────────────────────────────────
test('onSearch cancels an in-flight keystroke before applying its query', () => {
  const idx = src.indexOf('  onSearch(query) {');
  assert.notEqual(idx, -1, 'the page module must still export onSearch');
  const block = src.slice(idx, idx + 700);
  assert.match(block, /clearTimeout\(_searchDebounce\)/,
    'a programmatic search must not be silently overwritten 300ms later by a stale keystroke');
  assert.match(block, /getElementById\('order-search'\)/,
    'onSearch syncs the input — an id that exists now, where before it matched nothing');
});
