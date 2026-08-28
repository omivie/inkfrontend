/**
 * Line-item focus survives a quote reply — August 2026 (ERR-179)
 * =============================================================
 *
 * Typing a product code in the New Invoice editor kicked the operator out of the
 * box: the caret vanished, the product dropdown went with it, and it read as the
 * screen refreshing itself. Nothing was refreshing. There is no interval, no
 * poller and no focus listener on that page — what fired was the quote:
 *
 *     keystroke  →  scheduleQuote()  →  400ms  →  POST /invoices/quote
 *                →  applyQuote()     →  renderLines()
 *                →  host.innerHTML = ...   ← the focused <input> is destroyed
 *
 * Every keystroke re-armed it, so the grid was rebuilt roughly half a second
 * after each pause, mid-word. The `else` branch made it worse: the reply
 * re-rendered even when NOTHING about the lines had changed, purely to repaint a
 * badge.
 *
 * THE RULE, and it is not new — the Orders profit column already had it: an
 * async reply patches cells, it does not re-render the container the operator is
 * standing in. Here that is safe because of how narrow a quote is (see
 * applyQuoteToLines): it never adds, removes or reorders a row, and never touches
 * code, description, qty, supplierCost, costSource or kind. Price and badge are
 * the whole surface, and both are cells.
 *
 * TWO GUARDS carry the fix, and both are asserted below because both are the kind
 * that quietly stops being true:
 *
 *   1. NEVER WRITE THE BOX UNDER THE CARET — `document.activeElement`, the same
 *      rule js/cart.js:2312 applies to the cart quantity field. It covers the
 *      price cell and the freight box, both of which an async reply writes.
 *   2. A COUNT MISMATCH IS NOT PATCHABLE — say so by returning false and let the
 *      caller do the full render. A patch that silently covers half a grid would
 *      describe the wrong lines, which is the fail-soft shape this codebase keeps
 *      paying for. A skip is not a pass.
 *
 * The second half is a LEAK. Autocomplete menus are portalled to <body>
 * (ERR-107), so they do not die with the row that owned their input — only
 * destroy() removes them, `blur` never fires for a node removed from the DOM, and
 * invoices.js kept no handles at all. Every rebuild stranded two menus per line,
 * one of which could still be open and unclosable. The registers must be SPLIT:
 * line handles die with the grid, top-level pickers live with the drawer, and one
 * shared list is why Quick Order (which did keep handles) still never drained.
 *
 * Source-level assertions — these are browser ES modules with no jsdom in the
 * repo — matching tests/admin-autocomplete-portal-jul2026.test.js.
 *
 * Run: node --test tests/admin-invoice-line-focus-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const INVOICES = stripComments(read('inkcartridges/js/admin/pages/invoices.js'));
const QUICKORDER = stripComments(read('inkcartridges/js/admin/pages/quick-order.js'));
const PATCH = stripComments(read('inkcartridges/js/admin/utils/line-row-patch.js'));

/**
 * Body of `function name(...) { ... }`, brace-matched.
 *
 * The parameter list has to be walked past before hunting for the opening brace:
 * `patchQuotedLineRows(host, lines, { noteHtml } = {})` destructures, so the
 * first `{` after the name belongs to the signature, not the body.
 */
function fnBody(src, name) {
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.notEqual(start, -1, `${name}() not found`);
  let i = src.indexOf('(', start);
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')' && --parens === 0) { i++; break; }
  }
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

// The two editors that render the `.inv-line` grid and fold a quote into it.
// When a capability is opt-in per surface the enrolment list belongs in a test —
// this one went missing twice before (ERR-150, ERR-160).
const EDITORS = [
  { name: 'invoices.js', src: INVOICES, host: '#inv-lines', quoteFn: 'applyQuote' },
  { name: 'quick-order.js', src: QUICKORDER, host: '#qo-lines', quoteFn: 'requestQuote' },
];

// =========================================================================
//  1. The quote reply must not rebuild the grid
// =========================================================================

test('every line-grid editor is enrolled in the patch path', () => {
  for (const { name, src } of EDITORS) {
    assert.match(src, /import \{ patchQuotedLineRows \} from '\.\.\/utils\/line-row-patch\.js'/,
      `${name} must import patchQuotedLineRows`);
  }
});

