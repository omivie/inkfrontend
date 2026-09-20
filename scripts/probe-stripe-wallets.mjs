#!/usr/bin/env node
/**
 * Can a Stripe wallet actually render on our site? (ERR-268)
 * ==========================================================
 *
 * The wallet row on /payment produced ZERO payments in 173 live charges
 * between 2026-03-10 and 2026-09-17. Four CSP entries Stripe documents as
 * required were missing, including `hooks.stripe.com` — where 3-D Secure
 * challenges render, which is CARD revenue on the main path, not wallets.
 *
 * WHY A PROBE AND NOT A TEST
 * --------------------------
 * The whole class of defect here is invisible to everything we own:
 *
 *   - `inkcartridges/serve.json` sets NO headers, so LOCALHOST SERVES NO CSP.
 *     Every local run is green by construction (ERR-260 lesson 3).
 *   - The repo can be right while production is wrong. ERR-225's probe went
 *     red on its first run for exactly that: fix committed, not yet deployed.
 *   - A CSP refusal happens in a real browser and nowhere else. It passes
 *     every server-side assertion and every `curl`.
 *
 * So this reads the DEPLOYED header, and then opens a REAL BROWSER on the
 * REAL ORIGIN and mounts a real Express Checkout Element under the real
 * policy, which is the only place the answer exists.
 *
 * ── READ-ONLY. THE MODE IS PRINTED BEFORE ANY WORK. ─────────────────────────
 * §3 mounts an Express Checkout Element in DEFERRED mode (`mode: 'payment'`,
 * an amount and a currency, no client secret). Stripe creates NO PaymentIntent
 * until `confirm`, and this probe never confirms, never clicks a wallet button
 * and never submits. It does not touch the cart, the checkout session or any
 * order. It mounts into a detached node on an ordinary content page, so the
 * storefront's own scripts are not driven at all.
 *
 * It registers NO ctx.route() — a route handler BYPASSES CORS and the CSP, so
 * registering one while measuring a transport claim would make the measurement
 * a fiction. The point of this probe is that the browser is subject to the real
 * policy.
 *
 * A probe must OWN its safety, never borrow it from the service under test
 * (ERR-262). Here that means: the safety is structural — no confirm call
 * exists in this file — not "the backend would reject it anyway".
 *
 * WHAT THIS PROBE CANNOT DO, STATED PLAINLY
 * -----------------------------------------
 * Playwright drives Chromium. **Apple Pay on the web is a Safari/WebKit API
 * gated on a real device with a card in Wallet**, so `applePay` will read
 * false here no matter how correct the site is. That is reported as a NAMED
 * LIMIT, never as a failure, and it is never counted as evidence that Apple
 * Pay works. Only a human on real Safari can settle that half — §4 says so
 * and prints the exact URL to use.
 *
 * What §3 CAN settle, and nothing else we own can:
 *   - whether the browser refuses any Stripe or Link URI under our CSP
 *   - whether the Element reaches 'ready' at all (a refused frame never does)
 *   - which wallets Chromium reports as eligible
 *   - §3b: WHICH OF OUR TWO CHANGES THE ELIGIBILITY IS ACTUALLY DUE TO
 *
 * 🚨 §3b IS WHY THIS PROBE EXISTS, AND IT CONTRADICTED THE BRIEF THAT ASKED
 * FOR IT. Run on 2026-09-20 against production BEFORE any fix was deployed —
 * same browser, same origin, same unfixed CSP, one variable changed:
 *
 *     production's exact options:        klarna, link
 *       (applePay:false, googlePay:false)
 *     with paymentMethods:'always':      applePay, googlePay, klarna, link
 *
 * The CSP was NOT what suppressed Apple Pay and Google Pay. The missing
 * `paymentMethods` option was, and the CSP entries — though genuinely
 * required, and though 3DS has had no home this whole time — would not on
 * their own have produced one extra wallet payment.
 *
 * Note what else that measurement says: `link: true` on the UNFIXED site.
 * The wallet row was never dead. It was rendering Link and Klarna the whole
 * time, which is where some of those 46 Link charges came from. It was dead
 * for exactly the two wallets nobody could see.
 *
 * > ***An explanation that fits the symptom is not the cause. Change one
 * > variable against the live system and let it say so.***
 *
 * §3b stays in the probe permanently as the ATTRIBUTION control: a single
 * measurement is a constant with a good alibi (ERR-233).
 *
 * It lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel
 * output directory and is served publicly (ERR-229).
 *
 * Usage:  npm run probe:stripe-wallets
 *         npm run probe:stripe-wallets -- --headed     (watch it)
 * Exit:   0 = the deployed policy permits Stripe + Link, and the ECE mounted
 *         1 = a real failure — something a customer would hit
 *         2 = could not run (network, no Playwright). "We could not look" is
 *             never reported as "we looked and it was fine".
 */

