# Campaigns Domain

The Campaigns domain is the core business object in Flytedesk. A Campaign groups Orders (per supplier), which contain OrderLineItems (billing units) and Ads (individual placements).

## Model Hierarchy

```
Campaign (campaigns)
  └── Order (order) — one per supplier
        ├── OrderLineItem (order_line_item) — billing/revenue unit
        │     └── Ad (ads) — individual ad placement
        └── OrderProduct (order_product) — product configuration
  └── AdGroup (ad_groups) — SSP grouping for digital ads
        └── Ad (ads) — digital ad placements
```

## Campaign

**Model:** `ssap/app/Models/Campaign/Campaign.php`
**Table:** `campaigns`

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| ref | string | Reference code (prefix `C-`) |
| buyer_id | UUID FK | Buyer who owns the campaign |
| name | string | Campaign name |
| type | enum | `National` or `Local` |
| category | enum | `Brand`, `HWA`, `Elections` |
| status | enum | Computed lifecycle status |
| start_date | datetime | Earliest ad start date |
| end_date | datetime | Latest ad end date |
| fulfillment_pod_id | UUID FK | Assigned fulfillment rep (User) |
| buyer_primary_contact_id | UUID FK | Primary contact |
| buyer_billing_contact_id | UUID FK | Billing contact |
| summary | json | Computed analytics (ad counts, revenue) |
| task_counts | json | Pending task counts by type |
| is_ssp | boolean | Whether campaign uses SSP |

### Status Lifecycle

| Status | Meaning |
|--------|---------|
| Pending Approval | Has unapproved orders |
| Active | Has active or future ads running |
| Complete | All ads past end date, none canceled |
| Canceled | All ads canceled |

Status is auto-computed by `computeStatus()` on save based on order approval status and ad lifecycle.

### Relationships

- `buyer` — belongsTo Buyer
- `orders` — hasMany Order
- `ads` — hasMany Ad (through orders)
- `adGroups` — hasMany AdGroup
- `suppliers` — belongsToMany Supplier (through orders)
- `primaryContact` / `billingContact` — belongsTo Contact
- `fulfillmentPod` — belongsTo User
- `invoices` — morphToMany InvoiceDocument

### Key Methods

- `computeStatus()` — Auto-computes status from order/ad state
- `activeOrders()` — Orders in running statuses
- `unapprovedOrders()` — Orders pending approval
- `activeAds()` — Non-canceled ads
- `activeOrFutureAds()` — Ads still running or with future start dates
- `invoicedAds()` — Ads appearing on at least one invoice
- `isComplete()` — No more active or future ads
- `delete()` — Cascade deletes all orders

### Scopes

- `national()` — Filter for type = National

### Analytics (summary JSON)

- `ad_count` — Total active ads
- `ad_running_count` — Currently running ads
- `ad_completed_count` — Past-date ads
- `revenue_proposal` — Sum of buyer_price on line items
- `charge_buyer` — Sum of buyer charges
- `pay_supplier` — Sum of supplier payments
- `net_revenue` — charge_buyer - pay_supplier

---

## Order

**Model:** `ssap/app/Models/Order/Order.php`
**Table:** `order`

One Order per Campaign-Supplier pair. Represents the relationship between a buyer's campaign and a specific supplier.

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| ref | string | Reference code (prefix `O-`) |
| campaign_id | UUID FK | Parent campaign |
| buyer_id | UUID FK | Buyer |
| supplier_id | UUID FK | Supplier |
| status | enum | Computed from approval + ads |
| approval_status | enum | Approval workflow state |
| billing_preference | enum | `Prepaid` or `Postpaid` |
| total | decimal | Order total |
| ads_count | integer | Count of ads |

### Status Constants

| Status | Meaning |
|--------|---------|
| Pending | Awaiting approval |
| Approved | Approved and active |
| Changes Requested | Supplier requested changes |
| Rejected | Supplier rejected |
| Complete | All ads past run date |
| Canceled | All line items canceled |

