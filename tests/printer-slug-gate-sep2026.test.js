/**
 * Our printer-slug gate was stricter than the server's, and it cost us 20 printers
 * ================================================================================
 * ERR-272 · Sep 2026
 *
 * `PrinterContext.normalize()` decides whether a printer slug is something we
 * know. Its pattern was `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, and its docstring said
 * printer slugs are "lowercase, hyphen-joined, alphanumeric" as though that
 * were the contract.
 *
 * It never was. The backend has always allowed `_`, and since 2026-09-16 it
 * allows `.` and `+`. Its own 400 body now says so:
 *
 *   "Printer slug must contain only lowercase letters, numbers, hyphens,
 *    underscores, dots and plus signs"
 *
 * ── WHY THIS HAD NO SYMPTOM ────────────────────────────────────────────────
 *
 * `normalize()` returns `null` for anything it does not match, and null is this
 * module's honest answer for "not a slug". So nothing threw, nothing logged,
 * and nothing looked wrong. The module simply stopped knowing — and what it
 * knows is the printer annotation on a cart line and on the order that follows.
 *
 * Measured against the live sitemap on 2026-09-20: **20 printer URLs carry a
 * `.` or a `+`**, all of them real, distinct machines the backend serves today:
 *
 *   hp-designjet-z9+-24in        200, 11 compatible products
 *   hp-colour-laserjet-m880z+    200
 *   epson-300+                   200   (the Epson LQ-300+, a different printer
 *                                       from epson-300 — the whole reason `+`
 *                                       is preserved rather than stripped)
 *   universal-81001.01           200
 *
 * > ***A CLIENT-SIDE PATTERN STRICTER THAN THE SERVER'S IS NOT "EXTRA SAFE".
 * > It is a second, undocumented spec that nothing tests.***
 *
 * ── WHAT MUST STAY REFUSED, AND WHY ────────────────────────────────────────
 *
 * `,` `(` `)` `/` `$` `@` `\` `'` are still refused by the backend because the
 * products route feeds a slug-derived value into a PostgREST `.or()` filter
 * string, where `,` `(` `)` are syntax break-outs (the ERR-202/ERR-231 family).
 * `.` and `+` are inert there. 13 real printers still carry those characters
 * and still 400; they need a slug repair plus a redirect hop server-side, not a
 * wider gate here. This file is the negative control on that.
 *
 * Run: node --test tests/printer-slug-gate-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const codeOnly = require('./helpers/strip-comments.js');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CTX_SRC = read('inkcartridges/js/printer-context.js');
const PRINTERS_SRC = read('inkcartridges/js/admin/pages/printers.js');
const CTX_CODE = codeOnly(CTX_SRC);
const PRINTERS_CODE = codeOnly(PRINTERS_SRC);

/** Run the shipped module and hand back its global. Executed, not grepped. */
function loadPrinterContext(source = CTX_SRC) {
  const sandbox = { window: {}, module: { exports: {} }, localStorage: undefined, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'printer-context.js' });
  return sandbox.window.PrinterContext || sandbox.module.exports;
}

