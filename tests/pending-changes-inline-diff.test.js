/**
 * Pending Changes — inline `old → new` diff renderer tests
 * =========================================================
 *
 * Pins the contract laid out in:
 *   readfirst/pending-changes-price-diff-spec-may2026.md
 *
 * What this file guards against:
 *
 *   §3 — Per-field formatting rules
 *        - cost_price / retail_price tinted red on rise, green on drop, with
 *          ▲ / ▼ arrows; both formatted via formatNzd.
 *        - page_yield / weight_kg shown plain with `(+delta)` annotation.
 *        - color / product_type / pack_type shown as enum chip → enum chip.
 *        - barcode middle-truncated and rendered monospace with full text in title.
 *        - name diff collapsed to one line with full text in tooltip.
 *        - image_url shown as side-by-side thumbnails with arrow (or NEW tag for ADDs).
 *
 *   §4 — Reference TypeScript: buildFieldDiffs returns { field, old, newValue, isAdd, delta }
 *        where delta is populated only for numeric fields.
 *
 *   §5 — Acceptance: a row with cost_price 4.20→4.55 and retail_price 9.99→10.99
 *        renders BOTH lines with red tint and ▲ arrows, no extra API calls.
 *
 *   §ADD — Rows with old_data === null show only the proposed value with a NEW tag.
 *
 *   §DEACTIVATE — is_active: true → false is plain text, no tint.
 *
 * Run: node --test tests/pending-changes-inline-diff.test.js
 */

'use strict';

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');
const vm      = require('node:vm');

const ROOT    = path.resolve(__dirname, '..');
const SRC     = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'admin', 'pages', 'pending-changes.js'), 'utf8');

