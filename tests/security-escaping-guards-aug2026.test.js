/**
 * `window.Security` does not exist — never guard on it (ERR-167)
 * ==============================================================
 *
 * js/security.js declares:
 *
 *     const Security = { … };            // security.js:10
 *
 * A top-level `const` in a CLASSIC script creates a global *lexical* binding. It
 * is reachable as a bare `Security` from every other classic script and from the
 * admin's ES modules — but it is NOT a property of `window`. So:
 *
 *     window.Security               // undefined, always, everywhere
 *     typeof Security               // "object"
 *
 * Twelve call sites were written as
 *
 *     const escH = (s) => (window.Security?.escapeHtml ? Security.escapeHtml(s) : s);
 *
 * and every one of them had silently taken the fallback branch since it was
 * written. The worst was js/admin/components/product-search.js, whose fallback
 * returned the string COMPLETELY UNESCAPED and whose output is the admin's
 * product-picker dropdown — so catalogue product names were injected as raw HTML
 * into the page the operator builds invoices on.
 *
 * This is the same lesson already recorded in pages/invoices.js about a
 * `typeof AdminAuth` guard that hid an entire column:
 *
 *     "A defensive typeof guard around a missing import doesn't harden the
 *      feature, it deletes it. Import the thing and let it throw if it's absent."
 *
 * A guard that is always false is not a safety net. It is an off switch nobody
 * can see. This file makes the off switch impossible to reinstall.
 *
 * Run with: node --test tests/security-escaping-guards-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'inkcartridges');
const JS = path.join(ROOT, 'js');

/** Every .js file under inkcartridges/js, recursively. */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const FILES = walk(JS);
const rel = (p) => path.relative(ROOT, p);

// Comments may DISCUSS window.Security (this fix left explanations behind);
// only executable references are the defect.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ─── 1. The declaration this whole file depends on ───────────────────────────

test('security.js declares a bare `const Security` and never assigns window.Security', () => {
  const src = fs.readFileSync(path.join(JS, 'security.js'), 'utf8');
  assert.match(src, /^const Security = \{/m,
    'security.js must declare `const Security = {` — the premise of every assertion below');
  assert.equal(/window\.Security\s*=/.test(stripComments(src)), false,
    'security.js does NOT export onto window. If you are adding that, delete this test file '
    + 'and the twelve bare references it protects — but read ERR-167 first, because '
    + 'window.Security existing is not what made the guards wrong; the guards were wrong '
    + 'because they had a fallback at all.');
});

test('escapeHtml and escapeAttr both exist and escape the dangerous characters', () => {
  // Loaded as a plain script into a sandbox — it is a classic script, not a module.
  const src = fs.readFileSync(path.join(JS, 'security.js'), 'utf8');
  const vm = require('node:vm');
  const ctx = { window: {}, document: {}, console };
  vm.createContext(ctx);
  vm.runInContext(src + ';this.__S = Security;', ctx);
  const S = ctx.__S;

  assert.equal(typeof S.escapeHtml, 'function');
  assert.equal(typeof S.escapeAttr, 'function');
  const evil = `<img src=x onerror="alert('1')">`;
  const out = S.escapeHtml(evil);
  assert.equal(out.includes('<'), false, 'escapeHtml must neutralise <');
  assert.equal(out.includes('>'), false, 'escapeHtml must neutralise >');
  assert.equal(out.includes('"'), false, 'escapeHtml must neutralise "');
  assert.equal(out.includes("'"), false, "escapeHtml must neutralise '");
  // The premise of the whole bug: window.Security is undefined even after load.
  assert.equal(ctx.window.Security, undefined,
    'window.Security must stay undefined — that is exactly why guarding on it fails');
});

// ─── 2. The guard must never come back ───────────────────────────────────────

test('no file guards an escaper on `window.Security`', () => {
  const offenders = [];
  for (const file of FILES) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const re = /window\s*\.\s*Security/g;
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${rel(file)}:${line}`);
    }
  }
  assert.deepEqual(offenders, [],
    'window.Security is ALWAYS undefined (security.js:10 is a bare const), so any code '
    + 'branching on it takes its fallback 100% of the time. Reference `Security` directly:\n'
    + `  const escA = (s) => Security.escapeAttr(String(s ?? ''));\n`
    + 'Offenders:\n  ' + offenders.join('\n  '));
});

test('the admin escaper helpers call Security directly, with no fallback branch', () => {
  // These are the ones that render catalogue and customer data into innerHTML.
  const GUARDED = [
    'js/admin/components/product-search.js',
    'js/admin/components/autocomplete.js',
    'js/admin/pages/invoices.js',
    'js/admin/pages/quick-order.js',
    'js/admin/pages/contacts.js',
    'js/admin/pages/customers.js',
    'js/admin/pages/expenses.js',
    'js/admin/pages/business.js',
  ];
  for (const f of GUARDED) {
    const src = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const decls = src.match(/const esc[AH] = [^\n]+/g) || [];
    assert.ok(decls.length > 0, `${f} should declare an escA/escH helper`);
    for (const d of decls) {
      assert.match(d, /Security\.escape(Html|Attr)\(/,
        `${f}: escaper helper must call Security.escape*() — got: ${d}`);
      assert.equal(/\?|:\s*String\(/.test(d.replace(/\?\?/g, '')), false,
        `${f}: escaper helper must have NO fallback branch. A fallback that only strips `
        + `quotes (or nothing at all) is what shipped for months. Got: ${d}`);
    }
  }
});

test('the product picker escapes the product NAME it renders into innerHTML', () => {
  // The specific hole: escH(name) with a pass-through fallback, written straight
  // into the dropdown markup. Product names are catalogue data.
  const src = fs.readFileSync(path.join(ROOT, 'js/admin/components/product-search.js'), 'utf8');
  assert.match(stripComments(src), /const escH = \(s\) => Security\.escapeHtml\(/,
    'product-search.js escH must be the real escaper');
  assert.match(src, /admin-ac__pname">\$\{escH\(name\)\}/,
    'the product name must still go through escH on its way into innerHTML');
});
