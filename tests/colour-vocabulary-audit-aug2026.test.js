/**
 * Colour-vocabulary audit — contract tests (Aug 2026)
 * ===================================================
 *
 * ERR-143. `scripts/audit-colour-vocabulary.mjs` is the permanent replacement
 * for "wait for the next backend handoff and eyeball the swatches". This file
 * pins the properties that make it trustworthy, without running it (the live
 * pass needs the network; `npm run audit:colours:static` is the offline gate).
 *
 * What it guards:
 *
 *   - The script lives OUTSIDE inkcartridges/. That tree is the Vercel project
 *     root and is served publicly — inkcartridges/scripts/fit-audit.js is
 *     fetchable on the live site right now. Audit tooling must not deploy.
 *
 *   - It declares NO colour vocabulary of its own. An audit carrying its own
 *     copy of the colour list certifies a UI that does not exist; it has to
 *     load the SHIPPED ProductColors or it proves nothing.
 *
 *   - An unreachable API exits non-zero. "I could not read the catalogue" and
 *     "the catalogue is clean" are different sentences, and collapsing them is
 *     the absence-read-as-zero mistake behind ERR-139.
 *
 *   - The baseline record cannot rot. ERR-140 was a record that stayed green
 *     while the thing it described changed underneath it. This baseline fails
 *     both when a NEW finding appears and when a recorded one stops tripping.
 *
 * Run: node --test tests/colour-vocabulary-audit-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'audit-colour-vocabulary.mjs');
const BASELINE_PATH = path.join(ROOT, 'tests', 'fixtures', 'colour-vocabulary-baseline.json');

const SRC = fs.readFileSync(SCRIPT_PATH, 'utf8');

test('the audit lives outside inkcartridges/ — that tree is served publicly', () => {
    assert.ok(fs.existsSync(SCRIPT_PATH), 'scripts/audit-colour-vocabulary.mjs must exist');
    assert.ok(!fs.existsSync(path.join(ROOT, 'inkcartridges', 'scripts', 'audit-colour-vocabulary.mjs')),
        'the audit must NOT be under inkcartridges/ — vercel.json serves that tree as the site root');
});

test('package.json exposes audit:colours and audit:colours:static', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['audit:colours'], 'node scripts/audit-colour-vocabulary.mjs');
    assert.equal(pkg.scripts['audit:colours:static'], 'node scripts/audit-colour-vocabulary.mjs --static',
        'the static pass must be runnable with no network, so it can gate CI');
});

test('the audit loads the SHIPPED vocabulary and declares none of its own', () => {
    assert.match(SRC, /require\(utilsPath\)/,
        'must load ProductColors out of inkcartridges/js/utils.js');
    assert.match(SRC, /const\s*\{\s*ProductColors,\s*ProductSort\s*\}/,
        'must destructure the real exports');
    // A hex literal in the audit would be the start of a second vocabulary.
    // The only hexes allowed are inside the regexes that DETECT other people's
    // private maps, which match on a character class, never a literal colour.
    const hexLiterals = SRC.match(/['"]#[0-9a-fA-F]{3,8}['"]/g) || [];
    assert.deepEqual(hexLiterals, [],
        `the audit must not carry colour literals of its own; found ${hexLiterals.join(', ')}`);
});

test('an unreachable or short catalogue never reports "clean"', () => {
    assert.match(SRC, /Refusing to report "clean" from a catalogue we could not read/,
        'a failed live pass must abort loudly');
    assert.match(SRC, /process\.exit\(1\)/, 'and exit non-zero');
    assert.match(SRC, /returned ZERO products/,
        'an empty catalogue must be treated as a failure, not as "no findings"');
    assert.match(SRC, /L0-catalogue-count-mismatch/,
        'a count that disagrees with meta.total must surface as a finding, not be swallowed');
    assert.match(SRC, /did not terminate on has_next=false/,
        'a truncated walk must abort');
});

test('the static pass includes the private-colour-map regression gate', () => {
    assert.match(SRC, /S5-private-colour-map/,
        'the gate that stops a FOURTH private colour map must exist');
    // It must require BOTH cyan and magenta keys — the CMYK signature. A
    // looser "any colour word" test flags admin/pages/planner.js's sticky-note
    // palette forever, which is how a check earns an exemption and dies.
    assert.match(SRC, /CYAN_KEY_RE\.test\(src\)\s*\|\|\s*!MAGENTA_KEY_RE\.test\(src\)/,
        'the gate must require both a cyan and a magenta key, not any colour-named key');
});

test('the baseline record exists and every entry is fully attributed', () => {
    assert.ok(fs.existsSync(BASELINE_PATH), 'the baseline record must be committed');
    const record = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    assert.match(String(record.captured_at), /^\d{4}-\d{2}-\d{2}$/, 'captured_at must be an absolute date');
    assert.ok(Array.isArray(record.accepted) && record.accepted.length > 0,
        'the baseline must list the findings already reported to the backend');
    for (const entry of record.accepted) {
        assert.ok(entry.check, 'every entry names the check it silences');
        assert.ok(entry.subject, 'every entry names its subject (SKU or endpoint)');
        assert.ok(entry.reason, 'every entry says why it is accepted');
        assert.match(String(entry.reported_to_backend), /^\d{4}-\d{2}-\d{2}$/,
            'every entry records WHEN it was reported — an un-dated exemption is a permanent one');
    }
});

test('the baseline fails when a recorded finding is FIXED, not just when a new one appears', () => {
    // This is the anti-rot clause and the whole reason the record is worth
    // keeping. ERR-140 was a record that stayed green while reality moved.
    assert.match(SRC, /RESOLVED[\s\S]{0,80}no longer trip/,
        'a baseline entry that stops tripping must be reported');
    assert.match(SRC, /stale\.length === 0/,
        'and must contribute to a non-zero exit');
    // …but only when the live pass actually ran, or --static would report
    // every entry as a phantom fix.
    assert.match(SRC, /STATIC_ONLY\s*\?\s*\[\]/,
        'the stale check must be skipped under --static, where nothing is swept');
});

test('the known backend defects are all recorded, so none is silently forgotten', () => {
    const record = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const subjects = new Set(record.accepted.map(a => a.subject));
    // The headline data defects found on 2026-08-03. If the backend fixes one,
    // the audit says RESOLVED and this list gets shorter — deliberately.
    for (const sku of [
        'GPG510CLR-2PK',              // a 2-pack stored as pack_type "single"
        'GPG640CLR-2PK+GPG640VPVP',   // byte-identical names, $93.99 vs $121.99
        'GCL586', 'GCL646', 'GCL661', 'GCLI36C', 'G68',  // still color="Colour"
        'GCE506A',                    // a fuser kit tagged "Colour"
        'G804CLR',                    // the handoff's own SKU — live with no image
    ]) {
        assert.ok(subjects.has(sku), `baseline must record ${sku}`);
    }
});
