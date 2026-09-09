/**
 * ERR-235 — the checkout delivery area, and the dead end in front of it
 * ====================================================================
 *
 * Mobile recorded 0 completed checkouts against 36 starts over 120 days. One of
 * the reasons was this: NEITHER delivery_type radio was `checked`, both were
 * `required`, and three separate JS gates refused to advance without a
 * selection — while every price on the page was ALREADY being quoted as urban
 * via `...:checked')?.value || 'urban'`. The form displayed an urban quote and
 * then refused to accept the state it was displaying.
 *
 * Two things this suite exists to stop coming back:
 *
 *   1. The hand-off's proposed fix — add `checked` to the markup — was a no-op,
 *      because init()'s first statement was
 *      `querySelectorAll('input[name="delivery_type"]').forEach(r => r.checked = false)`.
 *      An attribute in the HTML was wiped before the page settled. §2 pins that
 *      the clear is gone AND that its real purpose (autofill must not silently
 *      select the expensive option) is kept.
 *
 *   2. The rural-address rule now exists in two files. §3 is the thing that
 *      stops them drifting — it extracts BOTH literals and compares them
 *      character for character, then runs both through the same case table.
 *      This is the pattern admin-invoice-quote-aug2026.test.js §4 already uses
 *      for Business.formatPercent, and it is used here for the same reason:
 *      invoice-quote.js is an ES module whose suite runs it in a vm sandbox
 *      with every `import` STRIPPED, so it cannot import the shared copy.
 *
 * Source-text assertions cannot prove a box is on screen or that a form can be
 * submitted — `npm run probe:checkout-delivery` measures that in a browser.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const CHECKOUT_HTML = fs.readFileSync(path.join(ROOT, 'html', 'checkout.html'), 'utf8');
const ADDRESSES_HTML = fs.readFileSync(path.join(ROOT, 'html', 'account', 'addresses.html'), 'utf8');
const CHECKOUT_JS = fs.readFileSync(path.join(ROOT, 'js', 'checkout-page.js'), 'utf8');
const ACCOUNT_JS = fs.readFileSync(path.join(ROOT, 'js', 'account.js'), 'utf8');
const UTILS_JS = fs.readFileSync(path.join(ROOT, 'js', 'utils.js'), 'utf8');
const QUOTE_JS = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'utils', 'invoice-quote.js'), 'utf8');
const COMPACT_CSS = fs.readFileSync(path.join(ROOT, 'css', 'checkout-compact.css'), 'utf8');

/** Comments explain; only code counts when asserting something is WIRED. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const CHECKOUT_CODE = stripComments(CHECKOUT_JS);
const ACCOUNT_CODE = stripComments(ACCOUNT_JS);

/** Brace-match a method body out of a source file. */
function fnBody(src, signature) {
    const start = src.indexOf(signature);
    assert.notEqual(start, -1, `not found: ${signature}`);
    // Start from the signature's OWN trailing brace. Scanning for the first
    // `{` after `start` finds the `{}` of a destructured default instead —
    // `getPopularProducts(params = {})` then "closes" immediately and the body
    // is empty, so every assertion about it fails for the wrong reason (or, far
    // worse, a doesNotMatch passes vacuously).
    const i = start + signature.length - 1;
    assert.equal(src[i], '{', `fnBody signature must end at its opening brace: ${signature}`);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error(`unbalanced braces after ${signature}`);
}

