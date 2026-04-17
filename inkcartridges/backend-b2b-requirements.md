# B2B Backend Technical Requirements

This document specifies all backend changes needed to support the B2B "Business Partner" ecosystem. The frontend is complete and expects these exact endpoints, request/response shapes, and database structures.

---

## 1. Database Schema

### `business_applications` (modify existing table)

Add these columns to the existing table:

```sql
ALTER TABLE business_applications ADD COLUMN IF NOT EXISTS business_type TEXT;          -- 'sole_trader', 'partnership', 'llc', 'trust', 'government', 'nonprofit'
ALTER TABLE business_applications ADD COLUMN IF NOT EXISTS ap_email TEXT;               -- Accounts payable email
ALTER TABLE business_applications ADD COLUMN IF NOT EXISTS billing_address JSONB;       -- { address1, address2, city, region, postcode }
ALTER TABLE business_applications ADD COLUMN IF NOT EXISTS shipping_address JSONB;      -- { address1, address2, city, region, postcode }
ALTER TABLE business_applications ADD COLUMN IF NOT EXISTS apply_net30 BOOLEAN DEFAULT FALSE;
ALTER TABLE business_applications ADD COLUMN IF NOT EXISTS credit_reference_url TEXT;   -- URL to uploaded file in Supabase Storage
```

### `business_accounts` (new table)

Created when an application is approved. One row per approved business.

```sql
CREATE TABLE business_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES business_applications(id),
    company_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',                    -- 'active', 'suspended', 'closed'
    credit_limit NUMERIC(10,2) NOT NULL DEFAULT 0,           -- Max credit in NZD
    credit_used NUMERIC(10,2) NOT NULL DEFAULT 0,            -- Current outstanding balance
    pricing_tier TEXT NOT NULL DEFAULT 'bronze',              -- 'bronze', 'silver', 'gold'
    net30_approved BOOLEAN NOT NULL DEFAULT FALSE,
    ap_email TEXT,
    billing_address JSONB,
    shipping_address JSONB,
    approved_at TIMESTAMPTZ,
    approved_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id)
);
```

### `business_invoices` (new table)

Created when a Net 30 order is placed.

