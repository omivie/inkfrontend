/**
 * Order numbers are opaque strings of VARIABLE WIDTH (Sep 2026, ERR-198)
 * =====================================================================
 *
 * On 2026-09-01 the backend (migration 157) stopped zero-padding the daily
 * sequence. Four shapes now coexist in every order list and all four still
 * resolve on every lookup endpoint:
 *
 *     2026090101                     current   10 chars
 *     20260901100                    current   11 chars, >99 orders in one day
 *     20260829000004                 interim   14 chars
 *     ORD-MMQXBRYO-6E93              legacy    pre-2026-05-18
 *     ORD-MP7GA80N-C3DD9FA2EC39F1DE  legacy    (16-char hex run)
 *
 * WHY THIS SUITE EXISTS, GIVEN THE HAND-OFF SAID "NO CODE CHANGES REQUIRED"
 * ------------------------------------------------------------------------
 * The hand-off searched the deployed bundles for PARSING assumptions — a
 * `\d{14}` regex, a `parseInt`, a `.length === 14` — and found none. That was
 * true. But the migration did not change how an order number parses; it changed
 * the fact that order numbers were FIXED WIDTH, and two things rested on that
 * without ever saying so:
 *
 *   1. NO ORDER NUMBER COULD BE A PREFIX OF ANOTHER. It can now: `2026090110`
 *      is a strict prefix of `20260901100`. The admin order search is a
 *      substring ILIKE, so one query returns both — and two call sites took
 *      `rows[0]`, one of them to attach a REFUND.
 *   2. TRUNCATING FOR DISPLAY WAS SAFE, because the leading 8 characters were a
 *      redundant date prefix. `dashboard.js` sliced the last 8 in five places;
 *      on a 10-character number that eats the century and prints `26090101`.
 *
 * THE GRAMMAR BELOW IS MEASURED, NOT CITED
 * ----------------------------------------
 * Every accepted/rejected value in `LIVE_GRAMMAR` was read off the live API on
 * 2026-09-01. `GET /api/orders/:orderNumber` validates BEFORE it authenticates,
 * so the grammar is observable unauthenticated: 400 = rejected, 401 = accepted.
 * `npm run probe:order-number` re-runs that sweep and fails if this file and the
 * backend ever disagree.
 *
 * A caution recorded here because it cost a wrong answer once already: the first
 * sweep probed the legacy hex run with `6E93X` and `GGGG` and read the 400s as a
 * LENGTH rule ("4 or 16 only"). `X` and `G` are not hex digits — those strings
 * were rejected on characters and the length question was never asked. With
 * hex-only controls the rule is a plain range, {4,16}. A measurement taken with
 * a bad control is not a measurement.
 *
 * Run with:
 *   node --test tests/order-number-format-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS = (...p) => path.join(ROOT, 'inkcartridges', 'js', ...p);
const HTML = (...p) => path.join(ROOT, 'inkcartridges', 'html', ...p);
const read = (p) => fs.readFileSync(p, 'utf8');

const { OrderNumber } = require(JS('utils.js'));

/**
 * Measured live 2026-09-01 against GET /api/orders/:orderNumber.
 * true = the backend accepted the shape (401, auth ran after validation).
 */
