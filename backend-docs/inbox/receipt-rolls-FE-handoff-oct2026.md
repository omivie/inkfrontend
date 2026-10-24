# Receipt Rolls: storefront handoff (Oct 2026)

**From:** backend · **Date:** 23 Oct 2026 · **Checklist:** FE-MASTER-CHECKLIST item 48

We now sell 19 POS paper rolls. The backend side is live: products, prices, photos, search, the bot-facing pages and the Google Shopping feed. The storefront needs four changes, and the first one blocks the category entirely.

---

## 1. P0: the category URL redirects to the shop home

`www` answers both URLs below with a **301**, for shoppers and for Googlebot:

| URL | Goes to today |
|---|---|
| `/shop?category=receipt` | `/shop` |
| `/shop?brand=okin&category=receipt` | `/shop?brand=okin` |

The storefront drops any category it does not recognise. So the "Receipt Rolls" link that `/api/site/nav` already serves lands on the shop home, and Google can never index the category.

**Fix:** add `receipt` wherever the allowed category list lives. The backend also accepts the aliases `receipt-rolls`, `receipt-roll` and `receipt_roll` and normalises them to `receipt`.

(The same redirect hits `/shop?category=photo_paper`. `paper` and `label` are fine.)

**Done when:** `curl -sI "https://www.inkcartridges.co.nz/shop?category=receipt"` returns `200`.

---

## 2. Ask: a clean landing URL, `/receipt-rolls`

Please give the category its own route, the way `/ribbons` works:

- The SPA renders the receipt-roll listing at `/receipt-rolls`.
- The bot middleware prerenders it from **`GET https://api.inkcartridges.co.nz/api/prerender/category/receipt`**. This is live now, with the title "Thermal Receipt & EFTPOS Rolls NZ — Fast NZ Delivery", a roll meta description, an intro, a buying guide, and a FAQ with matching FAQPage JSON-LD.

Tell us when it is live. We then set the taxonomy `landingPath`, which moves the nav link, canonical, breadcrumb and sitemap to `/receipt-rolls` in one edit. Until then the canonical is `/shop?category=receipt`.

---

## 3. Listing: skip the one-tile brand picker

There are two ways to fetch the listing.

**A. No brand needed (simplest):**
```
GET /api/products?category=receipt&limit=50
```
This returns all 19 products.

**B. The current category flow:**
```
GET /api/products/series?category=receipt
→ { requires_brand_selection: true, brands: [{ name: "Okin", slug: "okin", product_count: 19 }] }
```
There is only one brand. When the picker returns **exactly one brand**, go straight to `/shop?brand=okin&category=receipt` (`GET /api/shop?brand=okin&category=receipt`) instead of showing a single tile.

**Other listing rules:**
- **Order:** the API already sorts rolls by paper (bond, carbonless, thermal) and then by size. Please do not re-sort them by family.
- **Series chips:** rolls have none (`series_codes: []`), so the chip row is empty. Hide it rather than showing an empty bar.
- **Okin brand:** Okin is deliberately left out of the brand nav and the brand sitemap, because our brand-page copy is written about cartridges. Do not add an Okin brand tile or brand page link.

---

## 4. Product page and cards: `product_type === 'receipt_roll'`

A roll is its maker's own product, not a third-party replacement for a printer brand's part. The cartridge framing reads wrong on it, and some of it would be false.

**Hide on roll products:**
- the **Genuine / Compatible** badge (the API still sends `source: 'compatible'`, because Augmento is our compatible supplier);
- the **compatible-product disclaimer** (`trust_signals.warranty.compatible_label`, "not manufactured by …"). The bot-facing page already leaves it out;
- the **"Compatible printers" / "For use in"** block. Rolls have no printer links (`compatible_printers: []`);
- **page-yield, colour swatch and pack-suggestion** UI (`page_yield`, `color` and `pack_suggestion` are all `null`).

**Show:**
- `display_name` (equal to `name` for rolls), `description` (HTML), price and `quantity_breaks` as usual;
- a small spec table from `specifications`:

| key | example | notes |
|---|---|---|
| `roll_width_mm` | `80` | |
| `roll_diameter_mm` | `80` | |
| `paper` | `"Thermal"` · `"Bond"` · `"Carbonless 2-ply (white/yellow)"` | |
| `paper_weight_gsm` | `60` | |
| `bpa_free` | `true` | thermal only, otherwise absent |
| `core` | `"Coreless"` | only on CTR57X25P10, otherwise absent |
| `rolls_per_pack` | `5` | |

**Missing photo:** `CCR76X76P5` (the carbonless roll) has `image_url: null` on purpose: the supplier's box photo says "Thermal". Show a neutral placeholder. Do not use the coloured "COMPATIBLE" swatch tile.

**Do not add copy of your own** about roll length, FSC, or which named EFTPOS or printer models a roll fits. We have no reliable source for any of those (the supplier and resellers disagree on length by up to 60%). The descriptions say "check your device's paper width and maximum roll diameter" instead.

---

## 5. Category page copy (only if the SPA renders its own)

If the SPA builds its own title, h1 or FAQ for the category, keep them identical to the prerender. Bots and shoppers must see the same text (cloaking check):

- **title:** `Thermal Receipt & EFTPOS Rolls NZ — Fast NZ Delivery`
- **h1:** `Receipt Rolls NZ — Buy Online at InkCartridges.co.nz`
- **FAQ / buying guide:** do not write different text. Either leave them out of the SPA, or ask us and we will expose the backend's copy as an endpoint.

---

## No storefront change needed

- **Search:** roll-shaped queries are rewritten on the backend in `/search/smart`, `/suggest` and `/autocomplete`. Examples: "80x80" → `80x80mm`, "eftpos rolls" → thermal, "till rolls" → receipt, and "paper" is dropped. HP photo paper "10x15" and cartridge codes are left alone.
- **Cart and checkout:** standard. Each roll carries its own shipping weight (0.26–2.24 kg).
- **Nav:** `/api/site/nav` already lists `{ slug: 'receipt', label: 'Receipt Rolls', path: '/shop?category=receipt' }`. If your nav is hard-coded, add it.

---

## Reference

- **SKU shape:** `C{TR|BR|CR}{width}X{diameter}P{rolls}`. TR = thermal, BR = bond, CR = carbonless; for example `CTR80X80P5` is thermal, 80mm wide, 80mm diameter, pack of 5.
- **The 19 rolls:**
  - CTR57X25P10, CTR57X38P10, CTR57X40P10, CTR57X47P10, CTR57X50P10, CTR57X50P4, CTR57X57P10, CTR57X75P10
  - CTR76X48P5, CTR80X60P5, CTR80X70P5, CTR80X80P2, CTR80X80P5
  - CBR37X70P10, CBR44X75P10, CBR57X57P10, CBR76X70P5, CBR76X76P5
  - CCR76X76P5
- **Test product:** `https://www.inkcartridges.co.nz/products/thermal-receipt-rolls-80x80mm-bpa-free-pack-of-5/CTR80X80P5`

## Done when

1. `/shop?category=receipt` (or `/receipt-rolls`) returns 200 and shows all 19 rolls, in one click from the nav.
2. The CTR80X80P5 page shows no Genuine/Compatible badge, no compatible disclaimer, no printers block, and does show the spec table.
3. CCR76X76P5 shows a neutral placeholder image.
4. Tell backend when `/receipt-rolls` is live, so we can switch the canonical and sitemap.