```sql
CREATE TABLE business_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number TEXT NOT NULL UNIQUE,                      -- e.g. 'INV-2026-0001'
    business_account_id UUID NOT NULL REFERENCES business_accounts(id),
    order_id UUID NOT NULL REFERENCES orders(id),
    order_number TEXT NOT NULL,
    company_name TEXT NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'unpaid',                    -- 'unpaid', 'paid', 'overdue', 'void'
    due_date DATE NOT NULL,                                   -- order_date + 30 days
    paid_at TIMESTAMPTZ,
    pdf_url TEXT,                                             -- URL to generated PDF in Supabase Storage
    po_number TEXT,                                           -- Customer's purchase order number
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Indexes

```sql
CREATE INDEX idx_business_accounts_user_id ON business_accounts(user_id);
CREATE INDEX idx_business_invoices_account_id ON business_invoices(business_account_id);
CREATE INDEX idx_business_invoices_status ON business_invoices(status);
CREATE INDEX idx_business_invoices_due_date ON business_invoices(due_date);
```

---

## 2. API Endpoints

### 2.1 Public Business Endpoints (authenticated users)

#### `POST /api/business/apply` (modify existing)

Enhanced payload with new fields:

```json
{
    "company_name": "Acme Ltd",
    "nzbn": "1234567890123",
    "contact_name": "John Doe",
    "contact_email": "john@acme.co.nz",
    "contact_phone": "021 123 4567",
    "industry": "office_supplies",
    "business_type": "llc",
    "ap_email": "accounts@acme.co.nz",
    "billing_address": {
        "address1": "123 Queen St",
        "address2": "Level 5",
        "city": "Auckland",
        "region": "auckland",
        "postcode": "1010"
    },
    "shipping_address": {
        "address1": "123 Queen St",
        "address2": "Level 5",
        "city": "Auckland",
        "region": "auckland",
        "postcode": "1010"
    },
    "apply_net30": true,
    "estimated_monthly_spend": "$1000-$2500",
    "credit_reference_url": "https://storage.supabase.co/..."
}
```

**Response:** `{ "ok": true, "data": { "id": "uuid", "status": "pending" } }`

#### `GET /api/business/status` (modify existing)

Enhanced response for approved accounts:

```json
{
    "ok": true,
    "data": {
        "status": "approved",
        "application": {
            "company_name": "Acme Ltd",
            "submitted_at": "2026-04-01T10:00:00Z"
        },
        "credit_limit": 5000,
        "credit_remaining": 3500,
        "pricing_tier": "silver",
        "net30_approved": true
    }
}
```

For pending/rejected users, return existing format with just `status` and `application`.

#### `POST /api/business/credit-reference` (new)

Accepts `multipart/form-data` with a `file` field. Validates file type (PDF, JPG, PNG) and size (max 5 MB). Stores in Supabase Storage bucket `business-documents`.

**Response:** `{ "ok": true, "data": { "url": "https://..." } }`

#### `GET /api/business/dashboard` (new)

Returns B2B account overview data.

**Response:**
```json
{
    "ok": true,
    "data": {
        "credit_limit": 5000,
        "credit_used": 1500,
        "credit_remaining": 3500,
        "amount_due": 1500,
        "pricing_tier": "silver",
        "net30_approved": true,
        "company_name": "Acme Ltd"
    }
}
```

#### `GET /api/business/invoices?status=unpaid|paid&page=1&limit=20` (new)

Returns paginated invoices for the authenticated user's business account.

**Response:**
```json
{
    "ok": true,
    "data": {
        "invoices": [
            {
                "id": "uuid",
                "invoice_number": "INV-2026-0001",
                "order_number": "ORD-12345",
                "amount": 450.00,
                "due_date": "2026-05-01",
                "status": "unpaid",
                "paid_at": null,
                "po_number": "PO-789"
            }
        ],
        "pagination": { "total": 5, "page": 1, "limit": 20 }
    }
}
```

#### `GET /api/business/reorder-items` (new)

Returns the top 5 most frequently purchased products by this business account.

**Response:**
```json
{
    "ok": true,
    "data": {
        "items": [
            {
                "id": "product-uuid",
                "product_id": "product-uuid",
                "sku": "HP-952XL-BK",
                "name": "HP 952XL Black Ink Cartridge",
                "price": 45.99,
                "image_url": "https://...",
                "thumbnail": "https://..."
            }
        ]
    }
}
```

### 2.2 Admin Business Endpoints

All require admin authentication (`requireAdmin` middleware).

#### `GET /api/admin/business/applications?status=pending|approved|declined&search=&page=1&limit=20`

**Response:**
```json
{
    "ok": true,
    "data": {
        "applications": [
            {
                "id": "uuid",
                "company_name": "Acme Ltd",
                "contact_name": "John Doe",
                "contact_email": "john@acme.co.nz",
                "contact_phone": "021 123 4567",
                "business_type": "llc",
                "industry": "office_supplies",
                "estimated_monthly_spend": "$1000-$2500",
                "apply_net30": true,
                "credit_reference_url": "https://...",
                "billing_address": { ... },
                "shipping_address": { ... },
                "ap_email": "accounts@acme.co.nz",
                "nzbn": "1234567890123",
                "status": "pending",
                "submitted_at": "2026-04-01T10:00:00Z",
                "credit_limit": 0,
                "pricing_tier": null
            }
        ],
        "pagination": { "total": 12, "page": 1, "limit": 20 }
    }
}
```

#### `GET /api/admin/business/applications/:id`

Returns full application detail (same shape as above, single object).

#### `POST /api/admin/business/applications/:id/approve`

**Request:**
```json
{
    "credit_limit": 5000,
    "pricing_tier": "silver"
}
```

**Backend actions:**
1. Update `business_applications.status` to `'approved'`
2. Create `business_accounts` row with credit_limit, pricing_tier, net30_approved (based on apply_net30)
3. Send "Welcome" email to applicant's contact_email
4. Return `{ "ok": true, "data": { "id": "account-uuid" } }`

#### `POST /api/admin/business/applications/:id/decline`

**Request:** `{ "reason": "Insufficient credit history" }`

**Backend actions:**
1. Update `business_applications.status` to `'declined'`
2. Optionally send notification email
3. Return `{ "ok": true }`

#### `PATCH /api/admin/business/accounts/:id`

**Request:** `{ "credit_limit": 10000, "pricing_tier": "gold" }`

Updates the business account settings.

#### `GET /api/admin/business/invoices?status=&company=&from=&to=&page=1&limit=20`

Returns all invoices across all business accounts (admin view).

#### `POST /api/admin/business/invoices/:id/generate-pdf`

Triggers PDF generation for an invoice. Stores the PDF in Supabase Storage and updates `business_invoices.pdf_url`.

**Response:** `{ "ok": true, "data": { "pdf_url": "https://..." } }`

#### `POST /api/admin/business/invoices/:id/send-email`

Sends the invoice PDF to the business account's `ap_email` (or `contact_email` as fallback).

**Response:** `{ "ok": true }`

---

## 3. Middleware

### `requireB2B` Middleware

Checks that the authenticated user has an active `business_accounts` record with `status = 'active'`. Returns 403 if not.

Used on: `/api/business/dashboard`, `/api/business/invoices`, `/api/business/reorder-items`

### Net 30 Order Validation

When `payment_method: 'net30'` is received in `POST /api/orders`:

1. Verify user has `business_accounts` record with `net30_approved = true`
2. Calculate `credit_remaining = credit_limit - credit_used`
3. Verify `order_total <= credit_remaining`
4. If insufficient credit, return 400: `{ "error": { "message": "Insufficient credit. Remaining: $X.XX" } }`
5. If valid:
   - Create order with `status: 'invoiced'`, `payment_method: 'net30'`, `payment_status: 'pending'`
   - Create `business_invoices` record with `due_date = NOW() + 30 days`
   - Update `business_accounts.credit_used += order_total`
   - Generate invoice number (sequential: `INV-YYYY-NNNN`)
   - Return standard order response with `order_number`

---

## 4. Invoice PDF Generation

Generate PDF invoices with:
- Company header (InkCartridges.co.nz logo, address, NZBN)
- Invoice number, date, due date
- Customer: company name, billing address, AP email
- PO number (if provided)
- Line items: product name, SKU, quantity, unit price, line total
- Subtotal, shipping, GST breakdown, total
- Payment terms: "Net 30 — Payment due within 30 days of invoice date"
- Bank details for payment

**Recommended library:** `pdfkit` or `@react-pdf/renderer` (server-side)
**Storage:** Supabase Storage bucket `invoices/`

---

## 5. Approval Workflow

When admin approves a business application:

1. Create `business_accounts` record
2. Update `business_applications.status = 'approved'`
3. Send welcome email to applicant:
   - Subject: "Your Business Account Has Been Approved"
   - Body: Company name, pricing tier, credit limit (if Net 30), next steps
4. If Net 30 was requested and approved, mention payment terms in email

---

## 6. Tiered Pricing

For v1, implement a **flat percentage discount** per tier:
- Bronze: 5% off all products
- Silver: 10% off all products
- Gold: 15% off all products

Apply the discount in the cart/order calculation when the user has an active business account. The discount should be visible on product pages when a B2B user is logged in.

**Implementation:** Add a `b2b_discount` field to the cart calculation logic. When fetching cart totals or creating orders, check if the user has a `business_accounts` record and apply the tier discount.

---

## 7. Scheduled Jobs

### Late Fee / Overdue Detection

Run daily (cron job or Supabase pg_cron):

```sql
-- Flag overdue invoices
UPDATE business_invoices
SET status = 'overdue', updated_at = NOW()
WHERE status = 'unpaid'
  AND due_date < CURRENT_DATE;
