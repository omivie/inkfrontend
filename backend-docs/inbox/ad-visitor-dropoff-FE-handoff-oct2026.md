# Ad visitors leave without adding to cart: storefront follow-ups (2 Oct 2026)

Follow-up to `paid-traffic-conversion-FE-handoff-oct2026.md` (1 Oct). Everything below was checked on the live site on 2 October 2026 at 00:30 UTC, at laptop viewport sizes, as a first-time visitor with no cookies and the consent banner open.

## Why this matters

On 1 October, 19 paid clicks cost $67.90 and **none of the paid visitors we could track added anything to the cart**. Over the last 8 days, Google Ads cost $403 and brought in 4 orders that kept $94, a net loss of $309. Once a visitor reaches the cart, the funnel holds up: 69% of carts reach checkout and 81% of checkouts complete. The loss happens on the landing page.

Page speed is **not** the cause. Measured with an observer installed before navigation:

| Page | Buy box or prices on screen |
|---|---|
| Product page, first visit (`GGI690KCMY`) | 583 ms |
| Product page, repeat visit | 131 ms |
| Series page `?code=288`, first load of that page | 1.1 s |

Please don't spend time on speed for this problem. The problem is what the visitor sees on the first screen.

## 1. Still open from the 1 October handoff (highest priority)

None of these has changed since 1 October. They remain the top three items, and nothing in this document outranks them.

### 1.1 P0: Product page, Add to Cart below the fold

At 1366 × 599 on `/products/canon-genuine-gi690kcmy-ink-bottle-gi690-kcmy-4-pack/GGI690KCMY`:

| Element | Top edge |
|---|---|
| Price | 439 px |
| Consent banner | 538 px |
| Add to Cart | **704 px** (below the 599 px fold) |

Same fix as before: put quantity and Add to Cart directly under the price and stock line, and keep the consent banner off the buy box.

### 1.2 P1: Series page, no price or Add button on the first screen

At 1366 × 599 on `/shop?brand=epson&category=ink&code=288`:
- The first price starts at 635 px and the first Add button at 763 px, both below the fold.
- The page's first `<h1>` still reads "Shop Ink Cartridges & Toner NZ". The browser title is right ("Epson 288 / 288XL Ink Cartridges NZ").

### 1.3 P2: `code=288XL` still lists the standard 288 first

`/shop?brand=epson&category=ink&code=288XL` shows the same first three cards as `code=288`: standard 288 Black, Cyan and Magenta. A paid visitor who searched "epson 288xl cartridge" on 1 October landed on this page and left after one pageview. Screenshot: `paid-traffic-conversion-oct2026/e-code-288XL-1366x599-2026-10-02.png`. It shows the whole first screen with no price visible, the consent banner across the bottom, and two grey "No Image" tiles.

## 2. New: "No Image" tile on genuine products (P2)

552 genuine product images are waiting for the owner's manual review in the admin queue. 412 of them are for in-stock products, including Epson 288 Black and the 288 KCMY pack. They were pulled back for review after a watermark problem in September, and they will come back slowly.

Until then, a genuine single with no image shows a grey "No Image" placeholder. Genuine **packs** already fall back to a "GENUINE" brand tile. **Please use the same tile for genuine singles with no `image_url`.** It makes the gap look intentional instead of broken. Products affected right now: any genuine row where `image_url` is null.

## 3. New: old Oregon backend is suspended (check only)

The old Render service `ink-backend-zaeq.onrender.com` (Oregon) was suspended on 2 October 2026 at 00:28 UTC. Verified:
- Render's request logs show **no storefront, prerender, sitemap or bot traffic** to it in the 24 hours before suspension. The only caller was an uptime pinger hitting `GET /` once a minute, which the owner will repoint.
- `https://api.inkcartridges.co.nz/health` returns 200 from the Singapore service (commit `2166b99`, database connected).
- `https://www.inkcartridges.co.nz/sitemap.xml` and `/robots.txt` both return 200 after the suspension.

**Action:** search the storefront code and the Vercel environment variables for `ink-backend-zaeq` and `onrender.com`, and remove any leftover reference. Everything should call `https://api.inkcartridges.co.nz`. If a call must bypass Cloudflare, use `https://ink-backend-sg.onrender.com`.

## 4. New: printer pages switched on (spot check only)

Backend data changes on 1–2 October. No storefront code change is needed.

- **New cartridge links on pages that were switched off and empty:** each fit was checked against the manufacturer's own site. For example, HP Envy 6120e, 6130e and 6131e now list HP 68. Envy 6520e and 6530e also list HP 68. Envy Inspire 7920e now lists HP 804, and Smart Tank 7005 and 5105 list HP 31 / 32XL. Epson WF-7845 lists 812, Brother MFC-J4340DW lists LC436, HL-3170CDW lists TN251/255, and DCP-L1630W lists TN1170. HP LaserJet P2015n and P4015 list 53A and 64X. 19 printer pages were switched on.
- **Duplicate rows fixed:** 137 links were added across 18 printer pages whose cartridges were split between two spellings of the same machine (for example Dymo LabelWriter 450 Duo and HP OfficeJet Pro 8120 / 9110).

Please open two or three of these, for example `/shop?brand=hp&printer_slug=hp-envy-6130e`, and confirm they render normally. They have not been through the storefront's QA before.

## 5. New: about a quarter of paid clicks left no pageview (P3, investigate)

On 1 October, about 5 of 19 paid clicks never produced a `traffic_events` pageview. Normally almost every click does: 12 of 12 on 29 September and 13 of 13 on 30 September. Most of the missing ones came between 8 and 10 am NZT, on different products. That pattern fits one visitor with a tracker blocker, so it may not be a storefront bug.

**Question for you:** is the beacon `POST /api/analytics/traffic-event` blocked by uBlock Origin or Brave with their default lists? If it is, tell the backend before changing anything, because a new path needs a backend route. If it isn't blocked, no change is needed.

## 6. FYI: backend search fix, no storefront action

`b1934f3` (live): a multi-word printer search now matches a printer stored with different spacing. Before the fix, "Fuji Xerox Docuprint CM305 df" missed "Fuji Xerox DOCUPRINT CM 305DF" and showed two wrong parts. Now it matches the printer and lists its cartridges. If the storefront normalises queries before sending them, keep the spaces. The backend handles them.

## Not asked

- No price claims or "lowest price" copy (invariant 13).
- No speed work for this issue (see the table at the top).
- No change to the compatible colour-swatch tiles. We have no evidence they cost sales.
