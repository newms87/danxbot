# SSP (Supply-Side Platform) Domain

The SSP domain handles programmatic digital ad serving via Kevel (formerly Adzerk). It manages ad group delivery, impression tracking, analytics sync, and revenue/payout calculations.

## Data Flow

```
SSP Booking Request (API)
  → SspController validates via SspAdInput
  → SspRepository creates Campaign (is_ssp=true)
  → SspAdToPlatformAdJob creates Ad, AdGroup, Creative
  → Ad save triggers SyncAdGroupToDigitalVendorJob
  → Kevel API creates Flight, Ad, Creative entities
  → Kevel serves ads to digital zones (ProductVariant → Zone)
  → Nightly: SyncKevelAdAnalyticsByDateJob pulls metrics
  → AdReport/AdReportDate/AdReportDateCreative updated
```

## Model Hierarchy

```
Campaign (campaigns, is_ssp=true)
  └── AdGroup (ad_groups) — maps to Kevel Flight
        └── Ad (ads) — individual placement
              ├── AdReport (ad_report) — aggregate metrics
              │     └── AdReportDate (ad_report_date) — daily rollup
              │           └── AdReportDateCreative (ad_report_date_creatives)
              ├── Creative (creative) — ad creative assets
              └── KevelApiLog (kevel_api_logs) — sync history
```

## AdGroup

**Model:** `ssap/app/Models/Campaign/AdGroup.php`
**Table:** `ad_groups`

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| campaign_id | UUID FK | Parent campaign |
| creative_id | UUID FK | Associated creative |
| name | string | Ad group name |
| status | enum | Computed lifecycle status |
| goal_type | string | Impressions or Percentage |
| charge_type | string | CPM or Flat Rate |
| charge_rate | decimal | Buyer charge rate |
| payout_type | string | CPM or Flat Rate |
| payout_rate | decimal | Supplier payout rate |
| charge_metric | string | Billing metric type |
| payout_metric | string | Payout metric type |

### Status Lifecycle

| Status | Meaning |
|--------|---------|
| Active | Has active ads running |
| Complete | All ads finished |
| Pending | No ads created yet |
| Disabled | Manually disabled |

### Billing Metrics

| Metric | Maps To |
|--------|---------|
| Impressions | requests field |
| Visible Impressions | impressions field |
| Viewable Impressions | viewable_impressions field |
| Full Impressions | full_impressions field |
| Clicks | clicks field |

### Key Relationships

| Relationship | Type | Target |
|-------------|------|--------|
| ads() | HasMany | Ad |
| creative() | BelongsTo | Creative |
| campaign() | BelongsTo | Campaign |
| kevelApiLogs() | HasMany | KevelApiLog |
| sspLineItem() | MorphOne | External (type: ssp-line-item) |

## Ad (SSP Context)

**Model:** `ssap/app/Models/Campaign/Ad.php`
**Table:** `ads`

### SSP-Specific Columns

| Column | Type | Description |
|--------|------|-------------|
| ssp_status | enum | SSP lifecycle status |
| is_ssp_booked | boolean | Created via SSP |
| is_paused | boolean | Temporarily paused |
| impressions | int | Target impression count |
| charge_type/rate/metric | mixed | Buyer billing config |
| payout_type/rate/metric | mixed | Supplier payout config |

### SSP Status Lifecycle

| Status | Meaning |
|--------|---------|
| Pending | Pre-run, creative not approved |
| Ready | Pre-run, approved and ready |
| Started | Currently running |
| Completed | Post-run, verified/invoiced |
| Canceled | Cancelled |
| Delinquent | Delivery issue/warning |

### Computed SSP Status Logic

- **Pre-run** (start_date in future): Ready if creative has both buyer AND supplier approvals, else Pending
- **Running** (between start/end date): Started
- **Post-run** (past end_date): Completed if verification approved or invoiced, else Started
- **Cancelled**: Always Canceled

## Kevel Integration

**API Base:** `ssap/app/Api/Kevel/KevelApi.php`
**Auth:** Header `X-Adzerk-ApiKey` with config `kevel.api.key`

### Kevel Entity Mapping

| Flytedesk | Kevel | Description |
|-----------|-------|-------------|
| AdGroup | Flight | Container for ads |
| Ad | Ad | Individual placement |
| Creative | Creative | Ad creative assets |
| ProductVariant | Zone | Digital ad zone |

### Kevel API Log

**Model:** `ssap/app/Models/Vendor/KevelApiLog.php`
**Table:** `kevel_api_logs`