const LIVE_GRAMMAR = [
  // ── the hand-off's own §6 table ──
  ['2026090101', true, 'first order of 2026-09-01'],
  ['2026090129', true, '29th order of the day'],
  ['20260901100', true, '100th order — the widened form'],
  ['20260829000004', true, 'a real existing interim order'],
  ['ORD-MMQXBRYO-6E93', true, 'a real existing legacy order'],
  ['ORD-MP7GA80N-C3DD9FA2EC39F1DE', true, 'the long legacy form'],
  ['20260901', false, 'date prefix with no sequence'],
  ['202609011', false, 'date prefix with a single digit'],
  // ── numeric width boundary ──
  ['202609011', false, '9 digits'],
  ['2026090112', true, '10 digits'],
  ['20260901123456', true, '14 digits'],
  ['202609011234567', false, '15 digits'],
  // ── the date prefix is NOT semantically checked ──
  ['20261301100', true, 'month 13 is accepted — this is not a date'],
  ['9999999999', true, 'not a date at all, still a valid shape'],
  // ── legacy hex run: {4,16} ──
  ['ORD-AAAAAAAA-AAA', false, '3-char hex run'],
  ['ORD-AAAAAAAA-AAAA', true, '4-char hex run'],
  ['ORD-AAAAAAAA-AAAAA', true, '5-char hex run — NOT rejected'],
  ['ORD-AAAAAAAA-AAAAAAAA', true, '8-char hex run'],
  ['ORD-AAAAAAAA-AAAAAAAAAAAAAAAA', true, '16-char hex run'],
  ['ORD-AAAAAAAA-AAAAAAAAAAAAAAAAA', false, '17-char hex run'],
  // ── legacy character rules ──
  ['ORD-MMQXBRYO-GGGG', false, 'G is not a hex digit'],
  ['ORD-MMQXBRY!-6E93', false, 'punctuation in the id run'],
  ['ORD-IAAAAAAA-AAAA', true, 'I is fine — the "stricter regex" note was stale'],
  ['ORD-A-AAAA', true, 'the id run has no 8-char minimum'],
];

// ── 1. The vocabulary agrees with the server, value for value ───────────────

test('isValid matches the live backend grammar at every measured point', () => {
  for (const [value, accepted, why] of LIVE_GRAMMAR) {
    assert.equal(OrderNumber.isValid(value), accepted,
      `the backend ${accepted ? 'ACCEPTS' : 'REJECTS'} ${JSON.stringify(value)} (${why}), `
      + `so OrderNumber.isValid must agree. A validator that drifts from the server `
      + `either refuses real customers or promises lookups that 400 (ERR-198).`);
  }
});

test('a lowercase legacy number is rescued, not rejected', () => {
  // Measured: `ord-mmqxbryo-6e93` is a hard 400 on the live API. A customer
  // copying an old number out of a mail client that lowercased it was told
  // their order did not exist. Uppercasing is lossless for both shapes.
  assert.equal(OrderNumber.isValid('ord-mmqxbryo-6e93'), true,
    'normalise() uppercases, so the lowercase form must survive the round trip');
  assert.equal(OrderNumber.normalise('ord-mmqxbryo-6e93'), 'ORD-MMQXBRYO-6E93',
    'the normalised value is what gets sent to the backend');
});

test('normalise strips the # the site itself prints in front of order numbers', () => {
  // order-confirmation-page.js, order-detail-page.js and account.js all render
  // `#${order_number}`, so a pasted reference routinely arrives with the hash.
  assert.equal(OrderNumber.normalise('#2026090101'), '2026090101');
  assert.equal(OrderNumber.normalise('  #2026090101  '), '2026090101');
  assert.equal(OrderNumber.normalise('#'), '',
    'a box holding only a hash is EMPTY, not an order number — it must fail the '
    + 'presence check rather than being sent to the server');
  assert.equal(OrderNumber.normalise(null), '');
  assert.equal(OrderNumber.normalise(undefined), '');
});

test('era() labels each generation and refuses to guess at a non-shape', () => {
  assert.equal(OrderNumber.era('2026090101'), 'daily');
  assert.equal(OrderNumber.era('20260901100'), 'daily');
  assert.equal(OrderNumber.era('20260829000004'), 'interim');
  assert.equal(OrderNumber.era('ORD-MMQXBRYO-6E93'), 'legacy');
  assert.equal(OrderNumber.era('nonsense'), 'unknown');
  assert.equal(OrderNumber.era(''), 'unknown');
});

// ── 2. The prefix collision — the defect the new format actually introduced ──

