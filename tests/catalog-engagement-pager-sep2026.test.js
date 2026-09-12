/**
 * catalog-engagement-pager-sep2026.test.js — ERR-251
 * ==================================================
 *
 * THE FOUR DECOYS BECAME REAL, AND A STALE "DECOY" LIST IS WORSE THAN NO LIST.
 *
 * On 2026-09-03 `product_type`, `sort`, `offset` and `search` were accepted by
 * the endpoint's validator and then dropped by `stripUnknown`, so
 * `/api/admin/analytics/catalog/products` answered page one with a 200 however
 * you paged it. This page therefore shipped with NO pager and a caption that
 * said so in as many words — the right call, because a Next button that
 * silently re-serves page one is the ERR-151 decoy failure built into our own
 * UI.
 *
 * The backend's migration 170 made all four reach SQL. Re-measured here on
 * 2026-09-12 with a real owner JWT BEFORE a single control was drawn, because
 * this author's DATA has been reliable and their RENDERING ADVICE has not
 * (ERR-204) — so the payload gets measured, never the note:
 *
 *   ?limit=5                       first CLC37BK,  total 518, has_more true
 *   ?limit=5&offset=5              first C804XLBK  ← a DIFFERENT page
 *   ?sort=views                    meta.ranked_by "views"
 *   ?sort=revenue                  first GTN237KCMY, ranked_by "revenue"
 *   ?sort=bogus                    400 VALIDATION_FAILED
 *   ?search=TN2                    total 518 → 34
 *   ?product_type=toner_cartridge  total 518 → 113
 *   ?product_type=toner            400, listing the 17 accepted values
 *
 * The `total` moving with the filter is the load-bearing one: it confirms
 * filters apply BEFORE ranking, so the pager divides by the filtered count and
 * a paged walk can neither repeat nor skip a row.
 *
 * §1 the vocabulary moved, and the old name is GONE rather than emptied
 * §2 the type menu is an INTERSECTION, not a copy of either side
 * §3 `has_more` comes from the backend, never from rows.length === limit
 * §4 every filter change returns to page one
 * §5 the brands panel gets no pager, because its endpoint echoes none
 * §6 positive controls
 *
 * Run: node --test tests/catalog-engagement-pager-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, 'inkcartridges', rel), 'utf8');

// ONE owner for comment stripping (a peer's ERR-253). Assertions about what the
// code DOES must never read prose — this file's own header quotes the constant
// it asserts is gone, and a naive substring search fails on the explanation.
const stripComments = require('./helpers/strip-comments');

const UTIL_SRC = READ('js/admin/utils/catalog-engagement.js');
const PAGE_SRC = READ('js/admin/pages/catalog-engagement.js');
const API_SRC = READ('js/admin/api.js');
const CSS_SRC = READ('css/admin.css');

// ── §1 the vocabulary moved ────────────────────────────────────────────────

test('§1 all four former decoys are in REAL_PRODUCT_FILTERS', () => {
  const m = UTIL_SRC.match(/export const REAL_PRODUCT_FILTERS = \[([\s\S]*?)\]/);
  assert.ok(m, 'REAL_PRODUCT_FILTERS must be exported');
  for (const f of ['product_type', 'sort', 'offset', 'search']) {
    assert.ok(m[1].includes(`'${f}'`), `${f} reaches SQL now — it must be listed as real`);
  }
  // The six that were always real must still be there: this is an addition, not
  // a replacement, and dropping one would silently stop the page sending it.
  for (const f of ['from', 'to', 'source', 'brand_id', 'limit', 'include_offshore_bounces']) {
    assert.ok(m[1].includes(`'${f}'`), `${f} must survive the edit`);
  }
});

test('§1 DECOY_PRODUCT_FILTERS is DELETED, not emptied', () => {
  // A name that says "these are ignored" is an instruction to the next reader.
  // Leaving it in place saying nothing is how someone re-derives the whole
  // question — or worse, trusts it and removes a control that now works.
  //
  // Asserted against CODE, not prose: the explanation of what was removed has
  // to keep naming it, or the removal is unexplained.
  assert.ok(
    !/DECOY_PRODUCT_FILTERS/.test(stripComments(UTIL_SRC)),
    'the constant must be gone entirely, not left as an empty array'
  );
  assert.ok(
    !/DECOY_PRODUCT_FILTERS/.test(stripComments(PAGE_SRC)),
    'and nothing may still import it'
  );
  // Positive control on the stripper: the prose DOES still name it, so a
  // stripper that silently returned '' would make the two assertions above
  // vacuous. This is the check that keeps them honest.
  assert.match(UTIL_SRC, /DECOY_PRODUCT_FILTERS/,
    'the comment must still explain what was removed and why');
});

test('§1 the measurements that authorise this are written down', () => {
  // Without the numbers, the next person to read "these are real now" has only
  // a backend note to go on — and the note was wrong last time (ERR-204).
  assert.match(UTIL_SRC, /2026-09-12/, 'the re-measurement date must be recorded');
  assert.match(UTIL_SRC, /518/, 'the unfiltered total must be recorded');
  assert.match(UTIL_SRC, /before ranking/i, 'the filters-before-ranking property must be stated');
});

// ── §2 the type menu is an intersection ────────────────────────────────────

test('§2 the type menu is our vocabulary ∩ the endpoint, not a copy of either', () => {
  assert.match(PAGE_SRC, /CATALOG_TYPES_ACCEPTED[\s\S]{0,200}PRODUCT_TYPE_LABELS/,
    'TYPE_OPTIONS must be built from both lists');
  assert.match(PAGE_SRC, /from '\.\.\/utils\/product-types\.js'/,
    'the labels must come from the vocabulary OWNER, never a fresh hand-kept enum');
});

test('§2 universal_ribbon is accepted by the endpoint and must NOT be offered', () => {
  // Measured 2026-09-12: the endpoint accepts it and the live catalogue has
  // ZERO rows with it. Offering it would put an option in the menu that can
  // only ever return an empty leaderboard — which is ERR-163 exactly (`drum`
  // and `paper` sat in two admin menus for months matching nothing, and never
  // errored, because a filter value that is not a real type fails silently).
  assert.ok(
    UTIL_SRC.includes("'universal_ribbon'"),
    'it must stay in the ACCEPTED list — we still have to know the endpoint takes it'
  );
  const labels = READ('js/admin/utils/product-types.js');
  const m = labels.match(/export const PRODUCT_TYPE_LABELS = \{([\s\S]*?)\};/);
  assert.ok(m, 'PRODUCT_TYPE_LABELS must exist');
  assert.ok(
    !m[1].includes('universal_ribbon'),
    'and it must stay OUT of the label vocabulary, which is what filters it from the menu'
  );
});

// ── §3 has_more comes from the backend ─────────────────────────────────────

test('§3 readPager reports the BACKEND’s has_more, never rows.length === limit', () => {
  const fn = UTIL_SRC.slice(UTIL_SRC.indexOf('export function readPager('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /has\(meta, 'has_more'\)/, 'must read the reported field');
  assert.ok(
    !/rowCount\s*===\s*limit|length\s*===\s*limit/.test(body),
    'must NEVER infer has_more from a full page — that is wrong on the LAST full page '
    + 'and offers a Next button that lands on an empty table'
  );
});

test('§3 no echoed limit/offset means NO pager at all', () => {
  const fn = UTIL_SRC.slice(UTIL_SRC.indexOf('export function readPager('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /supported: false/, 'must be able to report "this endpoint has no pager"');
  assert.match(PAGE_SRC, /if \(!pager\.supported\) return '';/,
    'and the page must draw nothing in that case — an inferred pager over an endpoint '
    + 'that ignores offset is the decoy failure moved into our own UI');
});

// ── §4 every filter change returns to page one ─────────────────────────────

test('§4 resetPaging() exists and is called by EVERY control that narrows results', () => {
  assert.match(PAGE_SRC, /function resetPaging\(\)/, 'there must be one named reset');
  // Narrowing a result set while holding an offset leaves the operator past the
  // end of it, looking at an empty table that is not empty — and has_more:false
  // would disable the Next button that could rescue them.
  const calls = (PAGE_SRC.match(/resetPaging\(\);/g) || []).length;
  assert.ok(calls >= 4, `every filter path must reset paging; found ${calls} call sites`);
  // The change handler covers range/limit/brand/sort/type/search/bounces in one
  // place; the panel switch and the source pills are separate paths.
  const changeFn = PAGE_SRC.slice(PAGE_SRC.indexOf('function onContainerChange('));
  assert.match(changeFn.slice(0, changeFn.indexOf('\n}')), /resetPaging\(\);/,
    'the shared change handler must reset');
  assert.match(PAGE_SRC, /_source = pill\.dataset\.value;\s*\n\s*resetPaging\(\);/,
    'the source pills must reset');
});

test('§4 the pager steps by the CURRENT limit and never goes below zero', () => {
  assert.match(PAGE_SRC, /_offset = Math\.max\(0, _offset \+ step \* Number\(_limit \|\| 0\)\)/,
    'Previous from page one must clamp at 0, not send a negative offset');
});

test('§4 offset is omitted on page one, to keep the default URL stable', () => {
  // The same reasoning as include_offshore_bounces: page one shares one cache
  // key with itself, and this section runs on a measured 20-requests-per-minute
  // budget.
  assert.match(PAGE_SRC, /if \(_panel === 'products' && _offset > 0\) opts\.offset = _offset;/);
  assert.match(PAGE_SRC, /if \(_sort && _sort !== 'engagement'\) opts\.sort = _sort;/,
    'the default sort must be omitted for the same reason');
});

test('§4 the search box is debounced', () => {
  // Undebounced, a search field would spend the whole 20/min budget in about two
  // seconds of typing and then show a rate-limit countdown instead of results.
  assert.match(PAGE_SRC, /function onContainerInput\(/, 'typing needs its own handler');
  assert.match(PAGE_SRC, /_searchTimer = setTimeout\(/, 'it must debounce');
  assert.match(PAGE_SRC, /clearTimeout\(_searchTimer\)/, 'and cancel the pending one');
  assert.match(PAGE_SRC, /live\.focus\(\)/,
    'paint() replaces the controls, so focus must be restored or the field is unusable');
});

// ── §5 the brands panel gets no pager ──────────────────────────────────────

test('§5 brands is passed a null meta, so it can never draw a pager', () => {
  // Its endpoint echoes no limit/offset. A control drawn for one panel and not
  // the other is less confusing than one that silently does nothing on the
  // second — which is the entire lesson of this page.
  assert.match(PAGE_SRC, /_panel === 'products' \? readPager\(meta, rows\.length\) : readPager\(null, rows\.length\)/);
  // And the four product-only controls must be gated on the panel.
  for (const ctl of ['sortCtl', 'typeCtl', 'searchCtl']) {
    const re = new RegExp(`const ${ctl} = _panel === 'products' \\?`);
    assert.match(PAGE_SRC, re, `${ctl} must be products-only`);
  }
});

test('§5 the old honest caption survives for the panel that still needs it', () => {
  assert.match(PAGE_SRC, /this panel has no next page/,
    'brands still has no pager, and must still say so rather than going quiet');
  assert.match(PAGE_SRC, /!pager\.supported && count\.truncated/,
    'and that caption must appear ONLY where there is genuinely no pager');
});

// ── §6 positive controls ───────────────────────────────────────────────────

test('§6 positive control — the sources were really read', () => {
  assert.ok(UTIL_SRC.length > 8000, `utils is suspiciously short (${UTIL_SRC.length})`);
  assert.ok(PAGE_SRC.length > 15000, `page is suspiciously short (${PAGE_SRC.length})`);
  assert.match(PAGE_SRC, /function paint\(/, 'the function under test must exist');
});

test('§6 positive control — the pager markup is actually styled', () => {
  // A class the page emits and the stylesheet has never heard of renders as an
  // unstyled row of buttons. This is the ERR-237 entanglement in miniature: the
  // markup and the rule that makes it legible live in two files, and the suite
  // was green with the defect in it because no test asserted the pairing.
  for (const cls of ['ce-pager', 'ce-pager__page', 'ce-filter--search']) {
    assert.ok(PAGE_SRC.includes(cls) || CSS_SRC.includes(cls), `${cls} must exist somewhere`);
    assert.ok(CSS_SRC.includes(`.${cls}`), `.${cls} must be styled in admin.css`);
  }
});

test('§6 positive control — admin.css uses only variables it defines', () => {
  const defined = new Set([...CSS_SRC.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
  const block = CSS_SRC.slice(CSS_SRC.indexOf('Catalogue Engagement pager + search'));
  const used = [...block.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
  assert.ok(used.length > 0, 'the block must actually use a token, or this control proves nothing');
  for (const v of used) {
    assert.ok(defined.has(v), `${v} is used but never defined in admin.css`);
  }
});
