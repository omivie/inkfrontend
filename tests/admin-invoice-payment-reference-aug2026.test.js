/**
 * The payment block: the reference instruction, and the height it has to book
 * ===========================================================================
 *
 * Customers pay us by bank transfer. Until now the invoice told them WHERE to send
 * the money and nothing about what to put in the reference field, so payments
 * arrived that could not be matched back to an invoice. The document now prints
 * "Use Invoice number as Payment Reference" under the due date, and the stray full
 * stop after "Please make payment to" is a colon.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before it, NOTHING asserted a single string in this block — deleting "a/c Number"
 * outright passed every test in the repo. And the block is not a preview: the bytes
 * buildInvoiceDoc() produces are uploaded verbatim by syncStoredPdf(), so the emailed
 * attachment, the /business download and the admin Download button are one file
 * (ERR-189). A line that goes missing here goes missing at the customer.
 *
 * Two surfaces have to agree — the drawer preview the operator approves, and the PDF
 * the customer receives — so each is read separately. A line added to one only is a
 * document that ships looking unlike its proof.
 *
 * THE INVARIANT WORTH PINNING
 * ---------------------------
 * buildInvoiceDoc()'s vertical rhythm is hand-maintained: `payH` is a mirror, written
 * by hand, of the `py +=` chain that follows it, and it is what ensure() reserves
 * before drawing. Under-book it and the block runs off the foot of the page — which
 * is exactly how a 12-line invoice once reached a customer with no account number on
 * it (ERR-189). Adding this reference line is precisely the edit that breaks that
 * mirror, so test 4 recomputes it from the source rather than trusting the comment,
 * and test 5 is a POSITIVE CONTROL: the same check against a deliberately broken
 * fixture must FAIL, or a regex that quietly stops matching would leave this green.
 *
 * Run with: node --test tests/admin-invoice-payment-reference-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INVOICES = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'invoices.js');
const src = fs.readFileSync(INVOICES, 'utf8');

// Same brace-matcher as tests/admin-invoice-font-size-aug2026.test.js — this repo
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

const REFERENCE_LINE = 'Use Invoice number as Payment Reference';

// --- 1-3: the words on the page, on BOTH surfaces --------------------------------

const SURFACES = [
  ['the drawer preview', 'renderPreview'],
  ['the emailed PDF', 'buildInvoiceDoc'],
];

for (const [label, fn] of SURFACES) {
  test(`${label} prints the payment-reference instruction`, () => {
    const body = functionBody(src, fn);
    assert.ok(body.includes(REFERENCE_LINE),
      `${fn}() no longer prints "${REFERENCE_LINE}". Both surfaces must carry it: the ` +
      'operator approves the preview and the customer pays from the PDF, so dropping ' +
      'it from either is a payment that arrives with nothing to match it to.');
  });

  test(`${label} says "Please make payment to:" with a colon`, () => {
    const body = functionBody(src, fn);
    assert.ok(body.includes('Please make payment to:'),
      `${fn}() does not print "Please make payment to:".`);
    assert.ok(!body.includes('Please make payment to.'),
      `${fn}() still prints the full-stop form "Please make payment to." — the line ` +
      'introduces the account details below it, so it takes a colon.');
  });
}

test('the reference line is not conditioned on the due-date toggle', () => {
  // "Show payment due date" hides ONE line. The reference instruction is unconditional:
  // a payment with no reference is unmatchable whether or not we printed a due date.
  const pdf = paymentBlock(functionBody(src, 'buildInvoiceDoc'));
  const line = pdf.split('\n').find((l) => l.includes(REFERENCE_LINE));
  assert.ok(line, 'the reference line vanished from buildInvoiceDoc()');
  assert.ok(!/\bif\s*\(\s*due\s*\)/.test(line),
    'the reference line has been moved inside the `if (due)` branch — turning off ' +
    '"Show payment due date" would now also drop the payment reference.');

  const preview = functionBody(src, 'renderPreview');
  const idx = preview.indexOf(REFERENCE_LINE);
  // In the preview the due date is a ternary on displayDueDate(); the reference line
  // must sit outside it, i.e. after the ternary's closing `: ''}`.
  const ternaryEnd = preview.indexOf(": ''}", preview.indexOf('displayDueDate(d) ?'));
  assert.ok(ternaryEnd !== -1 && idx > ternaryEnd,
    'the reference line is inside the preview\'s due-date ternary — it would disappear ' +
    'with the due date, and the preview would stop matching the PDF.');
});

// --- 4: payH still mirrors the py advances ---------------------------------------

/** The payment block only — from its banner comment to the end of the function. */
function paymentBlock(body) {
  const start = body.indexOf('// --- Payment block ---');
  assert.notEqual(start, -1,
    'the "// --- Payment block ---" banner is gone from buildInvoiceDoc(); this test ' +
    'locates the block by it. Re-point it rather than deleting it.');
  return body.slice(start);
}