test('pickExact returns the wanted order even when a superstring sorts first', () => {
  // THE WHOLE POINT OF THIS FILE. `?search=2026090110` is a substring ILIKE, so
  // it legitimately matches order 100 as well as order 10, and the backend is
  // free to return them in any order. Taking rows[0] refunds the wrong customer.
  const rows = [{ order_number: '20260901100' }, { order_number: '2026090110' }];
  assert.equal(OrderNumber.pickExact(rows, '2026090110').order_number, '2026090110',
    'order 10 must come back as order 10, not as the order-100 row that shares its prefix');
  assert.equal(OrderNumber.pickExact(rows, '20260901100').order_number, '20260901100');
});

test('pickExact returns null on a near-miss rather than guessing', () => {
  const rows = [{ order_number: '20260901100' }];
  assert.equal(OrderNumber.pickExact(rows, '2026090110'), null,
    'a substring match is NOT the order that was asked for. An honest miss beats '
    + 'attaching a refund to an order the operator never named.');
  assert.equal(OrderNumber.pickExact([], '2026090101'), null);
  assert.equal(OrderNumber.pickExact(null, '2026090101'), null);
  assert.equal(OrderNumber.pickExact([{ order_number: '2026090101' }], ''), null,
    'an empty query matches nothing — never the first row');
});

test('pickExact and equals normalise both sides', () => {
  const rows = [{ order_number: 'ORD-MMQXBRYO-6E93' }];
  assert.ok(OrderNumber.pickExact(rows, ' ord-mmqxbryo-6e93 '),
    'a deep link or a paste can arrive trimmed differently or lowercased');
  assert.ok(OrderNumber.equals('#2026090101', '2026090101'));
  assert.ok(!OrderNumber.equals('', ''), 'empty is never equal to empty here');
  assert.ok(!OrderNumber.equals('2026090110', '20260901100'),
    'a prefix is NOT a match — this is the comparison the refund path got wrong');
});

// ── 3. Display is never truncated ───────────────────────────────────────────

test('forDisplay returns the whole order number, at every width', () => {
  for (const [value, accepted] of LIVE_GRAMMAR) {
    if (!accepted) continue;
    assert.equal(OrderNumber.forDisplay(value), value.trim(),
      `${value} must print whole. A truncated order number matches nothing in the `
      + `order search and cannot be quoted in an email (ERR-198).`);
  }
});

test('no source file truncates an order number for display', () => {
  // The five dashboard sites were `String(n).slice(-8)`. Nothing may reintroduce
  // that shape: with an unpadded 10-char number the slice eats the century.
  const suspects = [
    JS('admin', 'pages', 'dashboard.js'),
    JS('admin', 'pages', 'orders.js'),
    JS('admin', 'pages', 'refunds.js'),
    JS('admin', 'pages', 'customers.js'),
    JS('account.js'),
    JS('order-detail-page.js'),
    JS('order-confirmation-page.js'),
  ];
  for (const file of suspects) {
    const src = read(file).split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(src, /order_?[Nn]umber\s*(?:\|\| *'')?\s*\)?\s*\.slice\(/,
      `${path.basename(file)} slices an order number. Since ERR-198 the leading `
      + `8 characters are no longer a redundant date prefix, so any slice of one `
      + `produces a string that is not an order number.`);
    assert.doesNotMatch(src, /\.slice\(-8\)/,
      `${path.basename(file)} still carries a .slice(-8). That was safe only while `
      + `order numbers were 14 fixed characters (ERR-198).`);
  }
});

// ── 4. Sorting: chronological on purpose, and written down ──────────────────

test('nothing sorts on the order-number string', () => {
  // '2026090199' > '20260901100' is true, but order 99 came FIRST. Public lists
  // sort on created_at; the admin column maps to the backend's date sort.
  const files = ['account.js', 'track-order-page.js', 'order-detail-page.js']
    .map((f) => JS(f))
    .concat([JS('admin', 'pages', 'orders.js'), JS('admin', 'pages', 'dashboard.js')]);
  for (const file of files) {
    const src = read(file);
    assert.doesNotMatch(src, /\.sort\(\s*\([^)]*\)\s*=>[^)]*order_number/,
      `${path.basename(file)} compares order numbers in a sort comparator. That is `
      + `chronologically wrong above 99 orders in a day (ERR-198) — sort on created_at.`);
    assert.doesNotMatch(src, /order_number[^\n]*localeCompare/,
      `${path.basename(file)} localeCompares order numbers — same defect.`);
  }
});

