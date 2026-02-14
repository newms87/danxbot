# Billing Domain

The Billing domain handles invoicing buyers, paying suppliers, and tracking financial transactions. It integrates with QuickBooks for accounting and Stripe for credit card payments.

## Model Hierarchy

```
Document (documents) — base class
  ├── InvoiceDocument — bill TO buyer (accounts receivable)
  └── BillDocument — bill FROM supplier (accounts payable)
        └── DocumentLineItem (document_line_item) — line items
              └── source: OrderLineItem or Ad (polymorphic)

Transaction (transactions) — payment records
CreditCard (credit_cards) — buyer payment cards
PaymentMethod (payment_method) — payment types
```

## InvoiceDocument

**Model:** `ssap/app/Models/Accounting/Document/InvoiceDocument.php`
**Table:** `documents` (type discriminator: `InvoiceDocument`)

An invoice sent to a buyer for ad services rendered.

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| ref | string | Reference (prefix `I-`) |
| doc_number | string | QB-compatible number (max 21 chars) |
| amount | decimal | Total invoice amount |
| paid_amount | decimal | Amount paid so far |
| status | enum | Invoice lifecycle status |
| payment_preference | enum | `Prepaid`, `Postpaid`, `Prepaid In Full` |
| transaction_date | datetime | Invoice creation date |
| start_date | datetime | Billing period start |
| end_date | datetime | Billing period end |
| due_date | datetime | Payment due date |
| accounting_provider | string | `quickbooks`, `stripe`, etc. |
| accounting_provider_id | string | External system ID |
| is_tracked_by_source | boolean | 0 = National, 1 = Ad Shop |
| notes | text | Internal notes |

### Status Lifecycle

| Status | Meaning |
|--------|---------|
| Draft | Not sent to buyer |
| Sent | Sent to buyer, awaiting payment |
| Paid | Fully paid |
| Partially Paid | Partial payment received |
| Failed Payment | Credit card charge failed |
| Charged | Payment made but not reconciled |
| Void | Cancelled invoice |

**Flow:** `Draft → Sent → Paid / Partially Paid / Failed Payment / Charged` (Void from any state)

**Status Groupings:**
- `ACTIVE_STATUSES` — Sent, Paid, Partially Paid, Failed Payment, Charged
- `UNPAID_STATUSES` — Sent, Partially Paid, Failed Payment, Charged
- `AWAITING_PAYMENT_STATUSES` — Draft, Charged, Failed Payment

### Computed Fields

- `remaining_amount` — amount - paid_amount
- `share_link` — Guest JWT link (30-day expiry) for buyer to view/pay

### Relationships

- `buyer()` — via DocumentOwner (polymorphic)
- `supplier()` — via DocumentOwner (polymorphic)
- `customer()` — via DocumentOwner (polymorphic)
- `campaigns()` — morphToMany Campaign
- `orders()` — morphToMany Order
- `documentLineItems()` — hasMany DocumentLineItem (top-level only)
- `creditCards()` — morphToMany CreditCard
- `transactions()` — via Transactable trait
- `user()` — belongsTo User (creator)
- `terms()` — belongsTo Terms (payment terms)

### Key Methods

- `validatePaymentAmount($amount)` — Validates payment won't exceed balance
- `hasCreditCardTransactions()` — Whether paid via credit card
- `getPrimaryCreditCard()` — Resolves best credit card for charging
- `isNational()` — Returns true if is_tracked_by_source == 0
- `settings()` — Invoice display settings (logo, contacts, addresses)

---

## BillDocument

**Model:** `ssap/app/Models/Accounting/Document/BillDocument.php`
**Table:** `documents` (type discriminator: `BillDocument`)

A bill payable to a supplier for ad inventory used.

### Key Columns

Same structure as InvoiceDocument. Reference prefix: `B-`.

### Status Lifecycle

| Status | Meaning |
|--------|---------|
| Creating | Being assembled |
| Pending | No or partial payments sent |
| Paid | Fully paid |
| Void | Cancelled |

### Relationships

- `supplier()` — via DocumentOwner
- `orders()` — morphToMany Order
- `supplierInvoice()` — morphToOne InvoiceDocument (related supplier invoice)
- `qbBill()` — morphOne ExternalResource (QuickBooks reference)

### Key Behavior

- `delete()` — Cascades to delete associated supplier invoice
- `syncToExternal()` — Syncs to QuickBooks via SyncBillToQuickbooksJob

---

## DocumentLineItem