/**
 * Recompute what the block actually advances `py` by, for a given due-date state.
 * Everything inside the `if (thanksLines.length)` sign-off guard is excluded, because
 * payH is evaluated below with an empty sign-off.
 */
function pyAdvance(block, { due }) {
  const guard = block.indexOf('if (thanksLines.length)');
  assert.notEqual(guard, -1, 'the sign-off guard is gone from the payment block');
  const upTo = block.slice(0, guard);

  const seed = upTo.match(/let\s+py\s*=\s*ty\s*\+\s*([\d.]+)/);
  assert.ok(seed, 'could not read `let py = ty + N` — the block\'s starting drop.');
  let total = parseFloat(seed[1]);

  let counted = 0;
  for (const line of upTo.split('\n')) {
    // The due-date line advances py only when a due date is shown.
    if (!due && /\bif\s*\(\s*due\s*\)/.test(line)) continue;
    for (const m of line.matchAll(/py\s*\+=\s*([\d.]+)/g)) { total += parseFloat(m[1]); counted++; }
  }
  assert.ok(counted >= 3,
    `only ${counted} \`py +=\` advances found in the payment block — the regex has ` +
    'stopped matching the source and this test is measuring nothing.');
  return total;
}

/** payH as the source actually computes it, for a given due-date state. */
function reservedHeight(block, { due }) {
  const expr = block.match(/const\s+payH\s*=\s*([\s\S]*?);\n/);
  assert.ok(expr, 'could not read the `const payH = …` reservation.');
  // eslint-disable-next-line no-new-func
  return Function('due', 'thanksLines', `return (${expr[1]});`)(due, { length: 0 });
}

for (const due of [true, false]) {
  test(`payH reserves everything the payment block draws (due date ${due ? 'shown' : 'hidden'})`, () => {
    const block = paymentBlock(functionBody(src, 'buildInvoiceDoc'));
    const needed = pyAdvance(block, { due });
    const reserved = reservedHeight(block, { due });
    assert.ok(reserved >= needed,
      `payH reserves ${reserved}pt but the block advances py by ${needed}pt. payH is a ` +
      'HAND-WRITTEN mirror of the `py +=` chain — a line was added to one and not the ' +
      'other, so ensure() under-books and the block can run off the foot of the page. ' +
      'That is how an invoice once reached a customer with no account number on it ' +
      '(ERR-189). Add the matching term to payH.');
  });
}

// --- 5: positive control ----------------------------------------------------------

test('the payH check FAILS on a block that under-books its height', () => {
  // A copy of the real block with the reference line drawn but its 17.5pt left out of
  // payH — the exact mistake this change could have made. If this passes, tests 4 are
  // measuring nothing.
  const broken = `// --- Payment block ---
  const payH = 24 + (due ? 17.5 : 0) + 21 + 16.5
    + (thanksLines.length ? 32 + thanksLines.length * 14 : 0);
  ensure(payH);
  let py = ty + 24;
  if (due) { text('Payment due by X', M, py); py += 17.5; }
  text('${REFERENCE_LINE}', M, py); py += 17.5;
  text('Please make payment to:', M, py);
  py += 21;
  text('a/c Name:', M, py); py += 16.5;
  text('a/c Number:', M, py);
  if (thanksLines.length) { py += 32; }
`;
  assert.ok(reservedHeight(broken, { due: true }) < pyAdvance(broken, { due: true }),
    'the deliberately under-booked fixture passed the reservation check — the checks ' +
    'in test 4 are not actually comparing anything.');
});
