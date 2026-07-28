# Backend handoff — retro-claim signal, per-order points, and the guest invoice CTA

**Date:** 2026-07-28
**Requested by:** frontend (InkCartridges.co.nz)
**Repo affected:** backend API (`https://ink-backend-zaeq.onrender.com`) — separate repo from the frontend
**Status:** proposal, not yet implemented
**Priority:** low/medium — the frontend has shipped in a fail-soft state and degrades silently without any of this
**In reply to:** `loyalty-guest-retro-FE-handoff-jul2026.md` (backend → frontend, `16013fe` / `4ed7401`)

This document is self-contained.

---

## 0. First — three corrections to the FE handoff

Verified against the frontend source before implementing anything. Two of the handoff's
statements are wrong and one optional ask was unbuildable as written. None of this blocks you;
it just means less work than you thought in two places and a different shape in the third.

**(a) "Points may take 24h" copy can be removed — there is none.**
Searched every `.js`, `.html` and `.css` file case-insensitively for `24h`, `24 hours`,
`within 24`, `may take`, `overnight`, `nightly`, `pending points`, `shortly`. Zero hits relating
to loyalty. The only points-timing sentence that has ever shipped is:

> "Earn 1 point for every $1 you spend (excluding shipping), credited once your order is paid."

(`html/account/loyalty.html`, and the JS override in `js/loyalty-page.js`.) It never promised a
delay, so nothing needed removing. Nothing was added either — the tests now ban that vocabulary
outright so it cannot creep in later.

**(b) "The signup flow must keep calling POST /account/sync" — it does, and now more reliably.**
It is called from `js/auth.js` inside the global `onAuthStateChange` handler, which is
provider-agnostic (email/password, Google, Microsoft/Azure all route through it), plus a second
call from the account dashboard. We found and fixed one page that could not participate:
`html/account/reset-password.html` was not loading `auth.js`'s dependencies at all.

**(c) "The customer-facing downloadable invoice PDF is FE jsPDF" — there was no such PDF.**
This is the one that changes your mental model. jsPDF was loaded on exactly **one** page:
`/admin`. The only builder was `buildInvoiceDoc()` in `js/admin/pages/invoices.js`, which renders
the **operator's B2B tax invoice** — created by hand for invoiced accounts, uploaded to you by the
admin browser, and with no relationship to the loyalty ledger. **No storefront surface offered a
download of anything.** A retail customer had no receipt to download at all.

So "add the points line to the customer PDF" had nowhere to go. We built the missing thing
instead: a real customer receipt PDF (`js/order-receipt.js`), downloadable from
`/order-confirmation` and `/account/order-detail`, which renders the full money breakdown
including loyalty applied and points earned. **Your invoice email and the admin invoice document
are untouched.** Ask #1 in your list is now done, on the frontend, and needs nothing from you.

---

## 1. Ask A — a `retro` block on `POST /api/account/sync`

### Problem

Retro points are now awarded immediately during sync, which is a genuinely better experience —
but it is currently **invisible**. A converting guest signs up, lands on `/account`, and their
balance is 889 instead of 0 with orders in their history that they never placed while logged in.
Nothing on the page explains why. The most likely reading of an unexplained balance is a bug.

We want to say: *"1,412 points added to your account — we matched 3 previous orders to your new
account and credited the points you earned on them."*

We will not infer that message. We have the balance and we have the order list, so we could
guess — and a wrong "we found your past orders" is worse than saying nothing. Every number in
that sentence has to be one you sent.

### The ask

Add an optional `retro` object to the `POST /api/account/sync` response envelope:

```jsonc
{
  "ok": true,
  "data": {
    /* ...everything already there, unchanged... */
    "retro": {
      "orders_claimed": 3,      // integer > 0 — orders whose user_id was just set
      "points_awarded": 1412,   // integer > 0 — points credited for those orders
      "claim_id": "rc_01H..."   // optional, opaque; used only for dedup/support
    }
  }
}
```

Purely additive. No existing field changes shape.

### Two rules that matter more than the shape

1. **OMIT the whole block when nothing happened.** Do not send
   `{"orders_claimed": 0, "points_awarded": 0}`. On this frontend, "reported as zero" and "not
   reported" are different states with different UI, and collapsing them is the single most
   repeated defect in our error log (ERR-063/068/073/075/076 — six incidents, all the same
   shape). We treat a zeroed block as "nothing happened" and render nothing, so a zeroed block is
   *harmless* — but omitting it is unambiguous, and unambiguous is what we want.

