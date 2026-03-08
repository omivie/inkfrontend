# Backend Task: Contact Email Management Endpoints

## Context
The frontend has a contact form at `/html/contact` that POSTs to `POST /api/contact`. Currently this endpoint exists but doesn't send actual emails. The frontend also has a new admin page (`#contact-emails`) for managing which email addresses receive contact form submissions. The admin page is built and deployed — it just needs these backend endpoints to function.

## Endpoints to Implement

### 1. `GET /api/admin/contact-emails`
- **Auth**: Requires admin token (owner-only)
- **Response**: `{ ok: true, data: [ { id, email, created_at } ] }`
- Returns all configured recipient emails

### 2. `POST /api/admin/contact-emails`
- **Auth**: Requires admin token (owner-only)
- **Body**: `{ email: "someone@example.com" }`
- **Validation**: Valid email format, no duplicates
- **Response**: `{ ok: true, data: { id, email, created_at } }`

### 3. `DELETE /api/admin/contact-emails/:id`
- **Auth**: Requires admin token (owner-only)
- **Response**: `{ ok: true, data: { message: "Removed" } }`

## Database

Create a `contact_emails` table:

```sql
CREATE TABLE contact_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed the initial recipient
INSERT INTO contact_emails (email) VALUES ('vielandvnnz@gmail.com');
```

## Update `POST /api/contact`

The existing contact form endpoint currently returns `{ ok: true }` but doesn't send emails. Update it to:

1. Query all rows from `contact_emails` table
2. Send an email to each recipient with the form data
3. The payload from the frontend is: `{ name, email, subject, message, phone?, order_number? }`
4. The email should include all submitted fields in a readable format
5. Use whatever email service is already configured (e.g. Resend, SendGrid, Nodemailer) — if none exists, Resend is recommended (free tier: 100 emails/day)

### Suggested email format
- **To**: All emails from `contact_emails` table
- **Reply-To**: The customer's email (from form `email` field)
- **Subject**: `[InkCartridges Contact] {subject label} from {name}`
- **Body**: Include name, email, phone (if provided), order number (if provided), subject, and message

## Frontend Reference
- Admin page: `inkcartridges/js/admin/pages/contact-emails.js`
- Admin API methods: `inkcartridges/js/admin/api.js` (search for `getContactEmails`, `addContactEmail`, `removeContactEmail`)
- Contact form JS: `inkcartridges/js/contact-page.js`
- Contact form API call: `API.submitContactForm(payload)` → `POST /api/contact`