| Column | Type | Description |
|--------|------|-------------|
| id | int | Primary key |
| api_log_id | FK | Links to api_logs |
| type | string | Kevel API class name |
| ad_group_id | UUID FK | Related ad group |
| ad_id | UUID FK | Related ad |
| creative_id | UUID FK | Related creative |
| kevel_flight_id | int | Kevel Flight ID |
| kevel_ad_id | int | Kevel Ad ID |
| kevel_creative_id | int | Kevel Creative ID |

### Sync Flow

1. Ad/AdGroup save triggers `SyncJob('ad-group-sync-kevel', ...)`
2. `SyncAdGroupToDigitalVendorJob` → `DigitalVendorRepository::syncAdGroupToVendor()`
3. Creates/updates Kevel Flight, Ad, AdType, Creative entities
4. Records external IDs in External table
5. Logs sync requests/responses in KevelApiLog

## Impression & Click Tracking

### AdReport (Aggregate)

**Model:** `ssap/app/Models/Campaign/AdReport.php`
**Table:** `ad_report`

| Column | Type | Description |
|--------|------|-------------|
| id | int | Primary key |
| ad_id | UUID FK | Related ad |
| requests | int | Total request count |
| impressions | int | Visible impressions |
| viewable_impressions | int | Passed viewability threshold |
| full_impressions | int | Fully viewed |
| clicks | int | Click-throughs |

Key methods: `getCtr()` (clicks/impressions), `getViewability()` (viewable/impressions)

### AdReportDate (Daily)

**Model:** `ssap/app/Models/Campaign/AdReportDate.php`
**Table:** `ad_report_date`

| Column | Type | Description |
|--------|------|-------------|
| ad_report_id | FK | Parent aggregate |
| ad_id | UUID FK | Related ad |
| date | date | Report date |
| requests | int | Daily requests |
| impressions | int | Daily visible impressions |
| viewable_impressions | int | Daily viewable |
| full_impressions | int | Daily full views |
| clicks | int | Daily clicks |
| charge_buyer | decimal | Revenue for the day |
| pay_supplier | decimal | Payout for the day |

### AdReportDateCreative (Per-Creative)

**Table:** `ad_report_date_creatives`

Breaks down daily metrics by creative variation. Columns: `ad_report_date_id`, `ad_id`, `creative_id`, `variation`, plus the same metric fields.

### Tracking URLs

Generated from ProductVariant, pattern:
```
Click: https://k.fdsk.co/s/redirect/{websiteId}/{zoneId}/{adSizeId}/{propertyName}
Image: https://k.fdsk.co/s/{websiteId}/{zoneId}/{adSizeId}/{propertyName}
```

## Analytics Sync

### Nightly Job

**Job:** `ssap/app/Jobs/Analytics/SyncKevelAdAnalyticsByDateJob.php`

1. Calls `KevelQueuedReportApi::queueAndFetchReport()` for date range
2. Groups by day + creative ID
3. Splits into per-creative `SyncKevelAnalyticsToAdReportJob` batches
4. Each batch updates AdReport, AdReportDate, AdReportDateCreative

### Kevel Event IDs

| Event | ID | Description |
|-------|----|-------------|
| Visible Impression | 30 | Ad appeared on screen |
| Viewable Impression | 40 | Met MRC viewability (50% for 1s+) |
| Full Impression | 800 | Fully viewed |

### Report Statuses

| Status | Value | Description |
|--------|-------|-------------|
| In Progress | 1 | Report being generated |
| Complete | 2 | Report ready |
| Error | 3 | Report generation failed |

## SSP Sync Jobs

**Path:** `ssap/app/Jobs/Ssp/`
**Base:** `SspSyncJob` (abstract, 2 retries)

**Retry logic:**
- 503 → retry after 10 minutes
- 429 → retry after 1 minute
- 404 → stop retries

| Job | Purpose |
|-----|---------|
| SspAdToPlatformAdJob | Convert SSP booking to Ad |
| SspSyncCreativeJob | Sync creative to Kevel |
| SspSyncBookingReviewJob | Sync approval status |
| SspSyncVerificationJob | Sync post-run verification |
| SspSyncVerificationReviewJob | Sync verification approval |
| SspSyncCreativeReviewJob | Sync creative approval |
| SspSyncInvoiceJob | Sync billing data |
| SspPostBookingJob | Post-booking sync |
| SspDeleteCampaignJob | Delete SSP campaign |

## SSP API Endpoints

**Controller:** `ssap/app/Http/Controllers/Ssp/SspController.php`

### Ad Management

| Method | Path | Description |
|--------|------|-------------|
| POST | /ssp/ads | Create ads from SSP booking |
| PUT | /ssp/ads/{ad} | Update ad |
| DELETE | /ssp/ads/{ad}/cancel | Cancel ad |
| PUT | /ssp/ads/{ad}/resume | Resume cancelled ad |

### Creative Management