### Approval Status

`Pending`, `Approved`, `Changes Requested`, `Rejected`

### Relationships

- `campaign` — belongsTo Campaign
- `buyer` — belongsTo Buyer
- `supplier` — belongsTo Supplier
- `lineItems` — hasMany OrderLineItem
- `ads` — hasMany Ad
- `products` — hasMany OrderProduct
- `invoices` — morphToMany InvoiceDocument
- `bills` — morphToMany BillDocument
- `transactions` — belongsToMany Transaction

### Scopes

- `active()` — Active statuses only
- `national()` — National campaign orders
- `local()` — Local campaign orders
- `filterDateRange($dates)` — Filter by date range

---

## OrderLineItem

**Model:** `ssap/app/Models/Order/OrderLineItem.php`
**Table:** `order_line_item`

The billing/revenue unit. Each line item tracks buyer price, supplier price, commission, and invoicing status.

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| order_id | UUID FK | Parent order |
| type | enum | `ad`, `discount`, `fee` |
| status | enum | Invoice status |
| booking_type | enum | `Default`, `Guaranteed AV`, `Exclude` |
| buyer_price | decimal | Price charged to buyer |
| supplier_price | decimal | Price paid to supplier |
| commission | decimal | Commission percentage |
| is_billable | boolean | Whether billable |
| invoiced_amount | decimal | Amount already invoiced |
| invoiced_count | integer | Number of invoices |
| billed_amount | decimal | Amount billed to supplier |

### Status Constants

| Status | Meaning |
|--------|---------|
| Uninvoiced | Not yet on any invoice |
| Invoice Scheduled | Scheduled for invoicing |
| Partially Invoiced | Some amount invoiced |
| Invoiced | Fully invoiced |
| Canceled | Canceled |

### Computed Revenue Fields

- `charge_buyer` — Billable amount to buyer (considers booking_type, status)
- `pay_supplier` — Amount to pay supplier (considers commission)
- `net_revenue` — charge_buyer - pay_supplier
- `margin` — (charge_buyer - net_revenue) / charge_buyer
- `uninvoiced_amount` — charge_buyer - invoiced_amount
- `unbilled_amount` — billed_amount - pay_supplier

### Booking Types

- `Default` — Normal billing
- `Guaranteed AV` — Guaranteed availability (special pricing)
- `Exclude` — Excluded from billing/revenue calculations

---

## Ad

**Model:** `ssap/app/Models/Campaign/Ad.php`
**Table:** `ads`

Individual ad placement. Each ad tracks creative status, run dates, and verification.

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| ref | string | Reference code (prefix `A-`) |
| campaign_id | UUID FK | Campaign |
| order_id | UUID FK | Order |
| order_line_item_id | UUID FK | Billing line item |
| status | enum | Lifecycle status |
| approval_status | enum | Creative approval |
| ssp_status | enum | SSP delivery status |
| start_date | datetime | Run start |
| end_date | datetime | Run end |
| impressions | bigint | Target impressions |
| creative_id | UUID FK | Assigned creative |

### Status Lifecycle

**Pre-Run:**
- `Creative Pending` — Awaiting creative upload
- `Pending Creative Approval` — Creative submitted for approval
- `Ready` — All approvals complete

**Post-Run:**
- `Unverified` — Verification not submitted
- `Verification Rejected` — Verification rejected
- `Pending Verification Approval` — Verification submitted
- `Verified` — Fully verified

**Terminal:** `Canceled`

### SSP Status

`Pending`, `Ready`, `Started`, `Completed`, `Delinquent`, `Canceled`

### Relationships

- `campaign` — belongsTo Campaign
- `order` — belongsTo Order
- `orderLineItem` — belongsTo OrderLineItem
- `buyer` — belongsTo Buyer
- `supplier` — belongsTo Supplier
- `creative` — belongsTo Creative
- `adGroup` — belongsTo AdGroup
- `verification` — hasOne AdVerification
- `report` — hasOne AdReport