**Model:** `ssap/app/Models/Accounting/Document/DocumentLineItem.php`
**Table:** `document_line_item`

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| document_id | UUID FK | Parent document |
| type | enum | `Sale`, `Discount`, `Fee` |
| sku | string | Product SKU |
| name | string | Line item name |
| description | text | Description |
| amount | decimal | Line item total |
| quantity | integer | Quantity |
| date | datetime | Line item date |
| sourceable_type | string | Polymorphic type (OrderLineItem, Ad) |
| sourceable_id | UUID | Polymorphic ID |
| parent_id | UUID FK | Parent line item (hierarchical) |

### Relationships

- `document()` — belongsTo Document
- `source()` — morphTo (OrderLineItem, Ad, etc.)
- `orderLineItem()` — belongsTo OrderLineItem
- `children()` — hasMany DocumentLineItem (parent_id)

### Key Methods

- `getAccountingProductName()` — Resolves QB product name from campaign type/category
- `syncOrderLineItem()` — Syncs invoicing status back to OrderLineItem
- `resolveExpenseAccount()` / `resolveIncomeAccount()` — QB account mapping

---

## Transaction

**Model:** `ssap/app/Models/Accounting/Transaction.php`
**Table:** `transactions`

Records all financial transactions (payments, credits, refunds).

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | PK | Primary key |
| type | enum | Transaction type |
| status | enum | Transaction status |
| provider | enum | `quickbooks`, `stripe`, or empty |
| reference_id | string | External provider ID |
| payment_method_id | FK | Payment method used |
| credit_card_id | FK | Credit card used |
| buyer_id | FK | Buyer |
| supplier_id | FK | Supplier |
| amount | decimal | Transaction amount |
| fee | decimal | Associated fee |
| date | datetime | Transaction date |
| refunded_at | datetime | Refund timestamp |

### Type Constants

| Type | Meaning |
|------|---------|
| Payment | Payment received from buyer |
| Bill Payment | Payment sent to supplier |
| Transfer | Internal transfer |
| Credit | Credit applied |
| Discount | Discount applied |
| Subscription | Subscription payment |
| Sale | Revenue transaction |

### Status Constants

`Pending`, `Complete`, `Failed`, `Void`, `Partial Refund`

### Relationships

- `paymentMethod()` — belongsTo PaymentMethod
- `creditCard()` — belongsTo CreditCard
- `buyer()` / `supplier()` — belongsTo
- `orderLineItems()` — belongsToMany (many-to-many)
- `invoice()` — via Transactable trait

### Scopes

- `payment()` — Filter TYPE_PAYMENT
- `credit()` — Filter TYPE_CREDIT
- `active()` — Exclude STATUS_VOID
- `onlyPaymentMethod($name)` — Filter by payment method
- `exceptPaymentMethod($name)` — Exclude payment method

---

## PaymentMethod

**Model:** `ssap/app/Models/Order/PaymentMethod.php`
**Table:** `payment_method`

### Types

| Name | Description |
|------|-------------|
| Invoice | Bill via invoice (default) |
| Credit Card | Charge credit card |
| Discount | Discount/credit |
| Check | Pay by check |

### Key Static Methods

- `getDefaultMethodId()` — Returns Invoice method ID
- `getCreditCardMethodId()` — Returns Credit Card method ID
- `cached()` — All payment methods (cached)

---

## CreditCard

**Model:** `ssap/app/Models/Accounting/CreditCard.php`
**Table:** `credit_cards`

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | PK | Primary key |
| buyer_id | FK | Buyer who owns the card |
| primary | boolean | Is primary card |
| nickname | string | Last 4 digits or label |
| first_name / last_name | string | Cardholder name |
| billing_address fields | string | Billing address |
| failed_at | datetime | Last failed charge time |

---

## Key Repositories

### InvoiceDocumentRepository

- `createInvoiceForAds($ads, $paymentPref, $transDate, $start, $end)` — Creates invoice from ads
- `createInvoiceForOrderLineItems($lineItems, ...)` — Creates invoice from line items
- `syncInvoiceToProvider($invoice)` — Push to QuickBooks/Stripe
- `getInvoicePdfContents($invoice)` — Generate PDF via headless Chrome
- `deleteInvoice($invoice)` — Soft delete with cascade

**Uses Mappers:**
- `LocalAdsToInvoiceMapper` — For ad shop invoices
- `NationalAdsToInvoiceMapper` — For national invoices
- `NationalBillToInvoiceMapper` — For supplier invoices from bills

### BillDocumentRepository

- `createBillForAds($ads, ...)` — Creates bill from ads
- `syncBillToProvider($bill)` — Push to QuickBooks
- `lockBillingOperation($supplier)` — 15-minute lock per supplier
- `isBillingOperationLocked($supplier)` — Check if locked

**Uses Mappers:**
- `NationalAdsToBillMapper` — Maps ads to bill line items

