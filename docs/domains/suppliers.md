# Suppliers & Publications Domain

The Suppliers domain manages student media organizations, their publications, and ad inventory. Suppliers are the sell-side of the Flytedesk marketplace — they own media properties and sell ad placements to Buyers.

## Model Hierarchy

```
Supplier (suppliers)
  ├── SupplierUser (supplier_user) — junction to User
  ├── Campus (campuses) — associated school
  │     └── CampusData (campus_data) — enrollment, calendar
  ├── Customer (customer) — Buyer-Supplier relationship
  └── Medium (medium) — media type (Print, Digital, Email, etc.)
        └── Property (property) — publication/website
              └── Collection (collection) — product grouping
                    └── Product (product) — ad product
                          └── ProductVariant (product_variant) — ad placement/zone
```

**Important:** The platform does NOT have separate "Publication" or "AdZone" models. Instead:
- **Publications** = `Property` model (e.g., "The Daily Campus Website")
- **Ad Zones** = `ProductVariant` model (e.g., "300x250 Sidebar")

## Supplier

**Model:** `ssap/app/Models/Supplier/Supplier.php`
**Table:** `suppliers`

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | int | Primary key |
| name | varchar | Organization name |
| display_name | varchar | Auto-generated (name + campus + id) |
| organization_type | varchar | Student Media, Influencer, etc. |
| supply_status | varchar | Member, Non-member, Blacklist, etc. |
| primary_contact_id | int FK | Primary contact |
| billing_contact_id | int FK | Billing contact |
| rep_id | int FK | Flytedesk sales rep (User) |
| member_since | datetime | Date joined as member |
| billing_preference | varchar | Payment preferences |
| check_name | varchar | Name for check payments |
| website | varchar | Website URL |
| is_test | boolean | Test account flag |
| w9_form | json | W9 form data |
| has_setup_payments | boolean | Payment setup completed |
| national_commission | decimal | Commission rate override |
| deleted_at | timestamp | Soft delete |

### Organization Types

| Constant | Value |
|----------|-------|
| ORGANIZATION_TYPE_STUDENT_MEDIA | Student Media Organization |
| ORGANIZATION_TYPE_INFLUENCER | Influencer |
| ORGANIZATION_TYPE_CONTRACTOR | Contractor |
| ORGANIZATION_TYPE_VOTER_GUIDE | Voter Guide |

### Supply Status

| Constant | Value |
|----------|-------|
| SUPPLY_STATUS_MEMBER | Member |
| SUPPLY_STATUS_NONMEMBER | Non-member |
| SUPPLY_STATUS_BLACKLIST | Blacklist |
| SUPPLY_STATUS_UNKNOWN_IF_ACCEPTS_ADS | Unknown if accepts ads |
| SUPPLY_STATUS_DOESNT_ACCEPT_ADS | Doesn't accept ads |
| SUPPLY_STATUS_UNKNOWN_IF_EXISTS | Unknown if exists |
| SUPPLY_STATUS_DOESNT_EXIST | Doesn't exist |

### Key Relationships

| Relationship | Type | Target |
|-------------|------|--------|
| primaryContact() | BelongsTo | Contact |
| billingContact() | BelongsTo | Contact |
| repUser() | BelongsTo | User |
| users() / teamMembers() | BelongsToMany | User (via supplier_user) |
| supplierUsers() | HasMany | SupplierUser |
| campuses() | BelongsToMany | Campus |
| buyers() | BelongsToMany | Buyer (via customer) |
| customers() | HasMany | Customer |
| mediums() | HasMany | Medium |
| properties() | HasMany | Property |
| collections() | HasMany | Collection |
| products() | HasMany | Product |
| variants() | HasMany | ProductVariant |
| orders() | HasMany | Order |
| ads() | HasMany | Ad |
| nationalAds() | HasMany | Ad |
| adShop() | HasOne | AdShop |
| discounts() | HasMany | Discount |
| invoices() | MorphMany | Invoice |
| bills() | MorphMany | Bill |

### Key Methods

