/**
 * Admin Analytics section + collapsible sidebar groups (Sep 2026) — ERR-208
 * =========================================================================
 *
 * The owner asked for "one dedicated section in the admin side bar instead of the
 * multiple". Before this pass the reporting surfaces were spread over three sections:
 * the hub under "Finance", Demand Ranking / Catalogue Engagement / Price Monitor under
 * "Catalog". This file pins the result, and the two mechanisms it rests on.
 *
 *   §1–§4  the ANALYTICS section: where it sits, what is in it, what left Catalog,
 *          and that NOTHING was renamed on the way (deep links, ?tab= state and
 *          ROUTE_REDIRECTS all key off the route hash).
 *
 *   §5     ONE list of tabs. The sidebar's indented sub-links and the hub's own tab
 *          bar must read the same array. analytics.js already carried two lists keyed
 *          by the same ids — a `TABS` array for the bar and a `moduleMap` object for
 *          the lazy import — and the sidebar would have made three. Every drift bug in
 *          this repo's log has that shape (ERR-150/160: the same feature vanished twice,
 *          once at a whitelist parser and once at a call site; the July 2026 owner gate,
 *          where two lists governed access and only one was maintained). This is the
 *          assertion that matters most in the file.
 *
 *   §6–§7  the group markup: a real <button> owning a real container, the empty-group
 *          rule preserved, and sub-links that carry BOTH halves of their address.
 *
 *   §8     ERR-208 itself. `analytics.js` read `?tab=` only inside init(), and app.js's
 *          hashchange handler compared getRouteFromHash(), which strips the query. So a
 *          link to `#analytics?tab=traffic` did NOTHING when you were already on
 *          `#analytics`: the hash changed, the listener saw the same route and returned.
 *          website-traffic.js:562 has shipped such a link since June 2026. A hub tab is
 *          only addressable if the router notices an address change BELOW the route.
 *
 *   §9     the CSS, including the two states that do not fall out for free — the 60px
 *          rail (no headers, so nothing may be left folded) and the 280px mobile drawer.
 *
 *   §10    group state persists, and auto-expanding to show you where you are does not
 *          overwrite a section you chose to keep shut.
 *
 * SOURCE-TEXT assertions: the admin is a browser ES module that reads window globals, so
 * it cannot be require()d here and the repo has no jsdom (same approach as
 * admin-ia-overhaul-jul2026.test.js). APP_VERSION is deliberately NOT pinned —
 * asset-cache-tokens.test.js owns cache-bust freshness, and a literal pin here is the
 * ERR-063 anti-pattern that left nine suites permanently red.
 *
 * Run with: node --test tests/admin-analytics-section-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = (...p) => path.resolve(__dirname, '..', ...p);
const APP   = fs.readFileSync(R('inkcartridges', 'js', 'admin', 'app.js'), 'utf8');
const HUB   = fs.readFileSync(R('inkcartridges', 'js', 'admin', 'pages', 'analytics.js'), 'utf8');
const TABS  = fs.readFileSync(R('inkcartridges', 'js', 'admin', 'utils', 'analytics-tabs.js'), 'utf8');
const CSS   = fs.readFileSync(R('inkcartridges', 'css', 'admin.css'), 'utf8');

// Section-boundary helper: NAV_ITEMS is a flat array of `{ section: 'X' }` markers
// followed by their items, so "is key K in section S" is an index-range question.
const sectionIdx = (name) => APP.indexOf(`section: '${name}'`);
const keyIdx = (key) => APP.indexOf(`key: '${key}'`);
function inSection(key, section, nextSection) {
  const a = sectionIdx(section), b = sectionIdx(nextSection), k = keyIdx(key);
  return a !== -1 && b !== -1 && k > a && k < b;
}

// The four surfaces the owner wanted gathered.
const ANALYTICS_KEYS = ['analytics', 'demand-ranking', 'catalog-engagement', 'price-monitor'];

// ─────────────────────────────────────────────────────────────────────────────
// §1–§4 — the section
// ─────────────────────────────────────────────────────────────────────────────

test('§1 NAV_ITEMS has an Analytics section, between Overview and Sales', () => {
  assert.ok(sectionIdx('Analytics') !== -1,
    'NAV_ITEMS is missing { section: \'Analytics\' } — the dedicated reporting home.');
  assert.ok(sectionIdx('Overview') < sectionIdx('Analytics'),
    'Analytics must come after Overview: Dashboard stays the landing page.');
  assert.ok(sectionIdx('Analytics') < sectionIdx('Sales'),
    'Analytics must come before Sales — it is what the owner opens first.');
});

test('§2 every analytics surface lives in it', () => {
  for (const key of ANALYTICS_KEYS) {
    assert.ok(inSection(key, 'Analytics', 'Sales'),
      `"${key}" is not in the Analytics section. The whole point of this pass is that ` +
      'there is exactly ONE place to go and look at how the business is doing; a reporting ' +
      'surface filed anywhere else recreates the sprawl.');
  }
});

test('§2b none of them was left behind in Catalog', () => {
  for (const key of ['demand-ranking', 'catalog-engagement', 'price-monitor']) {
    assert.ok(!inSection(key, 'Catalog', 'Data Operations'),
      `"${key}" is still listed under Catalog as well. NAV_ITEMS renders every entry, so a ` +
      'duplicated key means two sidebar rows pointing at the same page.');
  }
  // Supplier Prices deliberately stayed: its day job is mapping supplier lines to products.
  assert.ok(inSection('supplier-prices', 'Catalog', 'Data Operations'),
    'supplier-prices was moved out of Catalog. It reports, but it is a catalogue-maintenance ' +
    'tool first — this pass deliberately left it where it was.');
  // Expenses deliberately stayed: its other two tabs are data entry.
  assert.ok(APP.indexOf("key: 'expenses'") > sectionIdx('Finance'),
    'expenses left the Finance section. It is a ledger you write, not a report you read.');
});

test('§3 all four stay owner-gated by the single derived rule', () => {
  for (const key of ANALYTICS_KEYS) {
    const i = keyIdx(key);
    assert.ok(/ownerOnly:\s*true/.test(APP.slice(i, i + 160)),
      `"${key}" lost ownerOnly: true. The gate is DERIVED from NAV_ITEMS ` +
      '(isOwnerOnlyRoute), so dropping the flag both shows the row to staff AND lets a ' +
      'direct #hash load the page — the exact hole the July 2026 pass closed.');
  }
  assert.ok(/function isOwnerOnlyRoute\s*\(/.test(APP),
    'isOwnerOnlyRoute() is gone — owner gating must stay single-source.');
  assert.ok(!/\bownerPages\b/.test(APP),
    'A second owner-gate list reappeared. Two lists drift; that is how 8 of 16 owner pages ' +
    'were loadable by direct hash before July 2026.');
});

test('§4 no route key was renamed — every deep link still resolves', () => {
  const keys = new Set([...APP.matchAll(/key:\s*'([^']+)'/g)].map(m => m[1]));
  for (const k of ['dashboard', 'orders', 'products', 'customers', 'invoices', 'analytics',
                   'control-center', 'promotions', 'expenses', 'demand-ranking', 'segments',
                   'tracking-requests', 'price-monitor', 'catalog-engagement', 'supplier-prices',
                   'sync-report', 'pending-changes']) {
    assert.ok(keys.has(k), `Route key "${k}" disappeared from NAV_ITEMS — #${k} would 404 in-app.`);
  }
  // The hub kept `analytics` and only changed its LABEL, so the three redirects into it hold.
  assert.ok(/key:\s*'analytics',\s*label:\s*'Performance'/.test(APP),
    'The analytics hub must keep key:"analytics" while reading "Performance" in the sidebar. ' +
    'Under an ANALYTICS header "Finance" misnames a hub whose tabs include Traffic and ' +
    'Acquisition — but the KEY is the address, and margin/financial-health/website-traffic ' +
    'all redirect through it.');
  const redirects = APP.slice(APP.indexOf('ROUTE_REDIRECTS'));
  for (const old of ['margin', 'financial-health', 'website-traffic']) {
    assert.ok(new RegExp(`'${old}'\\s*:`).test(redirects),
      `ROUTE_REDIRECTS lost the "${old}" alias — an old bookmark would 404.`);
  }
});

test('§4b the tab redirects land on their TAB, not just the hub', () => {
  const redirects = APP.slice(APP.indexOf('ROUTE_REDIRECTS'), APP.indexOf('async function loadPage'));
  for (const [from, to] of [['margin', 'analytics?tab=margins'],
                            ['financial-health', 'analytics?tab=health'],
                            ['website-traffic', 'analytics?tab=traffic']]) {
    assert.ok(redirects.includes(`'${from}': '${to}'`),
      `ROUTE_REDIRECTS['${from}'] must be '${to}'. #${from} is a bookmark whose entire ` +
      'meaning is the panel it names; pointing it at a bare #analytics drops you on ' +
      'Revenue instead. It could not be fixed before Sep 2026 — arriving from another ' +
      'page worked, but from inside the hub the router ignored the change (ERR-208).');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — one list of tabs (the assertion that matters most)
// ─────────────────────────────────────────────────────────────────────────────

test('§5 the tab manifest is a shared module, read by BOTH surfaces', () => {
  assert.match(TABS, /export const ANALYTICS_TABS\s*=\s*\[/,
    'utils/analytics-tabs.js must export ANALYTICS_TABS.');
  for (const id of ['revenue', 'health', 'margins', 'pricing', 'market-intel', 'traffic', 'acquisition']) {
    assert.ok(TABS.includes(`id: '${id}'`), `The manifest is missing the "${id}" tab.`);
  }
  assert.match(HUB, /import\s*\{[^}]*ANALYTICS_TABS[^}]*\}\s*from\s*'\.\.\/utils\/analytics-tabs\.js'/,
    'pages/analytics.js must take its tabs from the shared manifest.');
  assert.match(APP, /import\s*\{[^}]*ANALYTICS_TABS[^}]*\}\s*from\s*'\.\/utils\/analytics-tabs\.js'/,
    'app.js must build the sidebar sub-links from the shared manifest.');
});

test('§5b neither surface keeps a private copy of the list', () => {
  // The old `TABS = [ { id: 'revenue', label: ... } ... ]` literal, and the parallel
  // moduleMap that had to be edited alongside it.
  assert.ok(!/const TABS\s*=\s*\[/.test(HUB),
    'pages/analytics.js declares its own TABS array again. The sidebar reads the manifest; ' +
    'a second list here means adding a tab shows it in one place and not the other.');
  assert.ok(!/moduleMap/.test(HUB),
    'The `moduleMap` object is back. The module path must travel WITH the label in the ' +
    'manifest — two objects keyed by the same ids is the drift shape, not a coincidence.');
  // app.js must not hardcode tab ids either: it asks hubTabsFor(), which returns the manifest.
  assert.ok(!/'market-intel'/.test(APP),
    "app.js hardcodes a tab id ('market-intel'). Sub-links come from ANALYTICS_TABS.");
  assert.match(APP, /function hubTabsFor\s*\(/,
    'hubTabsFor() is the one place app.js resolves an item\'s tabs — the sidebar and the ' +
    'command palette both call it.');
});

test('§5c the manifest imports nothing (no cycle, no eager page load)', () => {
  assert.ok(!/^\s*import\s/m.test(TABS),
    'utils/analytics-tabs.js imported something. app.js must be able to read it without ' +
    'pulling in a page module — page modules import app.js back, and an eager import would ' +
    'also defeat the lazy page loading the router relies on.');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6–§7 — sidebar group markup
// ─────────────────────────────────────────────────────────────────────────────

test('§6 sections render as real, keyboard-operable collapsible groups', () => {
  assert.match(APP, /class="admin-nav-group\$\{isCollapsed \? ' is-collapsed' : ''\}"/,
    'renderSidebar must emit an .admin-nav-group wrapper carrying its collapsed state.');
  assert.match(APP, /<button type="button" class="admin-nav-group__toggle/,
    'The section header must be a <button> — a clickable <div> gives no Enter/Space, no ' +
    'focus ring and no role.');
  assert.match(APP, /aria-expanded="\$\{isCollapsed \? 'false' : 'true'\}"/,
    'The toggle must expose aria-expanded.');
  assert.match(APP, /aria-controls="navgrp-\$\{esc\(gid\)\}"/,
    'The toggle must point at the container it controls via aria-controls.');
  assert.match(APP, /id="navgrp-\$\{esc\(gid\)\}"/,
    'The items container needs the id aria-controls names.');
});

test('§6b an empty group renders NOTHING — header included', () => {
  assert.match(APP, /if \(!g\.items\.length\) continue;/,
    'A section with no item this role may see must produce no markup at all. Every entry ' +
    'in the Analytics section is ownerOnly, so for a plain admin this group is empty — ' +
    'without the skip they would see an "ANALYTICS" header with nothing under it.');
  assert.ok(!/pendingSection/.test(APP),
    'The old "pending label" string is back alongside the group wrapper. The rule survives, ' +
    'but a wrapper has to be opened before its children, so the decision moved up front.');
});

test('§7 hub sub-links carry BOTH halves of their address', () => {
  assert.match(APP, /data-nav="\$\{esc\(item\.key\)\}" data-nav-tab="\$\{esc\(t\.id\)\}"/,
    'A sub-link needs data-nav (the route) AND data-nav-tab (the ?tab= value): setActiveNav ' +
    'needs the pair to tell "Traffic" from its parent "Performance", which share a route.');
  assert.match(APP, /href="#\$\{esc\(item\.key\)\}\?tab=\$\{esc\(t\.id\)\}"/,
    'A sub-link must be a real address, not a JS handler — it has to survive a copy-paste, ' +
    'a middle-click and a bookmark.');
  assert.match(APP, /class="admin-nav-item admin-nav-item--sub"/,
    'Sub-links need the --sub modifier: it is what the indent, and the 60px-rail hide, key off.');
  assert.match(APP, /hubTabs:\s*'analytics'/,
    'The analytics nav item must be marked with hubTabs so renderSidebar emits its sub-links.');
});

test('§7b NAV_ITEMS stays flat — the owner-gate audit parses it with a regex', () => {
  // admin-ia-overhaul-jul2026.test.js §3 matches `{ key: '…' … }` and stops at the first `}`.
  // A nested children:[…] would make every item after it invisible to that audit.
  const nav = APP.slice(APP.indexOf('const NAV_ITEMS = ['), APP.indexOf('const NAV_BY_KEY'));
  assert.ok(!/children\s*:/.test(nav) && !/tabs\s*:\s*\[/.test(nav),
    'NAV_ITEMS gained a nested array/object. Keep it flat: the owner-gate audit walks it ' +
    'with a regex that stops at the first `}`, so a nested literal silently hides every ' +
    'entry after it and reopens the direct-hash hole. `hubTabs` is a flat STRING for this reason.');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — ERR-208: an address change below the route
// ─────────────────────────────────────────────────────────────────────────────

test('§8 the router acts on a query-only hash change', () => {
  assert.match(APP, /function getRouteDetailFromHash\s*\(/,
    'getRouteDetailFromHash() is missing — getRouteFromHash() throws the ?tab= away, so ' +
    'something has to read the other half.');
  assert.match(APP, /_currentPage\?\.onRouteChange\?\.\(detail\)/,
    'The hashchange handler must notify the current page when the ROUTE matched but the ' +
    'address changed. Without this branch a sidebar link to #analytics?tab=traffic does ' +
    'nothing at all while you are already on #analytics (ERR-208).');
  assert.match(APP, /if \(newRoute !== _currentPageName\) \{\s*navigate\(newRoute\);\s*return;/,
    'The route-changed path must return, so a real navigation does not also fire onRouteChange.');
});

test('§8b the hub answers onRouteChange, and announces switches back', () => {
  assert.match(HUB, /onRouteChange\(\{ tab \} = \{\}\)/,
    'pages/analytics.js must export onRouteChange — that is how a sidebar sub-link reaches it.');
  assert.match(HUB, /new CustomEvent\('admin:tab-change'/,
    'The hub must announce a tab switch. writeTabToHash uses history.replaceState (so tab ' +
    'switches do not stack back-button entries), which fires NO hashchange — without the ' +
    'event the sidebar never learns about a tab clicked inside the page.');
  assert.match(APP, /window\.addEventListener\('admin:tab-change'/,
    'app.js must listen for it. A DOM event rather than a call because app.js is evaluated ' +
    'as two module instances (see __ADMIN_BOOTED__) and page modules import the one that ' +
    'does not own the sidebar.');
  assert.match(HUB, /function switchTab\(tabId\)/,
    'One switchTab() for both entry points — the in-page bar and onRouteChange — so they ' +
    'cannot diverge in what they tear down.');
  assert.match(HUB, /if \(tabId === _activeTab\) \{ announceTab\(\); return false; \}/,
    'switchTab must no-op when the tab already matches. That is what stops ' +
    'hashchange -> onRouteChange -> switchTab -> announce from looping.');
});

test('§8c a bare #analytics still tells the sidebar which tab resolved', () => {
  assert.match(HUB, /await loadAnalytics\(\);[\s\S]{0,120}announceTab\(\);/,
    'init() must announce after it resolves the tab: #analytics with no ?tab= falls back to ' +
    'a default only the hub knows, and until it says so the sidebar cannot highlight a row.');
  assert.match(HUB, /if \(!tab\) \{ announceTab\(\); return; \}/,
    'onRouteChange with NO tab (a bare #analytics reached while already on the hub) must ' +
    're-announce, not return silently. The hub keeps the panel it is showing, so if it says ' +
    'nothing the sidebar falls back to marking the parent row while a named tab is still on ' +
    'screen — the address, the title and the highlight all disagreeing with the page.');
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 — CSS, including the two states that do not fall out for free
// ─────────────────────────────────────────────────────────────────────────────

test('§9 the group styles exist', () => {
  for (const sel of ['.admin-nav-group__toggle', '.admin-nav-group__chevron',
                     '.admin-nav-group__items', '.admin-nav-item--sub']) {
    assert.ok(CSS.includes(sel), `admin.css is missing ${sel}.`);
  }
  assert.match(CSS, /\.admin-nav-group\.is-collapsed \.admin-nav-group__items \{ display: none; \}/,
    'Collapsing a group must actually hide its items.');
  assert.match(CSS, /\[aria-expanded="false"\] \.admin-nav-group__chevron \{ transform: rotate\(-90deg\); \}/,
    'The chevron must follow aria-expanded, so the state has a visual as well as an ARIA form.');
});

test('§9b the 60px rail is never left with items folded behind a hidden header', () => {
  assert.match(CSS, /\.admin-sidebar--collapsed \.admin-nav-group\.is-collapsed \.admin-nav-group__items \{ display: block; \}/,
    'In the 60px rail the group headers are hidden, so a collapsed group would be rows that ' +
    'vanished with no control left to bring them back. The rail must show every group\'s items.');
  assert.match(CSS, /\.admin-sidebar--collapsed \.admin-nav-group__toggle,\s*\n\.admin-sidebar--collapsed \.admin-nav-item--sub \{ display: none; \}/,
    'The rail must hide the toggles and the sub-rows — seven rows sharing one icon, with ' +
    'their labels hidden, are indistinguishable at 60px.');
});

test('§9c the mobile drawer gets the groups back', () => {
  // The sidebar's own <=768px block — NOT lastIndexOf, which lands in a page's styles
  // thousands of lines later.
  const anchor = CSS.indexOf('.admin-sidebar--collapsed { width: 280px; }');
  assert.ok(anchor !== -1, 'Positive control: the mobile un-collapse rule moved — this slice ' +
    'no longer points at the sidebar block and the assertions below would pass vacuously.');
  const mq = CSS.slice(anchor, CSS.indexOf('}', CSS.indexOf('.admin-nav-group__items { padding: 0 8px; }', anchor)));
  assert.match(mq, /\.admin-sidebar--collapsed \.admin-nav-group__toggle \{ display: flex; \}/,
    'Below 768px the sidebar is a 280px drawer with full labels, so the headers come back. ' +
    'The shared hide-list uses `display: revert`, which would make a <button> inline-block, ' +
    'not flex — the toggle has to restate it.');
  assert.match(mq, /\.admin-sidebar--collapsed \.admin-nav-item--sub \{ display: flex; padding-left: 40px; \}/,
    'The drawer also restates the sub-row indent: `.admin-sidebar--collapsed .admin-nav-item` ' +
    'wins on specificity there and would flatten it.');
});

test('§9d every var() the new rules use is a token this file defines', () => {
  // ERR-205: a var() naming an undefined token fails SILENTLY. Positive control below.
  const start = CSS.indexOf('/* ---- Collapsible sidebar groups');
  const end = CSS.indexOf('.admin-sidebar__footer {', start);
  assert.ok(start !== -1 && end > start,
    'Positive control: the sidebar-group CSS block could not be located, so the token check ' +
    'below would have run over the wrong text (or the whole file).');
  const block = CSS.slice(start, end);
  const used = new Set([...block.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]));
  assert.ok(used.size > 0, 'Positive control: the new block should use tokens at all — if this ' +
    'fires, the slice missed the block and the check below was passing vacuously.');
  for (const token of used) {
    assert.ok(new RegExp(`^\\s*${token}:`, 'm').test(CSS),
      `admin.css uses ${token} in the sidebar-group rules but never defines it. An undefined ` +
      'token is not an error — the property is simply dropped, and the rule looks written.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §10 — group state
// ─────────────────────────────────────────────────────────────────────────────

test('§10 collapsed groups persist, and only explicit toggles are recorded', () => {
  assert.match(APP, /const NAV_GROUPS_KEY = 'admin_nav_groups';/,
    'Group state needs a stable localStorage key.');
  assert.match(APP, /function readCollapsedGroups\(\)[\s\S]{0,400}catch \{/,
    'Reading the stored state must be wrapped: localStorage throws outright in some ' +
    'contexts, and a corrupted value must not take the whole sidebar down with it.');
  assert.ok(/We persist ONLY the ids the operator explicitly collapsed/.test(APP),
    'Store the COLLAPSED set, not the expanded one, so a section added in a later release ' +
    'defaults to open instead of inheriting a preference recorded before it existed.');
  const expand = APP.slice(APP.indexOf('function expandGroupFor'));
  assert.ok(!/writeCollapsedGroups/.test(expand.slice(0, 400)),
    'expandGroupFor() writes to storage. Auto-expanding to show you where you are must not ' +
    'silently overwrite a section you chose to keep shut — the stored set records explicit ' +
    'toggles only.');
});

test('§10b the active row is resolved once, for both kinds of row', () => {
  assert.match(APP, /function setActiveNav\(route, tab\)/,
    'setActiveNav() is the single place the sidebar highlight is decided — navigate(), the ' +
    'query-only hashchange branch and the admin:tab-change listener all call it.');
  assert.ok(!/document\.querySelectorAll\('\.admin-nav-item'\)\.forEach\(el => \{\s*el\.classList\.toggle\('active', el\.dataset\.nav === pageName\);/.test(APP),
    'navigate() still sets the highlight inline. With sub-links that rule marks the parent ' +
    'AND is blind to which tab is showing.');
  assert.match(APP, /el\.classList\.toggle\('is-current-hub'/,
    'The parent of an active sub-link needs its own quieter marker, or the trail loses its ' +
    'middle step.');
});
