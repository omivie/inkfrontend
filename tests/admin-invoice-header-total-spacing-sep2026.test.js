/**
 * The invoice header meta and the Total, and the two collisions they printed
 * ==========================================================================
 *
 * The owner downloaded Invoice 3277 to check the layout and found two things
 * touching that should never touch:
 *
 *   1. "DATE1st September 2026" — the header's label column and value column
 *      overlapped, printing the label hard against the date with NO space.
 *   2. The Total sat flush on the rule that separates it from the figures it
 *      sums — "Total  $1,325.95" with its cap-heights resting on the line.
 *
 * And in the admin's live preview, the same meta block pushed the dates and the
 * GST number out through the right edge of the paper.
 *
 * WHY THE FIRST ONE WAS NOT A NEAR MISS
 * -------------------------------------
 * The label was drawn right-aligned at a hardcoded `pageW - M - 100` — 100 pt
 * reserved for the value, a guess. Measured against the real jsPDF 2.5.2 Times
 * metrics the admin loads, "1st September 2026" is 99.48 pt at 12 pt bold. The
 * gap between the label's right edge and the value's left edge was 0.52 pt. Any
 * value one character wider — "28th September 2026", a longer GST number — and
 * the two columns overlap outright. So the fix measures the widest value in the
 * block and seats the labels a fixed gap clear of it.
 *
 * WHAT THIS FILE PINS
 * -------------------
 *   1. The label column is DERIVED from a measured value width, never a constant.
 *   2. The rule-to-Total gap clears the Total's own cap height with room to spare
 *      (a gap is only "enough" relative to the size of the type it separates).
 *   3. The preview's meta block cannot shrink below its own content — that is
 *      what pushed the values off the paper — and its Total gets the same air.
 *   4. POSITIVE CONTROL: the pre-fix source must FAIL both geometry checks. Without
 *      it a regex that stopped matching would go silently green (ERR-181's lesson).
 *
 * Run with: node --test tests/admin-invoice-header-total-spacing-sep2026.test.js
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

// Same brace-matcher as tests/admin-invoice-font-size-aug2026.test.js.
function functionBody(source, name) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.notEqual(start, -1, `${name}() not found — did it get renamed?`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  assert.fail(`unbalanced braces while scanning ${name}()`);
}

/** True when the header's label column is measured from the values, not guessed. */
function headerMeasuresValues(body) {
  // The values are what the label column has to clear, so their width must be read
  // from the font — getTextWidth over the meta rows — and the label x expressed in
  // terms of that measurement.
  const measured = /const\s+(\w*[Vv]alW\w*)\s*=[\s\S]{0,200}?getTextWidth/.exec(body);
  if (!measured) return false;
  const labelX = new RegExp(`const\\s+\\w*[Ll]abelX\\w*\\s*=[^;]*\\b${measured[1]}\\b`).test(body);
  return labelX;
}

/** [gap, fontSize] for the Total: the distance from the rule to its baseline. */
function totalRuleGeometry(body) {
  // Two shapes have existed: `ty += N; line(..., ty - K, ...)` (the pre-fix one,
  // where the gap is implicit in the next row's advance) and the explicit
  // `const ruleY = …; ty = ruleY + G;`. Read whichever is present.
  const explicit = /const\s+ruleY\s*=\s*ty\s*-\s*([\d.]+)\s*;[\s\S]{0,300}?ty\s*=\s*ruleY\s*\+\s*([\d.]+)\s*;/.exec(body);
  const size = /totRow\('Total'[\s\S]{0,140}?size:\s*([\d.]+)/.exec(body);
  assert.ok(size, "could not read the Total's font size in buildInvoiceDoc()");
  if (explicit) return { gap: parseFloat(explicit[2]), size: parseFloat(size[1]) };
  const implicit = /doc\.setDrawColor\(20\)[^\n]*ty\s*-\s*([\d.]+)/.exec(body);
  assert.ok(implicit, 'could not find the rule drawn above the Total — if it moved, point ' +
    'this test at its new home rather than deleting it.');
  // The Total is drawn at the current ty and the rule at ty - back, so the gap IS back.
  return { gap: parseFloat(implicit[1]), size: parseFloat(size[1]) };
}

// Times-Bold cap height is 0.676 em: the glyph tops of a 16 pt "Total" reach
// 10.8 pt above its baseline. A gap smaller than that is an overlap; a gap equal
// to it is the defect the owner photographed — touching.
const CAP = 0.676;
const CLEARANCE = 4;   // pt of daylight we insist on between the rule and the type

test('the header label column is measured against the values, never a fixed guess', () => {
  const body = functionBody(src, 'buildInvoiceDoc');
  assert.ok(headerMeasuresValues(body),
    'buildInvoiceDoc() no longer derives the meta label x from a measured value width. ' +
    'A hardcoded offset is a guess at how wide a date is: at 12 pt Times bold ' +
    '"1st September 2026" is 99.48 pt, and the old 100 pt guess left 0.52 pt of gap — ' +
    'which is how the invoice printed "DATE1st September 2026".');
  assert.doesNotMatch(body, /pageW\s*-\s*M\s*-\s*100\b/,
    'the old hardcoded label column (pageW - M - 100) is back in buildInvoiceDoc().');
});

test('the Total clears the rule it is separated by', () => {
  const body = functionBody(src, 'buildInvoiceDoc');
  const { gap, size } = totalRuleGeometry(body);
  const needed = size * CAP + CLEARANCE;
  assert.ok(gap >= needed,
    `the Total's baseline is ${gap} pt below the rule, but at ${size} pt its cap height ` +
    `alone is ${(size * CAP).toFixed(1)} pt — the figure lands on the line. Give it at ` +
    `least ${needed.toFixed(1)} pt. Note this is a RATIO, not a constant: enlarging the ` +
    'Total without enlarging the gap re-opens the same defect.');
});

test('the totals stack still reserves its full height before drawing', () => {
  // The gap grew, so the ensure() reservation had to grow with it — otherwise the
  // block can be written past the bottom of A4, where draws are ABSENT, not clipped
  // (ERR-189). Every term below must be covered by the reservation.
  const body = functionBody(src, 'buildInvoiceDoc');
  // The prose above the totals mentions `ensure()` by name, so take the first call
  // that is an actual arithmetic reservation rather than the first textual match.
  const arg = [...body.matchAll(/ensure\(([^)]+)\)/g)]
    .map((m) => m[1].trim())
    .find((a) => /^[\d.\s*+]+$/.test(a));
  assert.ok(arg, 'the totals stack no longer reserves its height before drawing.');
  const reserved = Function(`"use strict"; return (${arg});`)();
  const { gap, size } = totalRuleGeometry(body);
  const rows = 3 * 17.5;                       // Sub Total, Freight, GST
  assert.ok(reserved >= rows + gap + size * CAP,
    `the totals stack reserves ${reserved} pt but draws ${(rows + gap + size * CAP).toFixed(1)} pt ` +
    '— a page break can now part the Total from the figures it sums.');
});