const SITE = process.env.SITE_BASE || 'https://www.inkcartridges.co.nz';
const HEADED = process.argv.includes('--headed');

// Read from config.js at run time rather than duplicating the key here — a
// second copy of a credential is a second thing to rotate.
const CONFIG_URL = `${SITE}/js/config.js`;

/**
 * Every entry Stripe documents for Stripe.js + Link, with what a customer
 * loses when it is absent. A check that says "something is wrong" without
 * naming it is one debugging session away from being ignored (ERR-260).
 */
const REQUIRED = [
  ['frame-src', 'https://js.stripe.com', 'the Payment Element itself cannot render'],
  ['frame-src', 'https://*.js.stripe.com', 'Stripe.js cannot start Element frames on its split origins'],
  ['frame-src', 'https://hooks.stripe.com', '3-D SECURE CHALLENGES HAVE NOWHERE TO RENDER — a card that triggers a 3DS step cannot complete. This is the main payment path, not the wallet row.'],
  ['frame-src', 'https://link.com', "Link's auth UI is refused — Link was 46 of the last 173 charges"],
  ['frame-src', 'https://*.link.com', "Link's assets (checkout.link.com, statics.link.com) are refused"],
  ['frame-src', 'https://pay.google.com', 'the Google Pay sheet cannot open'],
  ['script-src', 'https://js.stripe.com', 'Stripe.js cannot load at all'],
  ['script-src', 'https://*.js.stripe.com', 'Stripe.js cannot load on its split origins'],
  ['connect-src', 'https://*.stripe.com', 'Stripe.js cannot reach api.stripe.com'],
  ['connect-src', 'https://link.com', "Link's XHR is blocked"],
  ['connect-src', 'https://*.link.com', "Link's XHR to its subdomains is blocked"],
];

let pass = 0;
const failures = [];
const notes = [];
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const cannotRun = (m) => { console.log(`\n\x1b[33m▲ probe could not run\x1b[0m — ${m}`); process.exit(2); };

const directives = (csp) => Object.fromEntries(
  csp.trim().split(';').map(d => d.trim()).filter(Boolean)
    .map(d => { const p = d.split(/\s+/); return [p[0], p.slice(1)]; })
);

console.log('\n\x1b[1mprobe:stripe-wallets — can Apple Pay / Google Pay / Link render? (ERR-268)\x1b[0m');
console.log('\x1b[36mMODE: READ-ONLY\x1b[0m — GETs plus one browser that mounts a DEFERRED Express');
console.log('      Checkout Element. No PaymentIntent, no order, no cart, no confirm, no');
console.log('      ctx.route(). Nothing is written anywhere.');
console.log(`Site: ${SITE}\n`);

