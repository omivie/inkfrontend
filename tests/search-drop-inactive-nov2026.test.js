/**
 * ERR-378 — deactivated products must not show in search.
 *
 * The backend's /api/search/smart and /api/search/suggest returned products the
 * owner had deactivated (72778.01, 670.01 on 2026-11-09) while their product
 * page already 404'd. API.dropInactiveRows filters a result set with ONE
 * PostgREST read (`is_active=eq.true&id=in.(…)`); every search surface uses it.
 *
 * The method is EXECUTED (extracted from api.js, fetch stubbed), not grepped.
 *
 * Run: node --test tests/search-drop-inactive-nov2026.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INK = path.join(__dirname, '..', 'inkcartridges', 'js');
const api = fs.readFileSync(path.join(INK, 'api.js'), 'utf8');
const search = fs.readFileSync(path.join(INK, 'search.js'), 'utf8');

/** Brace-matched `async name(...) {...}` method from an object literal. */
function method(src, name) {
    const start = src.indexOf(`async ${name}(`);
    assert.notEqual(start, -1, `${name} must exist`);
    let depth = 0;
    for (let i = src.indexOf('{', src.indexOf(')', start)); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function build(anonRest) {
    const Config = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'ANON' };
    // eslint-disable-next-line no-new-func
    const make = new Function('Config', `return { ${method(api, 'dropInactiveRows')} };`);
    const obj = make(Config);
    obj.calls = [];
    obj.getToken = async () => 'ADMIN_JWT';
    obj._anonRest = async (url, init) => { obj.calls.push({ url, init }); return anonRest(url, init); };
    return obj;
}

test('drops rows the database does not return as active, in ONE request', async () => {
    const api1 = build(async () => ({ ok: true, rows: [{ id: A }, { id: C }] }));
    const out = await api1.dropInactiveRows([{ id: A, sku: '1' }, { id: B, sku: '72778.01' }, { id: C, sku: '3' }]);
    assert.deepEqual(out.rows.map(r => r.sku), ['1', '3']);
    assert.equal(out.checked, true);
    assert.equal(out.removed, 1);
    assert.equal(api1.calls.length, 1);
    assert.match(api1.calls[0].url, /is_active=eq\.true/);
    assert.match(api1.calls[0].url, new RegExp(`id=in\\.\\(${A},${B},${C}\\)`));
    assert.equal(api1.calls[0].init.headers.Authorization, 'Bearer ANON');
});

test('admin mirror sends the admin token so admin-only rows survive', async () => {
    const api1 = build(async () => ({ ok: true, rows: [{ id: A }] }));
    await api1.dropInactiveRows([{ id: A }], false);
    assert.equal(api1.calls[0].init.headers.Authorization, 'Bearer ADMIN_JWT');
});

test('a failed check keeps every row and says so (fail-soft, loud)', async () => {
    const api1 = build(async () => ({ ok: false, code: 'TIMEOUT' }));
    const rows = [{ id: A }, { id: B }];
    const out = await api1.dropInactiveRows(rows);
    assert.equal(out.rows.length, 2);
    assert.equal(out.checked, false);
});

test('no ids means no request', async () => {
    const api1 = build(async () => { throw new Error('must not be called'); });
    const out = await api1.dropInactiveRows([]);
    assert.equal(out.checked, true);
    assert.equal(api1.calls.length, 0);
});

test('every search surface routes through dropInactiveRows', () => {
    assert.match(method(api, 'smartSearch'), /dropInactiveRows\(res\.data\.products, route\.anonymous\)/);
    assert.match(method(api, 'searchSuggest'), /dropInactiveRows\(res\.data\.suggestions, suggestRoute\.anonymous\)/);
    const fetchSmart = method(search, 'function fetchSmart');
    assert.match(fetchSmart, /API\.dropInactiveRows\(items, route\.anonymous\)/);
    assert.match(fetchSmart, /if \(inactiveCheck !== 'failed'\) cacheSet\(query, answer\)/);
});
