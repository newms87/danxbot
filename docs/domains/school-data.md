# School Data Domain

The School Data domain provides LLM-powered batch processing of school/institution data. Users submit a Google Sheets URL with rows of schools, specify which data fields to populate, and a bot swarm processes rows in parallel using AI models.

## Model Hierarchy

```
SchoolDataRequest (school_data_requests)
  └── SchoolDataTask (school_data_tasks) — one per spreadsheet row
        └── SchoolDataActivity (school_data_activities) — LLM calls, progress tracking
```

Separately, campus/institution reference data lives under the Supplier domain:

```
Campus (campuses)
  └── CampusData (campus_data) — enrollment, demographics, calendar
  └── CampusDataCode (campus_data_codes) — lookup tables for types, majors, ethnicity
```

---

## SchoolDataRequest

**Model:** `ssap/app/Models/SchoolDataRequest.php`
**Table:** `school_data_requests`

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | bigint | Primary key |
| uuid | string | External identifier for API access |
| user_id | int FK | User who created the request |
| name | string | Human-readable request name |
| google_sheets_url | string | Source Google Sheets URL |
| sheet_name | string | Target sheet within the workbook |
| row_id_column | string | Column containing row identifiers |
| row_name_column | string | Column containing school names |
| instructions | text | User instructions for field resolution |
| processing_mode | string | `research` or `direct_answer` |
| allow_empty_values | boolean | Accept empty field values |
| resolved_fields | json | Array of resolved field configurations |
| preview_data | json | Cached preview of first few rows |
| status | string | Lifecycle status |
| bot_count | int | Parallel bots to dispatch (default 3) |
| task_timeout_seconds | int | Per-task timeout (default 300) |
| total_rows | int | Total spreadsheet rows |
| processed_rows | int | Rows completed |
| successful_rows | int | Rows with successful status |
| failed_rows | int | Rows with failed status |
| total_llm_cost_usd | decimal | Cumulative LLM cost |
| total_tokens | int | Cumulative token usage |

### Status Lifecycle

| Status | Meaning |
|--------|---------|
| pending | Initial state |
| field_resolution | LLM analyzing columns and instructions |
| clarification_needed | LLM needs user clarification on fields |
| confirmed | User confirmed resolved fields |
| processing | Bot swarm actively processing rows |
| completed | All rows processed |
| failed | Fatal error during processing |

### Relationships

- `user` — belongsTo User
- `tasks` — hasMany SchoolDataTask
- `rowTasks` — hasMany SchoolDataTask (filtered to row tasks only)
- `activities` — hasMany SchoolDataActivity

### Key Methods

- `getProgressPercentageAttribute()` — (processed_rows / total_rows) * 100
- `getSuccessRateAttribute()` — (successful_rows / processed_rows) * 100
- `getAvailableTask()` — Next task not started or timed out
- `recomputeRowCounts()` — Recalculate progress with lock protection
- `updateCachedTotals()` — Aggregate cost/token totals from activities

### Events

- `SchoolDataRequestUpdated` — Broadcast on status/progress changes to `school-data-request.{uuid}` channel

---

## SchoolDataTask

**Model:** `ssap/app/Models/SchoolDataTask.php`
**Table:** `school_data_tasks`

One task per spreadsheet row (or batch operation).

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | bigint | Primary key |
| uuid | string | Unique identifier |
| school_data_request_id | bigint FK | Parent request |
| title | string | Task title |
| description | text | Task details |
| row_number | int | Spreadsheet row number |
| status | string | Task status |
| metadata | json | Task-specific data |
| attempts | int | Retry attempt count |
| started_at | timestamp | Processing start time |
| completed_at | timestamp | Processing end time |

### Status Constants

`pending`, `in_progress`, `completed`, `failed`, `needs_clarification`, `incomplete`

### Key Methods

- `claim()` — Lock and claim task for bot processing (with timeout/retry checks)
- `start()` — Set status to in_progress
- `complete()` — Set status and completed_at
- `computeStatusFromActivities()` — Recalculate status from child activities
- `clearIncompleteOrFailedActivities()` — Remove failed activities for retry

---

## SchoolDataActivity

**Model:** `ssap/app/Models/SchoolDataActivity.php`
**Table:** `school_data_activities`

Records individual operations within a task (LLM calls, progress updates).

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | bigint | Primary key |
| school_data_request_id | bigint FK | Parent request |
| school_data_task_id | bigint FK | Parent task (nullable) |
| type | string | Activity type (e.g., `llm_communication`) |
| title | string | Activity title |
| description | text | Activity details |
| metadata | json | Prompts, responses, progress data |
| llm_cost_usd | decimal | LLM cost for this activity |
| input_tokens | int | Input token count |
| output_tokens | int | Output token count |
| llm_model | string | Model used |
| status | string | Activity status |
| row_number | int | Associated row number |

---

## Campus Reference Data

Campus models represent educational institutions. These are part of the Supplier domain but relevant to school data queries.

### Campus

**Model:** `ssap/app/Models/Supplier/Campus/Campus.php`
**Table:** `campuses`

Linked to suppliers via many-to-many (`supplier_campus` pivot). Supports soft deletes.

