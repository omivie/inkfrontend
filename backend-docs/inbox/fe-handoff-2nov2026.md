# FE handoff: 2 November 2026

From the backend, for the storefront developer. Full specs for every item live in [`FE-MASTER-CHECKLIST-oct2026.md`](FE-MASTER-CHECKLIST-oct2026.md) (items 38, 46, 50–63). This file is the short version: what to ship, in what order, and what changed on the backend on 1–2 Nov.

**The important change since the checklist was written:** the backend's bot pages for items 59–62 went live on **1 Nov**, earlier than planned. Bot pages (`/api/prerender/...`) and the www pages people see must say the same things, so items 59–62 are now **ship as soon as you can**, not "on the day we tell you".

---

## 1. Order of work

| # | Item | Priority | Size | Why now |
|---|---|---|---|---|
| 1 | **51**: a refused Pay press must not add the cart again | P0 | small | A customer was charged for 9 cartridges instead of 3 (order 2026100602). |
| 2 | **50**: www `/privacy`, Google Customer Reviews item + "Last updated" date | P0 | copy | The survey already sends buyer data to Google; the page must say so. |
| 3 | **52**: re-quote shipping when the postcode changes; number pad | P1 | small | The fee charged can differ from the fee shown. |
| 4 | **59**: compatible product pages stop printing `manufacturer_part_number` | P1 | small | It prints our supplier's code as if it were the maker's part number. |
| 5 | **60**: www `/about` and `/genuine-vs-compatible` copy | P1 | copy | Bot pages changed 1 Nov; www still carries removed claims. |
| 6 | **61**: printer-page copy (2 lines) + title check | P1 | copy | Bot pages changed 1 Nov. |
| 7 | **62**: `/ribbons` title, H1, intro, first FAQ | P2 → now | copy | Bot `/ribbons` changed 1 Nov. |
| 8 | **63**: review summary shows "NaN based on 1 review" | P1 | small | 5 product pages show it since 5 reviews were approved on 1 Nov. |
| 9 | **46**: printer pages list in-stock compatibles first + `compatibility_promise` beside Add | P1 | 1–2 days | Printer pages get the most free traffic and convert ~0%. |
| 10 | **38**: one-click "Remind me" on the order confirmation page (2 result lines changed) | P1 | half day | 2 of 48 web orders have reminder consent. |
| 11 | **27**: `warranty.compatible_label` under the COMPATIBLE heading | P2 | small | |

Item 37 (printer finder first on brand/category pages) stays P0 as already planned; slot it where it fits around 51.

Please reply with the date each item goes live. For 60, 61 and 62 that date matters most, because until then bot and www differ.

---

## 2. What changed on the backend (live 1–2 Nov)

You do not need to build anything for these, but they change what the API returns.

- **Product descriptions rewritten (4,112 rows).** `GET /api/products/:sku` `description` no longer says "same specifications as the original", "a fraction of the price of genuine", "significant cost savings", pack "save" prose or "Fast NZ delivery". Compatible rows now name the OEM part they replace, from the product name: "Compatible replacement for HP 02 (C8721WA) Black". The delivery line is "Free NZ shipping on orders over $100". If the storefront has any hard-coded copy with those old phrases, remove it too.
- **Testing claim kept, reworded:** "tested before dispatch" (our suppliers ship straight to customers, so "on receipt" was not true).
- **The Kelston warehouse, "dispatched from Kelston", opening hours and email reply-time promises are gone** from every bot page and from the LocalBusiness JSON-LD (customers are not met at the address). The registered company address stays.
- **Review-request email:** no $5 coupon, and no "review us on Google" link any more. The `/review?token=` page is unchanged.
- **Prices:** 11 singles and the 10 packs built from them were lowered on 2 Nov (e.g. CTN233Y $48.79 → $42.99). Nothing for you to do; caches refresh on their own.
- **Shopping feed:** no more `g:return_policy_label`, no "Fast" highlight, no supplier part numbers.

---

## 3. Items 59–63: full text (updated 2 Nov)

### 59. Compatible product pages: stop printing `manufacturer_part_number` (P1)

On a compatible cartridge, `manufacturer_part_number` holds our supplier's code (for example `IHP62BXL`), not the maker's part number (HP `C2P05AA`). Printed as a part or model number, it tells the shopper something untrue.