### Key Scopes

- `national()` / `local()` — Campaign type filter
- `readyToBill()` / `partiallyBilled()` / `fullyBilled()` — Billing status
- `readyToInvoice()` / `invoiced()` / `partiallyInvoiced()` — Invoice status
- `missingCreative()` — Ads needing creative
- `missingVerification()` — Ads needing verification

---

## AdGroup

**Model:** `ssap/app/Models/Campaign/AdGroup.php`
**Table:** `ad_groups`

Groups digital ads for SSP delivery. Controls pricing and delivery goals.

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| campaign_id | UUID FK | Campaign |
| name | string | Group name |
| status | enum | `Active`, `Complete`, `Pending`, `Disabled` |
| goal_type | enum | `Impressions` or `Percentage` |
| goal_value | decimal | Target value |
| charge_type | enum | `CPM` or `Flat Rate` |
| charge_rate | decimal | Buyer charge rate |
| payout_type | enum | `CPM` or `Flat Rate` |
| payout_rate | decimal | Supplier payout rate |
| priority | enum | `Platform API Lottery` or `Sponsorship` |

---

## Key Services

### CampaignRepository (`ssap/app/Repositories/CampaignRepository.php`)

- `refreshAnalytics($campaign)` — Recalculates ad counts, revenue, dates
- `cancel($campaign)` — Cancels all future-dated ads
- `resumeCanceled($campaign)` — Resumes canceled upcoming ads
- `changeBuyer($campaign, $buyer)` — Changes buyer (validates no invoices exist)
- `addAdsFromOrder($campaign, $order)` — Creates ads from order line items

### OrderRepository (`ssap/app/Repositories/OrderRepository.php`)

- Revenue field tracking via virtual fields
- Integration with AdAccountingRepository and InvoiceDocumentRepository

---

## Controllers

### AdminCampaignsTrackerController

- `list(PagerRequest)` — Paginated campaigns with filter/sort (50 per page)
- `summary(PagerRequest)` — Summary totals
- `filterFieldOptions(PagerRequest)` — Dropdown options for filters
- `applyAction(Campaign, PagerRequest)` — Actions: update, cancel, resume, delete

### SupplierOrdersController

- `list(PagerRequest)` — Paginated supplier orders
- `details(Order)` — Full order details with relationships
- `applyAction(Order, PagerRequest)` — Order actions
- `batchAction(PagerRequest)` — Batch operations

---

## Common Query Patterns

```sql
-- Active campaigns with revenue
SELECT c.id, c.name, c.status, c.summary->>'$.charge_buyer' as revenue
FROM campaigns c WHERE c.status = 'Active' AND c.deleted_at IS NULL;

-- Orders for a campaign
SELECT o.* FROM `order` o WHERE o.campaign_id = ? AND o.deleted_at IS NULL;

-- Uninvoiced line items
SELECT oli.* FROM order_line_item oli
WHERE oli.status = 'Uninvoiced' AND oli.deleted_at IS NULL;

-- Ads running now
SELECT a.* FROM ads a
WHERE a.status != 'Canceled' AND a.start_date <= NOW() AND a.end_date >= NOW()
AND a.deleted_at IS NULL;

-- Campaign revenue breakdown
SELECT oli.buyer_price, oli.supplier_price, oli.commission
FROM order_line_item oli
JOIN `order` o ON oli.order_id = o.id
WHERE o.campaign_id = ? AND oli.status != 'Canceled';
```

---

## External Integrations

- **Kevel** — Digital ad server sync for SSP campaigns/ad groups
- **Airtable** — Ad matrix sync (national ads only)
- **QuickBooks** — Invoice/bill document sync
- **Pusher** — Real-time updates via AdminCampaignUpdatedEvent
