/**
 * Product-type vocabulary — the single source of truth for the admin's
 * "All Types" filter AND for the New/Edit product editor's Product Type menu.
 *
 * Two pages ship the FILTER dropdown (pages/products.js and pages/pending-changes.js)
 * and until Jul 2026 each hand-maintained its own copy of the <option> list.
 * They drifted: both offered `drum` and `paper`, which are /shop CATEGORY slugs,
 * not `product_type` values — the columns say `drum_unit` (182 products) and
 * `photo_paper` (74). Neither option had ever matched a single row. A filter
 * value that isn't a real product_type doesn't error, it just silently returns
 * nothing, so the bug was invisible. Hence one list, imported by both.
 *
 * Aug 2026 (ERR-162): the same thing had happened one level down. The EDITOR's
 * type menu was hand-written TWICE inside pages/products.js — once in the New
 * Product modal, once in the Edit modal — and generateSEO() carried a THIRD
 * private label map. When the backend added `maintenance_box` (migration 136,
 * 2026-08-13) all three missed it, so four live products could not have their
 * own type re-selected and their generated meta titles came out with no product
 * noun at all. PRODUCT_TYPE_OPTIONS below is now the one editor menu.
 *
 * A value in this module is one of exactly two things:
 *   - a real `product_type` column value  → applied as `.eq('product_type', v)`
 *   - a TYPE_FILTER_GROUPS key            → applied as `.in('product_type', […])`
 * Nothing else is allowed; tests/admin-ribbon-type-filter.test.js and
 * tests/product-type-vocabulary-aug2026.test.js enforce it, and
 * `npm run audit:types` reconciles this file against the live catalogue in both
 * directions — offered-but-empty AND live-but-unoffered.
 */

/** Every real `product_type`, with the label the admin shows for it. */
export const PRODUCT_TYPE_LABELS = {
  ink_cartridge: 'Ink Cartridges', ink_bottle: 'Ink Bottles', toner_cartridge: 'Toner Cartridges',
  drum_unit: 'Drum Units', waste_toner: 'Waste Toner', maintenance_box: 'Maintenance Boxes',
  belt_unit: 'Belt Units', fuser_kit: 'Fuser Kits', fax_film: 'Fax Film',
  fax_film_refill: 'Fax Film Refills', printer_ribbon: 'Printer Ribbons',
  typewriter_ribbon: 'Typewriter Ribbons', correction_tape: 'Correction Tape',
  label_tape: 'Label Tape', photo_paper: 'Photo Paper', printer: 'Printers',
};

/**
 * Types the backend enum no longer accepts, kept ONLY so an existing row can
 * still render a human label. Never offered in any menu.
 *
 * `maintenance_kit` was in every list above for over a year and matched ZERO
 * rows the whole time — the `drum`/`paper` failure again (ERR-163). The Aug 2026
 * backend enum drops it outright: "Maintenance Kit" / "Maint Kit" feed names now
 * classify as `fuser_kit`, and waste-ink collectors got their own
 * `maintenance_box`.
 *
 * Retiring is LOUD, not absent: a row that somehow still carries the value reads
 * "Maintenance Kit (retired)" in the admin rather than a raw enum string, and
 * buildSelect() keeps it selectable-as-legacy so saving that row cannot rewrite
 * its type. What it must never do is offer the value to someone creating a
 * product.
 */
export const RETIRED_PRODUCT_TYPES = {
  maintenance_kit: 'Maintenance Kit (retired)',
};

/**
 * The `product_type` enum the API accepts on create, update and the list
 * filter — in the backend's own order, with the SINGULAR customer-facing label
 * (PRODUCT_TYPE_LABELS above is plural, for table headings and counts).
 *
 * This is the New/Edit modal's Product Type menu and the source of the type
 * noun generateSEO() puts in meta titles. Source of truth for the values:
 * maintenance-box-product-type-aug2026.md, backend a8fff8f / migration 136.
 */
export const PRODUCT_TYPE_OPTIONS = [
  { value: 'ink_cartridge',     label: 'Ink Cartridge' },
  { value: 'ink_bottle',        label: 'Ink Bottle' },
  { value: 'toner_cartridge',   label: 'Toner Cartridge' },
  { value: 'drum_unit',         label: 'Drum Unit' },
  { value: 'waste_toner',       label: 'Waste Toner' },
  { value: 'maintenance_box',   label: 'Maintenance Box' },
  { value: 'belt_unit',         label: 'Belt Unit' },
  { value: 'fuser_kit',         label: 'Fuser Kit' },
  { value: 'fax_film',          label: 'Fax Film' },
  { value: 'fax_film_refill',   label: 'Fax Film Refill' },
  { value: 'printer_ribbon',    label: 'Printer Ribbon' },
  { value: 'typewriter_ribbon', label: 'Typewriter Ribbon' },
  { value: 'correction_tape',   label: 'Correction Tape' },
  { value: 'label_tape',        label: 'Label Tape' },
  { value: 'photo_paper',       label: 'Photo Paper' },
  { value: 'printer',           label: 'Printer' },
];