function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
const CODE = stripComments(SRC);

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox: extract the pure helpers and run them with a stub `esc` + stub
// `resolveImageSrc`/`resolveRawImageSrc`. We do this so the formatting rules
// are tested as actual function calls (not just regex-matched), which catches
// off-by-ones the regex tests can't.
// ─────────────────────────────────────────────────────────────────────────────
function buildSandbox() {
    // Pull the helpers we need from the file. Each capture is a top-level
    // `function name(…) { … }` declaration that ends at a column-0 `}`.
    const grab = (name) => {
        const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`);
        const m = SRC.match(re);
        if (!m) throw new Error(`Could not extract function ${name} from pending-changes.js`);
        return m[0];
    };
    const sources = [
        'const PRICE_FIELDS    = new Set([\'cost_price\', \'retail_price\']);',
        'const NUMERIC_FIELDS  = new Set([\'page_yield\', \'weight_kg\']);',
        'const ENUM_FIELDS     = new Set([\'color\', \'product_type\', \'pack_type\']);',
        'const BLOCK_FIELDS    = new Set([\'name\', \'image_url\', \'description\']);',
        // Stub helpers used by the renderers.
        'function esc(s) { return String(s).replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\'); }',
        'function getChangedFields(item) { return Array.isArray(item.changed_fields) && item.changed_fields.length ? item.changed_fields : Object.keys(item.new_data || {}); }',
        'function resolveImageSrc(v) { return v ? String(v) : null; }',
        'function resolveRawImageSrc(v) { return v ? String(v) : null; }',
        grab('formatNzd'),
        grab('formatWeight'),
        grab('truncateBarcode'),
        grab('buildFieldDiffs'),
        grab('pillHtml'),
        grab('renderImageDiff'),
        grab('renderNameDiff'),
        grab('renderAddValue'),
        grab('renderInlineDiff'),
        // Surface them on the context object.
        'globalThis._exports = { formatNzd, formatWeight, truncateBarcode, buildFieldDiffs, renderInlineDiff };',
    ].join('\n');
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(sources, ctx);
    return ctx._exports;
}

const HELPERS = buildSandbox();

// ─────────────────────────────────────────────────────────────────────────────
// formatNzd
// ─────────────────────────────────────────────────────────────────────────────
test('formatNzd — two decimals, $ prefix, no thousands separator', () => {
    assert.equal(HELPERS.formatNzd(4.2), '$4.20');
    assert.equal(HELPERS.formatNzd(9.99), '$9.99');
    assert.equal(HELPERS.formatNzd(10.99), '$10.99');
    assert.equal(HELPERS.formatNzd(0), '$0.00');
});

test('formatNzd — coerces strings, defends against junk', () => {
    assert.equal(HELPERS.formatNzd('4.55'), '$4.55');
    assert.equal(HELPERS.formatNzd(null), '$0.00');
    assert.equal(HELPERS.formatNzd(undefined), '$0.00');
    assert.equal(HELPERS.formatNzd('not a number'), '$0.00');
});

// ─────────────────────────────────────────────────────────────────────────────
// truncateBarcode — leaves short values alone, middle-truncates long ones
// ─────────────────────────────────────────────────────────────────────────────
test('truncateBarcode — short barcodes pass through unchanged', () => {
    assert.equal(HELPERS.truncateBarcode('9421234567890'), '9421234567890'); // 13 chars
    assert.equal(HELPERS.truncateBarcode(''), '');
    assert.equal(HELPERS.truncateBarcode('942112345678901234'), '942112345678901234'); // 18 chars, ≤24
});

test('truncateBarcode — long barcodes get middle-ellipsis (12 + … + 12)', () => {
    const long = '1234567890ABCDEFGHIJKLMNOPQRSTUV'; // 32 chars
    const out  = HELPERS.truncateBarcode(long);
    assert.equal(out, '1234567890AB…KLMNOPQRSTUV');
    assert.equal(out.split('…')[0].length, 12);
    assert.equal(out.split('…')[1].length, 12);
});

// ─────────────────────────────────────────────────────────────────────────────
// buildFieldDiffs — shape contract from spec §4
// ─────────────────────────────────────────────────────────────────────────────
test('buildFieldDiffs — UPDATE row produces { field, old, newValue, isAdd:false, delta }', () => {
    const diffs = HELPERS.buildFieldDiffs({
        change_type: 'UPDATE',
        changed_fields: ['cost_price', 'retail_price'],
        old_data: { cost_price: 4.20, retail_price: 9.99 },
        new_data: { cost_price: 4.55, retail_price: 10.99 },
    });
    assert.equal(diffs.length, 2);
    // Individual field checks (vm context objects fail deepStrictEqual prototype check).
    assert.equal(diffs[0].field, 'cost_price');
    assert.equal(diffs[0].old, 4.20);
    assert.equal(diffs[0].newValue, 4.55);
    assert.equal(diffs[0].isAdd, false);
    assert.equal(diffs[0].delta, 0.35);
    assert.equal(diffs[1].field, 'retail_price');
    assert.equal(diffs[1].old, 9.99);
    assert.equal(diffs[1].newValue, 10.99);
    assert.equal(diffs[1].isAdd, false);
    assert.equal(diffs[1].delta, 1.00);
});

test('buildFieldDiffs — ADD row sets isAdd:true, old:null, no delta', () => {
    const diffs = HELPERS.buildFieldDiffs({
        change_type: 'ADD',
        changed_fields: ['cost_price', 'name'],
        old_data: null,
        new_data: { cost_price: 4.55, name: 'Compatible Ink Cartridge Replacement for Epson NEW Black' },
    });
    assert.equal(diffs[0].isAdd, true);
    assert.equal(diffs[0].old, null);
    assert.equal(diffs[0].newValue, 4.55);
    assert.equal(diffs[0].delta, undefined);
    assert.equal(diffs[1].isAdd, true);
    assert.equal(diffs[1].old, null);
});

test('buildFieldDiffs — DEACTIVATE row preserves boolean old/new', () => {
    const diffs = HELPERS.buildFieldDiffs({
        change_type: 'DEACTIVATE',
        changed_fields: ['is_active'],
        old_data: { is_active: true },
        new_data: { is_active: false },
    });
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].field, 'is_active');
    assert.equal(diffs[0].old, true);
    assert.equal(diffs[0].newValue, false);
    assert.equal(diffs[0].isAdd, false);
    assert.equal(diffs[0].delta, undefined); // booleans aren't numbers
});

// ─────────────────────────────────────────────────────────────────────────────
// renderInlineDiff — §3 per-field formatting + §5 acceptance
// ─────────────────────────────────────────────────────────────────────────────
test('§3 / §5 cost_price rise → red tint + ▲ arrow', () => {
    const html = HELPERS.renderInlineDiff({
        field: 'cost_price', old: 4.20, newValue: 4.55, isAdd: false, delta: 0.35,
    });
    assert.match(html, /pc-diff--up/, 'rising price must apply pc-diff--up tint class');
    assert.match(html, /\$4\.20/);
    assert.match(html, /\$4\.55/);
    assert.match(html, /▲/, 'rising price must show up-arrow');
    assert.match(html, /pc-row__field-chip[^>]*>cost_price</);
    assert.doesNotMatch(html, /▼/);
});

test('§3 / §5 retail_price rise → red tint + ▲ arrow', () => {
    const html = HELPERS.renderInlineDiff({
        field: 'retail_price', old: 9.99, newValue: 10.99, isAdd: false, delta: 1.00,
    });
    assert.match(html, /pc-diff--up/);
    assert.match(html, /\$9\.99/);
    assert.match(html, /\$10\.99/);
    assert.match(html, /▲/);
});

test('§3 cost_price drop → green tint + ▼ arrow', () => {
    const html = HELPERS.renderInlineDiff({
        field: 'cost_price', old: 4.55, newValue: 4.20, isAdd: false, delta: -0.35,
    });
    assert.match(html, /pc-diff--down/, 'dropping price must apply pc-diff--down tint class');
    assert.match(html, /▼/);
    assert.doesNotMatch(html, /▲/);
});

test('§3 cost_price unchanged → neutral tint, no arrow', () => {
    const html = HELPERS.renderInlineDiff({
        field: 'cost_price', old: 4.20, newValue: 4.20, isAdd: false, delta: 0,
    });
    assert.match(html, /pc-diff--neutral/);
    assert.doesNotMatch(html, /▲/);
    assert.doesNotMatch(html, /▼/);
});

test('§3 page_yield → plain text + delta in parens, no tint', () => {
    const html = HELPERS.renderInlineDiff({
        field: 'page_yield', old: 850, newValue: 1000, isAdd: false, delta: 150,
    });
    assert.match(html, /850/);
    assert.match(html, /1000/);
    assert.match(html, /\(\+150\)/, 'delta must render as (+150)');
    assert.doesNotMatch(html, /pc-diff--up/);
    assert.doesNotMatch(html, /pc-diff--down/);
    assert.doesNotMatch(html, /▲/);
});

test('§3 weight_kg → 2dp formatted with delta', () => {
    const html = HELPERS.renderInlineDiff({
        field: 'weight_kg', old: 0.10, newValue: 0.20, isAdd: false, delta: 0.10,
    });
    assert.match(html, /0\.10/);
    assert.match(html, /0\.20/);
    assert.match(html, /\(\+0\.10\)/);
});

test('§3 enum field (color) → enum chip → enum chip', () => {
    const html = HELPERS.renderInlineDiff({
        field: 'color', old: 'Black', newValue: 'Cyan', isAdd: false,
    });
    const chipCount = (html.match(/pc-diff__enum/g) || []).length;
    assert.equal(chipCount, 2, 'must render two enum chips');
    assert.match(html, /Black/);
    assert.match(html, /Cyan/);
});

test('§3 enum field (product_type, pack_type) treated identically', () => {
    for (const field of ['product_type', 'pack_type']) {
        const html = HELPERS.renderInlineDiff({ field, old: 'a', newValue: 'b', isAdd: false });
        assert.equal((html.match(/pc-diff__enum/g) || []).length, 2, `${field} must use enum chips`);
    }
});

test('§3 barcode → monospace + middle-truncated + full value in title', () => {
    const longOld = '11111111111111111111AAAA'; // 24 chars — at threshold
    const longNew = '22222222222222222222BBBB55555'; // 29 chars — over threshold
    const html = HELPERS.renderInlineDiff({
        field: 'barcode', old: longOld, newValue: longNew, isAdd: false,
    });
    assert.match(html, /pc-diff__values--mono/, 'barcode diff must use mono font');
    assert.match(html, new RegExp(`title="${longOld}"`), 'old barcode full value in title attr');
    assert.match(html, new RegExp(`title="${longNew}"`), 'new barcode full value in title attr');
    // Long value must be truncated; short one passes through.
    // 29-char input → first 12 + … + last 12.
    assert.match(html, /222222222222…222BBBB55555/, 'long barcode middle-truncated to 12 + … + 12');
});

test('§3 name → collapsed one-liner with old → new and tooltip carrying both', () => {
    const html = HELPERS.renderInlineDiff({
        field: 'name',
        old: 'Compatible Ink Cartridge Replacement for Brother LC432XL Black',
        newValue: 'Compatible Ink Cartridge Replacement for Brother LC432XL Cyan',
        isAdd: false,
    });
    assert.match(html, /pc-diff__name/);
    assert.match(html, /pc-diff--block/, 'name diff must wrap to its own line below the pill');
    assert.match(html, /title="OLD:[\s\S]*Brother LC432XL Black[\s\S]*NEW:[\s\S]*Brother LC432XL Cyan"/,
        'tooltip must carry both old and new full text');
});

test('§3 image_url → side-by-side thumbs with arrow, click-to-zoom data-* attrs', () => {
    const html = HELPERS.renderInlineDiff({
        field: 'image_url',
        old: 'https://cdn.example.com/old.jpg',
        newValue: 'https://cdn.example.com/new.jpg',
        isAdd: false,
    });
    assert.match(html, /pc-diff__images/);
    const thumbs = (html.match(/pc-diff__thumb/g) || []).length;
    assert.ok(thumbs >= 2, `image_url UPDATE must render two thumbnails (got ${thumbs})`);
    assert.match(html, /data-zoom="https:\/\/cdn\.example\.com\/old\.jpg"/);
    assert.match(html, /data-zoom="https:\/\/cdn\.example\.com\/new\.jpg"/);
    assert.match(html, /<span class="pc-diff__arrow">→<\/span>/, 'arrow between thumbs');
});

// ─────────────────────────────────────────────────────────────────────────────
// ADD rows — show only the proposed value + (NEW) tag
// ─────────────────────────────────────────────────────────────────────────────
test('ADD row, cost_price → shows formatted price + NEW tag, no arrow', () => {
    const html = HELPERS.renderInlineDiff({
        field: 'cost_price', old: null, newValue: 4.55, isAdd: true,
    });
    assert.match(html, /pc-diff--add/);
    assert.match(html, /\$4\.55/);
    assert.match(html, /pc-diff__new-tag[^>]*>NEW</);
    assert.doesNotMatch(html, /▲/);
    assert.doesNotMatch(html, /▼/);
    assert.doesNotMatch(html, /→/, 'ADD row must not show an arrow');
});

test('ADD row, name → renders the proposed name with NEW tag, full text in tooltip', () => {
    const proposed = 'Compatible Ink Cartridge Replacement for Epson NEW Black';
    const html = HELPERS.renderInlineDiff({
        field: 'name', old: null, newValue: proposed, isAdd: true,
    });
    assert.match(html, /pc-diff__new-tag[^>]*>NEW</);
    assert.match(html, new RegExp(`title="${proposed}"`));
    assert.match(html, new RegExp(proposed));
});

test('ADD row, image_url → shows the new thumb with NEW tag, no old slot', () => {
    const html = HELPERS.renderInlineDiff({
        field: 'image_url', old: null, newValue: 'https://cdn.example.com/new.jpg', isAdd: true,
    });
    const thumbs = (html.match(/pc-diff__thumb/g) || []).length;
    assert.equal(thumbs, 1, 'ADD row must render only the new thumbnail');
    assert.match(html, /pc-diff__new-tag[^>]*>NEW</);
    assert.doesNotMatch(html, /<span class="pc-diff__arrow">→<\/span>/, 'no arrow when there is no old image');
});

// ─────────────────────────────────────────────────────────────────────────────
// DEACTIVATE rows — is_active: true → false, plain, no tint
// ─────────────────────────────────────────────────────────────────────────────
test('DEACTIVATE row → is_active: true → false plain, no tint', () => {
    const html = HELPERS.renderInlineDiff({
        field: 'is_active', old: true, newValue: false, isAdd: false,
    });
    assert.match(html, /pc-row__field-chip[^>]*>is_active</);
    assert.match(html, /<span class="pc-diff__old">true<\/span>/);
    assert.match(html, /<span class="pc-diff__new">false<\/span>/);
    assert.doesNotMatch(html, /pc-diff--up/);
    assert.doesNotMatch(html, /pc-diff--down/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Wiring — renderRow uses buildFieldDiffs + renderInlineDiff (no extra fetches)
// ─────────────────────────────────────────────────────────────────────────────
test('renderRow uses buildFieldDiffs + renderInlineDiff (replaces chip-only path)', () => {
    const m = CODE.match(/function renderRow\(item\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(m, 'renderRow must exist');
    const body = m[1];
    assert.match(body, /buildFieldDiffs\(item\)/, 'renderRow must call buildFieldDiffs(item)');
    assert.match(body, /renderInlineDiff/, 'renderRow must map diffs through renderInlineDiff');
});

test('Render-only — no new API call sites added in pending-changes.js', () => {
    // Spec §6: backend response is byte-identical, no extra fetches. The
    // only AdminAPI call sites for fetching list/summary should remain
    // exactly the two pre-existing ones.
    const fetchCalls = (CODE.match(/AdminAPI\.getPendingChanges\b/g) || []).length;
    const summaryCalls = (CODE.match(/AdminAPI\.getPendingChangesSummary\b/g) || []).length;
    assert.equal(fetchCalls, 1, 'expect exactly one getPendingChanges call site');
    assert.equal(summaryCalls, 1, 'expect exactly one getPendingChangesSummary call site');
});

test('CSS — diff styles include tint classes, arrow, NEW tag, thumb', () => {
    const styles = SRC.match(/\.pc-diff[\s\S]*?--down[\s\S]*?\}/);
    assert.ok(styles, 'pc-diff style block must exist');
    assert.match(SRC, /\.pc-diff--up\b[^{]*\{[^}]*color:\s*var\(--danger\)/, 'up tint must use --danger color');
    assert.match(SRC, /\.pc-diff--down\b[^{]*\{[^}]*color:\s*var\(--success\)/, 'down tint must use --success color');
    assert.match(SRC, /\.pc-diff__new-tag[^{]*\{/, 'NEW tag style must exist');
    assert.match(SRC, /\.pc-diff__thumb img[^{]*\{[^}]*32px/, 'thumb size must be 32px (per spec §3 image_url row)');
});
