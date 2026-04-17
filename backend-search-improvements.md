# Backend Search Improvements — InkCartridges.co.nz

**Prepared for:** Backend Developer  
**Date:** 2026-04-17  
**Backend:** https://ink-backend-zaeq.onrender.com  
**Priority:** High — both issues cause visible search failures in production

---

## Overview

There are two backend search improvements needed. The frontend has already implemented workarounds for both, but the backend fixes will make search more robust, faster (fewer round-trips), and correct for edge cases the frontend can't catch.

---

## Issue 1: `/api/search/suggest` — Return `matched_printer` for Misspelled Printer Model Queries

### What's happening now

When a user types a slightly misspelled printer model name (e.g. `"hp officehjet pro 9720"` instead of `"hp officejet pro 9720"`), the suggest endpoint returns `did_you_mean` but **no `matched_printer`**:

```
GET /api/search/suggest?q=hp+officehjet+pro+9720&limit=1

Response:
{
  "ok": true,
  "data": {
    "suggestions": [],
    "did_you_mean": "HP OFFICEJET PRO 9720"
  }
}
```

But for the correctly spelled query, it **does** return `matched_printer`:

```
GET /api/search/suggest?q=hp+officejet+pro+9720&limit=1

Response:
{
  "ok": true,
  "data": {
    "suggestions": [...],
    "matched_printer": {
      "name": "HP OFFICEJET PRO 9720",
      "slug": "hp-officejet-pro-9720"
    }
  }
}
```

### What the frontend needs

When `matched_printer` is absent but `did_you_mean` is present, the frontend currently has to make a **second API call** using the corrected spelling to get the printer slug. This adds latency and is a fragile workaround.

### What the backend should do

When `did_you_mean` is computed for a query, **also run the printer model lookup on the corrected query** and include `matched_printer` in the same response if found.

**Pseudocode:**
```
function handleSuggest(rawQuery):
    correctedQuery = spellCorrect(rawQuery)          // already done — produces did_you_mean
    suggestions = findProductSuggestions(correctedQuery)
    printer = findMatchedPrinter(correctedQuery)     // run this on corrected query too

    return {
        suggestions: suggestions,
        did_you_mean: correctedQuery != rawQuery ? correctedQuery : null,
        matched_printer: printer ?? null
    }
```

### Expected response after fix

```
GET /api/search/suggest?q=hp+officehjet+pro+9720&limit=1

Response:
{
  "ok": true,
  "data": {
    "suggestions": [...HP 937 products...],
    "did_you_mean": "HP OFFICEJET PRO 9720",
    "matched_printer": {
      "name": "HP OFFICEJET PRO 9720",
      "slug": "hp-officejet-pro-9720"
    }
  }
}
```

### Why it matters

The frontend's primary search flow (shop page `?search=` route) calls `/api/search/suggest` first to detect printer model intent and redirect to the correct page. If `matched_printer` is missing, it falls through to a free-text search that returns 0 results — showing the user an empty page instead of their printer's compatible cartridges.

### Test cases

| Query | Expected `matched_printer` |
|---|---|
| `hp officejet pro 9720` | `{ name: "HP OFFICEJET PRO 9720", slug: "hp-officejet-pro-9720" }` |
| `hp officehjet pro 9720` | Same (typo: "officehjet") |
| `hp officejet pro9720` | Same (typo: missing space) |
| `hp oficejet pro 9720` | Same (typo: one "f") |
| `canon pixma mg3650` | `{ name: "Canon PIXMA MG3650", slug: "canon-pixma-mg3650" }` (if exists) |
| `hp 937` | `null` (this is a cartridge code, not a printer model) |

---

## Issue 2: `/api/search/smart` — Fix Relevance Scoring for Numeric Cartridge Codes

### What's happening now

Searching for `"hp 937"` returns **58 products**. The first 6 are correct (HP Genuine 937 cartridges), but the remaining 52 are irrelevant — they matched because "937" appears as a substring inside longer part numbers or descriptions.

```
GET /api/search/smart?q=hp+937&limit=10

Current response (names + relevance scores):
HP Genuine 937 Ink Cartridge Black (1,250 Pages)     | score: 490  ✅ correct
HP Genuine 937 Ink Cartridge Cyan (800 Pages)         | score: 490  ✅ correct
HP Genuine 937 Ink Cartridge Magenta (800 Pages)      | score: 490  ✅ correct
HP Genuine 937 Ink Cartridge Value Pack CMY 3-Pack    | score: 490  ✅ correct
HP Genuine 937 Ink Cartridge Value Pack KCMY 4-Pack   | score: 490  ✅ correct
HP Genuine 937 Ink Cartridge Yellow (800 Pages)       | score: 490  ✅ correct
HP Genuine 72 130ml Ink Cartridge Cyan (C9371A)       | score: 400  ❌ wrong — "937" is inside "9371A"
HP Genuine 72 130ml Ink Cartridge Magenta (C9372A)    | score: 395  ❌ wrong — "937" is inside "9372A"
HP Genuine 72 130ml Ink Cartridge Yellow (C9373A)     | score: 395  ❌ wrong — "937" is inside "9373A"
HP Genuine 507A Toner Cartridge Value Pack KCMY 4-Pack| score: 245  ❌ wrong — "937" only in description
```

