/**
 * Build-script wiring — May 2026
 * ===============================
 *
 * The repo has two package.jsons:
 *   /package.json                     — repo root (dev, test, test:e2e, BUILD)
 *   /inkcartridges/package.json       — Vercel project root (build)
 *
 * Vercel runs `npm run build` from `inkcartridges/` (because that's where
 * `vercel.json` lives). The repo-root `build` was missing pre-2026-05-12,
 * which meant `npm run build` from the repo root failed with "missing
 * script" — a foot-gun for any dev who tried to verify the deploy stamp
 * locally. Both now delegate to the same `stamp-versions.js` script and
 * produce byte-identical output.
 *
 * This test pins:
 *   1. Both package.jsons define a `build` script.
 *   2. Both scripts resolve to the same target file (`stamp-versions.js`).
 *   3. The script file actually exists.
 *   4. vercel.json's `buildCommand` is `npm run build` (matches both).
 *
 * Run with: node --test tests/build-script.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ROOT_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NESTED_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'inkcartridges', 'package.json'), 'utf8'));
const VERCEL_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, 'inkcartridges', 'vercel.json'), 'utf8'));

test('repo-root package.json defines a build script', () => {
    assert.ok(ROOT_PKG.scripts?.build,
        'repo-root package.json must define a "build" script — without it `npm run build` from the repo root fails');
});

test('inkcartridges/package.json defines a build script', () => {
    assert.ok(NESTED_PKG.scripts?.build,
        'inkcartridges/package.json must define a "build" script — Vercel runs `npm run build` from this directory');
});

test('both build scripts point at scripts/stamp-versions.js', () => {
    // The repo-root version uses the relative path from repo root; the
    // nested version uses the relative path from inkcartridges/. Both
    // should reference the same script file.
    assert.match(ROOT_PKG.scripts.build, /stamp-versions\.js/,
        'repo-root build must run stamp-versions.js (cache-busts /js/*.js + /css/*.css refs in HTML)');
    assert.match(NESTED_PKG.scripts.build, /stamp-versions\.js/,
        'inkcartridges build must run stamp-versions.js');
});

test('stamp-versions.js exists at the expected path', () => {
    const stampPath = path.join(ROOT, 'inkcartridges', 'scripts', 'stamp-versions.js');
    assert.ok(fs.existsSync(stampPath),
        `${stampPath} must exist — both build scripts reference it`);
});

test('vercel.json buildCommand is `npm run build`', () => {
    assert.equal(VERCEL_JSON.buildCommand, 'npm run build',
        'vercel.json must call `npm run build` so Vercel deploys hit the stamp script');
});

test('repo-root build script is callable from the repo root', () => {
    // Sanity check on the resolution: when Vercel-style /inkcartridges or
    // repo-root /., both invocations must end up running the same node
    // script. We don't actually execute it (would mutate HTML files),
    // but we verify the path string resolves to the file from the repo
    // root cwd.
    const repoRootCmd = ROOT_PKG.scripts.build;
    const m = repoRootCmd.match(/node\s+(\S+)/);
    assert.ok(m, 'repo-root build must invoke a node script');
    const scriptRel = m[1];
    const resolved = path.resolve(ROOT, scriptRel);
    assert.ok(fs.existsSync(resolved),
        `Resolved path "${resolved}" must exist when running build from the repo root`);
});