| Method | Description |
|--------|-------------|
| setDisplayName() | Auto-generates display_name from name + campus + id |
| isStudentMedia() | Check if org type is Student Media |
| isInfluencer() | Check if org type is Influencer |
| isContractor() | Check if org type is Contractor |
| ownsBuyer() | Check if supplier owns/manages a buyer |
| getNationalCommission() | Get commission rate (0 for non-student media) |
| getEnrollment() | Get campus enrollment number |
| resolveBillingContact() | Get billing or primary contact |
| shouldSyncToQuickbooks() | Check if QB sync should run |
| removeAllData() | Delete all supplier data |

## SupplierUser

**Model:** `ssap/app/Models/Supplier/SupplierUser.php`
**Table:** `supplier_user` (junction)

| Column | Type | Description |
|--------|------|-------------|
| id | int | Primary key |
| supplier_id | int FK | Links to suppliers.id |
| user_id | int FK | Links to users.id |

Relationships: `user()` → User, `supplier()` → Supplier
Traits: Taggable (supports tag names via `tagNames()`)

## Campus

**Model:** `ssap/app/Models/Supplier/Campus/Campus.php`
**Table:** `campuses`

| Column | Type | Description |
|--------|------|-------------|
| id | int | Primary key |
| name | varchar | Campus name |
| is_enabled | boolean | Active status |
| deleted_at | timestamp | Soft delete |

Relationships: `suppliers()` → BelongsToMany Supplier, `data()` → HasOne CampusData, `audiences()` → BelongsToMany Audience

### CampusData

**Table:** `campus_data`

| Column | Type | Description |
|--------|------|-------------|
| campus_id | int FK | Links to campuses.id |
| enrollment | int | Student enrollment |
| fall_break_start | date | Fall break start |
| fall_break_end | date | Fall break end |
| fall_finals_start | date | Fall finals start |
| spring_semester_start | date | Spring semester start |

## Media Kit Hierarchy

The Media Kit is the hierarchical structure organizing a supplier's ad inventory:

```
Supplier → Medium → Property → Collection → Product → ProductVariant
```

Each level has: `is_enabled`, `is_bookable` (virtual), `is_super` (Flytedesk-managed template), `sku` (auto-generated), `template_id`.

### Medium

**Model:** `ssap/app/Models/Mediakit/Medium/Medium.php`
**Table:** `medium`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| supplier_id | int FK | Parent supplier |
| name | varchar | Medium name |
| sku | varchar | Auto-generated SKU (1-2 chars) |
| is_enabled | boolean | Enabled status |
| is_super | boolean | Super media kit flag |
| template_id | string | Template reference |

**Medium Types:**

| Constant | Value |
|----------|-------|
| TYPE_PRINT | Print |
| TYPE_DIGITAL | Digital |
| TYPE_EMAIL | Email |
| TYPE_EMAIL_AD_SERVING | Email Ad Serving |
| TYPE_DOOH | DOOH |
| TYPE_SOCIAL | Social |
| TYPE_STREET_TEAM | Street Team |
| TYPE_OOH | Out of Home |
| TYPE_INFLUENCER | Influencer |

Relationships: `supplier()`, `properties()`, `products()`, `variants()`, `types()` → BelongsToMany MediumType

### Property (Publication)

**Model:** `ssap/app/Models/Mediakit/Property/Property.php`
**Table:** `property`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| supplier_id | int FK | Parent supplier |
| medium_id | UUID FK | Parent medium |
| name | varchar | Property name |
| ssp_name | varchar | SSP/external name override |
| sku | varchar | Auto-generated SKU |
| is_enabled | boolean | Enabled status |
| is_digital_content | boolean | Digital content flag |
| website_url | varchar | Property website |
| has_dimensions | boolean | Supports dimensions |
| min_days | int | Minimum booking days |
| min_impressions | int | Minimum impressions |
| schedule_type_id | int FK | Schedule type |

Key relationships: `supplier()`, `medium()`, `collections()`, `products()`, `variants()` → HasManyThrough ProductVariant

Key methods: `getSiteTitle()` (generate standard site title for external systems)

### Collection

**Model:** `ssap/app/Models/Mediakit/Collection/Collection.php`
**Table:** `collection`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| supplier_id | int FK | Parent supplier |
| medium_id | UUID FK | Parent medium |
| property_id | UUID FK | Parent property |
| name | varchar | Collection name |
| is_enabled | boolean | Enabled status |

Key relationships: `supplier()`, `medium()`, `property()`, `products()`, `schedule()` → HasOne Schedule