- On product pages where `source` is `compatible`, do not print `manufacturer_part_number`. Show nothing in its place: the `description` already carries the right reference ("Compatible replacement for HP 62XL (C2P05AA) Black") since 1 Nov.
- Ribbons (`product_type` `ribbon`) keep theirs: on a ribbon it is the group buyers search for ("Group 24").
- Genuine pages do not change.

**Done when:** a compatible ink or toner page (try C62XLBK, C02BK) shows no supplier code such as `IHP62BXL`; a genuine page and a ribbon page still show theirs.

### 60. www `/about` and `/genuine-vs-compatible` (P1, copy only)

Some lines on these pages are not true. The owner confirmed on 1 Nov that customers are not met at the Archibald Rd address and orders ship from our suppliers, not from Kelston. Two facts are confirmed and stay: we are NZ-owned ("100% NZ owned" stays), and every compatible cartridge is tested. Copy every new line exactly.

**`/about`**
1. "Why we're here": replace "Most New Zealand printer-supply websites are either offshore marketplaces with three-week shipping, or local stores charging that for a single black ink. We started InkCartridges.co.nz because there was an obvious gap: a New Zealand business that stocks the cartridge you actually need, ships it tracked the same day, charges a fair price, and answers the phone when you call." with "We started InkCartridges.co.nz to be a New Zealand business that sells the cartridge you actually need."
2. Intro: delete ", usually within one to two working days", so the sentence ends "on the NZ Post, Aramex and NZ Couriers courier networks."
3. Delivery times: in "Auckland metro orders placed before 12pm on a business day are dispatched same-day; metro typically has the parcel the next morning. Outside Auckland metro, dispatch is the next working day." delete everything after "dispatched same-day", keeping the full stop. In the "We're a small team" paragraph, delete "; outside Auckland metro, dispatch is the next working day". In "Where we ship", delete the line "Auckland metro — 1–2 working days from dispatch."
4. "What we believe": replace the heading "Buy once, prints right" with "Warranty and guarantee", and its text with "Genuine cartridges carry the original manufacturer warranty. Compatible cartridges are covered by our 30-day satisfaction guarantee."
5. "What we believe": replace the heading "Fair pricing, no surcharges" with "No surcharges". Keep the text under it.
6. "What we stock": replace "Compatible: third-party cartridges built to comparable specifications, offered at a lower cost than genuine. Each one is quality-checked on receipt and covered by our 30-day satisfaction guarantee." with "Compatible: third-party cartridges built to comparable specifications. Each one is tested before dispatch and covered by our 30-day satisfaction guarantee."
7. "Where we ship": replace "Every order is dispatched from our Kelston, Auckland office using NZ Post, Aramex (CourierPost) and NZ Couriers." with "Every order ships by courier."
8. The two "Hours: Monday – Friday, 9:00am – 5:00pm NZT" lines: in the top block, replace it with "Phone: 027 474 0115 · Email: support@inkcartridges.co.nz"; in the contact block, delete it.
9. "Call or write": replace "Our office is small and not staffed for retail walk-ins — please call or email first if you'd like to drop in. We pick up the phone in business hours and reply to email within one working day, every time." with "Call 027 474 0115 or email support@inkcartridges.co.nz."
10. "Real support": replace "Call 027 474 0115 in business hours and a person picks up. Email replies within one business day, every time." with "Call 027 474 0115 or email support@inkcartridges.co.nz." The heading stays.

**`/genuine-vs-compatible`**

11. In the summary, replace "Lower cost, and covered by our 30-day satisfaction guarantee." with "Covered by our 30-day satisfaction guarantee."
12. Delete "We reply within one business day."

**`/contact` and `/returns`:** remove any opening hours, reply-time promise or Kelston dispatch line you find. The phone number and email address stay.

**Done when:** none of the replaced lines appears on www, and each new line matches the text above exactly.

### 61. Printer pages: two lines and the title check (P1, copy only)

1. If your printer pages render their own text, change it as our bot page did on 1 Nov:
   - "Compatible cartridges cost less than genuine, and each names the part number it replaces." becomes "Each compatible cartridge names the {Brand} part number it replaces."
   - The FAQ question "How much can I save with compatible cartridges for the {printer}?" becomes "How do compatible and genuine prices compare for the {printer}?" (the answer is unchanged). The visible FAQ must stay word for word the same as the FAQ JSON-LD.