test('the admin Order # column documents that it sorts by DATE', () => {
  const orders = read(JS('admin', 'pages', 'orders.js'));
  const api = read(JS('admin', 'api.js'));
  assert.match(api, /'order_number':\s*filters\.order === 'asc' \? 'oldest' : 'newest'/,
    'the mapping to the backend date sort is the correct behaviour and must stay');
  assert.match(orders, /SORTABLE, AND IT SORTS BY DATE ON PURPOSE/,
    'the equivalence that made this honest died with fixed-width numbers, so the '
    + 'reason has to be written next to it or someone will "fix" it into a string sort');
  assert.match(api, /ERR-198/,
    'api.js must say why order_number maps to a date sort');
});

// ── 5. The copy cannot rot back to an invented shape ────────────────────────

const COPY_SURFACES = [
  [HTML('track-order.html'), 'the public Track Order form'],
  [HTML('account', 'track-order.html'), 'the signed-in Track Order form'],
  [HTML('contact.html'), 'the contact form'],
];

test('every order-number example shown to a customer is a real, mintable shape', () => {
  // Before ERR-198 these advertised `ORD-ABC123-XYZ` and `ORD-1042` — shapes the
  // backend has NEVER minted (`ORD-ABC123-XYZ` is not even a valid legacy form;
  // the hex run must be 4..16 hex digits). The site was telling customers what
  // their order number looks like, and it was wrong.
  for (const [file, what] of COPY_SURFACES) {
    const src = read(file);
    const inputs = [...src.matchAll(/<input[^>]*name="order_number"[^>]*>/g)].map((m) => m[0]);
    assert.ok(inputs.length, `${what} must still have an order_number input`);
    for (const input of inputs) {
      const ph = /placeholder="([^"]*)"/.exec(input);
      assert.ok(ph, `${what}: the order-number input needs a placeholder`);
      const example = ph[1].replace(/^e\.g\.\s*/i, '').trim();
      assert.ok(OrderNumber.isValid(example),
        `${what} offers "${example}" as an example order number, which the backend `
        + `would reject with 400. Show a shape we actually mint (ERR-198).`);
    }
  }
});

test('the example in the copy is the one the vocabulary owns', () => {
  for (const [file, what] of COPY_SURFACES) {
    assert.ok(read(file).includes(OrderNumber.EXAMPLE),
      `${what} should use OrderNumber.EXAMPLE (${OrderNumber.EXAMPLE}) so there is `
      + `one place to change it`);
  }
});

test('no invented order-number shape survives anywhere in the shipped tree', () => {
  const invented = ['ORD-ABC123-XYZ', 'ORD-1042', 'INK-78542'];
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
      else if (/\.(js|html)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  for (const file of walk(path.join(ROOT, 'inkcartridges'))) {
    const src = read(file);
    for (const bogus of invented) {
      if (!src.includes(bogus)) continue;
      // utils.js names them once, in the comment explaining why they were removed.
      // Allowed ONLY on comment lines — never in code that could render one.
      const codeLines = src.split('\n').filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      });
      const onlyInTheExplanation = !codeLines.some((l) => l.includes(bogus));
      assert.ok(onlyInTheExplanation,
        `${path.relative(ROOT, file)} still carries "${bogus}", a shape no order has `
        + `ever had (ERR-198).`);
    }
  }
});

