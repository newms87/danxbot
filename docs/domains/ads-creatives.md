# Ads & Creatives Domain

The Ads/Creatives domain manages creative assets, approval workflows, ad verification, and ad sizing. Creative approval involves a two-party workflow between buyers and suppliers, with auto-approval rules for certain ad types.

## Model Hierarchy

```
Creative (creatives)
  └── Ad (ads) — individual placement
        ├── AdVerification (ad_verification) — post-run verification
        │     └── AdVerificationRating (ad_verification_ratings) — file ratings
        └── AdReport (ad_report) — delivery metrics

BuyerCreativeFolder (buyer_creative_folders)
  ├── BuyerCreativeFolder (self-referential parent)
  └── BuyerCreativeComment (buyer_creative_comments)

Dimension (dimension) — ad size definitions
```

## Creative

**Model:** `ssap/app/Models/Creative/Creative.php`
**Table:** `creatives`

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| display_name | string | Human-readable name |
| status | enum | Current approval status |
| buyer_id | UUID FK | Buyer who owns the creative |
| product_variant_id | UUID FK | Associated product variant |
| date_supplier_approved | datetime | When supplier approved |
| date_buyer_approved | datetime | When buyer approved |
| date_supplier_rejected | datetime | When supplier rejected |
| date_buyer_rejected | datetime | When buyer rejected |
| supplier_rejection_note_id | FK | Supplier rejection reason |
| buyer_rejection_note_id | FK | Buyer rejection reason |
| last_downloaded_at | datetime | Last download timestamp |
| deleted_at | datetime | Soft delete |

### Status Lifecycle

| Status | Meaning |
|--------|---------|
| Pending | Initial state, awaiting upload |
| Pending Supplier | Buyer approved, awaiting supplier |
| Pending Buyer | Supplier approved, awaiting buyer |
| Rejected | Either party rejected |
| Change Requested | Changes needed |
| Accepted | Both parties approved |
| Pre-approved | Auto-approved |

### Key Relationships

| Relationship | Type | Target |
|-------------|------|--------|
| buyer() | BelongsTo | Buyer |
| ad() | HasOne | Ad |
| supplierRejectionNote() | BelongsTo | Note |
| buyerRejectionNote() | BelongsTo | Note |

### Key Methods

| Method | Description |
|--------|-------------|
| getVariationNames() | Get all variation names from form responses |
| getVariationsWithIds() | Get variations with SSP IDs (for Kevel) |
| getVariationNameBySspId() | Look up variation by SSP ID |
| updateBasedOnResumedAd() | Revert to Pending Supplier on ad resume |

Creative assets are stored via the `HasFormResponse` trait — form field responses hold uploaded files and variation data.

## Creative Approval Workflow

Creative approval is a two-party process between buyers and suppliers.

### Flow Diagram

```
                    Creative Created
                         │
                    STATUS_PENDING
                         │
              ┌──────────┴──────────┐
              ▼                      ▼
     Supplier uploads          Buyer uploads
              │                      │
     STATUS_PENDING_BUYER    STATUS_PENDING_SUPPLIER
              │                      │
         Buyer reviews          Supplier reviews
              │                      │
      ┌───────┴───────┐      ┌──────┴──────┐
      ▼               ▼      ▼              ▼
   Approves        Rejects  Approves     Rejects
      │               │      │              │
      ▼               ▼      ▼              ▼
 STATUS_ACCEPTED  STATUS_REJECTED  STATUS_ACCEPTED  STATUS_REJECTED
 (if both done)   (resubmit)       (if both done)   (resubmit)
```

### Approval Methods (CreativeRepository)

| Method | Action |
|--------|--------|
| supplierAcceptCreative($ad) | Sets date_supplier_approved, status → Accepted or Pending Buyer |
| buyerAcceptCreative($ad) | Sets date_buyer_approved, status → Accepted or Pending Supplier |
| supplierRejectCreative($ad, $note) | Sets date_supplier_rejected, status → Rejected, creates Note |
| buyerRejectCreative($ad, $note) | Sets date_buyer_rejected, status → Rejected, creates Note |

### Auto-Approval Rules