/** The admin's slug SUGGESTION helper, lifted out of its page module. */
function loadSlugify(source = PRINTERS_SRC) {
  const match = /function slugify\(s\) \{[\s\S]*?\n\}/.exec(source);
  assert.ok(match, 'could not lift slugify() out of admin/pages/printers.js');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${match[0]}; this.slugify = slugify;`, sandbox);
  return sandbox.slugify;
}

// ── The 20 live slugs the backend unblocked, measured 2026-09-20 ───────────
const LIVE_PLUS_DOT_SLUGS = [
  'epson-1600k3+', 'epson-1600k4+', 'epson-1900k2+', 'epson-300+', 'epson-300+ii',
  'hp-color-laserjet-m855x+', 'hp-color-laserjet-m880z+', 'hp-color-laserjet-m880z+nfc',
  'hp-colour-laserjet-m855x+', 'hp-colour-laserjet-m880z+', 'hp-colour-laserjet-m880z+nfc',
  'hp-designjet-z9+-24in', 'hp-designjet-z9+-44in', 'hp-designjet-z9+dr-44in',
  'hp-laserjet-m806x+nfc', 'nec-p6+', 'nec-p7+', 'hp-colour-laserjet-m880z+',
  'universal-81001.01', 'universal-81001.02',
];

// ── Still refused server-side: PostgREST `.or()` break-outs and friends ────
const MUST_REFUSE = [
  'hp-2700/2700e', 'oki-ml-182/390/420', 'lexmark-ms/mx-310',
  'canon-laserclass-4000/4500', 'hp-laserjet\\mfp6801',
  'brother-label-printer-(vc-500w)', 'fuji-xerox-wc3550@-a',
  "nakajima-x-600'", 'oki-$100works', 'whether-you’re-labeling-files',
  'foo,bar', 'a(b)c', 'semi;colon', 'space slug', 'UPPERCASE', '-leading-hyphen',
  '.leading-dot', '', '   ',
];

// ─────────────────────────────────────────────────────────────────────────────
// 0. The sources are real
// ─────────────────────────────────────────────────────────────────────────────

test('§0 the stripped sources are real code, not an empty string', () => {
  assert.ok(CTX_CODE.length > 1500, `printer-context.js stripped to ${CTX_CODE.length} chars`);
  assert.ok(PRINTERS_CODE.length > 3000, `printers.js stripped to ${PRINTERS_CODE.length} chars`);
  assert.match(CTX_CODE, /SLUG_PATTERN:/);
  assert.match(PRINTERS_CODE, /function slugify\(s\)/);
  // Positive control for the stripper, on prose no other guard depends on.
  assert.doesNotMatch(CTX_CODE, /undocumented spec that nothing tests/,
    'strip-comments left comment prose in the code string — the guards below are unreliable');
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The 20 printers the old pattern silently dropped
// ─────────────────────────────────────────────────────────────────────────────

test('§1 normalize() accepts every live slug carrying a . or a +', () => {
  const PrinterContext = loadPrinterContext();
  const dropped = LIVE_PLUS_DOT_SLUGS.filter((s) => PrinterContext.normalize(s) === null);
  assert.deepEqual(dropped, [],
    `these real, live printers would lose their cart/order annotation: ${dropped.join(', ')}`);
});

test('§1 normalize() returns the slug UNCHANGED — never a repaired guess', () => {
  const PrinterContext = loadPrinterContext();
  for (const slug of ['hp-designjet-z9+-24in', 'universal-81001.01', 'oki_ml182']) {
    assert.equal(PrinterContext.normalize(slug), slug);
  }
  // Trimming whitespace is the one repair it may do, and it is not a guess.
  assert.equal(PrinterContext.normalize('  epson-300+  '), 'epson-300+');
});

test('§1 underscores are accepted — the backend has always allowed them', () => {
  const PrinterContext = loadPrinterContext();
  assert.equal(PrinterContext.normalize('oki_ml182'), 'oki_ml182');
});

test('§1 POSITIVE CONTROL — an ordinary slug still works', () => {
  const PrinterContext = loadPrinterContext();
  assert.equal(PrinterContext.normalize('brother-mfc-j5740dw'), 'brother-mfc-j5740dw');
  assert.equal(PrinterContext.normalize('hp-photosmart-c6280'), 'hp-photosmart-c6280');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. NEGATIVE CONTROL — the gate did not simply open
// ─────────────────────────────────────────────────────────────────────────────

test('§2 every PostgREST break-out character is still refused', () => {
  const PrinterContext = loadPrinterContext();
  const leaked = MUST_REFUSE.filter((s) => PrinterContext.normalize(s) !== null);
  assert.deepEqual(leaked, [],
    `the gate was widened too far and now admits: ${leaked.join(', ')}`);
});

test('§2 the length cap and non-string inputs still refuse', () => {
  const PrinterContext = loadPrinterContext();
  assert.equal(PrinterContext.normalize('a'.repeat(121)), null);
  assert.equal(PrinterContext.normalize('a'.repeat(120)), 'a'.repeat(120), 'the cap is inclusive');
  for (const v of [null, undefined, 42, {}, [], true]) {
    assert.equal(PrinterContext.normalize(v), null, `${JSON.stringify(v)} is not a slug`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The admin no longer generates colliding slugs
// ─────────────────────────────────────────────────────────────────────────────

test('§3 🚨 "Epson LQ-300+" and "Epson LQ-300" get DIFFERENT slugs', () => {
  const slugify = loadSlugify();
  const plus = slugify('Epson LQ-300+');
  const bare = slugify('Epson LQ-300');
  assert.notEqual(plus, bare,
    'the admin generated one slug for two different printers — and `+` is the character '
    + 'the duplicate-printer canonical rule deliberately preserves (ERR-242 §9.3)');
  assert.equal(plus, 'epson-lq-300+');
  assert.equal(bare, 'epson-lq-300');
});

test('§3 an interior dot is kept; a trailing one is not', () => {
  const slugify = loadSlugify();
  // Real: universal-81001.01 is a live, servable slug.
  assert.equal(slugify('Universal 81001.01'), 'universal-81001.01');
  // Artefact: a trailing full stop is exactly what produced the junk row
  // `printronix-103.23.`, which turned out not to be a printer at all.
  assert.equal(slugify('Printronix 103.23.'), 'printronix-103.23');
  assert.equal(slugify('DocuPrint C1190 FS..'), 'docuprint-c1190-fs');
});

test('§3 every slug the admin generates is one the SERVER would accept', () => {
  // The round trip that matters: a suggestion the backend then 400s is a form
  // that fills itself in with a value it cannot save.
  const slugify = loadSlugify();
  const PrinterContext = loadPrinterContext();
  const names = [
    'Epson LQ-300+', 'HP DesignJet Z9+ 24in', 'Universal 81001.01',
    'Brother HL-L3230CDW', 'OKI ML182', 'Fuji Xerox DocuPrint CM505 da',
    'HP Colour LaserJet M880z+nfc', 'NEC P6+',
  ];
  for (const name of names) {
    const slug = slugify(name);
    assert.notEqual(PrinterContext.normalize(slug), null,
      `slugify(${JSON.stringify(name)}) produced ${JSON.stringify(slug)}, which our own gate refuses`);
  }
});

test('§3 slugify does not throw on empty or non-string input', () => {
  const slugify = loadSlugify();
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. RED-PROOF — put the old pattern back and the defect must return
//
// ERR-258: six guards that could not fail sat inside a green suite. A guard
// that cannot go red is a green light, not evidence.
// ─────────────────────────────────────────────────────────────────────────────

test('§4 MUTANT — the OLD pattern drops all 20 live slugs', () => {
  const mutated = CTX_SRC.replace(
    'SLUG_PATTERN: /^[a-z0-9][a-z0-9_.+-]*$/,',
    'SLUG_PATTERN: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,');
  assert.notEqual(mutated, CTX_SRC, 'the mutation did not apply — this red-proof is vacuous');

  const PrinterContext = loadPrinterContext(mutated);
  const dropped = LIVE_PLUS_DOT_SLUGS.filter((s) => PrinterContext.normalize(s) === null);
  assert.equal(dropped.length, LIVE_PLUS_DOT_SLUGS.length,
    'the old pattern must reject every one of them — otherwise §1 is not measuring the fix');
  // And it was not merely narrow: it also refused the underscores the backend
  // has always allowed.
  assert.equal(PrinterContext.normalize('oki_ml182'), null);
});

test('§4 MUTANT — a fully permissive pattern leaks the break-out characters', () => {
  const mutated = CTX_SRC.replace(
    'SLUG_PATTERN: /^[a-z0-9][a-z0-9_.+-]*$/,',
    'SLUG_PATTERN: /^.+$/,');
  assert.notEqual(mutated, CTX_SRC, 'the mutation did not apply — this red-proof is vacuous');

  const PrinterContext = loadPrinterContext(mutated);
  assert.notEqual(PrinterContext.normalize('foo,bar'), null,
    'the mutant must admit a comma — otherwise §2 proves nothing');
  assert.notEqual(PrinterContext.normalize('a(b)c'), null);
});

test('§4 MUTANT — the OLD slugify collapses the + and recreates the collision', () => {
  const mutated = PRINTERS_SRC.replace(
    /function slugify\(s\) \{[\s\S]*?\n\}/,
    "function slugify(s) {\n  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n}");
  assert.notEqual(mutated, PRINTERS_SRC, 'the mutation did not apply — this red-proof is vacuous');

  const slugify = loadSlugify(mutated);
  assert.equal(slugify('Epson LQ-300+'), slugify('Epson LQ-300'),
    'the old helper must collide — otherwise §3 is not measuring the fix');
});
