/**
 * The invoice type sizes — and the sign-off that was the smallest text on the page
 * ================================================================================
 *
 * The owner read a real emailed invoice and could barely make out the one line
 * addressed to the customer: "Thank you very much for your business and for
 * checking out InkCartridges.co.nz." It was set at 10 pt bold under a body of
 * 11 pt — the SMALLEST text on a document whose every other line is bigger.
 *
 * We own that document outright. `buildInvoiceDoc()` renders it with jsPDF and
 * `syncStoredPdf()` uploads those exact bytes (POST /api/admin/invoices/:id/pdf),
 * so the file the customer receives, the file /business serves and the file the
 * Download button produces are one file. There is no backend template to blame.
 *
 * WHAT THIS FILE PINS, AND WHY IT PINS SHAPES RATHER THAN NUMBERS
 * ---------------------------------------------------------------
 * Asserting "the thank-you is 12.5 pt" would just restate the source in a second
 * place and fail every time someone nudges the layout. What must not come back is
 * the DEFECT: a sign-off smaller than the text it sits under, and a payment block
 * that can fall off the bottom of the page. So:
 *
 *   1. The thank-you line is never smaller than the items-table body.
 *   2. Nothing in the document drops below a legibility floor.
 *   3. The HTML preview's base size stays in step with the PDF's body size —
 *      the operator approves the preview and the customer receives the PDF, so
 *      the two drifting apart is how a document ships looking unlike its proof.
 *   4. The totals and payment blocks reserve their height before drawing, and the
 *      doc re-anchors to the last page after autoTable paginates.
 *
 * Test 5 is a POSITIVE CONTROL: the same assertion run against a deliberately
 * broken source must FAIL. Without it this file could pass by measuring nothing —
 * a regex that stops matching is silently green (ERR-181's lesson, one page over).
 *
 * Run with: node --test tests/admin-invoice-font-size-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INVOICES = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'invoices.js');
const ADMIN_CSS = path.resolve(__dirname, '..', 'inkcartridges', 'css', 'admin.css');
const src = fs.readFileSync(INVOICES, 'utf8');
const css = fs.readFileSync(ADMIN_CSS, 'utf8');

// Same brace-matcher as tests/admin-invoice-cost-not-on-document.test.js — this repo
// deliberately carries no parser dependency, and it only has to handle this one file.
function functionBody(source, name) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.notEqual(start, -1, `${name}() not found in invoices.js — did it get renamed?`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  assert.fail(`unbalanced braces while scanning ${name}()`);
}

// --- The two measurements the defect was about -----------------------------------

/** Size of the sign-off, read off the branch that actually draws it. */
function thankYouSize(body) {
  // The line is drawn inside the `if (thanksLines.length)` / `if (d.footer.thankYou)`
  // guard — matching the guard rather than the whole file is what keeps this pointed
  // at the sign-off and not at some other 12.5 elsewhere in the function.
  const guard = body.match(/if\s*\((?:thanksLines\.length|d\.footer\.thankYou)\)\s*\{[^}]*\}/);
  assert.ok(guard, 'could not find the thank-you branch in buildInvoiceDoc() — if the ' +
    'sign-off moved, point this test at its new home rather than deleting it.');
  const size = guard[0].match(/setFontSize\(([\d.]+)\)/);
  assert.ok(size, 'the thank-you branch sets no font size; it now inherits whatever ran ' +
    'before it, which is exactly how it drifted small the first time.');
  return parseFloat(size[1]);
}

/** Size of the items-table body — the document's baseline "body text". */
function itemsBodySize(body) {
  const styles = body.match(/styles:\s*\{[^}]*fontSize:\s*([\d.]+)/);
  assert.ok(styles, 'could not read the autoTable body fontSize in buildInvoiceDoc()');
  return parseFloat(styles[1]);
}

test('the sign-off is never smaller than the invoice body text', () => {
  const body = functionBody(src, 'buildInvoiceDoc');
  const thanks = thankYouSize(body);
  const items = itemsBodySize(body);
  assert.ok(thanks >= items,
    `the thank-you line is ${thanks} pt against a ${items} pt body. That is the original ` +
    'defect: the one sentence written TO the customer, set smaller than everything above ' +
    'it. Whatever the body size becomes, the sign-off matches or exceeds it.');
});

