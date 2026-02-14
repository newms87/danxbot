# Buyers Domain

A Buyer is an advertiser account in Flytedesk. Buyers create campaigns, place orders with suppliers, and manage creative assets. Buyer accounts can be agencies (managing multiple campaigns) or direct advertisers.

## Model Hierarchy

```
Buyer (buyers)
  ├── Campaign (campaigns) — advertising campaigns
  ├── BuyerUser (buyer_user) — team members (pivot)
  ├── Contact (contact) — primary, billing, creative contacts
  ├── Address (address) — primary, billing addresses
  ├── CreditCard (credit_cards) — saved payment methods
  ├── Audience (audiences) — custom targeting segments
  ├── Invite (invites) — pending team invitations
  └── BuyerCreativeUpload (buyer_creative_uploads) — creative upload portals
        └── BuyerCreativeFolder (buyer_creative_folders) — folder hierarchy
              ├── File (files) — uploaded creative files
              └── BuyerCreativeComment (buyer_creative_comments)
```

---

## Buyer

**Model:** `ssap/app/Models/Buyer/Buyer.php`
**Table:** `buyers`

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | int | Primary key |
| buyer_company | string | Company/organization name |
| buyer_phone | string | Phone number |
| billing_email | string | Billing email address |
| billing_preference | enum | `Prepaid` or `Postpaid` |
| campaign_type_id | int FK | 1=National, 2=Local |
| primary_contact_id | int FK | Primary Contact |
| billing_contact_id | int FK | Billing Contact |
| rep_id | int FK | Assigned Flytedesk admin rep |
| buyer_approved | boolean | Invoice payment allowed |
| buyer_accept_terms | boolean | Terms acceptance |
| can_book_all_audiences | boolean | Audience booking permission |
| check_name | string | Check payment name |

### Relationships

- `users` / `teamMembers` — belongsToMany User (via `buyer_user` pivot)
- `primaryContact` — belongsTo Contact
- `billingContact` — belongsTo Contact
- `campaigns` — hasMany Campaign
- `orders` — hasMany Order
- `ads` — hasMany Ad
- `suppliers` — belongsToMany Supplier (via `customer` pivot)
- `audiences` — hasMany Audience
- `invites` — hasMany Invite
- `creditCards` — hasMany CreditCard
- `repUser` — belongsTo User (assigned Flytedesk rep)

### Contact Types

Buyers support three contact types:

| Type | Cardinality | Description |
|------|-------------|-------------|
| Primary | One | Main business contact |
| Billing | One | Invoice recipient (falls back to primary) |
| Creative | Many | Creative contacts |

### Key Methods

- `getBillingContact()` — Returns billing contact; falls back to primary if no billing email
- `setContacts()` — Auto-creates primary/billing contacts on buyer creation
- `isOwnedBySupplier()` — True if no admin-role users (supplier-created account)
- `getPrimaryCreditCard()` — Returns card marked as primary
- `removeAllData()` — Detaches all users and force-deletes buyer

### Model Hooks

- `creating` — Auto-creates primary/billing contacts
- `saved` — Syncs to GAM/Kevel digital vendor, QuickBooks accounting, Stripe payment provider

### Traits

| Trait | Purpose |
|-------|---------|
| Accountable | QuickBooks/Stripe account sync |
| Addressable | Primary and billing addresses |
| Contactable | Polymorphic contact management |
| Documentable | Document attachments |
| HasExternalResources | GAM/Kevel vendor sync |
| KeywordSearchable | Search by id, company name |
| Auditable | Change tracking |

---

## BuyerUser (Pivot)

**Model:** `ssap/app/Models/Buyer/BuyerUser.php`
**Table:** `buyer_user`

Join table for the buyer-user many-to-many relationship. Auditable.

---

## Customer (Buyer-Supplier Relationship)

**Model:** `ssap/app/Models/Account/Customer.php`
**Table:** `customer`

Represents the relationship between a Buyer and Supplier. One per campaign-supplier pair or ad shop relationship.

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | int | Primary key |
| buyer_id | int FK | Buyer |
| supplier_id | int FK | Supplier |
| is_active | boolean | Active flag |
| billing_preference | string | Prepaid/Postpaid |
| managed | boolean | 1=publisher-managed, 0=buyer-managed |
| can_access_ad_shop | boolean | Ad shop permission |
| rate_class | string | Pricing tier |
| type | string | Customer type |

### Customer Types

`Local`, `National`, `Non-Profit`, `On Campus`

### Approval Statuses

| Status | Value | Meaning |
|--------|-------|---------|
| Pending | 0 | Awaiting approval |
| Approved | 1 | Approved |
| Rejected | 2 | Rejected |

---

## Invite

**Model:** `ssap/app/Models/Account/Invite.php`
**Table:** `invites`

