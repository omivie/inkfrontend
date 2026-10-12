/**
 * ERR-323 — clicking the Google Customer Reviews badge did nothing.
 *
 * components.css clips #google-reviews-badge to --google-badge-max (100px) to
 * hide Google's load hops. Clicking the badge grows Google's iframe to its
 * rating card (344x570 measured live), and the clip cut it to a blank corner.
 * footer.js now adds .is-settled once the 86x64 badge has landed in view, and
 * CSS lifts the clip for .is-settled.
 *
 * publishBadgeFootprint is lifted from the shipped footer.js and run in a vm
 * against each state of Google's measured load sequence.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function liftFunction(src, name) {
    const start = src.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' exists in footer.js');
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error('unbalanced ' + name);
}

const publishSrc = liftFunction(stripComments(read('js/footer.js')), 'publishBadgeFootprint');

function run(frame, opts = {}) {
    const classes = new Set(opts.settled ? ['is-settled'] : []);
    const props = {};
    const rect = (r) => ({ left: r[0], top: r[1], width: r[2], height: r[3] });
    const el = {
        getBoundingClientRect: () => rect(opts.box || frame),
        querySelector: () => (frame ? { getBoundingClientRect: () => rect(frame) } : null),
        classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) },
    };
    const document = { documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } } };
    const window = {
        innerWidth: 1440,
        getComputedStyle: (node) => (node === el
            ? { position: 'fixed' }
            : { getPropertyValue: (k) => (k === '--google-badge-max' ? ' 100px' : '') }),
    };
    vm.runInNewContext(publishSrc + '\npublishBadgeFootprint(el);', { el, window, document });
    return { settled: classes.has('is-settled'), props };
}

test('ERR-323 load hops never settle the badge (the clip must stay while they play)', () => {
    assert.equal(run([1439, -9101, 2, 2]).settled, false, '2x2 parked off-screen');
    assert.equal(run([1439, -9101, 450, 150]).settled, false, 'measuring iframe parked');
    assert.equal(run([1340, 800, 450, 150], { box: [1340, 800, 100, 100] }).settled, false, '450x150 in view');
    assert.equal(run([1340, 836, 614, 64], { box: [1340, 836, 100, 64] }).settled, false, '614x64 in view');
    assert.equal(run(null, { box: [0, 0, 0, 0] }).settled, false, 'phone: no iframe box');
});

test('ERR-323 the landed 86x64 badge settles and publishes its footprint', () => {
    const r = run([1354, 836, 86, 64]);
    assert.equal(r.settled, true);
    assert.equal(r.props['--google-badge-width'], '86px');
    assert.equal(r.props['--google-badge-height'], '64px');
});

test('ERR-323 the open card (344x570) is not republished as a footprint', () => {
    const r = run([1096, 330, 344, 570], { settled: true });
    assert.equal(r.settled, true);
    assert.deepEqual(r.props, {}, 'consent bar keeps the 86px reserve while the card is open');
});

test('ERR-323 CSS lifts the clip for .is-settled and keeps it for the load hops', () => {
    const css = stripComments(read('css/components.css'));
    assert.match(css, /#google-reviews-badge \{[^}]*max-width: var\(--google-badge-max\);[^}]*overflow: hidden;/);
    assert.match(css, /#google-reviews-badge\.is-settled \{\s*max-width: none;\s*max-height: none;\s*\}/);
});