### CampusData

**Model:** `ssap/app/Models/Supplier/Campus/CampusData.php`
**Table:** `campus_data`

Institutional data including enrollment, academic calendar, and demographics.

Key fields: `enrollment`, `fall_break_start`, `fall_break_end`, `fall_finals_start`, `spring_semester_start`, plus many more academic calendar fields.

### CampusDataCode

**Model:** `ssap/app/Models/Supplier/Campus/CampusDataCode.php`
**Table:** `campus_data_codes`

Lookup tables for coded values:

| Category | Examples |
|----------|----------|
| SCHOOL_TYPE | Public 4-year, Private 4-year, Public 2-year |
| CONFERENCE | Athletic conference membership |
| INSTITUTION_SIZE | Highly Residential, Primarily Nonresidential |
| POPULATION_SIZE | Population density classification |
| POPULAR_MAJORS | PCIP_ prefixed major codes |
| GRAD_PROGRAMS | GRAD_ prefixed program codes |
| RELIGION | Religious affiliation codes |

**Ethnicity fields:** `ethnic_black`, `ethnic_white`, `ethnic_asian`, `ethnic_hispanic`, `ethnic_native_american`, `ethnic_native_hawaiian`, `ethnic_multiple`

---

## Processing Flow

1. **Request Creation** — User provides Google Sheets URL, sheet name, instructions, processing mode
2. **Field Resolution** — LLM analyzes columns and instructions to determine target fields. May require clarification.
3. **User Confirmation** — User confirms or refines resolved fields
4. **Bot Swarm Processing** — `ProcessSchoolDataBatchJob` loads spreadsheet, creates row tasks, dispatches `SchoolDataBotJob` workers (configurable count, default 3)
5. **Row Processing** — Each bot claims tasks via distributed locks, processes rows with LLM, creates activity records
6. **Completion** — Request marked complete when all tasks done. Failed tasks can be retried individually or in bulk.

### Concurrency

Uses `LockHelper` for race condition protection:
- `school-data-bot-dispatch:{requestId}` — Bot dispatch locking
- `school-data-finalize:{requestId}` — Request finalization
- `school-data-progress:{requestId}` — Progress recomputation

---

## Key Services

| Service | Purpose |
|---------|---------|
| `SchoolDataRequestService` | Request lifecycle (create, resolve fields, start processing) |
| `SchoolDataTaskService` | Task distribution, retry, finalization |
| `SchoolDataBatchService` | Batch initialization (load sheet, create tasks) |
| `SchoolDataProcessingService` | LLM-driven field resolution and data processing |
| `SchoolRowProcessingService` | Individual row processing during bot execution |
| `FieldDataCollectionService` | Field data collection using LLM |
| `SchoolDataActivityLogger` | Activity tracking within tasks |
| `SchoolDataPreviewService` | Preview data from Google Sheets |

---

## API Endpoints

**Prefix:** `/admin/v4/school-data`

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/` | Show processing page |
| GET | `/previous` | User's previous requests |
| GET | `/{requestUuid}` | Show specific request |
| GET | `/api/request/{requestUuid}` | Get request data (JSON) |
| GET | `/api/tasks/{requestUuid}` | Paginated tasks with filtering |
| GET | `/api/tasks/{taskId}/activities` | Activities for a task |
| POST | `/api/resolve-fields` | Analyze sheet and resolve fields |
| POST | `/api/refine-fields` | Re-resolve with clarification |
| POST | `/api/preview` | Preview spreadsheet data |
| POST | `/api/start-processing` | Begin bot swarm processing |
| POST | `/api/retry-task/{taskId}` | Retry single failed task |
| POST | `/api/retry-all-tasks/{requestId}` | Retry all failed tasks |

---

## Configuration

**File:** `config/school-data.php`

| Key | Default | Purpose |
|-----|---------|---------|
| models.field_resolution | gpt-5-mini | LLM for field resolution |
| models.data_collection | gpt-5-mini | LLM for data collection |
| models.boost_collection | gpt-5 | Upgraded model for retries |
| max_task_retries | 3 | Max retry attempts per task |
| default_bot_count | 3 | Default parallel bot count |
| default_task_timeout_seconds | 300 | Default per-task timeout |

---

## Common Query Patterns

```sql
-- Active processing requests
SELECT * FROM school_data_requests
WHERE status = 'processing' AND user_id = ?;

-- Tasks for a request with status
SELECT id, row_number, status, attempts, started_at, completed_at
FROM school_data_tasks
WHERE school_data_request_id = ? ORDER BY row_number;

-- Failed tasks for retry
SELECT * FROM school_data_tasks
WHERE school_data_request_id = ? AND status IN ('failed', 'incomplete');

-- LLM cost breakdown by request
SELECT SUM(llm_cost_usd) as total_cost, SUM(input_tokens + output_tokens) as total_tokens
FROM school_data_activities
WHERE school_data_request_id = ?;

-- Campus enrollment data
SELECT c.id, c.name, cd.enrollment
FROM campuses c
JOIN campus_data cd ON cd.campus_id = c.id
WHERE cd.enrollment > 0;
```