test('the preview meta block cannot shrink below its own content', () => {
  const rule = /\.inv-doc__meta\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'could not find the .inv-doc__meta rule in admin.css');
  assert.doesNotMatch(rule[1], /min-width:\s*0\b/,
    'min-width: 0 is back on .inv-doc__meta. The values are nowrap, so shrinking below ' +
    'min-content does not wrap them — it pushes the dates and the GST number out through ' +
    'the right edge of the paper, which is exactly what the operator screenshotted.');
  assert.match(rule[1], /min-width:\s*min-content/,
    '.inv-doc__meta needs an explicit min-content floor; flex would otherwise squeeze it.');
  const head = /\.inv-doc__head\s*\{([^}]*)\}/.exec(css);
  assert.match(head[1], /flex-wrap:\s*wrap/,
    '.inv-doc__head must be allowed to wrap: with a min-content floor on the meta block, a ' +
    'drawer too narrow for title + meta has to break the line rather than overflow.');
});

test('the preview Total gets the same air as the PDF Total', () => {
  const grand = /\.inv-doc__grand\s+td\s*\{([^}]*)\}/.exec(css);
  assert.ok(grand, 'could not find .inv-doc__grand td in admin.css');
  const pad = /padding-top:\s*([\d.]+)px/.exec(grand[1]);
  const size = /font-size:\s*([\d.]+)px/.exec(grand[1]);
  assert.ok(pad && size, '.inv-doc__grand td must state both its font-size and its padding-top');
  // Same ratio test as the PDF, in px: the operator approves this surface.
  assert.ok(parseFloat(pad[1]) >= parseFloat(size[1]) * 0.5,
    `.inv-doc__grand td has ${pad[1]}px of padding under a ${size[1]}px Total — the figure sits ` +
    'on the rule, the same defect the PDF had.');
});

test('POSITIVE CONTROL — the pre-fix source must fail both geometry checks', () => {
  // Verbatim shapes from before the fix. If these pass, the checks above are not
  // checking: a regex that stops matching is silently green.
  const brokenHeader = `
    function buildInvoiceDoc(d) {
      invoiceMeta(d).forEach(([k, v]) => {
        doc.text(k.toUpperCase(), pageW - M - 100, my, { align: 'right' });
        doc.text(String(v ?? ''), pageW - M, my, { align: 'right' });
      });
    }`;
  assert.ok(!headerMeasuresValues(functionBody(brokenHeader, 'buildInvoiceDoc')),
    'the pre-fix header (a hardcoded 100 pt label column) passed the measurement check.');

  const brokenTotal = `
    function buildInvoiceDoc(d) {
      totRow('GST', money(t.gst));
      ty += 6;
      doc.setDrawColor(20); doc.setLineWidth(1); doc.line(labelX, ty - 11, valX, ty - 11);
      totRow('Total', money(t.total), { bold: true, size: 16, gap: 17.5 });
    }`;
  const geo = totalRuleGeometry(functionBody(brokenTotal, 'buildInvoiceDoc'));
  assert.equal(geo.gap, 11, 'the control fixture stopped being measured');
  assert.ok(!(geo.gap >= geo.size * CAP + CLEARANCE),
    `the deliberately-broken fixture (an 11 pt gap under a 16 pt Total, cap height ` +
    `${(16 * CAP).toFixed(1)} pt) passed the clearance check — the check is not checking.`);
});