/** Every value the API accepts, in enum order. */
export const PRODUCT_TYPES = PRODUCT_TYPE_OPTIONS.map(o => o.value);

/** The singular customer-facing noun for a type — 'maintenance_box' → 'Maintenance Box'. */
export function productTypeNoun(type) {
  const hit = PRODUCT_TYPE_OPTIONS.find(o => o.value === type);
  return (hit && hit.label) || '';
}

/**
 * The admin-facing label for a stored `product_type`: canonical first, then the
 * retired vocabulary, then the raw value. Never blank for a non-empty type — an
 * unrecognised value shows itself rather than disappearing into an em dash.
 */
export function productTypeLabel(type) {
  if (!type) return '';
  return PRODUCT_TYPE_LABELS[type] || RETIRED_PRODUCT_TYPES[type] || type;
}

/**
 * The ribbon family: printer ribbons (82), typewriter ribbons (22) and
 * correction tape (6). Same membership as the /shop "ribbons" category and as
 * API._CATEGORY_PRODUCT_TYPES.ribbons — the three surfaces must agree.
 *
 * Also gates the product drawer's "Ribbon Brands" section: ribbon-family
 * products link to the ribbon_brands catalogue via product_ribbon_brands.
 */
export const RIBBON_PRODUCT_TYPES = ['printer_ribbon', 'typewriter_ribbon', 'correction_tape'];

/**
 * Filter values that stand for a GROUP of product_types rather than one.
 *
 * "All Ribbons" used to hang off the SOURCE dropdown as a fake source value
 * ("ribbon"), which conflated two axes — source is genuine/compatible/
 * remanufactured, ribbon-ness is a product_type. It lives here now. Keys must
 * never collide with a real product_type.
 */
export const TYPE_FILTER_GROUPS = { ribbons: RIBBON_PRODUCT_TYPES };

/** The product_type[] a filter value expands to, or null when it names a single type. */
export function typeFilterGroup(value) {
  return TYPE_FILTER_GROUPS[value] || null;
}

/** True if `type` (a product's own product_type) is matched by filter value `value`. */
export function matchesTypeFilter(value, type) {
  if (!value) return true;
  const group = typeFilterGroup(value);
  return group ? group.includes(type) : type === value;
}

/**
 * The "All Types" menu, in display order. Printers are excluded — they have
 * their own tab. The em-dashed entries sit under "All Ribbons" to read as its
 * members.
 */
export const TYPE_FILTER_OPTIONS = [
  { value: '', label: 'All Types' },
  { value: 'ink_cartridge', label: 'Ink Cartridge' },
  { value: 'ink_bottle', label: 'Ink Bottle' },
  { value: 'toner_cartridge', label: 'Toner' },
  { value: 'ribbons', label: 'All Ribbons' },
  { value: 'printer_ribbon', label: '— Printer Ribbon' },
  { value: 'typewriter_ribbon', label: '— Typewriter Ribbon' },
  { value: 'correction_tape', label: '— Correction Tape' },
  { value: 'drum_unit', label: 'Drum' },
  { value: 'belt_unit', label: 'Belt Unit' },
  { value: 'fuser_kit', label: 'Fuser Kit' },
  { value: 'waste_toner', label: 'Waste Toner' },
  { value: 'maintenance_box', label: 'Maintenance Box' },
  { value: 'fax_film', label: 'Fax Film' },
  { value: 'fax_film_refill', label: 'Fax Film Refill' },
  { value: 'label_tape', label: 'Label Tape' },
  { value: 'photo_paper', label: 'Paper' },
];

/**
 * <option> markup for a type <select>, marking `current` selected. Values and
 * labels are module literals, so there is nothing to escape.
 */
export function typeFilterOptions(current = '') {
  return TYPE_FILTER_OPTIONS
    .map(o => `<option value="${o.value}"${o.value === current ? ' selected' : ''}>${o.label}</option>`)
    .join('');
}

/**
 * <option> markup for the EDITOR's type <select> (New / Edit product), marking
 * `current` selected.
 *
 * Callers in pages/products.js pass PRODUCT_TYPE_OPTIONS to buildSelect()
 * instead, because buildSelect() adds the legacy-value preservation that stops a
 * save from silently rewriting an unrecognised type. This helper exists for
 * anything that needs the raw markup (and for the tests, which assert the menu
 * really contains what the vocabulary claims).
 */
export function productTypeOptions(current = '') {
  return PRODUCT_TYPE_OPTIONS
    .map(o => `<option value="${o.value}"${o.value === current ? ' selected' : ''}>${o.label}</option>`)
    .join('');
}