```

Optionally send overdue notification emails when invoices are flagged.

### Invoice Payment Processing

When a B2B customer pays an invoice (manual payment recorded by admin):
1. Update `business_invoices.status = 'paid'`, `paid_at = NOW()`
2. Update `business_accounts.credit_used -= invoice_amount`

---

## 8. Supabase Storage Buckets

Create these storage buckets:
- `business-documents` — for credit reference uploads (private, authenticated access)
- `invoices` — for generated invoice PDFs (private, authenticated access)

RLS policies:
- Users can upload to `business-documents` (their own files only)
- Users can read their own invoices from `invoices`
- Admins can read/write all files in both buckets

---

## 9. Email Templates

### Application Received
- **To:** Applicant
- **Subject:** "Business Account Application Received"
- **Body:** Confirmation that application is under review, 24-48 hour timeline

### Application Approved
- **To:** Applicant
- **Subject:** "Your Business Account Has Been Approved"
- **Body:** Welcome message, pricing tier, credit limit, link to business dashboard

### Application Declined
- **To:** Applicant
- **Subject:** "Business Account Application Update"
- **Body:** Polite decline with contact info for questions

### Invoice Created
- **To:** AP email (or contact email)
- **Subject:** "Invoice [INV-YYYY-NNNN] from InkCartridges.co.nz"
- **Body:** Invoice summary, PDF attachment, payment instructions

### Invoice Overdue
- **To:** AP email (or contact email)
- **Subject:** "Overdue Invoice [INV-YYYY-NNNN]"
- **Body:** Reminder with amount due and original due date


---

## Rate Limiting — Important

### `POST /api/business/apply`
The current rate limit is too aggressive and is blocking legitimate first-time submissions. The error "Too many requests. Please wait a moment." appeared on a user's **first-ever** submission attempt.

**Required change:** Rate limit this endpoint **per authenticated user** (not per IP), with a generous window:
- Max **5 attempts per user per 24 hours** (covers re-submits after fixing validation errors)
- Or: **3 attempts per user per hour**
- Do NOT use IP-based rate limiting for authenticated endpoints — shared IPs (offices, NAT) will cause false positives

### `POST /api/business/reapply`
Apply the same user-scoped rate limit as above.

### General recommendation
For all authenticated B2B endpoints (`/api/business/*`), use user-ID–scoped rate limits rather than IP-based limits.