test('nothing on the invoice drops below the legibility floor', () => {
  // 9 pt was the old floor for the small-caps FROM/BILL TO labels; below that a
  // printed A4 invoice stops being comfortably readable, which is what started this.
  const FLOOR = 10;
  const body = functionBody(src, 'buildInvoiceDoc');
  const sizes = [...body.matchAll(/setFontSize\(([\d.]+)\)/g)].map((m) => parseFloat(m[1]));
  assert.ok(sizes.length >= 8, `only found ${sizes.length} explicit sizes in buildInvoiceDoc() — ` +
    'this test has probably stopped measuring the thing it was written for.');
  const tooSmall = sizes.filter((s) => s < FLOOR);
  assert.deepEqual(tooSmall, [],
    `these sizes are below the ${FLOOR} pt floor: ${tooSmall.join(', ')}. The autoTable ` +
    `head size is checked separately.`);
  const head = body.match(/headStyles:\s*\{[^}]*fontSize:\s*([\d.]+)/);
  assert.ok(head && parseFloat(head[1]) >= FLOOR,
    `the items-table header is ${head && head[1]} pt, below the ${FLOOR} pt floor.`);
});

test('the HTML preview stays in step with the PDF it is a proof of', () => {
  // The operator approves the on-screen preview; the customer receives the PDF. If
  // the two sizes drift, the proof stops predicting the document. CSS px against
  // PDF pt is 96/72 = 1.333 at nominal scale; the preview sits a shade tighter to
  // fit the drawer, so allow a band rather than an exact ratio.
  const previewBlock = css.slice(css.indexOf('.inv-doc {'));
  const base = previewBlock.match(/font-size:\s*([\d.]+)px/);
  assert.ok(base, 'could not read the .inv-doc base font-size from admin.css');
  const previewPx = parseFloat(base[1]);
  const pdfPt = itemsBodySize(functionBody(src, 'buildInvoiceDoc'));
  const ratio = previewPx / pdfPt;
  assert.ok(ratio >= 1.15 && ratio <= 1.40,
    `.inv-doc is ${previewPx}px against a ${pdfPt}pt PDF body (ratio ${ratio.toFixed(2)}). ` +
    'One of the two was resized without the other — raise or lower them together.');
});

test('the preview sign-off matches the preview body, as it does in the PDF', () => {
  const previewBlock = css.slice(css.indexOf('.inv-doc {'));
  const base = parseFloat(previewBlock.match(/font-size:\s*([\d.]+)px/)[1]);
  const thanks = previewBlock.match(/\.inv-doc__thanks\s*\{[^}]*font-size:\s*([\d.]+)px/);
  assert.ok(thanks, 'could not read .inv-doc__thanks font-size from admin.css');
  assert.ok(parseFloat(thanks[1]) >= base,
    `.inv-doc__thanks is ${thanks[1]}px against a ${base}px body — the same defect the PDF ` +
    'had, on the surface the operator signs off from.');
});

test('the totals and payment blocks cannot fall off the bottom of the page', () => {
  // buildInvoiceDoc walked an unbounded y-cursor and never re-anchored after
  // autoTable paginated, so on a long invoice the bank details silently vanished or
  // landed on page 1 under the table. js/order-receipt.js:27-37 documents both.
  const body = functionBody(src, 'buildInvoiceDoc');
  assert.match(body, /doc\.setPage\(doc\.internal\.getNumberOfPages\(\)\)/,
    'buildInvoiceDoc() reads lastAutoTable.finalY without re-anchoring to the last page. ' +
    'A two-page items table will get its totals drawn on page 1, underneath the table.');
  assert.match(body, /const\s+ensure\s*=\s*\(/,
    'buildInvoiceDoc() has no ensure() bound check — the totals and the "Please make ' +
    'payment to." block can be written past the bottom of A4 and vanish silently.');
  // Reserved in ONE call each, so neither block can straddle a break.
  const reservations = [...body.matchAll(/\n\s*ensure\(/g)];
  assert.ok(reservations.length >= 2,
    `only ${reservations.length} ensure() reservation(s). The totals stack and the payment ` +
    'block each need one, or a page break can part the Total from its figures — or the ' +
    'account number from the words telling the customer to pay it.');
});

test('POSITIVE CONTROL — a sign-off set smaller than the body must fail this file', () => {
  // Without this, every assertion above could pass by matching nothing at all.
  const broken = `
    function buildInvoiceDoc(d) {
      doc.autoTable({ styles: { font: 'times', fontSize: 12.5, cellPadding: 4 } });
      if (thanksLines.length) { doc.setFont('times', 'bold'); doc.setFontSize(10); doc.text(x); }
    }`;
  const body = functionBody(broken, 'buildInvoiceDoc');
  assert.equal(thankYouSize(body), 10, 'the control fixture stopped being measured');
  assert.equal(itemsBodySize(body), 12.5, 'the control fixture stopped being measured');
  assert.ok(!(thankYouSize(body) >= itemsBodySize(body)),
    'the deliberately-broken fixture passed the sign-off check — the check is not checking.');
});
