# Pending Changes — inline old → new diff (frontend spec)

**Version:** 1.0 · **Date:** 2026-05-05 · **Backend route file:** `src/routes/adminReview.js` · **Service:** `src/services/pendingReviewService.js` · **Migration:** none required

The admin Pending Changes list (`/admin#pending-changes`) currently renders only the colored field-name pills (`cost_price`, `retail_price`, `name`, …). This change adds the actual `old → new` value next to each pill so the reviewer can verify a price move at a glance, without expanding the row.

This is a **render-only** change. Backend already ships the data: every list-response item includes `old_data` (jsonb, null on ADD) and `new_data` (jsonb). No API call shape changes; no extra fetches.

---

## 1. Data source

`GET /api/admin/pending-changes` already returns:

```ts
type PendingChange = {
  id: string;
  product_id: string;
  sku: string;
  source: 'genuine' | 'compatible';
  change_type: 'ADD' | 'UPDATE' | 'DEACTIVATE';
  status: 'pending' | 'approved' | 'rejected' | 'partial' | 'superseded';
  changed_fields: string[];
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown>;
  field_decisions?: Record<string, 'approved' | 'rejected'>;
};
```

**Guarantees** (pinned by `__tests__/adminReview-list-shape.test.js`):

- The list endpoint does `select('*')`, so every column is on every row.
- Every `field` in `changed_fields` is present in `new_data`.
- For `change_type !== 'ADD'`, every `field` in `changed_fields` is present in `old_data`.
- For `change_type === 'ADD'`, `old_data === null`.

Reviewable fields (the keys you may encounter): `cost_price`, `retail_price`, `name`, `image_url`, `barcode`, `page_yield`, `weight_kg`, `color`, `product_type`, `pack_type`.

---

## 2. UX

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Compatible Ink Cartridge Replacement for Brother LC432XL …                 │
│  C-BRO-LC432XL-INK-KCMY                                                     │
│                                                                             │
│  [cost_price]  $4.20 → $4.55  ▲                                             │
│  [retail_price] $9.99 → $10.99 ▲                                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                                          [Approve] [Deny] >
```

- The existing pill stays. The diff renders directly to the right of each pill, on the same line for short values (prices, page_yield, weight_kg, barcode, color, product_type, pack_type) and below for long values (name, image_url).
- Multiple pills wrap onto multiple lines.
- Bulk-action UI (`Approve Selected` / `Reject Selected`) is unchanged.

---

## 3. Per-field formatting rules

| Field | Renderer | Example | Notes |
|---|---|---|---|
| `cost_price` | `formatNzd(old)` `→` `formatNzd(new)` + tint | `$4.20 → $4.55` | Tint NEW: green if dropped, red if rose, neutral otherwise. Show `▲` / `▼` icon. |
| `retail_price` | same as cost_price | `$9.99 → $10.99` | Tint applies. |
| `page_yield` | plain `old → new` + delta in parens | `850 → 1000 (+150)` | Plain text, no tint. |
| `weight_kg` | `oldKg → newKg` 2dp | `0.10 → 0.20` | Plain text. |
| `barcode` | `old → new` monospace | `9421… → 9421…` | Truncate middle to 12 chars + ellipsis on each side. |
| `color` | enum chip → enum chip | `Black → Cyan` | |
| `product_type` | enum chip → enum chip | `ink → toner` | |
| `pack_type` | enum chip → enum chip | `single → multipack` | |
| `name` | `<Diff>` collapsed: `OldName → NewName` truncated to 1 line, full text in tooltip / popover. | | Use `<DiffPopover>` (see below). |
| `image_url` | Two 32×32 thumbs side-by-side with `→` between. Click expands to full lightbox. | | If `old_data` is null, show only the new thumb with `(NEW)` tag. |

### ADD rows (`old_data === null`)

Render only the proposed value with a `(NEW)` tag:

```
[cost_price]  $4.55  (NEW)
[retail_price] $10.99 (NEW)
[name] Compatible Ink Cartridge Replacement for Epson NEW Black  (NEW)
```

### DEACTIVATE rows

`changed_fields` is typically `['is_active']` only. Render `is_active: true → false` plain text, no tint. (`is_active` is in `REVIEWABLE_FIELDS`.)

---

## 4. Reference TypeScript

```ts
// types/pending-changes.ts
export type ReviewableField =
  | 'cost_price' | 'retail_price' | 'name' | 'image_url' | 'barcode'
  | 'page_yield' | 'weight_kg' | 'color' | 'product_type' | 'pack_type'
  | 'is_active';

