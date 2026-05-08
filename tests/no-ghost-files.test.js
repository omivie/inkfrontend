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
 *   • The duplicate root copy of backend-passover.md (canonical lives in readfirst/)
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

test('no duplicate root backend-passover.md (canonical in readfirst/)', () => {
  const root = path.join(ROOT, 'backend-passover.md');
  const canonical = path.join(ROOT, 'readfirst', 'backend-passover.md');
  assert.strictEqual(
    fs.existsSync(root), false,
    'Root-level backend-passover.md was a duplicate of readfirst/backend-passover.md. ' +
    'Use readfirst/backend-passover.md only.'
  );
  assert.strictEqual(
    fs.existsSync(canonical), true,
    'readfirst/backend-passover.md is the canonical handoff doc and must exist.'
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