| Method | Path | Description |
|--------|------|-------------|
| POST | /ssp/ads/{ad}/creative | Create creative variation |
| PUT | /ssp/ads/{ad}/creative/{id} | Update creative |
| DELETE | /ssp/ads/{ad}/creative/{id} | Delete creative |

### Verification

| Method | Path | Description |
|--------|------|-------------|
| POST | /ssp/ads/{ad}/verification | Submit verification |
| POST | /ssp/ads/{ad}/verification/review | Approve/reject |
| DELETE | /ssp/ads/{ad}/verification | Delete verification |

### Lookup

| Method | Path | Description |
|--------|------|-------------|
| GET | /ssp/suppliers | List suppliers |
| GET | /ssp/campuses | List campuses/schools |
| GET | /ssp/variants | List product variants |
| GET | /ssp/skus | List SKU inventory |
| GET | /ssp/buyers | List buyers |
| GET | /ssp/campaigns | List campaigns |

## SSP Repository

**Path:** `ssap/app/Repositories/Ssp/SspRepository.php`

| Method | Description |
|--------|-------------|
| updateOrCreateCampaign($ref, $name, $buyerId) | Create is_ssp=true campaign |
| createAdJob($campaign, $input) | Dispatch SspAdToPlatformAdJob |
| deleteCampaigns() | Delete all SSP campaigns |
| resetTestingData() | Reset Kevel/Airtable/SSP data |

## Common SQL Queries

**Check ad delivery status:**
```sql
SELECT a.ref, a.status, a.ssp_status, a.start_date, a.end_date,
       ar.requests, ar.impressions, ar.viewable_impressions, ar.clicks
FROM ads a
LEFT JOIN ad_report ar ON a.id = ar.ad_id
WHERE a.campaign_id = ?
ORDER BY a.start_date DESC;
```

**Check fill rates by date:**
```sql
SELECT ard.date, ard.requests, ard.impressions,
       ROUND(100 * ard.impressions / NULLIF(ard.requests, 0), 2) as fill_rate,
       ard.clicks,
       ROUND(100 * ard.clicks / NULLIF(ard.impressions, 0), 2) as ctr
FROM ad_report_date ard
WHERE ard.ad_id = ?
ORDER BY ard.date DESC;
```

**Check impressions by creative:**
```sql
SELECT ardc.creative_id, ardc.variation,
       SUM(ardc.requests) as total_requests,
       SUM(ardc.impressions) as total_impressions,
       SUM(ardc.clicks) as total_clicks
FROM ad_report_date_creatives ardc
WHERE ardc.ad_id = ?
GROUP BY ardc.creative_id, ardc.variation;
```

**Check Kevel sync errors:**
```sql
SELECT kal.*, al.status_code, al.method, al.url
FROM kevel_api_logs kal
JOIN api_logs al ON kal.api_log_id = al.id
WHERE kal.ad_id = ? OR kal.ad_group_id = ?
ORDER BY al.created_at DESC
LIMIT 20;
```

**Find ads awaiting verification:**
```sql
SELECT a.ref, a.status, a.ssp_status, a.end_date
FROM ads a
WHERE a.ssp_status IN ('Started', 'Completed')
AND a.status = 'Unverified'
AND NOT EXISTS (
  SELECT 1 FROM ad_verification av
  WHERE av.ad_id = a.id AND av.approved_at IS NOT NULL
);
```

**Check revenue vs payout:**
```sql
SELECT ard.ad_id, a.ref,
       SUM(ard.charge_buyer) as revenue,
       SUM(ard.pay_supplier) as payout,
       SUM(ard.charge_buyer - ard.pay_supplier) as margin
FROM ad_report_date ard
JOIN ads a ON ard.ad_id = a.id
WHERE a.campaign_id = ?
GROUP BY ard.ad_id, a.ref;
```

## Key Files

| File | Purpose |
|------|---------|
| ssap/app/Models/Campaign/AdGroup.php | Ad group model |
| ssap/app/Models/Campaign/Ad.php | Ad model (SSP fields) |
| ssap/app/Models/Campaign/AdReport.php | Aggregate metrics |
| ssap/app/Models/Campaign/AdReportDate.php | Daily metrics |
| ssap/app/Models/Vendor/KevelApiLog.php | Kevel sync logs |
| ssap/app/Api/Kevel/KevelApi.php | Kevel API base |
| ssap/app/Api/Kevel/KevelQueuedReportApi.php | Analytics reports |
| ssap/app/Http/Controllers/Ssp/SspController.php | SSP API endpoints |
| ssap/app/Repositories/Ssp/SspRepository.php | SSP business logic |
| ssap/app/Jobs/Ssp/ | SSP sync jobs |
| ssap/app/Jobs/Analytics/ | Analytics sync jobs |