2. **The award must be idempotent.** Sync is called on **every** sign-in, not just the first, and
   from two call sites per page load. Awarding points per call would multiply a user's balance by
   their login count. We assume you already handle this (the one-time backfill implies you do);
   this is stated so it stays true.

Sending the block on repeat syncs is fine — we keep a per-device marker keyed on
`user + orders + points` and announce a given claim at most once.

### What we do with it

`Auth.captureRetroClaim()` (`js/auth.js`) stashes it in `sessionStorage`, and the dashboard's
`renderRetroClaimBanner()` (`js/account.js`) announces it once, then deletes it. Until you ship
the field, every path renders nothing. **There is no error state and no degradation** — the
feature is simply dormant.

---

## 2. Ask B — `points_earned` and `loyalty_points_redeemed` on the order

This is your own optional ask #2. Yes please, and here is why it is worth more than it looks.

### Problem

`GET /api/orders/{order_number}` exposes `loyalty_discount_amount` (the dollar value redeemed)
but neither:

- `points_earned` — points credited for this order, nor
- `loyalty_points_redeemed` — the point **count** spent on it.

Consequences on our side, both bad:

**1. We reimplemented your earn rule in JavaScript.** `/order-confirmation` estimated the figure
as `floor(order_total − shipping)` and rendered it as `≈ +85 pts`. That is your business rule
living in our client, guessing. It also violates our own standing rule that the backend owns
every price (DEC-004).

Worse, the old implementation read shipping as
`order.shippingCost || order.shipping_cost || 0` — so an order whose shipping we could not read
**estimated off the full total** and overstated the points by the shipping amount. Now fixed: an
unknown input collapses the row to nothing rather than showing a confident wrong number. But the
estimate should not exist at all.

**2. We can show the dollars but not the points.** The order summary can say `-$12.00` but never
`1,200 pts`, because the count is not in the payload — which is a strange thing for a *points*
programme to be unable to say.

### The ask

Add to `GET /api/orders/{order_number}` (and the same object in `GET /api/orders` if it is cheap):

| Field | Type | Meaning |
|---|---|---|
| `points_earned` | `integer \| null` | Points credited for this order. `null` = **not yet determined** (e.g. payment not settled). `0` = determined to be zero. Please keep those distinct. |
| `loyalty_points_redeemed` | `integer \| null` | Point count spent on this order. `null` = not reported, `0` = none redeemed. |

### What changes for us when it lands

`js/order-totals.js` already prefers `points_earned` over the estimate and already reads
`loyalty_points_redeemed` for the label — **both are wired and dormant today**. The moment you
ship the fields:

- `≈ +85 pts` becomes `+85 pts` on the confirmation page, order detail, and the receipt PDF;
- the estimate caveat sentence disappears on its own;
- the applied row starts reading `Loyalty points applied (1,200 pts)`.

No frontend release required for the first two. We will then delete `pointsEarnedEstimate`
entirely, which is the actual goal.

---

## 3. Ask C — one character on the guest invoice CTA

Your guest-order invoice email renders *"Sign up & claim your points"* pointing at
`${SITE_URL}/account`.

`/account` is the **dashboard**, which requires auth. A logged-out visitor is redirected to
`/account/login`, which opens on the **Sign In** tab. Someone who just clicked "sign up" is now
looking at a sign-in form — the one thing they cannot use.

**Please change the CTA to `${SITE_URL}/account?intent=signup`.**

The frontend already honours it (shipped 2026-07-28): `?intent=signup` carries through the auth
redirect and opens the **Create Account** tab, matching what the on-site rewards nudge already
does. Anything other than exactly `signup` is ignored, and the value is never reflected into the
URL, so it is not an open-redirect or reflection sink.

Until you change it the link still works — it just lands on the wrong tab.

---

## 4. Summary

| # | Ask | Blocking? | FE state today |
|---|---|---|---|
| A | `data.retro` on `POST /account/sync` (omit when nothing happened; idempotent award) | no | wired, dormant, renders nothing |
| B | `points_earned` + `loyalty_points_redeemed` on the order | no | wired; falls back to a clearly-labelled estimate |
| C | guest invoice CTA → `/account?intent=signup` | no | FE side shipped and waiting |

Nothing here changes an existing field's shape or type. Nothing here needs a coordinated
release — each ask improves the UI the moment it lands, with no frontend deploy.

## 5. Non-goals

- Not asking for a loyalty ledger endpoint per order.
- Not asking you to change the invoice email. The "could have earned" nudge is good as-is.
- Not asking for anything on the admin invoice document.
- Not asking for a points figure on the **cart** — `POST /api/cart/loyalty` already carries
  everything the redemption widget needs.