export interface FieldDiff<T = unknown> {
  field: ReviewableField | string;
  old: T | null;     // null for ADD rows or fields absent from old_data
  newValue: T;
  isAdd: boolean;
  delta?: number;    // populated for numeric fields
}

export function buildFieldDiffs(row: PendingChange): FieldDiff[] {
  const isAdd = row.change_type === 'ADD' || row.old_data === null;
  return row.changed_fields.map(field => {
    const oldVal = isAdd ? null : row.old_data?.[field] ?? null;
    const newVal = row.new_data[field];
    const delta = (typeof oldVal === 'number' && typeof newVal === 'number')
      ? Number((newVal - oldVal).toFixed(4))
      : undefined;
    return { field, old: oldVal, newValue: newVal, isAdd, delta };
  });
}
```

```tsx
// components/FieldDiffPill.tsx
const PRICE_FIELDS = new Set(['cost_price', 'retail_price']);
const NUMERIC_FIELDS = new Set(['page_yield', 'weight_kg']);
const ENUM_FIELDS = new Set(['color', 'product_type', 'pack_type']);

export function FieldDiffPill({ diff }: { diff: FieldDiff }) {
  if (diff.isAdd) {
    return <Pill field={diff.field} value={String(diff.newValue)} tag="NEW" />;
  }
  if (PRICE_FIELDS.has(diff.field)) {
    const tint = diff.delta! > 0 ? 'text-red-600' : diff.delta! < 0 ? 'text-emerald-600' : 'text-muted-foreground';
    return (
      <span className="inline-flex items-center gap-2">
        <Pill field={diff.field} />
        <span className="font-mono text-xs">
          {formatNzd(diff.old as number)} → <span className={tint}>{formatNzd(diff.newValue as number)}</span>
          {diff.delta! > 0 ? ' ▲' : diff.delta! < 0 ? ' ▼' : ''}
        </span>
      </span>
    );
  }
  if (NUMERIC_FIELDS.has(diff.field)) {
    return (
      <span className="inline-flex items-center gap-2">
        <Pill field={diff.field} />
        <span className="font-mono text-xs text-muted-foreground">
          {String(diff.old)} → {String(diff.newValue)}
          {diff.delta !== undefined && ` (${diff.delta > 0 ? '+' : ''}${diff.delta})`}
        </span>
      </span>
    );
  }
  if (ENUM_FIELDS.has(diff.field)) {
    return (
      <span className="inline-flex items-center gap-2">
        <Pill field={diff.field} />
        <EnumChip>{String(diff.old)}</EnumChip> → <EnumChip>{String(diff.newValue)}</EnumChip>
      </span>
    );
  }
  if (diff.field === 'image_url') {
    return <ImageDiffThumbs oldUrl={diff.old as string} newUrl={diff.newValue as string} />;
  }
  // name + barcode + fallthrough
  return <DiffPopover field={diff.field} oldValue={String(diff.old)} newValue={String(diff.newValue)} />;
}
```

`formatNzd(n)` → `$${n.toFixed(2)}` (no thousands separator needed; cartridges rarely exceed $999).

---

## 5. Acceptance

A row whose `changed_fields = ['cost_price', 'retail_price']`, `old_data = { cost_price: 4.20, retail_price: 9.99 }`, and `new_data = { cost_price: 4.55, retail_price: 10.99 }` MUST render:

```
[cost_price]   $4.20 → $4.55  ▲
[retail_price] $9.99 → $10.99 ▲
```

with both NEW values tinted red, both arrows showing increase, and zero additional API calls vs. the current page. Approve / Deny / bulk actions behave identically.

---

## 6. What does NOT change

- Backend API: `GET /api/admin/pending-changes` response is byte-identical (the fields were always returned).
- Bulk approval scripts in `scripts/`: out of scope.
- The Pending Changes summary endpoint and filter chips: unchanged.
- The detail / per-row review modal: out of scope (it already shows the diff). This spec only adds the inline preview on the list view.