| Condition | Auto-Approves |
|-----------|---------------|
| Supplier-owned buyer | Buyer step |
| Non-approval-required local ad + buyer set creative | Supplier step |
| National ads without requirement + buyer approved | Supplier step |

When both parties approve: `AdRepository::creativeAccepted()` → may set Ad to `STATUS_READY`.

## Ad Creative Fields

**Model:** `ssap/app/Models/Campaign/Ad.php`
**Table:** `ads`

### Creative-Related Columns

| Column | Type | Description |
|--------|------|-------------|
| creative_id | UUID FK | Associated creative |
| approval_status | enum | Ad-level approval status |
| approval_user_id | FK | Who approved the ad |
| approval_note_id | FK | Approval comment/reason |
| creative_phase | string | Logical grouping for uploads |

### Ad Approval Status Constants

| Status | Meaning |
|--------|---------|
| Pending Approval | Awaiting approval |
| Approved | Ad approved |
| Rejected | Ad rejected |
| Change Requested | Changes needed |

### Ad Status (Creative-Related)

| Status | Meaning |
|--------|---------|
| Creative Pending | Awaiting creative upload |
| Pending Creative Approval | Creative submitted, awaiting review |
| Ready | All approvals done, ready to run |
| Unverified | Post-run, awaiting verification |
| Pending Verification Approval | Verification submitted |
| Verified | Verification approved |
| Verification Rejected | Verification rejected |

### Creative Filter Scopes

| Scope | Description |
|-------|-------------|
| creativeStatus($status) | Filter by complete/incomplete |
| creativeSubmitted($value) | Filter by form submission |
| creativePendingApproval($value) | Locals awaiting approval |
| missingCreative($excludeUpcoming) | Ads without completed creative |

## Ad Verification

**Model:** `ssap/app/Models/Verification/AdVerification.php`
**Table:** `ad_verification`

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| ad_id | UUID FK | Related ad |
| status | enum | Verification status |
| approved_at | datetime | When approved |
| rejected_at | datetime | When rejected |
| date_supplier_last_updated | datetime | Last supplier update |
| rejection_note_id | UUID FK | Rejection reason |

### Status Lifecycle

| Status | Meaning |
|--------|---------|
| Unverified | Initial post-run state |
| Pending Approval | Verification submitted |
| Verified | Approved |
| Rejected | Rejected with reason |

### Verification Workflow

```
Ad end_date passes → Ad::STATUS_UNVERIFIED
         │
  Supplier submits verification form
         │
  AdVerification::STATUS_PENDING
         │
  ┌──────┴──────┐
  ▼              ▼
Local ads:     National ads:
Auto-approve   Admin reviews
  │              │
  ▼         ┌────┴────┐
Verified    ▼         ▼
         Approved   Rejected
            │         │
         Verified  Verification Rejected
```

### Verification Methods (VerificationRepository)

| Method | Action |
|--------|--------|
| approve($ad) | Sets approved_at, Ad → Verified |
| reject($ad, $reason) | Sets rejected_at, creates Note, Ad → Verification Rejected |
| saveVerification($ad, $input) | Save form data, trigger auto-approve for locals |

### Ad Verification Rating

**Model:** `ssap/app/Models/Verification/AdVerificationRating.php`
**Table:** `ad_verification_ratings`

Per-file star ratings (1-5) on verification submissions. Columns: `verification_id`, `file_id`, `rating`.

## Dimension (Ad Sizes)

**Model:** `ssap/app/Models/Mediakit/Dimension.php`
**Table:** `dimension`

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| type | string | null (default) or 'ad-size' |
| width | int | Width value |
| height | int | Height value |
| unit | string | 'pixels', 'percent', etc. |

### Common Digital Ad Sizes

| Size | Use Case |
|------|----------|
| 300x250 | Medium rectangle |
| 728x90 | Leaderboard |
| 160x600 | Wide skyscraper |
| 320x50 | Mobile banner |
| 970x250 | Billboard |
| 970x90 | Large leaderboard |
| 1200x628 | Social/native |
| 1x1 | Tracking pixel |

## Buyer Creative Folders

**Model:** `ssap/app/Models/Buyer/BuyerCreativeFolder.php`
**Table:** `buyer_creative_folders`

Hierarchical folder system for organizing buyer creative files. Self-referential `parent_id` enables nested folders. Integrates with Slack via `slack_thread_ts` for discussions.