Further down (positions 20–58): HP Compatible 94, 920, 95, CF35, W231, 02 ink cartridges — these rank because they share the `hp` brand keyword, and their descriptions or part numbers contain scattered digit matches.

### Root cause

The numeric part of the query (`937`) is being matched as a substring rather than as a whole-number word boundary. `C9371A` contains the string `937`, so it scores almost as high as a product named "937".

### What the backend should do

When a query contains a numeric token (e.g. `937`, `046`, `564`), apply **whole-number boundary matching** for that token. A number should only match if it is **not immediately adjacent to another digit** in the field being searched.

**Rule:** For numeric token `N`, it matches field value `V` only if the regex `(?:^|[^\d])N(?:[^\d]|$)` matches `V`.

**Examples:**
- `"HP Genuine 937 Ink Cartridge"` → "937" is surrounded by spaces → **match** ✅
- `"C9371A"` → "937" is followed by "1" (a digit) → **no match** ✅
- `"C9372A"` → "937" is followed by "2" → **no match** ✅
- `"HP Compatible 94 (C8765WA)"` → "937" doesn't appear → **no match** ✅

**Scoring suggestion:**

Rather than discarding non-boundary matches entirely (they might be legitimately relevant in some edge cases), you can heavily penalise them:

```
// Pseudocode for scoring numeric tokens
function scoreNumericToken(token, fieldValue):
    if wholeNumberMatch(token, fieldValue):
        return HIGH_SCORE        // e.g. existing weight × 1.0
    elif substringMatch(token, fieldValue):
        return LOW_SCORE         // e.g. existing weight × 0.05  — demote heavily
    else:
        return 0
```

Products that only match via substring should have a combined score low enough that they don't appear in the first page of results (top 20).

### Expected response after fix

```
GET /api/search/smart?q=hp+937&limit=20

After fix — only products where "937" is an isolated number:
HP Genuine 937 Ink Cartridge Black (1,250 Pages)      ✅
HP Genuine 937 Ink Cartridge Cyan (800 Pages)          ✅
HP Genuine 937 Ink Cartridge Magenta (800 Pages)       ✅
HP Genuine 937 Ink Cartridge Value Pack CMY 3-Pack     ✅
HP Genuine 937 Ink Cartridge Value Pack KCMY 4-Pack    ✅
HP Genuine 937 Ink Cartridge Yellow (800 Pages)        ✅
(no HP 72, no HP 94, no HP 920, no HP CF35, etc.)
```

### Additional test cases

| Query | Should return | Should NOT return |
|---|---|---|
| `hp 937` | HP 937 cartridges only | HP 72 (C9371A), HP 94, HP 920 |
| `canon 046` | Canon 046 toner cartridges | Products where "046" appears inside a longer code |
| `epson 564` | Epson 564 cartridges | Products where "564" is a substring of a longer part number |
| `hp 72` | HP 72 cartridges | HP 720, HP 72A (if "72" appears embedded in longer numbers elsewhere) |
| `069` | Products named "069" or with code "069" | "S41069", "CT351069" |

---

## Summary Table

| Endpoint | Issue | Fix Required |
|---|---|---|
| `GET /api/search/suggest` | Missing `matched_printer` when query is misspelled but `did_you_mean` is computed | Run printer lookup on the `did_you_mean` corrected query and include result in same response |
| `GET /api/search/smart` | Numeric tokens match as substrings inside longer part numbers, polluting results with irrelevant products | Apply whole-number boundary matching for numeric tokens; heavily penalise substring-only matches |

---

## Notes for Implementation

- The frontend has workarounds in place for both issues (an extra round-trip for Issue 1, a client-side regex filter for Issue 2), but these are band-aids. Backend fixes will make search correct for all surfaces (not just the shop search page).
- For Issue 2, the regex `(?:^|[^\d])NUMBER(?:[^\d]|$)` is the same filter already applied on the frontend — it's a reliable definition of "isolated number".
- For Issue 1, the `matched_printer` lookup is already implemented for non-typo queries, so this should be a small extension of the existing logic.
