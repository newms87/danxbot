# Model Relationship Map

This is a condensed reference of all major platform models and how they connect. Use this to understand which tables to JOIN before writing any SQL query.

## Core Business Models

```
Buyer (buyers)
  ├─→ Campaign (campaigns)           buyer_id FK
  ├─→ Order (order)                  buyer_id FK
  ├─→ Ad (ads)                       buyer_id FK (through orders)
  ├──► User (users)                  via buyer_user pivot
  ├─→ Contact (contact)              primary_contact_id, billing_contact_id FK
  ├─→ CreditCard (credit_cards)      buyer_id FK
  ├──► Supplier (suppliers)          via customer pivot
  └─→ Audience (audiences)           buyer_id FK

Campaign (campaigns)
  ├─→ Order (order)                  campaign_id FK
  ├─→ Ad (ads)                       campaign_id FK
  ├─→ AdGroup (ad_groups)            campaign_id FK
  ←── Buyer (buyers)                 buyer_id FK
  └──► InvoiceDocument (documents)   via morphToMany

Order (order)
  ├─→ OrderLineItem (order_line_item)  order_id FK
  ├─→ Ad (ads)                         order_id FK
  ├─→ OrderProduct (order_product)     order_id FK
  ←── Campaign (campaigns)             campaign_id FK
  ←── Buyer (buyers)                   buyer_id FK
  ←── Supplier (suppliers)             supplier_id FK
  └──► Transaction (transactions)      via pivot

OrderLineItem (order_line_item)
  ←── Order (order)                  order_id FK
  └─→ Ad (ads)                       order_line_item_id FK

Ad (ads)
  ←── Campaign (campaigns)           campaign_id FK
  ←── Order (order)                  order_id FK
  ←── OrderLineItem (order_line_item)  order_line_item_id FK
  ←── AdGroup (ad_groups)            ad_group_id FK
  ←── Creative (creatives)           creative_id FK
  ←── Buyer (buyers)                 buyer_id FK (through order)
  └←── Supplier (suppliers)          supplier_id FK (through order)

Supplier (suppliers)
  ├──► User (users)                  via supplier_user pivot
  ├──► Buyer (buyers)                via customer pivot
  ├──► Campus (campuses)             via campus_supplier pivot
  ├─→ Contact (contact)              primary_contact_id, billing_contact_id FK
  ├─→ Medium (medium)                supplier_id FK
  ├─→ Property (property)            supplier_id FK
  ├─→ Product (product)              supplier_id FK
  ├─→ ProductVariant (product_variant)  supplier_id FK
  ├─→ Order (order)                  supplier_id FK
  ├─→ Ad (ads)                       supplier_id FK
  └─→ Discount (discounts)           supplier_id FK
```

## Media Kit Hierarchy

```
Supplier → Medium → Property → Collection → Product → ProductVariant
(suppliers)  (medium)  (property)  (collection)  (product)  (product_variant)
```

Each level links to its parent via FK. All share `supplier_id` for direct supplier access.

**Important naming:** "Publications" = `property` table. "Ad Zones" = `product_variant` table.

## Billing & Accounting

```
InvoiceDocument (documents, type='InvoiceDocument')
  ├─→ DocumentLineItem (document_line_item)  document_id FK
  ├──► Campaign, Order, Buyer, Supplier      via document_owner pivot
  └──► CreditCard (credit_cards)             via morphToMany

BillDocument (documents, type='BillDocument')
  ├─→ DocumentLineItem (document_line_item)  document_id FK
  └──► Order, Supplier                       via document_owner pivot

DocumentLineItem (document_line_item)
  ←── Document (documents)              document_id FK
  └─→ OrderLineItem or Ad               sourceable (polymorphic)

Transaction (transactions)
  ←── Buyer (buyers)                    buyer_id FK
  ←── Supplier (suppliers)              supplier_id FK
  ←── PaymentMethod (payment_method)    payment_method_id FK
  ←── CreditCard (credit_cards)         credit_card_id FK
```

## Users & Auth

```
User (users)
  ├──► Buyer (buyers)                via buyer_user pivot
  ├──► Supplier (suppliers)          via supplier_user pivot
  └──► Role (roles)                  via role_user pivot
        └──► Permission (permissions)  via permission_role pivot
```

## Key Join Tables (Pivots)

| Pivot Table | Connects | Key Columns |
|-------------|----------|-------------|
| buyer_user | Buyer ↔ User | buyer_id, user_id |
| supplier_user | Supplier ↔ User | supplier_id, user_id |
| customer | Buyer ↔ Supplier | buyer_id, supplier_id |
| campus_supplier | Campus ↔ Supplier | campus_id, supplier_id |
| role_user | Role ↔ User | role_id, user_id |
| permission_role | Permission ↔ Role | permission_id, role_id |
| document_owner | Document ↔ various | document_id, owner_type, owner_id |

## Primary Key Types

| Type | Tables |
|------|--------|
| UUID | campaigns, order, order_line_item, ads, ad_groups, documents, document_line_item, medium, property, collection, product, product_variant |
| Integer | buyers, suppliers, users, roles, permissions, credit_cards, transactions, campuses, discounts, invites |

## Soft Deletes

Most tables use `deleted_at` column. Always include `AND deleted_at IS NULL` in queries unless you specifically want deleted records.
