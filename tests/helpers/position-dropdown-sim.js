/**
 * positionDropdown() simulator — the one copy
 * ===========================================
 *
 * Slices `positionDropdown`'s body out of inkcartridges/js/search.js and runs
 * it against a stubbed DOM, so the geometry contract is tested against the REAL
 * source rather than a paraphrase of it. Two test files drive it:
 *
 *   tests/search-dropdown-height.test.js          — the panel fills its space
 *   tests/search-dropdown-viewport-fit-sep2026.js — the panel stays ON SCREEN
 *
 * It lives in tests/helpers/ (not matched by `node --test tests/*.test.js`)
 * because a simulator that exists twice is a simulator that will disagree with
 * itself: the copy the failing test uses will be the one nobody updated.
 *
 * The stub must cover EVERY DOM surface positionDropdown touches — element
 * rects, CSS custom properties (set AND removed), the dropdown's classList, and
 * document.querySelector('.site-header'). If positionDropdown grows a new DOM
 * call, this throws rather than silently simulating something the browser does
 * not do; extend it here, in one place.
 *
 * Returns everything a caller needs to reconstruct the painted box:
 *   props      — the CSS custom properties still set at the end of the call
 *   classes    — the dropdown's class list afterwards (contains 'is-above'?)
 *   placement  — 'above' | 'below', derived from that class
 *   box        — { top, bottom, height } in viewport coordinates
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const JS_PATH = path.join(__dirname, '..', '..', 'inkcartridges', 'js', 'search.js');

function extractFunctionBody(source, signature) {
    const fnStart = source.indexOf(signature);
    if (fnStart === -1) throw new Error(`function not found in search.js: ${signature}`);
    const open = source.indexOf('{', fnStart);
    let depth = 1;
    let i = open + 1;
    while (i < source.length && depth > 0) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') depth--;
        if (depth === 0) break;
        i++;
    }
    return source.slice(open + 1, i);
}

/**
 * @param {object} opts
 * @param {number} opts.innerWidth      viewport width
 * @param {number} opts.innerHeight     viewport height
 * @param {number} opts.inputBottom     input's bottom edge, viewport coords
 * @param {number} [opts.inputHeight=40]
 * @param {number} opts.formLeft
 * @param {number} opts.formWidth
 * @param {number} [opts.headerBottom=0] bottom edge of .site-header; 0 = no header
 */
function simulatePositionDropdown({
    innerWidth,
    innerHeight,
    inputBottom,
    inputHeight = 40,
    formLeft,
    formWidth,
    headerBottom = 0,
}) {
    const props = {};
    const classes = new Set();
    const inputTop = inputBottom - inputHeight;

    const dropdown = {
        style: {
            setProperty: (k, v) => { props[k] = v; },
            removeProperty: (k) => { delete props[k]; },
        },
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c),
            toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
        },
    };

    const rect = (o) => ({ ...o, right: o.left + o.width, x: o.left, y: o.top, toJSON: () => o });
    const state = {
        input: {
            getBoundingClientRect: () => rect({
                top: inputTop, bottom: inputBottom, left: formLeft, width: formWidth, height: inputHeight,
            }),
        },
        form: {
            getBoundingClientRect: () => rect({
                top: inputTop, bottom: inputBottom, left: formLeft, width: formWidth, height: inputHeight,
            }),
        },
        dropdown,
    };

    const window = { innerWidth, innerHeight };
    const document = {
        querySelector: (sel) => {
            if (sel !== '.site-header') return null;
            if (!headerBottom) return null;
            return { getBoundingClientRect: () => rect({ top: 0, bottom: headerBottom, left: 0, width: innerWidth, height: headerBottom }) };
        },
    };

    const js = fs.readFileSync(JS_PATH, 'utf8');
    const body = extractFunctionBody(js, 'function positionDropdown(');
    // eslint-disable-next-line no-new-func
    const fn = new Function('state', 'window', 'document', body);
    fn(state, window, document);

    const maxHeight = parseInt(props['--smart-ac-max-height'], 10);
    const above = classes.has('is-above');
    let box;
    if (above) {
        const bottomVar = parseInt(props['--smart-ac-bottom'], 10);
        const bottom = innerHeight - bottomVar;
        box = { top: bottom - maxHeight, bottom, height: maxHeight };
    } else {
        const top = parseInt(props['--smart-ac-top'], 10);
        box = { top, bottom: top + maxHeight, height: maxHeight };
    }

    return { props, classes, placement: above ? 'above' : 'below', box };
}

module.exports = { simulatePositionDropdown, extractFunctionBody, JS_PATH };
