# Paid-traffic conversion: storefront fixes (Oct 2026)

## Why

The owner asked for more of the customers who arrive from Google Ads to buy.

Paid sessions since 2026-09-07 (sessions carrying a `gclid`), by landing page:

| Landing page | Device | Sessions | One-page bounce | Reached cart |
|---|---|---|---|---|
| /ink-cartridges | desktop | 63 | 21% | 9.5% |
| /ink-cartridges | mobile | 26 | 42% | 15.4% |
| /shop?brand=…&code=… | desktop | 63 | 59% | 6.3% |
| /shop?brand=…&code=… | mobile | 49 | 59% | 10.2% |
| **product page (Shopping ads)** | **desktop** | **45** | **67%** | **0%** |
| product page (Shopping ads) | mobile | 58 | 88% | 5.2% |

Once a visitor reaches the cart, the rest of the funnel is healthy: about 72% of carts reach checkout and nearly all of those complete. The loss happens on the landing page.

## 1. P0: Add to Cart is hidden on the most common business laptop screen

Measured live on 2026-10-01 on `/products/compatible-drum-unit-for-brother-dr1070/CDR1070BK`.

| Viewport | Add to Cart | Covering it |
|---|---|---|
| 1440 × 900 | 689–737 px (visible) | none; consent banner starts at 839 |
| **1366 × 768** | **689–737 px** | **an empty fixed `div` at 643–707 and the consent banner at 707–768** |

1366 × 768 is the most common laptop resolution in offices. It is also desktop, where 72% of our orders and most business buyers are. On that screen a Shopping-ad visitor lands on a product page and cannot see the button without scrolling or dismissing the banner.

**Fix:**
- Remove, or make non-overlapping, the empty 64 px fixed element directly above the consent banner.
- Keep Add to Cart above the fold at 1366 × 768: place it above the quantity-break ladder, not below it.
- Make the consent banner a compact single-line bar, or a corner card, so it never overlaps the buy box.

**Acceptance:** at 1366 × 768 and 1280 × 720, with the consent banner open, `getBoundingClientRect()` of Add to Cart sits fully above the top edge of every fixed element.

## 2. See our reviews on Google

Already specified in `google-reviews-link-FE-handoff-sep2026.md`. Ads from competitors show seller ratings of 4.7 to 4.9. Our only route to stars is collecting reviews.

## 3. Microsoft Advertising tag (only if the owner opens a Microsoft Ads account)

Bing is 8% of NZ search and 13% of desktop search, and its clicks cost 30–50% less. If the owner imports the Google campaigns, the storefront needs:

- the Microsoft UET tag on every page;
- a purchase event on order confirmation carrying the order total, the equivalent of the Google Ads purchase tag.

The owner will supply the UET tag ID.

## Not asked

- No price claims or "lowest price" copy anywhere. This is invariant 13, and the account was suspended over it in May 2026.
- The `/shop` code pages bounce at 59%, but the cause measured so far is price comparison, not the page itself. A shopper searching a specific cartridge code compares prices before buying. Do not redesign that page on this evidence.
