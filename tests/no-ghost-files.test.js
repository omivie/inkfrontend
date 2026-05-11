/**
 * Ghost-file lockdown — May 2026
 * ==============================
 *
 * Pins the cleanup that removed all ad-hoc screenshots, one-off PDFs,
 * Playwright debug logs, and superseded handoff docs from the repo on
 * 2026-05-08. The pattern of dumping `*.png` captures and stale specs
 * at the project root had crept up to ~32 MB of noise across 800+ files.
 *
 * If someone re-introduces any of the following, this test fails:
 *
 *   • Any *.png / *.jpg / *.jpeg / *.gif / *.webp / *.pdf at the repo root
 *     (legit images live under inkcartridges/assets/ or inkcartridges/favicon*)
 *   • The .playwright-mcp/ debug directory
 *   • Any *.png inside audit-output/ (only audit-output/report.json is tracked)
 *   • Top-level *-report.html one-off reports
 *   • Any backend-handoff.md / per-task spec markdown files re-appearing
 *     after the 2026-05-11 hand-off to backend (all readfirst/ specs +
 *     handoffs/backend-handoff.md were delivered and deleted)
 *   • Any .DS_Store file anywhere in the tree
 *
 * Run with: node --test tests/no-ghost-files.test.js
 *
 * Spec: readfirst/ghost-file-cleanup-may2026.md
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function listRoot() {
  return fs.readdirSync(ROOT, { withFileTypes: true });
}

function walk(dir, out, skip) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full);
    if (skip(rel, entry)) continue;
    if (entry.isDirectory()) walk(full, out, skip);
    else out.push(rel);
  }
  return out;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.vercel', '.vscode', '.claude',
]);

function listAll() {
  return walk(ROOT, [], (rel, entry) => {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) return true;
    return false;
  });
}

test('no ad-hoc screenshots or PDFs at repo root', () => {
  const banned = /\.(png|jpe?g|gif|webp|pdf)$/i;
  const offenders = listRoot()
    .filter(e => e.isFile() && banned.test(e.name))
    .map(e => e.name);
  assert.deepStrictEqual(
    offenders, [],
    `Found ad-hoc binaries at repo root: ${offenders.join(', ')}. ` +
    `Move legit images to inkcartridges/assets/, delete one-off captures.`
  );
});

test('no top-level *-report.html one-off reports', () => {
  const offenders = listRoot()
    .filter(e => e.isFile() && /-report\.html$/i.test(e.name))
    .map(e => e.name);
  assert.deepStrictEqual(
    offenders, [],
    `Found one-off report HTMLs at root: ${offenders.join(', ')}. ` +
    `Reports belong in readfirst/ as markdown, not standalone HTML.`
  );
});

test('.playwright-mcp/ debug directory must not exist', () => {
  const dir = path.join(ROOT, '.playwright-mcp');
  assert.strictEqual(
    fs.existsSync(dir), false,
    '.playwright-mcp/ is Playwright-MCP debug output (gitignored). ' +
    'Delete it — never check it in.'
  );
});

test('audit-output/ holds only report.json (no orphan screenshots)', () => {
  const dir = path.join(ROOT, 'audit-output');
  if (!fs.existsSync(dir)) return; // dir is optional
  const offenders = fs.readdirSync(dir).filter(name => name !== 'report.json');
  assert.deepStrictEqual(
    offenders, [],
    `audit-output/ should contain only report.json. Found: ${offenders.join(', ')}.`
  );
});

test('backend handoff / per-task spec markdown is not re-introduced', () => {
  // 2026-05-11: all backend-handoff content + per-task readfirst/ specs
  // were delivered to the backend dev and deleted from the repo. Spec
  // detail now lives only in code + tests (the durable source of truth).
  // If anyone re-adds these files, the doc-sprawl is starting again.
  const banned = [
    'backend-handoff.md',                                     // repo root
    'backend-passover.md',                                    // repo root
    'handoffs/backend-handoff.md',                            // pre-cleanup canonical
    'readfirst/backend-passover.md',                          // pre-2026-05-11 location
    'readfirst/admin-ribbon-row-blocked-may2026.md',          // per-task handoff
    'readfirst/admin-ribbon-source-filter-may2026.md',
    'readfirst/legal-content-cms-may2026.md',
    'readfirst/product-surface-consistency-may2026.md',
    'readfirst/search-pagination-may2026.md',
    'readfirst/series-base-merge-may2026.md',
    'readfirst/shop-transient-failure-recovery-may2026.md',
    'readfirst/source-chip-removal-may2026.md',
    'inkcartridges/backend-handoff.md',                       // wrong tree
    'inkcartridges/readfirst/backend-handoff.md',             // wrong tree
  ];
  const offenders = banned.filter(rel => fs.existsSync(path.join(ROOT, rel)));
  assert.deepStrictEqual(
    offenders, [],
    `Per-task handoff/spec markdown re-appeared: ${offenders.join(', ')}. ` +
    'These were delivered to the backend dev on 2026-05-11 and removed; ' +
    'durable spec info belongs in code + tests, not in standalone .md files.'
  );
});

test('no .DS_Store files tracked anywhere', () => {
  const offenders = listAll().filter(rel => path.basename(rel) === '.DS_Store');
  assert.deepStrictEqual(
    offenders, [],
    `Found .DS_Store files: ${offenders.join(', ')}. ` +
    `These are macOS junk — gitignored, never commit.`
  );
});

test('.gitignore blocks every ghost-file pattern', () => {
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  const required = [
    '.playwright-mcp/',
    '/*.png',
    '/*.pdf',
    '/*-report.html',
    'audit-output/*',
    '!audit-output/report.json',
    '.DS_Store',
  ];
  for (const pattern of required) {
    assert.match(
      gitignore, new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
      `.gitignore must contain "${pattern}" to keep ghost files out`
    );
  }
});