test('the static order-detail heading carries no fabricated order number', () => {
  const src = read(HTML('account', 'order-detail.html'));
  const h1 = /<h1 class="account-content__heading">([^<]*)<\/h1>/.exec(src);
  assert.ok(h1, 'the heading must still exist for order-detail-page.js to fill in');
  assert.doesNotMatch(h1[1], /\d/,
    'this markup is only ever SEEN when the order fails to load — i.e. when the '
    + 'customer is already lost. A fake number there ("Order #INK-78542") tells them '
    + 'they are looking at an order (ERR-198).');
});

// ── 6. Enrolment — "every surface calls X" is a list nobody maintains ───────

test('every surface that renders an order number goes through OrderNumber', () => {
  // ERR-150/160: the same feature vanished twice because enrolment lived in a
  // comment. It lives here instead.
  const enrolled = [
    [JS('admin', 'pages', 'dashboard.js'), 'the dashboard cards and tables'],
    [JS('admin', 'pages', 'orders.js'), 'the orders list, modal title and deep link'],
    [JS('admin', 'pages', 'refunds.js'), 'the refund order lookup'],
    [JS('track-order-page.js'), 'the customer tracking form'],
  ];
  for (const [file, what] of enrolled) {
    assert.match(read(file), /OrderNumber\./,
      `${what} (${path.basename(file)}) renders or matches an order number but never `
      + `calls OrderNumber. One vocabulary, or the rules drift apart again (ERR-198).`);
  }
});

test('OrderNumber is actually on window, so no guard silently disables it', () => {
  // ERR-156/167: `security.js` is a bare const, so every `window.Security?.x ? … :
  // fallback` guard in the tree was an OFF SWITCH and the fallback was the only
  // branch that ever ran. The admin pages are ES modules and reach this through
  // `window.OrderNumber`, so the assignment is load-bearing.
  const utils = read(JS('utils.js'));
  assert.match(utils, /if \(typeof window !== 'undefined'\) window\.OrderNumber = OrderNumber;/,
    'utils.js must publish OrderNumber on window — the admin modules read it there');
  assert.match(utils, /\n        OrderNumber\n?\s*\};/,
    'OrderNumber must also be in module.exports so tests and probes run the real one');
});

test('no call site wraps OrderNumber in a truthiness guard', () => {
  const files = [
    JS('admin', 'pages', 'dashboard.js'), JS('admin', 'pages', 'orders.js'),
    JS('admin', 'pages', 'refunds.js'), JS('track-order-page.js'),
  ];
  for (const file of files) {
    assert.doesNotMatch(read(file), /window\.OrderNumber\s*\?[^?]/,
      `${path.basename(file)} guards on window.OrderNumber. If the fallback is the `
      + `only branch that ever runs, the guard IS the bug (ERR-167) — let it throw.`);
  }
});

// ── 7. Positive controls — these checks must FAIL on the pre-fix source ─────

test('POSITIVE CONTROL — the pre-fix sources fail the predicates above', () => {
  // Verbatim shapes from before the fix. If these pass, the checks are not
  // checking: a regex that stops matching is silently green (ERR-186).
  const preFixDashboard = "items.push({ label: `#${String(num).slice(-8)}`, href: 'tracking-requests' });";
  assert.match(preFixDashboard, /\.slice\(-8\)/,
    'the truncation check must fire on the source it was written for');

  const preFixFocus = "const match = rows.find(r => String(r.order_number || '').toLowerCase() === wanted);\n"
    + '  if (match) { openOrderModal(match); } else if (rows.length === 1) { openOrderModal(rows[0]); }';
  assert.match(preFixFocus, /rows\.length === 1/,
    'the unverified-row fallback is the shape that opened the wrong order');

  const preFixRefund = 'const result = await AdminAPI.getOrders({ search: val }, 1, 1);\n  foundOrder = orders[0];';
  assert.match(preFixRefund, /orders\[0\]/,
    'the refund path bound to the first row of a substring search');

  // And the copy checks: the old placeholder must be rejected by isValid.
  for (const bogus of ['ORD-ABC123-XYZ', 'ORD-1042', 'INK-78542', 'INK-10432', 'ORD-ABC-1']) {
    assert.equal(OrderNumber.isValid(bogus), false,
      `"${bogus}" was shown to customers as an example order number and the backend `
      + `rejects it — the copy check has to catch exactly this.`);
  }
});