Pending team member invitations.

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| email | string | Invitee email |
| buyer_id | int FK | Buyer account |
| role | string | Role slug |
| status | string | Invitation status |
| contact_type | string | Comma-separated contact types |

### Statuses

`INVITE_SENT`, `REQUESTED`, `REJECTED`, `ACCEPTED`

---

## Creative Management

### BuyerCreativeFolder

**Model:** `ssap/app/Models/Buyer/BuyerCreativeFolder.php`
**Table:** `buyer_creative_folders`

Hierarchical folder structure for organizing creative assets. Supports Slack thread integration.

Key fields: `buyer_id`, `parent_id` (self-referential), `name`, `sort_order`, `file_count`, `slack_thread_ts`, `slack_channel_id`

Key methods: `isTopLevel()`, `getFullPath()`, `getAllDescendantIds()`, `getTreeFiles()`, `getTreeComments()`

### BuyerCreativeUpload

**Model:** `ssap/app/Models/Buyer/BuyerCreativeUpload.php`
**Table:** `buyer_creative_uploads`

Configuration for buyer creative upload portals. Generates JWT-authenticated shareable URLs.

### BuyerCreativeComment

**Model:** `ssap/app/Models/Buyer/BuyerCreativeComment.php`
**Table:** `buyer_creative_comments`

Comments on creative folders with optional Slack sync.

Key fields: `buyer_creative_folder_id`, `user_id`, `text`, `is_internal`, `author_name`, `slack_message_ts`

---

## CreditCard

**Model:** `ssap/app/Models/Accounting/CreditCard.php`
**Table:** `credit_cards`

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| buyer_id | int FK | Buyer |
| primary | boolean | Is primary card |
| is_viewable | boolean | Visible to buyer |
| nickname | string | Card label (often last 4 digits) |
| first_name / last_name | string | Cardholder name |
| billing_address | string | Billing address |
| failed_at | timestamp | Last failed charge |

---

## Buyer Onboarding

**Repository:** `ssap/app/Repositories/BuyerRepository.php`

### Signup Flow

1. `signup($input)` — Complete onboarding:
   - Creates Buyer with company info
   - Creates User (always assigned `buyer-admin` role)
   - Attaches User to Buyer
   - Grants supplier access if `supplier_id` provided
   - Triggers welcome email, auto-logs in

2. `create($input)` — Creates Buyer record:
   - Creates/finds Primary Contact from user info
   - Creates/finds Billing Contact from billing email (or reuses primary)
   - Sets primary and billing addresses

### Team Management

- `sendInviteToEmail()` — If user exists: add immediately. If new: create Invite with INVITE_SENT status
- `registerUserFromBuyerInvite()` — Register invited user, attach to buyer, set contact type
- `registerExistingUserToBuyer()` — Add existing user with role
- `removeUser()` — Delete BuyerUser and associated invite

### Roles

| Role | Access Level |
|------|-------------|
| buyer-admin | Full access |
| buyer-member | Limited access |
| buyer-editor | Can edit some resources |
| buyer-viewer | Read-only |

---

## External Integrations

### Digital Vendor (GAM/Kevel)

Syncs on buyer save when `buyer_company` or `primary_contact_id` changes. Maps buyer to AdvertiserApiModel.

### QuickBooks

Syncs on buyer save when `buyer_company`, `primary_contact_id`, or `billing_contact_id` changes. Creates/updates QBO Customer record.

### Stripe

Updates Stripe customer when contact info changes. Credit cards stored locally with Stripe references.

### Slack

Creative comments and files sync to Slack threads via background jobs:
- `SendBuyerCreativeCommentSlackJob`
- `SyncBuyerCreativeFilesSlackJob`
- `DeleteBuyerCreativeCommentSlackJob`

---

## Common Query Patterns

```sql
-- All buyers with their primary contact
SELECT b.id, b.buyer_company, c.email, c.first_name, c.last_name
FROM buyers b
LEFT JOIN contact c ON c.id = b.primary_contact_id;

-- Team members for a buyer
SELECT u.id, u.name, u.email
FROM users u
JOIN buyer_user bu ON bu.user_id = u.id
WHERE bu.buyer_id = ?;

-- Buyer's campaigns with status
SELECT c.id, c.name, c.status, c.type
FROM campaigns c
WHERE c.buyer_id = ? AND c.deleted_at IS NULL;

-- Buyer-supplier relationships
SELECT cust.*, s.name as supplier_name
FROM customer cust
JOIN suppliers s ON s.id = cust.supplier_id
WHERE cust.buyer_id = ? AND cust.is_active = 1;

-- Pending invitations
SELECT email, role, status, contact_type
FROM invites
WHERE buyer_id = ? AND status = 'INVITE_SENT';

-- Buyer revenue summary
SELECT SUM(oli.buyer_price) as total_revenue
FROM order_line_item oli
JOIN `order` o ON oli.order_id = o.id
WHERE o.buyer_id = ? AND oli.status != 'Canceled';
```
