# Admin Color dropdown — May 2026

## What changed

The admin product drawer's **Color** field is now a canonical-list dropdown
(`<select>`), not a free-text input. It is bound to a single source of
truth — `ProductColors.OPTIONS` in `inkcartridges/js/utils.js` — which is
ordered to mirror `ProductSort.COLOR_ORDER` (K → C → M → Y → CMY → KCMY →
specialty).

## Why

Free-text invited data drift. Before the change, editors typed `black`,
`Black`, `BLACK`, `Blk`, …; the storefront's tier sort
(`ProductSort.colorTier`, `utils.js`) only recognises the PascalCase
canonical forms (`Black`, `Cyan`, `CMY`, `KCMY`, …). One typo and the row
fell into `TIER_UNKNOWN` and landed at the end of the K→C→M→Y→CMY→KCMY
grid — a silent failure mode that only surfaced in production after
catalog re-sort.

A snapshot of 1,200 live products (May 2026) showed exactly these stored
values, in PascalCase: `Black, CMY, Magenta, White, Cyan, Yellow, KCMY,
Photo, Black/Red, Value Pack, Clear` (plus null/empty). The dropdown
mirrors these and adds the long tail from `ProductColors.map` (Photo
Black, Matte Black, Light Cyan/Magenta, Red/Blue/Green, Gray, etc.) so
admins can pick any specialty colour without typing.

## Where

- **Source of truth** — `inkcartridges/js/utils.js`
  `ProductColors.OPTIONS` (array of `{value, label}`).
- **Helper** — `inkcartridges/js/admin/pages/products.js`
  `buildColorSelect(id, selected)` (sits next to `buildSelect`).
- **Call sites** — same file, the create modal (~line 681) and the edit
  drawer (~line 936). Both bind through `buildColorSelect('edit-color', …)`
  inside a `formGroup('Color', …)`.
- **Save payload** — unchanged. Both save handlers still read
  `val('edit-color')` into `data.color` and `PUT
  /api/admin/products/:id` (or `POST /api/admin/products`) over the
  existing contract.

## Behaviours guarded

1. The select carries `data-color-select="canonical"` — a stable handle
   for tests and devtools.
2. Empty / new product: leading `<option value="">Select color…</option>`
   is preselected.
3. Editing a known canonical value (e.g. `Black`): the matching option is
   the only one preselected; the placeholder loses its `selected`
   attribute.
4. Editing a legacy / unknown value (e.g. `CustomTeal` from a pre-rule
   import): the canonical list is rendered intact, plus the unknown
   value is appended **pre-selected** as `<option value="CustomTeal"
   selected>CustomTeal (legacy)</option>` so the editor never silently
   drops it on save.
5. Order: K (`Black, Photo Black, Matte Black`) → C → M → Y → CMY → KCMY
   → specialty (Red/Blue/Green/grays/White/Clear/Black/Red/Value
   Pack/Multipack). Mirrors `ProductSort.COLOR_ORDER`.

## Tests

`tests/admin-color-dropdown.test.js` — 7 tests, all green.

- `ProductColors.OPTIONS` exists, ≥20 entries, all `{value,label}`.
- All production-observed values present.
- K → C → M → Y → CMY → KCMY ordering.
- Both call sites bind to `buildColorSelect`, and no `<input
  id="edit-color">` remains.
- `buildColorSelect` runtime: blank state, canonical match, legacy
  preservation.
- Save handlers still read `val('edit-color')`.
- `buildColorSelect` co-located with `buildSelect`.

Run: `node --test tests/admin-color-dropdown.test.js`

## How to extend

Adding a new canonical color is a one-line change in
`inkcartridges/js/utils.js` — append to `ProductColors.OPTIONS`. The
admin dropdown picks it up automatically. Then add the same value to
`ProductSort.COLOR_ORDER` (and to the tier-resolution branches in
`colorTier`) so the storefront grid sorts it correctly. Update the
production-snapshot list in `tests/admin-color-dropdown.test.js` if the
new value is one the backend now stores.
