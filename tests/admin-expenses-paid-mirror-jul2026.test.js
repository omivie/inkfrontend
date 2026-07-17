/**
 * Expense editor — paid date mirrors the expense date until manually changed
 * ==========================================================================
 * Owner ask: Paid date defaults to the Expense date and auto-follows when the
 * expense date changes — but once the owner edits the paid date directly, it
 * sticks (later expense-date edits leave it alone). Same "touched" pattern the
 * GST checkbox uses.
 *
 * These are static source assertions (matching the other admin-expenses-*
 * tests); the live behaviour is exercised in the browser during verification.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
    path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'expenses.js'),
    'utf8');

test('the paid-date field defaults to the expense date (not just today)', () => {
    // Template initial value must fall back to the expense date before today.
    assert.match(SRC, /id="e-paid-date"[^>]*value="\$\{escA\(m\.paid_date \|\| m\.expense_date \|\| todayInputValue\(\)\)\}"/,
        'paid-date input must default to m.paid_date || m.expense_date || today');
});

test('a syncPaidMirror pushes the expense date into an untouched paid field', () => {
    assert.match(SRC, /const syncPaidMirror = \(\) =>/, 'syncPaidMirror helper must exist');
    // Gated on the touched flag, and it copies #e-date into #e-paid-date.
    assert.match(SRC, /paidDate\.dataset\.touched !== '1'\s*\)\s*paidDate\.value = \$\('#e-date'\)\.value/,
        'the mirror must only run while the paid field is untouched, copying #e-date');
    // Wired to the expense-date field.
    assert.match(SRC, /\$\('#e-date'\)\?\.addEventListener\('(input|change)', syncPaidMirror\)/,
        'syncPaidMirror must be wired to #e-date edits');
});

test('a direct paid-date edit marks it touched (stops mirroring)', () => {
    assert.match(SRC, /paidDate\?\.addEventListener\('input',\s*\(\) => \{ paidDate\.dataset\.touched = '1'; \}\)/,
        'editing the paid date must set dataset.touched');
    assert.match(SRC, /paidDate\?\.addEventListener\('change',\s*\(\) => \{ paidDate\.dataset\.touched = '1'; \}\)/,
        'change on the paid date must also set dataset.touched');
});

test('an existing record with a deliberately-different paid date is pre-touched', () => {
    assert.match(SRC, /model\.paid_date && model\.paid_date !== model\.expense_date\)\s*\{\s*paidDate\.dataset\.touched = '1'/,
        'a stored paid date that differs from the expense date must not be clobbered on edit');
});

test('collectPayload falls back to the expense date, not just today', () => {
    assert.match(SRC, /payload\.paid_date = \$\('#e-paid-date'\)\.value \|\| \$\('#e-date'\)\.value \|\| todayInputValue\(\)/,
        'an empty paid date should fall back to the expense date before today');
});