2. If any www title or meta description says "Fast NZ Delivery" (or "fast" with no number), drop it: the bot printer titles now end "| InkCartridges.co.nz".
3. Please confirm your printer-page H1 and title read `display_name`.

**Done when:** no printer page says compatibles "cost less than genuine", asks "How much can I save", or says "Fast NZ Delivery"; you have told us what the H1 and title read.

### 62. `/ribbons` title, H1, intro and first FAQ (ship now)

Our bot page `/api/prerender/category/ribbons` changed on 1 Nov. Copy these word for word from it (checked live on 2 Nov):

- Title: "Typewriter & Printer Ribbons NZ | InkCartridges.co.nz"
- H1: "Typewriter and Printer Ribbons NZ"
- Intro: "We stock 22 typewriter ribbons and 6 correction tapes for Brother, Canon, IBM, Nakajima, Olivetti, Olympia, Sharp and Triumph-Adler typewriters, plus universal ribbons, and 81 printer ribbons for Epson, OKI, Citizen, Star, Panasonic and other makes. All prices include GST. Free shipping on orders over $100."
- First FAQ: "How do I find the right ribbon for my typewriter?" Answer: "Check the make and model on your typewriter and search for it, or search the code printed on your current ribbon spool. Unopened items can be returned within 30 days."

The counts in the intro move with stock. On the day you ship, copy the intro from the bot page, not from here.

**Done when:** www `/ribbons` and the bot page show the same title, H1, intro and first FAQ.

### 63. Product page review summary shows "NaN" (P1)

On a product with one approved review (C604XLKCMY), the "Customer Reviews" summary reads "NaN based on 1 review", while the rating link at the top correctly shows "5.0 / 1 review". Compute the summary average from the same field the top link uses (the reviews API's average rating), and hide the summary when there are no reviews.

**Done when:** C604XLKCMY shows "5.0 based on 1 review" in the summary, and a product with no reviews shows no summary.

---

## 4. Small changes inside existing items

- **Item 38:** the two "Done" lines changed on 1 Nov (the reminder date is an estimate, so the page cannot promise "before you run out"):
  - `delivery_blocked: null`, `reminders_resumed: false`: "Done — we'll email you when these are likely running low."
  - `delivery_blocked: null`, `reminders_resumed: true`: "Done — reorder reminders are back on. We'll email you when these are likely running low."
- **Item 46, point 4:** beside each Add on printer pages, show `trust_signals.compatibility_promise.label` ("Not sure it fits? 30-day returns on unopened items" today). It comes with every `GET /api/cart` response; the PDP already renders it. Read it from the API, never type it in. Never say "guaranteed fit".
- **Item 50:** when the Google Customer Reviews item goes live on www `/privacy`, change "Last updated: 5 May 2026" to the day you publish.

---

## 5. Copy rules (apply to anything new)

- No "cheapest", "lowest price", "best price", "save up to", "unbeatable", "guaranteed fit", or any comparison with genuine prices ("lower cost than genuine", "fraction of the price").
- No "fast" without a number. Delivery facts come from the API (`shipping_promise`, `getTrustSignals()` via `/api/site/trust`): same-day dispatch is for **Auckland metro** orders placed **before 12pm on a business day**.
- No opening hours, reply-time promises, or "dispatched from Kelston".
- No coupon codes anywhere.
- No "dedicated account support" or account manager.
- Shipping fees and the $100 free-shipping threshold: unchanged.

---

## 6. How to check your work against ours

| Item | Bot page to compare with |
|---|---|
| 59 | `https://api.inkcartridges.co.nz/api/prerender/product/C62XLBK` |
| 60 | `https://api.inkcartridges.co.nz/api/prerender/static/about`, `/static/genuine-vs-compatible`, `/static/contact`, `/static/returns` |
| 61 | `https://api.inkcartridges.co.nz/api/prerender/printer/{brand}/{printer-slug}` |
| 62 | `https://api.inkcartridges.co.nz/api/prerender/category/ribbons` |

Questions: reply on the handoff thread, or ask the owner to forward them.
