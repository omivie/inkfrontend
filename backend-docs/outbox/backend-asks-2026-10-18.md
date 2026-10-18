# Frontend asks — 18 October 2026

**From:** frontend · **Date:** 18 October 2026 (NZDT)
**Answers:** your `backend-response-2026-10-17.md` (filed in `backend-docs/inbox/`).

Thank you. We measured every claim the frontend now relies on (`npm run probe:backend-17oct`,
read-only: 20 pass, 0 fail on 18 Oct). Everything below is built and live on our side as
ERR-359 to ERR-365. This file lists the six things that are still open. Each section says what
we measured.

**What we shipped against your response:**

| Your item | Our side |
|---|---|
| Titles | `display_name` is shown verbatim on every product surface. `ProductName.build` is deleted. The legacy pack grammar still runs, but only on rows you did not compose (the owner-pending packs) (ERR-359) |
| Pack contents | `quantity` and `page_yield` per row, `contents_known`, and `page_yield_pages` on singles. The extra product read per cartridge is gone (ERR-360) |
| Printer list | Toner ⇄ drum match on `compatible_printer_slugs`. When the field is absent, we fall back to the 2-printer sample. A retired printer slug in the address bar is replaced with `printer.slug` (ERR-361) |
| Points | A $0 order uses `payment_method: "points"`. Every new error code has wording. Wallet buttons hide at $0. A $0 order sends no Ads/UET purchase (ERR-362) |
| Admin Pricing | `gross_margin_pct`, `price_source` / `price_rule_id`. Bulk changes go through `POST /pricing/bulk` (preview first, then `confirm:true`). Margin rules can be listed, previewed, saved, turned on/off and deleted (ERR-363) |
| Net-margin sort | The two columns now sort by `net_margin_incl_fixed_pct` and `profit_incl_fixed_ex_gst`, and the tooltip note is gone (ERR-364) |
| Old pack URLs | Crawlers now get a hard 301 on www. This is guarded; see §2 (ERR-365) |

**Not done, on purpose:** `_recountChipsFromListing` stays. See §1.

---

## §1 Option (b): please pair toner and drum tiles by printer on the server

**Yes, please build option (b).** The owner's rule (16 Oct) is that toners and drums match **by
printer**. Your `series[].count` and the `?code=` listing still pair them **by code**. If we
deleted our recount, the tile numbers would stop matching what a click shows.

**Measured 18 Oct** (`probe:chip-counts`, paced, read-only):

| Brother page | tiles | storefront tile = cards on click | your `series.count` ≠ cards on click |
|---|---|---|---|
| toner | 53 | 53 | 43 |
| drums | 44 | 44 | 26 |

What we need: on `category=toner` and `category=drums` only, compute `series[].count` and the
`?code=` listing with the printer rule. That means own-category rows that carry the code, plus
partner-type rows (toner_cartridge ⇄ drum_unit) that share at least one
`compatible_printer_slugs` entry with them. Once that is live, `probe:chip-counts` shows 0
BACKEND-DRIFT and we delete the recount.

## §2 `GET /products/<slug>/<SKU>` sends the CURRENT address to a search page

Your "Pack names" ask 2 says this endpoint "answers 301 with the new address when a hop exists,
and passes through when none does". The first half holds. The second half does not.

| Request (18 Oct) | Answer |
|---|---|
| `…/products/lc3313kcmy-…-kcmy-4-pack/CLC3313KCMY` (old) | **301** to `/products/lc3313kcmy-…-kcmy-pack/CLC3313KCMY` ✓ |
| `…/products/lc3313kcmy-…-kcmy-pack/CLC3313KCMY` (current) | **301** to `/shop?search=Products%2Flc3313kcmy%20for%20brother` ✗ |

Same answer from `api.inkcartridges.co.nz` and `ink-backend-sg.onrender.com`.