const run = async () => {
  // ── §1 ────────────────────────────────────────────────────────────────────
  console.log('\x1b[1m§1 — the DEPLOYED header permits Stripe and Link\x1b[0m');
  let csp = '';
  try {
    const res = await fetch(`${SITE}/payment`, { redirect: 'follow' });
    csp = res.headers.get('content-security-policy') || '';
    if (!csp) {
      bad('no CSP header on /payment',
        'the page is served with no Content-Security-Policy at all — either the header '
        + 'config was dropped, or this is not the production host. Check www, never the '
        + 'apex: the apex 307s before headers apply.');
    } else {
      ok(`/payment answers ${res.status} with a CSP header`);
      const d = directives(csp);
      for (const [dir, src, cost] of REQUIRED) {
        if ((d[dir] || []).includes(src)) ok(`${dir} allows ${src}`);
        else bad(`${dir} IS MISSING ${src}`, cost);
      }
      // A widened policy is never the fix.
      if ((d['script-src'] || []).includes("'unsafe-inline'")) {
        bad("script-src carries 'unsafe-inline'",
          'this unblocks every injected script on the one page where that matters most. '
          + 'It is not the wallet fix.');
      }
    }
  } catch (e) {
    cannotRun(`${SITE}/payment unreachable: ${e.message}`);
  }

  // ── §2 ────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[1m§2 — has the repo drifted from production?\x1b[0m');
  try {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const vercel = JSON.parse(readFileSync(join(here, '..', 'inkcartridges', 'vercel.json'), 'utf8'));
    let repoCsp = '';
    for (const rule of vercel.headers || []) {
      for (const h of rule.headers || []) {
        if (/^content-security-policy$/i.test(h.key)) repoCsp = h.value;
      }
    }
    if (!repoCsp) {
      soft('no CSP found in inkcartridges/vercel.json', 'cannot compare');
    } else if (repoCsp.trim() === csp.trim()) {
      ok('inkcartridges/vercel.json matches the deployed header exactly');
    } else {
      // Say WHICH SIDE is behind. "They differ" sends the reader to the wrong file.
      const rd = directives(repoCsp), pd = directives(csp);
      const only = (a, b) => {
        const out = [];
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
          for (const s of (a[k] || [])) if (!(b[k] || []).includes(s)) out.push(`${k} ${s}`);
        }
        return out;
      };
      const repoAhead = only(rd, pd), prodAhead = only(pd, rd);
      if (repoAhead.length && !prodAhead.length) {
        soft('THE REPO IS AHEAD OF PRODUCTION — this fix is committed but NOT DEPLOYED',
          'Expected before the push, and it is the reason §1 may be red above. Deploy, then '
          + `re-run. Repo has, production does not:\n        ${repoAhead.join('\n        ')}`);
      } else if (prodAhead.length && !repoAhead.length) {
        bad('PRODUCTION IS AHEAD OF THE REPO — someone edited the header outside this repo',
          `production has, the repo does not:\n        ${prodAhead.join('\n        ')}`);
      } else {
        bad('the repo and production have diverged in BOTH directions',
          `repo only: ${repoAhead.join(', ')}\n      production only: ${prodAhead.join(', ')}`);
      }
    }
  } catch (e) {
    soft('could not read inkcartridges/vercel.json', e.message);
  }

  // ── §3 ────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[1m§3 — a real browser, under the real policy\x1b[0m');
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    cannotRun('playwright is not installed — §3 is the only check that can see a CSP refusal');
  }

  let key = '';
  try {
    const cfg = await (await fetch(CONFIG_URL)).text();
    key = (/STRIPE_PUBLISHABLE_KEY:\s*'([^']+)'/.exec(cfg) || [])[1] || '';
    if (!key) cannotRun('could not read STRIPE_PUBLISHABLE_KEY from the deployed config.js');
  } catch (e) {
    cannotRun(`could not fetch ${CONFIG_URL}: ${e.message}`);
  }

  const browser = await chromium.launch({ headless: !HEADED });
  try {
    const page = await browser.newPage();
    const refusals = [];
    const pageErrors = [];
    page.on('console', (m) => {
      const t = m.text();
      // Chromium reports CSP blocks as console errors; keep the whole line, the
      // blocked URI is the entire point.
      if (/Refused to (frame|load|connect|execute)|Content Security Policy/i.test(t)) refusals.push(t);
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));

    // An ordinary content page on the production origin. NOT /payment: that
    // needs a cart and a checkout session, and building one would make this
    // probe a writer. The CSP is served on EVERY path, so the policy under
    // test is identical.
    const res = await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!res || !res.ok()) cannotRun(`${SITE}/ returned ${res && res.status()}`);
    ok(`loaded ${SITE}/ on the production origin`);

    const result = await page.evaluate(async ({ pk }) => {
      const out = { violations: [], stripeLoaded: false, ready: null, baseline: null, error: null, timedOut: false };
      // Catch refusals the page reports natively, which is more precise than
      // scraping console text.
      document.addEventListener('securitypolicyviolation', (e) => {
        out.violations.push({ directive: e.violatedDirective, blocked: e.blockedURI });
      });

      await new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = 'https://js.stripe.com/v3/';
        s.onload = resolve;
        s.onerror = () => resolve();
        document.head.appendChild(s);
      });
      if (typeof window.Stripe !== 'function') { out.error = 'Stripe.js did not load'; return out; }
      out.stripeLoaded = true;

      try {
        const stripe = window.Stripe(pk);
        // DEFERRED: an amount and a currency, no client secret. Stripe creates
        // no PaymentIntent until confirm, and we never confirm.
        const mount = (extra) => new Promise((resolve) => {
          const elements = stripe.elements({ mode: 'payment', amount: 4999, currency: 'nzd' });
          const ece = elements.create('expressCheckout', Object.assign({
            emailRequired: false, phoneNumberRequired: false,
            billingAddressRequired: false, shippingAddressRequired: false,
            buttonHeight: 48,
          }, extra));
          const host = document.createElement('div');
          host.style.cssText = 'position:fixed;left:-10000px;top:0;width:400px';
          document.body.appendChild(host);
          const timer = setTimeout(() => resolve({ timedOut: true }), 15000);
          ece.on('ready', (ev) => { clearTimeout(timer); resolve({ apm: (ev && ev.availablePaymentMethods) || {} }); });
          ece.on('loaderror', (ev) => { clearTimeout(timer); resolve({ error: (ev && ev.error && ev.error.message) || 'loaderror' }); });
          ece.mount(host);
        });

        // The configuration this fix ships.
        const shipped = await mount({ paymentMethods: { applePay: 'always', googlePay: 'always' } });
        out.ready = shipped.apm || null;
        out.timedOut = !!shipped.timedOut;
        if (shipped.error) out.error = shipped.error;

        // §3b ATTRIBUTION CONTROL — the configuration production ran until this
        // fix: no paymentMethods option at all. Same browser, same origin, same
        // policy, one variable.
        const base = await mount({});
        out.baseline = base.apm || null;
      } catch (e) {
        out.error = e && e.message;
      }
      return out;
    }, { pk: key });

    // --- what the browser refused -------------------------------------------
    const allRefusals = [
      ...result.violations.map(v => `${v.directive} blocked ${v.blocked}`),
      ...refusals,
    ];
    const relevant = allRefusals.filter(r => /stripe|link\.com|pay\.google/i.test(r));
    if (relevant.length === 0) {
      ok('the browser refused nothing Stripe- or Link-bound under the live policy');
    } else {
      bad('THE LIVE POLICY REFUSED A STRIPE/LINK REQUEST IN A REAL BROWSER',
        relevant.join('\n      '));
    }
    if (allRefusals.length !== relevant.length) {
      soft(`${allRefusals.length - relevant.length} other CSP notice(s) seen`,
        'not Stripe- or Link-bound, so not this probe\'s subject: '
        + allRefusals.filter(r => !relevant.includes(r)).slice(0, 3).join(' | '));
    }

    // --- did the Element actually come up? ----------------------------------
    if (!result.stripeLoaded) {
      bad('Stripe.js did not load on the production origin', result.error || 'no detail');
    } else if (result.timedOut) {
      bad("the Express Checkout Element never reached 'ready'",
        'A refused frame never fires ready. This is precisely the silent state the '
        + 'wallet row sat in: no error, no log, an empty gap above the card form.');
    } else if (result.error) {
      bad('the Express Checkout Element failed to mount', result.error);
    } else {
      const apm = result.ready || {};
      const eligible = Object.keys(apm).filter(k => apm[k]);
      ok(`the Element reached 'ready' — a frame the CSP permits. Map: ${JSON.stringify(apm)}`);
      if (eligible.length) ok(`Chromium reports eligible: ${eligible.join(', ')}`);
      else soft('Chromium reports NO eligible wallet',
        'Expected on a clean automated profile with no Google account and no Wallet. '
        + 'This is the browser/device answer, not a site problem — §1 and the refusal '
        + 'check above are what adjudicate the site.');
      if (apm.link) ok('Link is eligible — the link.com entries are doing their job');

      // ── §3b ────────────────────────────────────────────────────────────────
      console.log("\n\x1b[1m§3b — attribution: is it the CSP, or paymentMethods:'always'?\x1b[0m");
      const base = result.baseline;
      if (!base) {
        soft('the attribution control did not mount', 'cannot attribute this run');
      } else {
        const gained = Object.keys(apm).filter(k => apm[k] && !base[k]);
        const baseList = Object.keys(base).filter(k => base[k]).join(', ') || '(none)';
        console.log(`    without paymentMethods (as production ran): ${baseList}`);
        console.log(`    with paymentMethods:'always' (shipped):     ${eligible.join(', ') || '(none)'}`);
        if (gained.length) {
          ok(`paymentMethods:'always' is what adds ${gained.join(' + ')} — on THIS policy, `
            + 'whatever the CSP says');
        } else if (eligible.length) {
          soft('both configurations report the same wallets in this browser',
            'so this run cannot attribute the difference. Expected on a profile where the '
            + "wallets are eligible anyway; it is NOT evidence that 'always' is unnecessary.");
        }
        // The claim the brief made, checked rather than repeated.
        if (base.link) {
          soft('THE WALLET ROW WAS NEVER DEAD — Link is eligible WITHOUT any of our changes',
            'The brief reported "the wallet row has never produced a single payment". Link '
            + 'renders in that row and took 46 of the last 173 charges. The row was live; it '
            + 'was missing exactly the two wallets nobody could see.');
        }
      }
    }
    if (pageErrors.length) {
      soft(`${pageErrors.length} page error(s) during the mount`, pageErrors.slice(0, 2).join(' | '));
    }
  } catch (e) {
    cannotRun(`browser step failed: ${e.message}`);
  } finally {
    await browser.close();
  }

  // ── §4 ────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[1m§4 — what this probe did NOT check\x1b[0m');
  soft('APPLE PAY IS UNPROVEN BY THIS RUN, AND CANNOT BE PROVEN BY IT',
    'Apple Pay on the web is a Safari/WebKit API gated on a real device with a card in '
    + 'Wallet. Chromium reports it false however correct the site is, so a green run above '
    + 'is NOT evidence Apple Pay works. A skip is not a pass.\n'
    + `      Settle it by hand: open ${SITE}/payment?wallet-debug=1 in Safari on a Mac with\n`
    + '      Touch ID, or on an iPhone, with a real cart through to step 3. The console prints\n'
    + '        [wallets] ready: applePay, link        -> working\n'
    + '        [wallets] ready, but NO eligible wallet -> the device reported nothing\n'
    + '        [wallets] CSP REFUSED ...               -> an entry is still missing\n'
    + '        [wallets] TIMEOUT ...                   -> the frame never came up\n'
    + '      Isolate site-vs-browser against Stripe\'s own demo if it disagrees:\n'
    + '      https://docs.stripe.com/testing/wallets?ui=express-checkout-element');

  console.log(`\n\x1b[1mResult:\x1b[0m ${pass} passed, ${failures.length} failed, ${notes.length} noted.`);
  if (notes.length) { console.log('\nNoted:'); notes.forEach(n => console.log(`  ~ ${n}`)); }
  if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log(`  ✗ ${f}`)); process.exit(1); }
  console.log('\x1b[32mThe deployed policy permits Stripe and Link, and the Element mounted.\x1b[0m\n');
};

run().catch((e) => { console.error('\nProbe crashed:', e); process.exit(2); });