### AccountingRepository

- `getInvoicesWithPaymentsDue()` — Invoices with credit card payment due
- `chargeInvoice($invoice)` — Charges buyer via Stripe
- `exportByDocument($filter)` — Export accounting data

---

## Key Jobs

### Invoice Jobs

- `CreateInvoiceForAdsJob` — Creates invoices grouped by campaign
- `CreateSupplierInvoiceForLineItemsJob` — Creates supplier invoice from line items
- `CreateSupplierInvoiceForNationalBillJob` — Creates supplier invoice from bill
- `SetInvoiceStatusJob` — Updates invoice status
- `DeleteInvoiceJob` — Soft delete invoice

### Bill Jobs

- `CreateBillForAdsJob` — Creates bills grouped by supplier (with 15-min lock)
- `CreateLineItemsForBillJob` — Creates line items using NationalAdsToBillMapper
- `DeleteBillJob` — Soft delete bill

### Sync Jobs

- `SyncInvoiceToQuickbooksJob` — Push invoice to QB
- `SyncBillToQuickbooksJob` — Push bill to QB
- `SyncAdAccountingReportJob` — Sync ad accounting
- `SyncAdReportChargeBuyerPaySupplierJob` — Sync charges and payments

---

## Key Workflows

### Invoice Creation

1. Select ads or order line items + payment preference + date range
2. InvoiceDocumentRepository creates Document record
3. Mapper creates DocumentLineItems from source ads/OLIs
4. Document synced to QuickBooks via SyncInvoiceToQuickbooksJob
5. Transaction created when payment is received

### Bill Creation (Supplier Payment)

1. Ads grouped by supplier
2. BillDocumentRepository creates bill (with supplier lock check)
3. NationalAdsToBillMapper creates line items
4. Bill synced to QuickBooks
5. Supplier invoiced via CreateSupplierInvoiceForLineItemsJob

### Credit Card Payment

1. Invoice has unpaid balance and credit card on file
2. AccountingRepository::chargeInvoice() calls Stripe via PaymentProvider
3. Transaction created (Complete or Failed)
4. On failure: InvoiceCreditCardPaymentFailedEmail sent
5. Invoice status updated (Paid, Partially Paid, or Failed Payment)

### Document Deletion

1. Mark `delete_started_at`
2. Delete DocumentLineItems
3. If bill: cascade delete associated supplier invoice
4. Soft delete document

---

## Common Query Patterns

```sql
-- Unpaid invoices
SELECT d.* FROM documents d
WHERE d.type LIKE '%InvoiceDocument'
AND d.status IN ('Sent', 'Partially Paid', 'Failed Payment', 'Charged')
AND (d.amount - d.paid_amount) > 0
AND d.deleted_at IS NULL;

-- Invoices for a campaign
SELECT d.* FROM documents d
JOIN document_owner do ON d.id = do.document_id
WHERE do.owner_type LIKE '%Campaign' AND do.owner_id = ?;

-- Buyer's total outstanding
SELECT SUM(d.amount - d.paid_amount) as outstanding
FROM documents d
JOIN document_owner do ON d.id = do.document_id
WHERE do.owner_type LIKE '%Buyer' AND do.owner_id = ?
AND d.type LIKE '%InvoiceDocument'
AND d.status IN ('Sent', 'Partially Paid')
AND d.deleted_at IS NULL;

-- Recent transactions for a buyer
SELECT t.* FROM transactions t
WHERE t.buyer_id = ? AND t.status != 'Void'
ORDER BY t.date DESC LIMIT 20;

-- Line items on an invoice
SELECT dli.* FROM document_line_item dli
WHERE dli.document_id = ? AND dli.parent_id IS NULL
ORDER BY dli.date;
```

---

## Business Rules

1. **Doc number limit:** Max 21 characters (QuickBooks restriction)
2. **Payment validation:** Cannot pay more than remaining_amount
3. **Void protection:** Void invoices cannot be paid
4. **Supplier lock:** 15-minute billing operation lock per supplier prevents concurrent billing
5. **National vs Ad Shop:** Determined by `is_tracked_by_source` flag (0 = National)
6. **Cascade delete:** Bill deletion cascades to related supplier invoice
7. **Share link expiry:** Guest JWT links expire in 30 days
8. **QB sync versioning:** Uses updated_at timestamp as version for QuickBooks sync

---

## External Integrations

- **QuickBooks Online** — Invoices synced as QBO Invoices, bills as QBO Bills, buyers as Customers, suppliers as Vendors
- **Stripe** — Credit card charges for invoice payments
- **Headless Chrome** — PDF generation for invoice downloads