Our middleware follows a 301 only when it lands on `/products/<another slug>/<same SKU>`. That
keeps the www 301 safe today. Please make the current address answer 200 (or 404) with no
redirect, as described, so that the endpoint means one thing.

## §3 Two gaps in `display_name`

1. **`/api/products/:sku` drops the brand on rows that are not composed.**
   G74C0ZV0's stored name is "Lexmark Genuine 74C0ZV0 Drum Unit (150,000 pages)". The listings
   send that string. The PDP sends "74C0ZV0 Drum Unit (150,000 pages)". Your doc says to show
   `display_name` verbatim everywhere. On the PDP that would print a title with no brand. We
   counted 768 rows that are not composed, and 623 of them are genuine rows whose stored name
   starts "<Brand> Genuine". The G74C0ZV0 PDP shows the brand dropped; we did not open all 623. For now, a `display_name` that is a suffix of `name` counts as "not composed" on
   our side, and we show the stored name.
   **Please send the stored name there too**, the same as the listings do.
2. **`compatible_alternatives[]` and `pack_suggestion` carry no `display_name`.**
   Measured on GTN2445BK and GLC432XLBK. These are the "Our compatible version" box and the
   "Buy the full set" box on the PDP. They show the stored name until the field arrives; our
   code already reads it.

## §4 Colour mismatches: our 15

You asked for the SKUs. Our last run of the old title builder (18 Oct, before we deleted it)
flagged 15 `color_mismatch` rows:

- **13 compatible mono drums:** CDR1070BK, CDR1170BK, CDR2025BK, CDR2125BK, CDR2225BK,
  CDR2315BK, CDR2415BK, CDR2530BK, CDR3000BK, CDR3115BK, CDR3325BK, CDR3415BK, CDR3605BK.
  As you said, these are not contradictions; the name has no colour word.
- **2 that look real, please check:**
  - **GCLTP407C**: "Samsung Genuine CLTP407C Toner Cartridge (1,500 pages)" is stored as colour
    **Black**, single, with yield text "bk 1,500 cl 1,000". CLT-P407C is sold as a 4-colour toner
    set, so the colour, pack type and yield all look wrong.
  - **G74C0ZV0**: "Lexmark Genuine 74C0ZV0 Drum Unit (150,000 pages)" is stored as **Black**.
    Please check this against Lexmark's part list. We believe 74C0ZV0 is the colour imaging unit
    and 74C0ZK0 the black one.

## §5 Two packs the rename missed

Both have colour `KCMY` and still say "4-Pack":

- `CDR233CLKCMY`: "DR233CL Compatible Drum Unit for Brother DR233CL 4-Pack"
- `CDR251CLKCMY`: "DR251CL Compatible Drum Unit for Brother DR251CL 4-Pack"

Your rule (`KCMY` + "4-Pack" ⇒ "KCMY-Pack") should cover them. They are not among the 46
owner rows. Our display rewrites them, so shoppers already see "KCMY-Pack".

## §6 Two pricing-rule calls we did not exercise

We tested the rule **preview** (POST without `confirm`) against production. We did not save,
switch off or delete a rule, because each of those reprices live products. Please confirm:

1. `DELETE /api/admin/pricing/rules/:ruleId` needs no body and no `confirm`. Does it return a
   `job_id` for the reprice? We poll `reprice-jobs/:job_id` when one comes back.
2. `PATCH /:ruleId {is_active:false}` without `confirm` returns the same preview shape as POST
   (`affected`, `unchanged`, `locked`, `sample`, …). Our "Turn off" button shows that preview
   before it sends `confirm:true`.

---

**Waiting on the owner, not on you:** names for the 46 packs; the 89 HP DesignJet names; and
which of the 5 unconfirmed printer rows (`brother-hl-l9430cdn`, `brother-mfc-8380dn`,
`brother-fax-2890`, `brother-hl-2060`, `brother-hll-3210cdw`) you should review first.
