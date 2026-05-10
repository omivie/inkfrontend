# Ink Finder Wiring Spec — May 2026

The "What printer do you have?" finder on the homepage and brand-pages should consume the grouped-series endpoint shipped in the May 2026 work, not the flat printer list. This doc is the canonical wiring contract for FEINK.

## Endpoint

```
GET /api/printers/by-brand/:brandSlug?grouped=true&exclude_non_ink=true
```

**Response shape:**

```json
{
  "ok": true,
  "data": {
    "brand": { "name": "Canon", "slug": "canon" },
    "total_models": 539,
    "series_groups": [
      {
        "id": "pixma-ts-series",
        "name": "PIXMA TS Series",
        "model_count": 21,
        "models": [
          { "slug": "canon-pixma-ts3160", "full_name": "Canon PIXMA TS3160" },
          ...
        ]
      },
      { "id": "pixma-pro-series", "name": "PIXMA Pro Series", "model_count": 8, "models": [...] },
      ...
    ]
  }
}
```

## UX recommendations

**Two-step cascade:**

1. **Series picker** — `series_groups[i].name` rendered as cards or a dropdown. Customer picks "PIXMA TS Series".
2. **Model picker** — within the picked series, render `models[]` as a select. Customer picks "Canon PIXMA TS3160".

After both selections, navigate to `/shop?brand=<brandSlug>&printer_slug=<modelSlug>` (the May 2026 canonical URL — see `url-consolidation-may2026.md`).

**Why this beats a flat dropdown:** Canon has 539 models. A flat select is unscannable. The series grouping cuts cognitive load to ≤20 series, and within each series the models are typically 5-30. Customers who don't know which series they have can use the brand-page's series-card grid as a visual lookup.

## Empty-state fallback

When `series_groups` is empty (rare brands like Dymo) or returns zero matches:

1. Fall back to the un-grouped `?grouped=false` shape.
2. Show a flat searchable dropdown of `models[]`.

## Storefront copy

- **Section heading:** "Find ink for your printer"
- **Step 1 prompt:** "Which series?"
- **Step 2 prompt:** "Which model?"
- **CTA after step 2:** "Show cartridges for `<full_name>`"

Avoid jargon like "MPN" or "OEM" in the finder UX — customers find their printer by what's on the front of the printer (the model number), not by spec sheet codes.

## Affordance

Make the active selection obvious:

- Selected series card: bold border + filled background.
- Selected model: bold weight in the dropdown, "✓" prefix.
- After both steps: a sticky "Show cartridges for X" CTA at the bottom of the viewport so customers don't have to scroll back.

## Acceptance

- Homepage `/` → finder shows series cards for the user's last-selected brand (or default Brother).
- `/brand/canon` brand-page → series cards visible directly under the brand hero.
- Selecting "PIXMA TS Series" → "Canon PIXMA TS3160" → click "Show cartridges" → `/shop?brand=canon&printer_slug=canon-pixma-ts3160` loads with the cartridge grid.

## Backend reference

- Endpoint handler: `src/routes/printers.js` (`/by-brand/:brandSlug`).
- Series grouping logic: `src/utils/printerSeries.js`.
- Persisted `printer_models.series` column: migration 059 (already applied).