test('POSITIVE CONTROL — a naive fixed-width validator fails the live grammar', () => {
  // The shape the hand-off went looking for, and the shape someone would write
  // from the old format. It must disagree with the measured table, or this
  // suite is not testing anything the migration changed.
  const naive = (v) => /^\d{14}$/.test(String(v));
  const disagreements = LIVE_GRAMMAR.filter(([v, ok]) => naive(v) !== ok);
  assert.ok(disagreements.length > 0,
    'a 14-digit-only validator must disagree with the live grammar somewhere');
  assert.ok(disagreements.some(([v]) => v === '2026090101'),
    'specifically, it must reject the CURRENT format — that is the migration');
});

// ── 8. The rendered output, not just the source text ────────────────────────

test('the dashboard tables render every order-number shape WHOLE', () => {
    // The checks above pin that the source no longer slices. This one runs the
    // real render functions and reads the HTML they produce, because "the source
    // has no .slice" and "the operator can read the order number" are different
    // claims and only the second one matters.
    const vm = require('node:vm');
    const src = read(JS('admin', 'pages', 'dashboard.js'));

    /** Body of a named function declaration, brace-matched. */
    function lift(name) {
        const start = src.search(new RegExp(`(?:^|\\n)function ${name}\\s*\\(`));
        assert.notEqual(start, -1, `function ${name} not found in dashboard.js`);
        const open = src.indexOf('{', start);
        let depth = 0;
        for (let i = open; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
        }
        throw new Error(`unbalanced braces in ${name}`);
    }

    const box = {
        console, Math, Number, Object, Array, String, Boolean, JSON, Date, RegExp, isNaN,
        esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
        formatPrice: (n) => '$' + Number(n || 0).toFixed(2),
        timeAgo: () => '1h ago',
        firstArray: (o, keys) => {
            if (Array.isArray(o)) return o;
            for (const k of keys) if (o && Array.isArray(o[k])) return o[k];
            return [];
        },
        // The real vocabulary — a stub here would let the rendered label drift
        // from what the dashboard actually prints.
        window: { OrderNumber },
    };
    box.globalThis = box;
    const ctx = vm.createContext(box);
    vm.runInContext(
        lift('orderRef') + '\n' + lift('renderRecentOrdersCard')
        + '\n;globalThis.renderRecentOrdersCard = renderRecentOrdersCard;',
        ctx, { filename: 'dash.js' });

    const shapes = ['2026090101', '20260901100', '20260829000004', 'ORD-MMQXBRYO-6E93'];
    const orders = shapes.map((order_number, i) => ({
        order_number, id: `uuid-${i}`, customer_name: 'Jun Jackson',
        total: 84.98, status: 'paid', created_at: '2026-09-01T02:00:00Z',
    }));
    const html = box.renderRecentOrdersCard({ orders });

    for (const n of shapes) {
        assert.ok(html.includes(`>${n}<`),
            `the Recent Orders card must print ${n} in full. Got a cell that does not `
            + `contain it — the old .slice(-8) rendered "${n.slice(-8)}", which matches no `
            + `order and cannot be pasted into the order search (ERR-198).`);
    }
    // And the row carries the number the click handler needs to deep-link with.
    assert.ok(html.includes('data-order-number="2026090101"'),
        'wireOrderRowClicks reads data-order-number to build #orders?focus=');

    // A row with NO order number still degrades to a short id rather than blank.
    const noNumber = box.renderRecentOrdersCard({ orders: [{ id: 'abcdef1234567890', status: 'paid' }] });
    assert.ok(noNumber.includes('>abcdef12<'),
        'a row carrying only a UUID keeps the first-8 short form — nobody types a UUID');
});