### Key Methods

| Method | Description |
|--------|-------------|
| isTopLevel() | Is this a root folder? |
| getFullPath() | "Parent / Child / Grandchild" path |
| getAllDescendantIds() | Recursive descendant IDs |
| getTreeFiles() | All files with folder paths |
| getTreeComments() | All comments in folder tree |

### Buyer Creative Comments

**Model:** `ssap/app/Models/Buyer/BuyerCreativeComment.php`
**Table:** `buyer_creative_comments`

Comments on creative folders with `is_internal` flag (hidden from buyer unless permitted). Links to Slack messages via `slack_message_ts`.

## Feature Flags

| Flag | Description |
|------|-------------|
| SSP_CONTROLLED_CREATIVES | Creative management is SSP-only |
| SSP_CONTROLLED_VERIFICATIONS | Verification is SSP-only |
| SSP_CONTROLLED_ACTION_REVIEWS | Approval reviews managed by SSP |
| CT_COLLABORATIVE_EDITING | Real-time collaborative ad editing |

## Common SQL Queries

**Find creatives pending approval:**
```sql
SELECT c.id, c.display_name, c.status, c.buyer_id
FROM creatives c
WHERE c.status IN ('Pending Supplier', 'Pending Buyer')
AND c.deleted_at IS NULL;
```

**Find ads awaiting creative upload:**
```sql
SELECT a.ref, a.status, a.creative_id, c.status as creative_status
FROM ads a
LEFT JOIN creatives c ON a.creative_id = c.id
WHERE a.status = 'Creative Pending'
AND a.deleted_at IS NULL;
```

**Find ads with approved creatives ready to run:**
```sql
SELECT a.ref, a.status, a.approval_status, c.status as creative_status
FROM ads a
JOIN creatives c ON a.creative_id = c.id
WHERE c.status = 'Accepted'
AND a.approval_status = 'Approved'
AND a.deleted_at IS NULL;
```

**Find ads awaiting verification:**
```sql
SELECT a.ref, a.status, a.end_date, av.status as verification_status
FROM ads a
LEFT JOIN ad_verification av ON a.id = av.ad_id
WHERE a.status IN ('Unverified', 'Pending Verification Approval')
AND a.deleted_at IS NULL;
```

**Check creative approval history:**
```sql
SELECT c.id, c.display_name, c.status,
       c.date_supplier_approved, c.date_buyer_approved,
       c.date_supplier_rejected, c.date_buyer_rejected,
       sn.text as supplier_rejection_note,
       bn.text as buyer_rejection_note
FROM creatives c
LEFT JOIN notes sn ON c.supplier_rejection_note_id = sn.id
LEFT JOIN notes bn ON c.buyer_rejection_note_id = bn.id
WHERE c.buyer_id = ?;
```

**Get buyer creative folders with file counts:**
```sql
SELECT bcf.id, bcf.name, bcf.parent_id, bcf.file_count
FROM buyer_creative_folders bcf
WHERE bcf.buyer_id = ?
AND bcf.deleted_at IS NULL
ORDER BY bcf.sort_order;
```

## Key Files

| File | Purpose |
|------|---------|
| ssap/app/Models/Creative/Creative.php | Creative model with approval status |
| ssap/app/Models/Campaign/Ad.php | Ad model with creative fields |
| ssap/app/Models/Verification/AdVerification.php | Post-run verification |
| ssap/app/Models/Verification/AdVerificationRating.php | File ratings |
| ssap/app/Models/Mediakit/Dimension.php | Ad size definitions |
| ssap/app/Models/Buyer/BuyerCreativeFolder.php | Folder hierarchy |
| ssap/app/Models/Buyer/BuyerCreativeComment.php | Folder comments |
| ssap/app/Repositories/CreativeRepository.php | Creative upload/approval logic |
| ssap/app/Repositories/AdRepository.php | Ad approval management |
| ssap/app/Repositories/VerificationRepository.php | Verification approval logic |
| ssap/app/Http/Controllers/Admin/AdminCreativeController.php | Admin creative UI |
| ssap/app/Http/Controllers/Delivery/BuyerCreativeUploadController.php | Buyer file management |