/** Run the real DeliveryArea object out of utils.js, without the other 3700 lines. */
function loadDeliveryArea() {
    const block = fnBody(UTILS_JS, 'const DeliveryArea = {');
    const sandbox = { RegExp, String, Boolean, Object };
    vm.createContext(sandbox);
    vm.runInContext(`${block};\nglobalThis.__DA = DeliveryArea;`, sandbox);
    return sandbox.__DA;
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — the markup the shopper actually gets
// ─────────────────────────────────────────────────────────────────────────────

test('§1 Urban is pre-selected and Rural is not', () => {
    const urban = CHECKOUT_HTML.match(/<input[^>]*name="delivery_type"[^>]*value="urban"[^>]*>/);
    const rural = CHECKOUT_HTML.match(/<input[^>]*name="delivery_type"[^>]*value="rural"[^>]*>/);
    assert.ok(urban && rural, 'both delivery options must exist');

    assert.match(urban[0], /\schecked\b/,
        'urban must be pre-selected — the page already quotes the urban rate on load via the '
        + "`|| 'urban'` fallback in fetchShippingFromAPI, so this makes the form agree with the "
        + 'number it is showing rather than blocking on it');
    assert.doesNotMatch(rural[0], /\schecked\b/,
        'rural is the more expensive option and must never be the default');

    // Positive control: the matcher can see a `checked` when there is one.
    assert.match(urban[0], /name="delivery_type"/, 'sanity — the captured tag is the right one');
});

test('§1 each option carries a price element, and the markup does not fill it in', () => {
    const prices = CHECKOUT_HTML.match(/class="delivery-type-option__price"[^>]*>/g) || [];
    assert.equal(prices.length, 2, 'both Urban and Rural need a price line');
    for (const v of ['urban', 'rural']) {
        assert.match(CHECKOUT_HTML, new RegExp(`delivery-type-option__price" data-delivery-price="${v}"></span>`),
            `the ${v} price must be EMPTY in the markup — it is filled from the backend's own `
            + 'quote at runtime. A number hardcoded here would be a price the frontend invented');
    }
    // The class was styled before any element ever carried it.
    assert.match(COMPACT_CSS, /\.delivery-type-option__price\s*\{/,
        'the style this element finally uses');
    assert.match(COMPACT_CSS, /\.delivery-type-option__price:empty\s*\{\s*display:\s*none/,
        'an unknown price must COLLAPSE, not render as an empty line or a $0.00 — absence is '
        + 'not zero (ERR-063/149/150)');
});

test('§1 the rural auto-detect has somewhere to speak', () => {
    assert.match(CHECKOUT_HTML, /id="delivery-type-notice"[^>]*aria-live="polite"/,
        'moving a price-affecting field silently is indistinguishable from a bug; the change '
        + 'has to be announced, and announced to a screen reader too');
    assert.match(CHECKOUT_HTML, /id="delivery-type-notice"[^>]*hidden/,
        'and it starts empty rather than reserving a blank strip');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — the clear that made the obvious fix a no-op
// ─────────────────────────────────────────────────────────────────────────────

test('§2 init() no longer clears the radios, and the blanket clear cannot come back', () => {
    assert.doesNotMatch(CHECKOUT_CODE, /forEach\(r => r\.checked = false\)/,
        'this line ran as the FIRST statement of init() and wiped the `checked` attribute on '
        + 'every load — it is why simply adding `checked` to the HTML fixed nothing');
    assert.match(CHECKOUT_CODE, /this\._normaliseDeliveryType\(\);/,
        'init() must normalise the group to exactly one selection instead');
});

test('§2 the autofill defence the old line existed for is KEPT', () => {
    // The clear was not arbitrary: browser autofill can select for the shopper,
    // and landing on Rural silently doubles their freight. Dropping the EMPTY
    // state is the change; dropping the defence would be a regression.
    const fn = fnBody(CHECKOUT_JS, '_normaliseDeliveryType() {');
    assert.match(fn, /r\.checked = \(r\.value === DeliveryArea\.URBAN\)/,
        'normalise must ASSERT urban rather than merely fill a blank — otherwise an autofilled '
        + 'Rural survives and the shopper is quoted double without choosing it');
    assert.match(fn, /_deliveryTypeUserChosen = false/, 'and it resets the "a person chose" flag');
});

test('§2 only a real user interaction sets the user-chosen flag', () => {
    const fn = fnBody(CHECKOUT_JS, 'setupShippingHandlers() {');
    assert.match(fn, /this\._deliveryTypeUserChosen = true;/,
        'the change listener is the honest place to record a decision: assigning .checked in '
        + 'script does not fire `change`, so this flag can only be set by a person');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — ONE rural rule, in two files, pinned equal
// ─────────────────────────────────────────────────────────────────────────────

test('§3 the rural regex is character-for-character identical in both copies', () => {
    const mine = UTILS_JS.match(/RURAL_RE:\s*(\/[^\n]*?\/[a-z]*),/);
    const theirs = QUOTE_JS.match(/hint\.delivery_type = (\/[^\n]*?\/[a-z]*)\.test\(text\)/);
    assert.ok(mine, 'utils.js must declare DeliveryArea.RURAL_RE');
    assert.ok(theirs, 'invoice-quote.js must still decide delivery_type from a regex');

    assert.equal(mine[1], theirs[1],
        'A DELIBERATE PORT, pinned. invoice-quote.js is an ES module whose suite strips every '
        + '`import` before running it in a vm, so it cannot import the shared copy — the same '
        + 'trade already taken for Business.formatPercent. THIS assertion is what stops the two '
        + 'drifting, so if you "tidy" one side (the third alternative is subsumed by the '
        + 'second), tidy both in the same commit.');
});

test('§3 and both copies agree on real New Zealand addresses', () => {
    // Character equality is necessary, not sufficient — a regex can be identical
    // and still be applied differently. Run both through the same table.
    const DA = loadDeliveryArea();
    const theirs = new RegExp(
        QUOTE_JS.match(/hint\.delivery_type = \/([^\n]*?)\/([a-z]*)\.test\(text\)/)[1],
        QUOTE_JS.match(/hint\.delivery_type = \/([^\n]*?)\/([a-z]*)\.test\(text\)/)[2]);

    const cases = [
        ['123 Great North Road, Auckland 1021', false],
        ['45 Someplace Road, RD 2, Kaiwaka 0573', true],
        ['45 Someplace Road, RD2, Kaiwaka', true],
        ['12 Rural Delivery Lane, Whangarei', true],
        ['9 Rd Street, Christchurch', false],   // "Rd" with no number is a road, not a route
        ['1234 Great North Road', false],       // a street number is not an RD number
        ['', false],
    ];
    for (const [addr, expected] of cases) {
        assert.equal(DA.looksRural(addr), expected, `DeliveryArea on: ${addr || '(empty)'}`);
        assert.equal(theirs.test(addr), expected, `invoice-quote copy on: ${addr || '(empty)'}`);
    }
});

test('§3 classify() answers urban/rural, classifyOrNull() refuses to guess', () => {
    const DA = loadDeliveryArea();
    assert.equal(DA.classify('RD 3, Levin'), 'rural');
    assert.equal(DA.classify('1 Queen St'), 'urban');
    // Absence of a rural token is not evidence of an urban address.
    assert.equal(DA.classifyOrNull(''), null);
    assert.equal(DA.classifyOrNull('   '), null);
    assert.equal(DA.classifyOrNull(undefined), null);
    assert.equal(DA.classifyOrNull('1 Queen St'), 'urban');
});

test('§3 DeliveryArea is actually exported — the ERR-167 check', () => {
    // `Security` and `Config` are bare consts that never reached window, and
    // every `window.X?.` guard around them was a silent off switch. account.js
    // reads `typeof DeliveryArea === 'undefined'`, so this must really exist.
    assert.match(UTILS_JS, /if \(typeof window !== 'undefined'\) window\.DeliveryArea = DeliveryArea;/,
        'the global assignment must be present, not assumed');
    assert.match(UTILS_JS, /\n\s*DeliveryArea\n\s*\};/,
        'and it must be in the module.exports list so node tests can reach it');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — the auto-detect: upgrades only, never over a person, never silent
// ─────────────────────────────────────────────────────────────────────────────

test('§4 the hint only ever UPGRADES, and only withdraws what it set itself', () => {
    const fn = fnBody(CHECKOUT_JS, '_applyRuralHint() {');
    assert.match(fn, /if \(this\._deliveryTypeUserChosen\) return;/,
        'a person who chose is never overridden');
    assert.match(fn, /this\._deliveryTypeAuto && this\._setDeliveryType\(DeliveryArea\.URBAN\)/,
        'it must withdraw ONLY a choice it made itself — an automatic selection that cannot be '
        + 'automatically withdrawn is a typo that overcharges forever');
    assert.match(fn, /_announceDeliveryNotice\(/,
        'and every switch it makes is announced');
});

test('§4 the announcement names the token it matched', () => {
    const fn = fnBody(CHECKOUT_JS, '_applyRuralHint() {');
    assert.match(fn, /DeliveryArea\.RURAL_RE\.exec\(text\)/,
        'exec, not test — the shopper is told WHICH part of their address triggered this, so a '
        + 'wrong guess is obvious to them rather than mysterious');
    assert.match(fn, /match\[0\]/, 'and the matched text is what gets shown');
});

test('§4 the notice is set as text, never as HTML', () => {
    const fn = fnBody(CHECKOUT_JS, '_announceDeliveryNotice(text) {');
    assert.match(fn, /\.textContent = text \|\| ''/,
        'the matched substring comes from a user-typed address — textContent, never innerHTML');
    assert.doesNotMatch(fn, /innerHTML/, 'no innerHTML anywhere near shopper-supplied text');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — the prices are the backend's
// ─────────────────────────────────────────────────────────────────────────────

test('§5 both delivery prices come from the backend, one quote each', () => {
    const fn = fnBody(CHECKOUT_JS, 'async _refreshDeliveryPrices() {');
    assert.match(fn, /API\.getShippingOptions\(/,
        'the figures are quoted by POST /api/shipping/options for THIS cart — weight-aware and '
        + 'free-shipping-aware. cart.js:12 is explicit that the frontend never computes prices');
    assert.match(fn, /ask\(DeliveryArea\.URBAN\), ask\(DeliveryArea\.RURAL\)/,
        'one call per area, so neither label is inferred from the other');
    assert.doesNotMatch(fn, /[*/]\s*1\.15|\+\s*fee|fee\s*\*/,
        'no arithmetic on a fee — printing a number we derived is the same defect as inventing one');
});

test('§5 a price we could not get renders EMPTY, never zero', () => {
    const fn = fnBody(CHECKOUT_JS, 'async _refreshDeliveryPrices() {');
    assert.match(fn, /fee == null \? '' :/,
        'unknown must be empty; :empty then hides the line. "$0.00" would read as FREE');
    assert.match(fn, /fee === 0 \? 'FREE'/,
        'and a real zero from the backend is honestly FREE');
    assert.match(fn, /this\._deliveryPriceKey = null;/,
        'a failed lookup must not be cached, or one blip freezes the labels for the session');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — the two smaller defects found on the way
// ─────────────────────────────────────────────────────────────────────────────

test('§6 restoreCheckoutState puts the delivery area back', () => {
    const fn = fnBody(CHECKOUT_JS, 'restoreCheckoutState() {');
    assert.match(fn, /state\.deliveryType/,
        'deliveryType has always ridden in checkoutData and was never read back, so a shopper '
        + 'who reached /payment and tapped back silently lost a price-affecting choice');
    assert.match(fn, /this\._deliveryTypeUserChosen = true;/,
        'a restored choice is a deliberate one — nothing may auto-select over it');
});

test('§6 the duplicate-error guard asks about the element it appends to', () => {
    const fn = fnBody(CHECKOUT_JS, 'validateFormFields(form) {');
    assert.doesNotMatch(fn, /if \(!container\.querySelector\('\.form-error'\)\)/,
        'this read `container` while appending to `container.parentElement`, so the guard never '
        + 'saw the message it had just created and stacked a fresh "Please select an option" on '
        + 'every failed click');
    assert.match(fn, /if \(!container\.parentElement\.querySelector\('\.form-error'\)\)/,
        'ask the element you append to');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — saved addresses stopped lying
// ─────────────────────────────────────────────────────────────────────────────

test('§7 the addresses form finally HAS the control account.js was reading', () => {
    assert.match(ADDRESSES_HTML, /id="address-delivery-type"/,
        'account.js:saveAddress has always read input[name="delivery_type"]:checked on this page '
        + 'and there was no such input, so it fell through to `|| \'urban\'` on EVERY save — every '
        + 'address in every account was stored as urban whatever the truth was');
    for (const v of ['urban', 'rural']) {
        assert.match(ADDRESSES_HTML, new RegExp(`name="delivery_type" value="${v}"`),
            `the ${v} option must exist on the addresses form`);
    }
    assert.match(ADDRESSES_HTML, /value="urban"[^>]*checked/,
        'same default as checkout — one behaviour, two surfaces');
});

test('§7 both account.js reads are scoped to the modal', () => {
    // An unscoped document query is what made this a silent no-op for so long.
    const unscoped = ACCOUNT_CODE.match(/document\.querySelector\(`?'?input\[name="delivery_type"\]/g) || [];
    assert.deepEqual(unscoped, [],
        'every delivery_type lookup in account.js must be scoped to #address-delivery-type');
    assert.match(ACCOUNT_CODE, /#address-delivery-type input\[name="delivery_type"\]:checked/,
        'saveAddress reads the scoped control');
});

test('§7 the addresses form uses the SAME rule, not a second copy of it', () => {
    const fn = fnBody(ACCOUNT_JS, '_applyAddressRuralHint() {');
    assert.match(fn, /DeliveryArea\.RURAL_RE/,
        'it must ask the shared rule — a third copy of the regex is exactly what §3 forbids');
    assert.doesNotMatch(ACCOUNT_JS, /\\brd\\s\*\\d\\b/,
        'and account.js must not spell the pattern itself');
    assert.match(fn, /if \(this\._addressDeliveryUserChosen\) return;/,
        'same three rules as checkout: upgrade only, never over a person, never silently');
});

test('§7 checkout trusts a saved address again, and says why', () => {
    const fn = fnBody(CHECKOUT_JS, 'fillAddressFields(address) {');
    assert.doesNotMatch(fn, /Do NOT auto-select delivery type/,
        'that refusal was correct while the stored value was always fiction; it is not now');
    assert.match(fn, /if \(address\.delivery_type\) \{\s*\n\s*this\._setDeliveryType\(address\.delivery_type\);/,
        'a saved address carries a real answer about the customer\'s own address');
    assert.match(fn, /this\._applyRuralHint\(\);/,
        'and the address text can still upgrade it');
});
