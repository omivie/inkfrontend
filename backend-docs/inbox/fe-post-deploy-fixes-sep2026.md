# Post-deploy fixes — FE, 2026-09-28

**From:** backend · **Follows:** `conversion-fixes-FE-reply-sep2026.md` and our
response `conversion-fixes-FE-reply-backend-response-sep2026.md`

Thank you for the deploy. We checked it on production on 2026-09-28 in fresh
browser contexts (desktop 1440x900 and phone 390x664).

**Working:**
- The "Fits …" line on cards and on the PDP, and "Not sure it fits? 30-day
  returns on unopened items".
- The value strip under the header.
- The "Email me a copy of my cart if I don't finish" box at checkout.
- `/value-packs`, `/bulk-pricing` and `/rewards`.
- No rewards popover anywhere; the last `rewards_nudge_*` event was
  2026-09-27 03:49 NZT.

Five items remain, in priority order.

---

## 1. P0 — switch on the `/review` page (today)

**Now:** `/review?token=<a real token>` shows "This review link isn't active yet.
Thank you for your order — we'll email you when reviews open." It never calls
`GET /api/reviews/by-token/:token`. The review flag in `Config.DARK_FEATURES` is
still `false`.

**Why today:** since 2026-09-27 the review-request email links every product to
this page, and for GUESTS (most buyers) it is the only way to review. No email
has gone out since the change yet. The job runs nightly at 16:00 NZT, so the
first one can go out on any evening.

**Fix:** flip the flag. The backend is live:
- `GET /api/reviews/by-token/:token` → `{order_number, items: [{sku, name, image_url, reviewed}]}`, or 404.
- `POST /api/reviews/by-token {token, sku, rating, title?, body?}` → 201, or 200 with `already_existed: true`.

**Acceptance:** a real token lists the order's products, and a submitted rating
shows `reviewed: true` on reload. We can send you a live token for a test
order on request.

## 2. P0 — compatible PDP on desktop: the Add button is under the cookie bar

**Measured** on `CLC73BK` at 1440x900 with a first-visit context:
- The Add to Cart button is at **y 881–929**; the consent bar starts at **y 839**.
- A first-time desktop visitor (every ad click) cannot see or click Add without
  scrolling past the bar.

**What pushes it down**, top to bottom in the right column:
- price block
- the countdown line
- "1.0¢ per page"
- the **full compliance box**, two lines: "Compatible (third-party) ink
  cartridge for Brother printers — not made or endorsed by Brother. Sold by
  Office Consumables Ltd."
- the **4-card "Buy more, save more" grid** (3+, 4+, 7+, 8+)
- the "At 1 you pay…" line
- then Add

**Fix (the owner's decision, 2026-09-27), all three parts:**
1. **Compliance:** keep ONE line directly under the title: "Compatible — not
   made by Brother". The full box moves **below** Add. Do not drop the wording;
   the full text must still be on the page.
2. **Quantity ladder:** above Add, show one line: "3+ from $5.56 each · See all
   prices". The 4-card grid moves below Add, or opens from that link. Use the
   first rung of `quantity_breaks` and never state a maximum saving.
3. **Printer fit:** see item 4.

**Acceptance:** at 1440x900, first visit, consent bar open, the Add button on a
compatible PDP is fully above y 839. Check `CLC73BK` and one compatible toner
(for example `CTN2450`).

## 3. P1 — product cards drop the "+N"

**Now:** a card reads "Fits Brother DCP J525W, Brother DCP J725DW" with nothing
after it. The LC73 cartridge fits 11 printers.

**Why:** `compatible_printers` on listing rows is capped at **two** on purpose
(a page of 200 cartridges carries thousands of links). The total is in its own
field.

**Fix:** `+N = compatible_printers_count − compatible_printers.length`. That is
11 − 2 = "+9" for LC73. Show nothing extra when the result is 0. The PDP is
unaffected; it has the full list.

## 4. P1 — desktop PDP: printer fit is below the fold

**Now:** on desktop the "Fits: Brother MFC J5910DW, Brother MFC J432W +9 more"
line renders at **y 1160**, below Add. The owner's requirement is that printer
fit is obvious **before** the Add button.

**Fix:** one line, "Fits: {first two} +N more", directly under the title (next
to the compliance line from item 2). The full list and the "Check your
printer" box can stay where they are. Phone layout is fine as it is.

## 5. P1 — the same-day countdown needs its scope

**Now:** the green line "Order within 5h 03m for same-day dispatch" has no
qualifier. Two lines above it, the delivery row correctly says "Order before 2pm
NZT for same-day dispatch (Auckland metro)". The promise
(`trust_signals.shipping_promise.promise`) covers Auckland metro only.

**Fix:** "Order within 5h 03m for same-day dispatch (Auckland metro)". Or drop
the countdown and keep the delivery row, which already says it. This is a
truthfulness item (inv 9 / inv 13), the same class as the support-hours fix.

---

## Scoreboard (BF-076) — first read, 2026-09-28

The deploy is one day old, so this is a baseline, not a verdict. We will
re-send it after 7 full days.

| Measure | Value |
|---|---|
| `rewards_nudge_*` events | 23 on 09-25, 25 on 09-26, **1 on 09-27** (03:49, before deploy), **0 since** |
| Wallet charges since 09-20 | **0 Apple Pay, 0 Google Pay**. Card 8, Link 3. Too few orders since the deploy to judge the wallet change. |
| R7 (mobile burn) | quiet |
| R13 (run rate), 7 days to 09-26 | −$14.46/day after ads |
| First full day on the new site + new ads (09-27) | 1 order, from a Search ad on a phone. −$7.93 after ads, against −$47 to −$85 on each of the three days before. |

## Backend changes you do not need to act on

- **Guest carts are now kept 14 days**, matching the "saved until" date the cart
  shows. Until 2026-09-28 the nightly cleanup deleted them after 72 hours,
  along with the cart-email consent.
- **Review-request emails go to guest orders too**, and link to `/review` (hence
  item 1).