for (const { name, src, host, quoteFn } of EDITORS) {
  test(`${name}: the quote reply patches cells, it does not re-render the grid`, () => {
    const body = fnBody(src, quoteFn);
    assert.match(body, /patchQuotedLineRows\(/,
      `${quoteFn}() must fold the quote in by patching`);
    assert.match(body, new RegExp(host.replace('#', '#')),
      `${quoteFn}() must resolve the grid host ${host}`);
  });

  test(`${name}: the only renderLines() left on the quote path is the mismatch fallback`, () => {
    const body = fnBody(src, quoteFn);
    const calls = body.match(/renderLines\(\)/g) || [];
    assert.ok(calls.length <= 1,
      `${quoteFn}() calls renderLines() ${calls.length}x — an async reply may only ` +
      'rebuild the grid as the row-count fallback');
    if (calls.length === 1) {
      assert.match(body, /(!patchQuotedLineRows\([\s\S]*?\)\)\s*renderLines\(\))|(!patched\)\s*renderLines\(\))/,
        `${quoteFn}()'s renderLines() must be guarded by a failed patch, nothing else`);
    }
  });
}

test('invoices.js: the unconditional "badge may have changed" re-render is gone', () => {
  assert.doesNotMatch(fnBody(INVOICES, 'applyQuote'), /else\s*\{\s*renderLines\(\)/,
    'the else branch rebuilt the whole grid to repaint a badge — that was the bug');
});

// =========================================================================
//  2. The patch helper's two guards
// =========================================================================

test('patchQuotedLineRows never writes .value into the focused element', () => {
  assert.match(PATCH, /document\.activeElement/,
    'the helper must know what has focus');
  const body = fnBody(PATCH, 'patchQuotedLineRows');
  assert.match(body, /if\s*\(price\s*!==\s*active\)\s*price\.value\s*=/,
    'the price write must be gated on the element not being the active one');
});

test('patchQuotedLineRows reports a row-count mismatch instead of half-patching', () => {
  const body = fnBody(PATCH, 'patchQuotedLineRows');
  assert.match(body, /rows\.length\s*!==\s*src\.length[\s\S]{0,40}return false/,
    'a DOM/draft disagreement must return false, not patch what it can');
  assert.match(body, /return true/, 'a successful patch must be distinguishable');
});

test('patchQuotedLineRows handles all three note-strip transitions', () => {
  const body = fnBody(PATCH, 'patchQuotedLineRows');
  assert.match(body, /existing\?\.remove\(\)/, 'note removed when there is nothing to say');
  assert.match(body, /existing\.outerHTML\s*=/, 'note replaced when it changed');
  assert.match(body, /insertAdjacentHTML\('beforeend'/, 'note inserted when it is new');
});

test('patchQuotedLineRows reads the price through linePrice, not a hardcoded field', () => {
  // Invoices calls it unitCost, Quick Order unitPrice. One function serves both
  // only because invoice-quote.js already owns that pair.
  assert.match(PATCH, /import \{[^}]*linePrice[^}]*\} from '\.\/invoice-quote\.js'/);
  assert.match(PATCH, /data-lfield="unitCost"[\s\S]{0,40}data-lfield="unitPrice"/,
    'the price cell selector must match both editors');
});

// =========================================================================
//  3. Portalled dropdowns must not be stranded in <body>
// =========================================================================

