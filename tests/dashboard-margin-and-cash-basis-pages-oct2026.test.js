/**
 * dashboard-margin-and-cash-basis-pages-oct2026.test.js — ERR-310
 *
 * Live 2026-10-07, /admin#dashboard?period=all: Net Margin tile read −139.0%. The real
 * figure was −1.39%: fmtPct multiplied any |n| ≤ 1.5 by 100, guessing it was a fraction.
 * Every caller passes a percent. (Part 2, the cash-basis order pager, was deleted with the
 * cash basis itself — ERR-387.)
 *
 * Run: node --test tests/dashboard-margin-and-cash-basis-pages-oct2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Moved helpers now live in utils/dash-charts.js; lift() still reads them from this combined source.
const src = fs.readFileSync(path.join(__dirname, '..', 'inkcartridges', 'js', 'admin', 'utils', 'dash-charts.js'), 'utf8').replace(/^export /gm, '') + '\n' + fs.readFileSync(
  path.join(__dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'dashboard.js'), 'utf8');

function lift(name) {
  const start = src.search(new RegExp(`\\n(?:async\\s+)?function\\s+${name}\\s*\\(`)) + 1;
  assert.ok(start > 0, `${name} not found in dashboard.js — renamed?`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces lifting ${name}`);
}

function load() {
  const ctx = vm.createContext({ Number });
  vm.runInContext(`${lift('fmtPct')}\nthis.fmtPct = fmtPct;`, ctx);
  return ctx;
}

test('fmtPct prints a near-breakeven percent as itself, not ×100', () => {
  const { fmtPct } = load();
  assert.equal(fmtPct(-1.39), '-1.4%', 'the live −139.0% tile');
  assert.equal(fmtPct(0.33), '0.3%');
  assert.equal(fmtPct(1.5), '1.5%');
  assert.equal(fmtPct(26.2), '26.2%');
  assert.equal(fmtPct(0), '0.0%');
  assert.equal(fmtPct(null), null);
  assert.equal(fmtPct('x'), null);
});
