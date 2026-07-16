# FE Response — Market-Aware Hybrid Pricing Engine (Jul 2026)

Response to `pricing-hybrid-engine-fe-handoff-jul2026.md` (BE `37a99f4`, migration 113). All three items shipped + tests + live verification (owner session against prod backend). Logged as ERR-087.

## Item 1 — tier reband (the hard breakage): FIXED, and future-proofed
The FE had hardcoded the tier bucket keys in four places (a second source of truth). We made the calculator **key-agnostic** — tier bounds are now parsed from the key string itself — so a *future* reband needs **zero FE changes**.

- `js/admin/utils/pricingCalculator.js`: `parseTierKey` / `tierMidpoint` / `sortTierKeys` / `lookupMultiplierByCost`; deleted the parallel `TIER_BOUNDS_*` tables; `DEFAULT_TIERS` refreshed to the live values (genuine 18 / compatible 14 / **ribbon 7**); `coarsePreset(source, keys)` generates over any key set; `validateTierMap(map, liveKeys)` validates against the live keys; `normalizeTierResponse(resp)` tolerates `{defaults,overrides,effective}` / bare `{genuine,compatible}` / flat array and fails loud otherwise.
- `js/admin/pages/cc2-pricing.js`: renders/validates/saves from the **live keys** the API returns; removed the `{...DEFAULT_TIERS, ...effective}` merge that was re-injecting removed keys (the actual cause of the `.unknown(false)` failures).

Two findings worth flagging back:
1. **`ribbon` (7 bands) wasn't in the handoff** but is in the live response and prices ribbon products. We carry it through read paths, but `/pricing/simulate` **rejects `source:'ribbon'`** (verified), so the interactive simulator stays genuine+compatible. If simulating ribbon should be possible, the simulate endpoint needs to accept it.
2. We recomputed the FE golden cost→retail pairs from the live default multipliers. The FE mirror models **cost-plus only** (the market cap is backend-only); `/pricing/simulate` remains the authority for a proposed change's impact.

## Item 2 — per-product margin offsets: controls removed
The click-to-edit "Margin %" cell (the only FE surface hitting `PUT /products/:id/margin-offset`, confirmed a 200-noop `{deprecated:true, applied:false}`) is now a **read-only** margin badge. Removed the editor, its API method, and dead CSS. (The bulk `PUT /pricing/product-offsets` had no FE surface.)

## Item 3 — `manual_retail_price`: surfaced as an owner-only override
Added an owner-only **"Override price (exact)"** input to the product edit drawer + Price Monitor copy now says match/undercut sets a fixed price override.

**One gap to close on your side:** the admin `GET /api/admin/products/:id` returns a curated field set that does **not** include `manual_retail_price` (the `PUT` accepts it fine). So the input is **write-only** — it can't pre-fill the current override, and to avoid silently wiping an override set via the Price Monitor on an unrelated edit, we only send the field on explicit intent (a value sets it; a "Clear override" checkbox nulls it). **Please add `manual_retail_price` to the admin product GET** and we'll make the input pre-fill + round-trip normally.

## Verification
Full FE suite **2363 pass / 0 fail**. Live (Playwright, owner @ localhost:3000 → prod backend): Pricing tab renders all 14/18 live bands; Preview → `Aggregate impact (625 SKUs)` + KPIs + sample rows; margin cell display-only; override input + clear present. Also fixed a pre-existing render-order bug that left the simulator's results skeleton stuck.