### Product

**Model:** `ssap/app/Models/Mediakit/Product/Product.php`
**Table:** `product`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| supplier_id | int FK | Parent supplier |
| medium_id | UUID FK | Parent medium |
| collection_id | UUID FK | Parent collection |
| campus_id | int FK | Associated campus |
| name | varchar | Product name |
| ssp_name | varchar | SSP name override |
| is_enabled | boolean | Enabled status |
| quantity_limit | int | Quantity limit |

Key relationships: `supplier()`, `medium()`, `collection()`, `property()` (via collection), `variants()`, `fulfillmentMethods()` → BelongsToMany FulfillmentMethod

### ProductVariant (Ad Zone)

**Model:** `ssap/app/Models/Mediakit/ProductVariant/ProductVariant.php`
**Table:** `product_variant`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| supplier_id | int FK | Parent supplier |
| medium_id | UUID FK | Parent medium |
| product_id | UUID FK | Parent product |
| name | varchar | Variant name (e.g., "300x250 Sidebar") |
| ssp_name | varchar | SSP/external name override |
| sku | varchar | Auto-generated SKU |
| is_enabled | boolean | Enabled status |
| is_bookable_ad_shop | boolean | Available in Ad Shop |
| quantity | int | Available quantity |
| attributes | json | Dimensions, location, color, etc. |
| enabled_rate_classes | json | Enabled rate classes |
| unit_id | int FK | Pricing unit |
| placement_setting_id | int FK | Placement config |
| gam_ad_unit_id | varchar | Google Ad Manager ID |

Key relationships: `supplier()`, `product()`, `property()` (via collection), `rateSheets()`, `ads()` → HasManyThrough Ad, `skuInventory()`, `adReportDates()`, `unit()` → BelongsTo Unit

Key methods:
| Method | Description |
|--------|-------------|
| dimensions() | Get Dimension object from attributes JSON |
| primaryRateSheet() | Get primary (non-impression) rate sheet |
| resolveRateSheetForDate() | Find rate sheet for specific date |
| isBookable() | Check full hierarchy bookability |
| getZoneName() | Generate zone name for external systems |
| syncToExternal() | Sync to digital vendor (GAM/Kevel) |

Virtual attributes: `is_bookable`, `full_name` (full hierarchy name), `serving_tag` (email HTML tag)

## Customer (Buyer-Supplier Relationship)

**Table:** `customer`

The Customer model represents a Buyer-Supplier relationship. It controls which rate classes and payment methods a buyer can access for a specific supplier.

Key methods on SupplierRepository:
| Method | Description |
|--------|-------------|
| grantBuyerAccess(Supplier, Buyer) | Create Customer relationship |
| buyerApprovedForRateClass($s, $b, $rc) | Check rate class approval |
| buyerCanUsePaymentMethod($s, $b, $pm) | Check payment method access |

## Discount

**Model:** `ssap/app/Models/Supplier/Discount/Discount.php`
**Table:** `discounts`

| Column | Type | Description |
|--------|------|-------------|
| id | int | Primary key |
| supplier_id | int FK | Parent supplier |
| name | varchar | Discount name |
| code | varchar | Discount code |
| type | char | '%' or '$' |
| value | decimal | Discount amount/percentage |
| start_date | datetime | Valid from |
| end_date | datetime | Valid until |
| uses | int | Usage limit (null = unlimited) |
| status | boolean | 1=Enabled, 0=Disabled |

Key method: `isUsable()` — checks status, date range, and remaining uses.

## SupplierRepository

**Path:** `ssap/app/Repositories/SupplierRepository.php`

| Method | Description |
|--------|-------------|
| registerSupplier($data) | Register new supplier with user account |
| createSupplier(Campus, $name) | Create supplier for a campus |
| updateAccount(Supplier, $input) | Update supplier account info |
| addUserToTeam(Supplier, User) | Add user to supplier team |
| sendInviteToEmail(Supplier, $email, Role) | Send team invitation |
| removeUser(SupplierUser, Supplier) | Remove user from team |
| takeover(Supplier) | Log in as supplier (admin feature) |
| init(Supplier) | Initialize new supplier (media kit, ad shop) |
| getPurchasedProducts($supplier) | Get tree of purchased products |