for (const { name, src } of EDITORS) {
  test(`${name}: renderLines() destroys the outgoing handles BEFORE wiping the grid`, () => {
    const body = fnBody(src, 'renderLines');
    const drain = body.indexOf('destroyHandles(_acLineHandles)');
    const wipe = body.indexOf('host.innerHTML');
    assert.notEqual(drain, -1, `${name}: renderLines() must drain the line handles`);
    assert.notEqual(wipe, -1);
    assert.ok(drain < wipe,
      `${name}: the drain must precede the innerHTML wipe — after it, the inputs ` +
      'are already gone and their <body> menus are unreachable');
  });

  test(`${name}: line handles and top-level picker handles are separate registers`, () => {
    assert.match(src, /_acLineHandles\s*=\s*\[\]/, `${name} needs a line register`);
    assert.match(src, /_acTopHandles\s*=\s*\[\]/, `${name} needs a top-level register`);
    // The whole point of the split: draining on every re-render must not take the
    // party / order picker down with it.
    assert.doesNotMatch(fnBody(src, 'renderLines'), /destroyHandles\(_acTopHandles\)/,
      `${name}: renderLines() must never drain the top-level pickers`);
  });

  test(`${name}: every attached handle is captured, none discarded`, () => {
    assert.doesNotMatch(src, /^\s*attachProductAutocomplete\(/m,
      `${name}: a bare attachProductAutocomplete() call throws its handle away`);
  });
}

test('invoices.js: closing the drawer tears the portalled menus down', () => {
  assert.match(INVOICES, /onClose:[^\n]*teardownAutocompletes\(\)/,
    'the menus are <body> children — the drawer closing does not remove them');
  const teardown = fnBody(INVOICES, 'teardownAutocompletes');
  assert.match(teardown, /destroyHandles\(_acLineHandles\)/);
  assert.match(teardown, /destroyHandles\(_acTopHandles\)/);
});

test('invoices.js: rebuildEditor() drains before swapping the body out', () => {
  const body = fnBody(INVOICES, 'rebuildEditor');
  const drain = body.indexOf('destroyHandles(_acLineHandles)');
  const swap = body.indexOf('setBody(');
  assert.ok(drain !== -1 && drain < swap,
    'setBody() drops the inputs; their menus must go first');
});

// =========================================================================
//  4. The other two async writers into focused fields
// =========================================================================

test('setFreightValue writes the draft always, the box only when unfocused', () => {
  const body = fnBody(INVOICES, 'setFreightValue');
  assert.match(body, /_draft\.freight\s*=/,
    'the durable record is written unconditionally');
  assert.match(body, /input\s*!==\s*document\.activeElement/,
    'an async courier autofill must not rewrite the number mid-keystroke');
});

test('renderShippingRow defers rather than rebuilding the courier select in use', () => {
  const body = fnBody(INVOICES, 'renderShippingRow');
  assert.match(body, /\[data-freight-option\][\s\S]{0,80}_shippingRowDirty\s*=\s*true[\s\S]{0,20}return/,
    'a quote landing while the select has focus must postpone, not yank');
  // Guarded on the select ALONE — the "apply free shipping" button is in this
  // same host and has to repaint the instant it is clicked.
  assert.doesNotMatch(body, /host\.contains\(document\.activeElement\)/,
    'deferring on the whole row would freeze the apply-free-shipping button');
});

test('the deferred shipping row is actually paid off — a skip is not a pass', () => {
  assert.match(INVOICES, /form\.addEventListener\('focusout', onFormFocusOut\)/,
    'something must pay off _shippingRowDirty');
  const body = fnBody(INVOICES, 'onFormFocusOut');
  assert.match(body, /_shippingRowDirty/);
  assert.match(body, /renderShippingRow\(\)/,
    'focusout must run the render that was postponed');
  assert.match(INVOICES, /_shippingRowDirty\s*=\s*false;\s*\n?\s*\}/,
    'resetQuoteState must clear the flag so it cannot survive into the next editor');
});

// =========================================================================
//  5. The preview repaint is coalesced, and cancelled on close
// =========================================================================

test('refreshPreview coalesces to one paint per frame', () => {
  const body = fnBody(INVOICES, 'refreshPreview');
  assert.match(body, /requestAnimationFrame/,
    'it ran on every keystroke and rebuilt the whole invoice document each time');
  assert.match(body, /_previewFrame\s*!=\s*null[\s\S]{0,20}return/,
    'a frame already pending must not queue a second');
});

test('a pending preview frame cannot paint into a torn-down drawer', () => {
  assert.match(INVOICES, /onClose:[^\n]*cancelPreviewFrame\(\)/,
    'ERR-045: async work must not outlive the editor');
  assert.match(fnBody(INVOICES, 'paintPreview'), /if\s*\(!_editorRefs\s*\|\|\s*!_draft\)\s*return/,
    'and the frame itself must re-check, since cancel races the callback');
});

test('nothing reads #inv-preview back, so coalescing cannot break a caller', () => {
  const reads = INVOICES.match(/querySelector\('#inv-preview'\)/g) || [];
  assert.equal(reads.length, 1, 'the preview node is write-only paint');
});
