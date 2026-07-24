/**
 * dashboard-coldload-persist-jul2026.test.js — pin the cold-load persistence contract
 * ====================================================================================
 *
 * Reported 2026-07-24: after retiring the faint reload dim (ERR-115), the user asked
 * why a FULL PAGE REFRESH still showed a spinner on a blank page instead of the last
 * data. Cause: `_payloadCache` is an in-memory Map — empty after a hard refresh.
 *
 * Fix (ERR-116): the last-rendered dashboard payload is written through to localStorage
 * and the Map is seeded from it on the first load of the module's life, so a refresh
 * paints the last-known dashboard instantly (full colour) and then revalidates — exactly
 * like in-app stale-while-revalidate. Persistence mirrors AdminAPI's account-keyed,
 * fail-soft localStorage pattern.
 *
 * These are source-read assertions (no DOM) pinning the regulators that keep the fix
 * robust and safe against future edits.
 *
 * Run with: node --test tests/dashboard-coldload-persist-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DASH_SRC = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/admin/pages/dashboard.js'), 'utf8');

test('dashboard.js: declares a payload-shape schema version for the persisted cache', () => {
  assert.match(DASH_SRC, /const\s+DASH_CACHE_SCHEMA\s*=\s*\d+/,
    'must declare DASH_CACHE_SCHEMA so a stale-shape blob is ignored, not fed to render()');
});

test('dashboard.js: the persisted-cache key is account-scoped', () => {
  // Keeps one admin's financials out of another admin's session on a shared browser.
  const keyFn = DASH_SRC.match(/function\s+_dashCacheKey\(\)\s*\{[\s\S]+?\}/);
  assert.ok(keyFn, '_dashCacheKey() must exist');
  assert.match(keyFn[0], /Auth[\s\S]*\.id/, 'key must incorporate the account id');
  assert.match(keyFn[0], /admin_dash_cache:/, 'key must use the admin_dash_cache namespace');
});

test('dashboard.js: read + write helpers wrap localStorage in try/catch (private mode / quota)', () => {
  const readFn  = DASH_SRC.match(/function\s+_readPersistedPayload\([\s\S]+?\n\}/);
  const writeFn = DASH_SRC.match(/function\s+_writePersistedPayload\([\s\S]+?\n\}/);
  assert.ok(readFn,  '_readPersistedPayload() must exist');
  assert.ok(writeFn, '_writePersistedPayload() must exist');
  assert.match(readFn[0],  /try\s*\{[\s\S]*localStorage\.getItem[\s\S]*\}\s*catch/,
    'read must guard localStorage.getItem in try/catch');
  assert.match(writeFn[0], /try\s*\{[\s\S]*localStorage\.setItem[\s\S]*\}\s*catch/,
    'write must guard localStorage.setItem in try/catch');
  // Read must gate on the schema version before returning a payload.
  assert.match(readFn[0], /DASH_CACHE_SCHEMA/, 'read must version-gate on DASH_CACHE_SCHEMA');
});

test('dashboard.js: the Map is seeded from storage BEFORE the warm-cache lookup, once only', () => {
  const hydrateIdx = DASH_SRC.indexOf('_readPersistedPayload(cacheKey)');
  const lookupIdx  = DASH_SRC.indexOf('const cached = isOwner ? _payloadCache.get(cacheKey)');
  assert.ok(hydrateIdx > 0, 'must seed the Map via _readPersistedPayload(cacheKey)');
  assert.ok(lookupIdx  > 0, 'must keep the warm-cache lookup');
  assert.ok(hydrateIdx < lookupIdx,
    'the storage seed must run BEFORE the cached lookup so the warm branch fires on a refresh');
  assert.match(DASH_SRC, /_storageHydrated/, 'must guard the seed with a once-only flag');
});

test('dashboard.js: successful render writes the payload through to storage', () => {
  const setIdx   = DASH_SRC.indexOf('_payloadCache.set(cacheKey, payload)');
  // lastIndexOf skips the `function _writePersistedPayload(cacheKey, payload)` definition
  // and lands on the CALL site.
  const writeIdx = DASH_SRC.lastIndexOf('_writePersistedPayload(cacheKey, payload)');
  assert.ok(setIdx   > 0, 'must set the in-memory cache');
  assert.ok(writeIdx > 0, 'must write through to localStorage');
  assert.ok(setIdx < writeIdx, 'write-through must follow the in-memory set');
});

test('dashboard.js: cached repaint is guarded so a bad blob cannot white-screen the page', () => {
  // The seeded repaint must be wrapped so a stale-shape payload clears storage and
  // falls back to the spinner instead of throwing out of render().
  assert.match(
    DASH_SRC,
    /try\s*\{\s*render\(cached\)[\s\S]*?\}\s*catch[\s\S]*?_clearPersistedPayload\(\)/,
    'the cached render() must be wrapped and clear the persisted cache on failure'
  );
});