## Controllers

| Controller | Purpose |
|-----------|---------|
| SupplierOrdersController | Order views, list, summary, actions |
| SupplierAdsController | Ad views, approvals, dashboard summary |
| SupplierBillingController | Billing and invoice management |
| SupplierCustomers | Customer relationship management |

**Path:** `ssap/app/Http/Controllers/Supplier/`

## Feature Flags

| Flag | Description |
|------|-------------|
| SSP_CONTROLLED_CREATIVES | Creative management is SSP-only |
| SSP_CONTROLLED_VERIFICATIONS | Verification is SSP-only |

## Common SQL Queries

**Find supplier by name:**
```sql
SELECT * FROM suppliers WHERE name LIKE '%search%' AND deleted_at IS NULL;
```

**Find supplier's team members:**
```sql
SELECT u.*, r.name as role_name FROM users u
JOIN supplier_user su ON u.id = su.user_id
JOIN role_user ru ON u.id = ru.user_id
JOIN roles r ON ru.role_id = r.id
WHERE su.supplier_id = ?
AND u.deleted_at IS NULL;
```

**Get supplier's media kit hierarchy:**
```sql
SELECT m.name as medium, p.name as property,
       c.name as collection, pr.name as product,
       pv.name as variant, pv.sku, pv.is_enabled
FROM product_variant pv
JOIN product pr ON pv.product_id = pr.id
JOIN collection c ON pr.collection_id = c.id
JOIN property p ON c.property_id = p.id
JOIN medium m ON p.medium_id = m.id
WHERE pv.supplier_id = ?
ORDER BY m.name, p.name, c.name, pr.name, pv.name;
```

**Find suppliers by campus:**
```sql
SELECT s.* FROM suppliers s
JOIN campus_supplier cs ON s.id = cs.supplier_id
JOIN campuses c ON cs.campus_id = c.id
WHERE c.name LIKE '%university%'
AND s.deleted_at IS NULL;
```

**Find active member suppliers:**
```sql
SELECT s.id, s.name, s.supply_status, s.organization_type
FROM suppliers s
WHERE s.supply_status = 'Member'
AND s.deleted_at IS NULL
ORDER BY s.name;
```

**Check supplier's ad inventory (enabled variants):**
```sql
SELECT pv.id, pv.name, pv.sku, pv.is_enabled,
       pr.name as product, p.name as property, m.name as medium
FROM product_variant pv
JOIN product pr ON pv.product_id = pr.id
JOIN collection c ON pr.collection_id = c.id
JOIN property p ON c.property_id = p.id
JOIN medium m ON p.medium_id = m.id
WHERE pv.supplier_id = ?
AND pv.is_enabled = 1
ORDER BY m.name, p.name, pv.name;
```

**Find supplier's customers (buyer relationships):**
```sql
SELECT b.name as buyer_name, c.*
FROM customer c
JOIN buyers b ON c.buyer_id = b.id
WHERE c.supplier_id = ?;
```

**Get campus enrollment data:**
```sql
SELECT c.name, cd.enrollment,
       cd.fall_break_start, cd.spring_semester_start
FROM campuses c
JOIN campus_data cd ON c.id = cd.campus_id
JOIN campus_supplier cs ON c.id = cs.campus_id
WHERE cs.supplier_id = ?;
```

## Key Files

| File | Purpose |
|------|---------|
| ssap/app/Models/Supplier/Supplier.php | Main Supplier model |
| ssap/app/Models/Supplier/SupplierUser.php | User-Supplier junction |
| ssap/app/Models/Supplier/Campus/Campus.php | Campus model |
| ssap/app/Models/Mediakit/Medium/Medium.php | Medium (media type) |
| ssap/app/Models/Mediakit/Property/Property.php | Property (publication) |
| ssap/app/Models/Mediakit/Collection/Collection.php | Collection grouping |
| ssap/app/Models/Mediakit/Product/Product.php | Product model |
| ssap/app/Models/Mediakit/ProductVariant/ProductVariant.php | Variant (ad zone) |
| ssap/app/Models/Supplier/Discount/Discount.php | Discount codes |
| ssap/app/Repositories/SupplierRepository.php | Supplier business logic |
| ssap/app/Http/Controllers/Supplier/ | Supplier controllers |
