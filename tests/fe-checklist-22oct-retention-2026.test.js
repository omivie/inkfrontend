/**
 * FE checklist 2026-10-22 — retention + SEO housekeeping (ERR-372)
 * =============================================================================
 *   §38  confirmation page: ONE "Remind me when it's time to reorder" card,
 *        shown only when the order's reminder_consent_at is null (absent ≠
 *        null) and the order is not cancelled; one POST; the backend's five
 *        outcome lines; the printer card is not a second ask.
 *   §40  reorder reminders: one shared module (PDP + account), pure copy and
 *        interval rules, the corrected ?subscription= toasts, and the
 *        signed-out /cart?reorder= sign-in line.
 *   §39  admin Retention tab: "—" for null, "n of m · x%", small-sample rules.
 *   §42  noindex on /quote, /track-order, /account; the SPA printer description
 *        mirrors buildPrinterPageMeta (≤155, whole sentences, skip-and-continue).
 *
 * Run: node --test tests/fe-checklist-22oct-retention-2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, 'inkcartridges', rel), 'utf8');

function methodSrc(src, name) {
    const re = new RegExp(`\\n\\s+(?:async\\s+)?${name}(?:\\s*:\\s*(?:async\\s+)?function)?\\s*\\(([^)]*)\\)\\s*\\{`);
    const m = re.exec(src);
    assert.ok(m, `${name}() must exist`);
    const open = m.index + m[0].length - 1;
    let depth = 0; let q = null;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '\'' || c === '"' || c === '`') { q = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return { params: m[1], body: src.slice(open, i + 1), async: /async/.test(m[0]) };
    }
    throw new Error(`unbalanced ${name}`);
}
function method(file, name, self = {}, globals = {}) {
    const { params, body, async } = methodSrc(stripComments(read(file)), name);
    const keys = Object.keys(globals);
    return new Function(...keys, `return (${async ? 'async ' : ''}function (${params}) ${body});`)(...keys.map((k) => globals[k])).bind(self);
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ═══ §38 confirmation card ══════════════════════════════════════════════════

test('§38 the five outcome lines, in the backend\'s words', () => {
    const f = method('js/order-confirmation-page.js', 'reminderOutcome');
    const E = 'support@inkcartridges.co.nz';
    assert.equal(f({ delivery_blocked: null, reminders_resumed: false }, E), "Done — we'll email you before you run out.");
    assert.equal(f({ delivery_blocked: null, reminders_resumed: true }, E), "Done — reorder reminders are back on. We'll email you before you run out.");
    assert.equal(f({ delivery_blocked: 'bounced' }, E), `We've noted your request, but emails to this address have been bouncing, so reminders can't reach you. Contact us at ${E} to update your email address.`);
    assert.equal(f({ delivery_blocked: 'unsubscribed' }, E), `We've noted your request, but this address is unsubscribed from our emails, so we can't send reminders. To get them, contact us at ${E} and we'll switch emails back on.`);
    assert.equal(f({ delivery_blocked: 'recommendations_off' }, E), "We've noted your request, but product recommendation emails are switched off in your account, and reorder reminders follow that setting. Turn them back on under email preferences in your account.");
});

function cardDom() {
    const listeners = {};
    const els = {
        'reminder-consent-card': { hidden: true, dataset: {}, innerHTML: '', appendChild() {} },
        'reminder-consent-btn': { disabled: false, dataset: {}, addEventListener: (t, f) => { listeners[t] = f; } },
        'reminder-consent-status': { hidden: true, textContent: '' },
        'save-printer-prompt': { hidden: false },
    };
    return { els, listeners, document: { getElementById: (id) => els[id] || null, createElement: () => ({ setAttribute() {}, textContent: '' }) } };
}

test('§38 shown ONLY for reminder_consent_at === null on a live order; absent is not "never asked"', () => {
    for (const [order, want] of [
        [{ orderNumber: '2026102401', status: 'paid', reminderConsentAt: null }, true],
        [{ orderNumber: '2026102401', status: 'paid', reminderConsentAt: undefined }, false],
        [{ orderNumber: '2026102401', status: 'paid', reminderConsentAt: '2026-10-24T01:00:00Z' }, false],
        [{ orderNumber: '2026102401', status: 'cancelled', reminderConsentAt: null }, false],
        [{ orderNumber: '2026102401', status: 'failed', reminderConsentAt: null }, false],
    ]) {
        const { els, document } = cardDom();
        const self = {};
        method('js/order-confirmation-page.js', 'renderReminderCard', self, { document, API: {} })(order);
        assert.equal(els['reminder-consent-card'].hidden, !want, JSON.stringify(order));
        assert.equal(els['save-printer-prompt'].hidden, want, 'one ask only');
    }
});

test('§38 one press ⇒ one POST, disabled while in flight; a failure says so and re-enables', async () => {
    const { els, listeners, document } = cardDom();
    let calls = 0;
    const self = { _supportEmail: async () => 'support@x.nz', reminderOutcome: () => 'done-line' };
    const API = { setReminderConsent: async () => { calls++; assert.equal(els['reminder-consent-btn'].disabled, true); return { ok: false, code: 'RATE_LIMITED' }; } };
    method('js/order-confirmation-page.js', 'renderReminderCard', self, { document, API })({ orderNumber: '2026102401', status: 'paid', reminderConsentAt: null });
    await listeners.click();
    assert.equal(calls, 1);
    assert.equal(els['reminder-consent-btn'].disabled, false);
    assert.equal(els['reminder-consent-status'].textContent, "Sorry, that didn't save. Please try again.");
    assert.equal(els['reminder-consent-card'].dataset.reminder, 'error');
});

test('§38 the API call: POST, no body, the same authority as GET /api/orders/:n', () => {
    const api = stripComments(read('js/api.js'));
    assert.match(api, /async setReminderConsent\(orderNumber\) \{\s*return this\.request\(`\/api\/orders\/\$\{encodeURIComponent\(orderNumber\)\}\/reminder-consent`, \{ method: 'POST' \}\);/);
    const conf = stripComments(read('js/order-confirmation-page.js'));
    assert.match(conf, /reminderConsentAt: Object\.prototype\.hasOwnProperty\.call\(apiOrder, 'reminder_consent_at'\)/);
    const html = read('html/order-confirmation.html');
    const card = html.indexOf('id="reminder-consent-card"');
    assert.ok(html.indexOf('confirmation-totals__actions') < card, 'under the order summary');
    assert.ok(card < html.indexOf('id="create-account-prompt"') && card < html.indexOf('id="business-account-offer"'), 'above the account and business offers');
    assert.match(html, /Want a reminder before you run out\?/);
    assert.match(html, />Remind me when it's time to reorder<\/button>/);
    assert.doesNotMatch(html.slice(card, card + 1500), /type="checkbox"|checked/, 'never pre-selected');
});

// ═══ §40 reorder reminders ══════════════════════════════════════════════════

global.Security = { escapeHtml: esc, escapeAttr: esc };
const { ReorderReminders: R } = require('../inkcartridges/js/reorder-reminders.js');

test('§40 interval text: weeks when whole, days otherwise', () => {
    assert.equal(R.everyText(42), 'Every 6 weeks');
    assert.equal(R.everyText(7), 'Every 1 week');
    assert.equal(R.everyText(45), 'Every 45 days');
    assert.equal(R.everyLower(56), 'every 8 weeks');
    assert.equal(R.everyText(null), '');
    assert.deepEqual(R.INTERVAL_WEEKS, [4, 6, 8, 10, 12, 16, 26]);
});

test('§40 default interval: the existing active reminder\'s, else 6 (ink) / 8 (toner, bottles)', () => {
    assert.equal(R.defaultWeeks('ink_cartridge', []), 6);
    assert.equal(R.defaultWeeks('toner_cartridge', []), 8);
    assert.equal(R.defaultWeeks('ink_bottle', []), 8);
    assert.equal(R.defaultWeeks('ink_cartridge', [{ status: 'paused', interval_days: 70 }, { status: 'active', interval_days: 84 }]), 12);
    assert.equal(R.defaultWeeks('ink_cartridge', [{ status: 'active', interval_days: 45 }]), 6, 'an off-list interval is not offered');
});

test('§40 one reminder per item: active wins, paused is reported, nothing offered twice', () => {
    const subs = [
        { id: 1, status: 'paused', items: [{ sku: 'A' }] },
        { id: 2, status: 'active', items: [{ sku: 'B' }, { sku: 'A' }] },
        { id: 3, status: 'cancelled', items: [{ sku: 'C' }] },
    ];
    assert.equal(R.coverFor('A', subs).state, 'active');
    assert.equal(R.coverFor('A', subs).sub.id, 2);
    assert.equal(R.coverFor('C', subs), null, 'a cancelled reminder covers nothing');
    assert.equal(R.coverFor('D', subs), null);
    assert.equal(R.coverFor('A', [subs[0]]).state, 'paused');
});

test('§40 the create lines, new vs merged, from the response (never computed)', () => {
    const made = R.createdText({ data: { existing: false, merged: false, subscription: { next_due: '2026-12-09', interval_days: 42 } } });
    assert.equal(made, "Reminder set. We'll email you around 9 December 2026, then every 6 weeks, with this item ready to add to your cart in one click. Nothing is ordered or charged until you check out. You can pause or change it any time in your account.");
    const merged = R.createdText({ data: { existing: true, merged: true, subscription: { next_due: '2026-11-30', interval_days: 56 } } });
    assert.match(merged, /^Added to your reorder reminder\. We'll email you around 30 November 2026, then every 8 weeks, with all its items/);
});

test('§40 no banned words anywhere the module or the account copy can print', () => {
    const src = stripComments(read('js/reorder-reminders.js')) + stripComments(read('js/account.js'));
    assert.doesNotMatch(src, /auto-?reorder|subscribe & save|never run out|scheduled reorder/i);
    // "subscription" survives only as the API path / param name, never in copy.
    const R2 = require('../inkcartridges/js/reorder-reminders.js').ReorderReminders;
    for (const t of [R2.createdText({ data: { subscription: { next_due: '2026-12-09', interval_days: 42 } } }), R2.everyText(42)]) {
        assert.doesNotMatch(t, /subscri|save|%/i, t);
    }
    for (const m of read('js/account.js').matchAll(/text: '((?:[^'\\]|\\.)*)'/g)) assert.doesNotMatch(m[1], /subscri/i, m[1]);
    assert.doesNotMatch(stripComments(read('js/reorder-reminders.js')), /\.email\b/, 'a reminder\'s email copy is never shown');
});

test('§40 the ?subscription= toasts say "reorder reminder", in the backend\'s words', () => {
    const src = read('js/account.js');
    assert.ok(src.includes("Your reorder reminder is set up. We\\'ll email you every 60 days. Nothing is ordered or charged until you check out."));
    assert.ok(src.includes("You already have a reorder reminder for this order."));
    assert.ok(src.includes("Reorder reminders aren\\'t available for this order. Contact us and we\\'ll help."));
    assert.ok(src.includes("We couldn\\'t set up your reorder reminder. Please try the link in your email again, or contact us."));
});

test('§40 guests get one sign-in link back to the same product, no control', async () => {
    const el = { hidden: true, innerHTML: '', dataset: {} };
    global.document = { getElementById: (id) => (id === 'product-reminder' ? el : null) };
    global.window = { location: { pathname: '/products/x/CLC233BK', search: '' } };
    global.Auth = { isAuthenticated: () => false };
    try {
        await R.mountPdp({ sku: 'CLC233BK', product_type: 'ink_cartridge' });
        assert.equal(el.hidden, false);
        assert.equal(el.innerHTML, '<a class="product-reminder__signin" href="/account/login?redirect=%2Fproducts%2Fx%2FCLC233BK">Sign in to get a reorder reminder for this item.</a>');
        await R.mountPdp({ sku: 'R1', product_type: 'printer_ribbon' });
        assert.equal(el.hidden, true, 'ribbons and other types get nothing');
    } finally { delete global.document; delete global.window; delete global.Auth; }
});

test('§40 the PDP and the dashboard both load the one module', () => {
    for (const page of ['html/product/index.html', 'html/account/index.html']) {
        assert.match(read(page), /<script defer src="\/js\/reorder-reminders\.js\?v=[0-9a-f]{8}"><\/script>/, page);
    }
    const pdp = read('html/product/index.html');
    assert.ok(pdp.indexOf('id="product-promise"') < pdp.indexOf('id="product-reminder"'), 'after the fit line (which stays directly under Add)');
    assert.match(read('html/account/index.html'), /Reminders go to your account email address\. Nothing is ordered or charged until you check out\./);
});

test('§40.4 a signed-out ?reorder=loaded|unavailable says sign in, and comes back to /cart', async () => {
    const src = stripComments(read('js/cart-deep-link.js'));
    assert.match(src, /REORDER_SIGNED_OUT: \{ text: 'Sign in to see the items we added to your cart\.', type: 'info' \}/);
    assert.match(src, /this\._toast\(this\.REORDER_SIGNED_OUT, '\/account\/login\?redirect=' \+ encodeURIComponent\('\/cart'\)\)/);
});

// ═══ §39 retention ══════════════════════════════════════════════════════════

test('§39 retention cells: "—" for null, counts beside every rate, small samples flagged', async () => {
    const U = await import(pathToFileURL(path.join(ROOT, 'inkcartridges/js/admin/utils/retention.js')).href);
    assert.deepEqual(U.rateCell(null), { text: '—', small: false, missing: true });
    assert.deepEqual(U.rateCell({ repeat_customers: 4, observed_customers: 43, rate_pct: 9.3 }), { text: '4 of 43 · 9.3%', small: false, missing: false });
    assert.equal(U.rateCell({ repeat_customers: 0, observed_customers: 12, rate_pct: 0 }).text, '0 of 12 · 0.0%', 'a real zero stays a zero');
    assert.equal(U.rateCell({ repeat_customers: 0, observed_customers: 12, rate_pct: 0 }).small, true);
    assert.equal(U.medianCell({ median_days_to_second_order: null }).text, '—');
    assert.equal(U.medianCell({ median_days_to_second_order: 41.6, customers_with_second_order: 5 }).small, true);
    const g = { revenue_per_customer_incl_gst: { d30: 123.4 }, second_order_within: { d30: { observed_customers: 25 } } };
    assert.deepEqual(U.revenueCell(g, 'd30'), { text: '$123.40', small: false, missing: false });
    assert.equal(U.revenueCell(g, 'd90').text, '—');
    const rows = U.rowsFor({ cohorts: [{ cohort: '2026-09', month_complete: true, all: { customers: 3 } }, { cohort: '2026-10', month_complete: false, all: {} }], totals: { all: { customers: 9 } } }, 'all');
    assert.deepEqual(rows.map((r) => [r.label, r.inProgress, !!r.total]), [['2026-09', false, false], ['2026-10', true, false], ['Total', false, true]]);
    assert.match(U.footerText({ as_of: '2026-10-24', orders_counted: 226, excluded: { test_orders: 3, staff_orders: 1 } }), /^As of 2026-10-24 · 226 orders counted · excluded: 3 test, 1 staff$/);
    assert.deepEqual(U.SEGMENTS.map((s) => s.id), ['all', 'ad_acquired', 'other', 'invoice_or_quick_order']);
});

test('§39 one tab in the shared manifest; one named GET; never beside the cohorts stub', () => {
    assert.match(read('js/admin/utils/analytics-tabs.js'), /\{ id: 'retention',\s+label: 'Retention',\s+lazy: '\.\/retention\.js' \}/);
    assert.match(stripComments(read('js/admin/api.js')), /async getRetention\(signal = null\) \{\s*return analyticsHttpGetNamed\('\/api\/admin\/analytics\/retention', signal\);/);
    const page = stripComments(read('js/admin/pages/retention.js'));
    assert.doesNotMatch(page, /cohorts/i);
    assert.match(page, /res\?\.status === 403 \? 'This report is for the owner account only\.'/);
    assert.match(page, /meta\.definitions/);
    assert.doesNotMatch(stripComments(read('js/admin/pages/customers.js')), /getRetention|retention\.js/);
});

// ═══ §42 SEO ════════════════════════════════════════════════════════════════

test('§42.2 /quote and /track-order are noindex (meta + header); /account carries the header', () => {
    for (const p of ['html/quote.html', 'html/track-order.html']) assert.match(read(p), /<meta name="robots" content="noindex, follow">/, p);
    const v = JSON.parse(read('vercel.json'));
    const hdr = (src) => (v.headers.find((h) => h.source === src) || {}).headers || [];
    assert.ok(hdr('/(quote|track-order)').some((h) => h.key === 'X-Robots-Tag' && /noindex/.test(h.value)));
    assert.ok(hdr('/account(/.*)?').some((h) => h.key === 'X-Robots-Tag' && /noindex/.test(h.value)));
});

test('§42.3 the printer description mirrors buildPrinterPageMeta', () => {
    const SeoMeta = require('../inkcartridges/js/seo-meta.js').SeoMeta || require('../inkcartridges/js/seo-meta.js');
    const d = (o) => SeoMeta.printerPageDescription(Object.assign({ printer: 'Brother MFC-J4620DW', threshold: 100, cutoff: '12pm', returnsDays: 30 }, o));
    // 147 chars; "30-day returns." would make 163 > 155, so it is left off.
    assert.equal(d({ count: 12, sources: ['compatible', 'genuine'], noun: 'ink' }),
        '12 ink cartridges for the Brother MFC-J4620DW — genuine & compatible. Free shipping over $100. Auckland metro orders by 12pm NZT dispatch same day.');
    // A short printer name leaves room for all three.
    assert.equal(d({ count: 2, sources: ['genuine'], noun: 'ink', printer: 'HP 65' }),
        '2 genuine ink cartridges for the HP 65. Free shipping over $100. Auckland metro orders by 12pm NZT dispatch same day. 30-day returns.');
    // Skip-and-continue: the long dispatch sentence is skipped, the short returns one still fits.
    const mid = d({ count: 9, sources: ['compatible'], noun: 'toner', printer: 'Brother HL-L2375DW Mono Laser Printer Series' });
    assert.ok(!/dispatch/.test(mid) && /30-day returns\.$/.test(mid), mid);
    assert.equal(d({ count: 1, sources: ['genuine'], noun: 'toner' }).split('.')[0], '1 genuine toner cartridge for the Brother MFC-J4620DW');
    assert.equal(d({ count: 5, sources: ['compatible'], noun: '' }).split('.')[0], '5 compatible cartridges for the Brother MFC-J4620DW');
    // A sentence that does not fit is SKIPPED and the next is still tried.
    const long = d({ count: 3, sources: ['genuine', 'compatible'], noun: 'ink', printer: 'X'.repeat(70) });
    assert.ok(long.length <= 155, String(long.length));
    assert.doesNotMatch(long, /\.\.\./);
    assert.match(long, /— genuine & compatible\.( |$)/);
    assert.ok(long.endsWith('.'), 'whole sentences only');
    assert.equal(d({ count: 0, sources: [] }), null);
});
