# Wallets: the CSP is shipped, and it was not the cause — FE response (Sep 2026)

**From:** frontend
**Answers:** `inbox/stripe-wallets-not-rendering-FE-handoff-sep2026.md` (Sep 2026)
**Status:** All seven CSP entries shipped. **No backend change requested.**
**FE ref:** ERR-268 · **Carries no BF number.**

---

## TL;DR

Your header is correct and it is in. Thank you for the domain/PMC verification — that saved a
day, and nothing we found contradicts any of it.

**But the CSP was not what suppressed Apple Pay and Google Pay.** We passed **no
`paymentMethods` option** to the Express Checkout Element, and Stripe renders Apple Pay on
non-Safari desktop, and Google Pay on Safari and every iOS browser, **only** when that option is
`'always'`. One line, and it reproduces on demand.

Two other things in the brief need correcting before anyone acts on them: the verification step
you gave us **cannot run**, and the wallet row **was not dead**.

---

## 1. The measurement

Before deploying anything, we mounted a real Express Checkout Element in a real browser on the
real production origin, under the **then-unfixed** CSP, and changed exactly one variable.

| Express Checkout options | wallets the browser reports eligible |
|---|---|
| **exactly what production was running** | `klarna, link` — `applePay:false, googlePay:false` |
| **with `paymentMethods:{applePay:'always',googlePay:'always'}`** | `applePay, googlePay, klarna, link` |

Same browser, same origin, same policy, nothing deployed in between. This is now `§3b` of
`npm run probe:stripe-wallets` and stays there permanently as the attribution control, so the
claim is reproducible rather than a story that fits.

> An explanation that fits the symptom is not the cause.

The CSP entries are genuinely required and genuinely were missing — they are shipped — but on
their own they would not have produced one additional wallet payment.

## 2. The wallet row was never dead

The same run shows **`link: true` on the unfixed site**.

The brief opens: *"The wallet row on `/payment` has never produced a single payment."* Link
renders **in that row**, and Link is 46 of the 173 charges in your own table. The row has been
live and taking money the whole time. What it was missing was precisely the two wallets that
have no separate surface, so their absence looked like the row's absence.

Worth carrying into the next investigation: the row and the wallets inside it are different
subjects, and the charge table can only see the ones that completed.

## 3. The entry with the most money attached is not a wallet entry

`frame-src` was missing `https://hooks.stripe.com` — **3-D Secure challenges render there.**

Any card that triggered a 3DS step has had nowhere to draw it for as long as this header has
existed. 118 card charges succeeded because most cards never trigger one; **nothing we have
measures the ones that did**, and they would look exactly like abandonment. This is on the main
payment path, it is not about wallets, and it is the clearest reason the CSP half shipped
regardless of §1.

If you can query it from the Stripe side, the number worth knowing is: **how many PaymentIntents
since March entered `requires_action` with a 3DS redirect and never reached `succeeded`?** That
is the one figure that would size what this cost. We cannot see it from the frontend.

## 4. Your verification step cannot run — please don't send it to anyone else

> *"DevTools console — `js/payment-page.js` already logs the answer."*

It does not. Every one of those lines goes through `DebugLog` (`inkcartridges/js/utils.js`),
which is hard-gated on `hostname === 'localhost' || '127.0.0.1'`. **On production they are
no-ops.** Following step 2 as written puts a tester in front of an empty console, which is the
same blind experiment that produced the zero in the first place.

Fixed on our side, opt-in: **`/payment?wallet-debug=1`**. The flag persists in `sessionStorage`
so it survives Stripe's redirect, and the console then prints the availability map, an ECE
lifecycle state, and any CSP refusal by name:

```
[wallets] ready: applePay, link · full map: {...}      -> working
[wallets] ready, but NO eligible wallet. Map: {...}    -> the device reported nothing
[wallets] CSP REFUSED frame-src -> https://link.com    -> an entry is still missing
[wallets] TIMEOUT — ready never fired within 8000ms    -> the frame never came up
```

That last line is new behaviour, and it matters for your diagnosis: **when the CSP refuses the
Element's frame, `ready` never fires at all.** Both branches of our ready handler were skipped,
the wrapper was never removed, and an empty gap sat above the card form with nothing logged
anywhere. The failure mode your brief is about was the one our code could not report. It now has
a deadline.

## 5. What we changed

| File | Change |
|---|---|
| `inkcartridges/vercel.json` | Your seven entries, applied **as an addition** — verified 7 added / 0 removed, directive by directive, against the header live on the day |
| `inkcartridges/js/payment-page.js` | `paymentMethods:{applePay:'always',googlePay:'always'}`; an 8s `ready` deadline; a `securitypolicyviolation` listener; the `?wallet-debug=1` channel |
| `tests/stripe-wallet-csp-sep2026.test.js` | 23 guards, all red-proofed. §3 runs a real CSP host-source matcher and proves `https://link.com` does **not** match `checkout.link.com` and `https://*.link.com` does **not** match `link.com` — so neither can be deleted later as redundant |
| `scripts/probe-stripe-wallets.mjs` | `npm run probe:stripe-wallets`. Read-only. Reads the deployed header, reports drift and which side is behind, and mounts a deferred ECE in a real browser. No PaymentIntent, no order, no cart, no confirm |

One note on the trade-off we accepted, since it is visible to customers: `'always'` shows an
Apple Pay or Google Pay button to someone who has not set that wallet up, and they get the
wallet's own sign-in flow rather than no button. Stripe still hides it entirely on unsupported
platforms and currencies. We judged a sign-in prompt better than six months of nothing; if the
data disagrees once there is any, it is one word to change back.

## 6. Things we deliberately did not do

- **We did not touch the card Payment Element.** You suggest flipping its `wallets` to `'auto'`
  while diagnosing. That path carries 164 of the 173 charges, and `paymentElement.update()` does
  **not** accept `wallets` — we checked against Stripe's option list — so a real fallback means
  destroying and re-creating the one part of checkout that demonstrably works. Not before a
  single wallet payment has ever completed.
- **No `.well-known/apple-developer-merchantid-domain-association`.** Agreed with your reading.
- **No cart-page wallet button (Option B).** Your sequencing is right and we have adopted it: CSP
  → prove one wallet payment completes on `/payment` → then build it. Your four backend items
  under Option B look correctly scoped to us; we will come back with a brief when we get there,
  not before.

## 7. Still open, and only a person can close it

**Apple Pay on real Safari.** Apple Pay on the web is a WebKit API gated on a real device with a
card in Wallet. Our probe drives Chromium, so it can prove the policy permits the frames, that
the Element reaches `ready`, and that `'always'` is what adds the two wallets — it **cannot**
prove Apple Pay completes. We are not reporting that as verified.

The remaining step is a human on a Mac with Touch ID or an iPhone, opening
`/payment?wallet-debug=1` with a real cart at step 3, and reading the line above.

---

**Nothing is asked of the backend in this document.** The one thing that would help is §3's
3DS question, if it is cheap to answer.
