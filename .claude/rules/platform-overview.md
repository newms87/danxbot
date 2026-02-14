# Platform Overview (Dev Team Reference)

This is a high-level overview of the Flytedesk platform for agents building Flytebot. For the running Flytebot Chat agent's knowledge, see `src/agent/system-prompt.md` and `docs/domains/`.

## Tech Stack

- **Backend**: Laravel 10+ (PHP 8.2), MySQL 8, Redis
- **Frontend**: Vue 3, TypeScript, Quasar UI framework, Tailwind CSS, Inertia.js
- **Infrastructure**: Docker (Laravel Sail), Nginx, Queue workers

## Repository Structure

The platform is a monorepo:
- `ssap/` — Laravel backend (API, business logic, migrations, models)
- `mva/src/` — Vue 3 frontend (pages, components, composables)
- `digital/playground/` — Separate Vue app for ad/creative management

## Key Model Relationships

- Buyer → has many Campaigns → has many Flights → has many LineItems
- Supplier → has many Publications → has many AdZones
- Campaign → has many CampaignTargets (schools/demographics)
- Flight → belongs to Campaign, has many LineItems
- Ad/Creative → belongs to Buyer, has approval workflow

## Database Conventions

- Table names: plural snake_case (`campaigns`, `line_items`, `ad_sizes`)
- Primary keys: `id` (auto-increment)
- Foreign keys: `{model}_id` pattern (`campaign_id`, `buyer_id`)
- Timestamps: `created_at`, `updated_at`, `deleted_at` (soft deletes)
- Status fields: string enums stored as varchar

## Common Patterns

- **FilterBuilder**: Custom query macro for building filtered/sorted queries from request params
- **Inertia.js**: Controllers return `Inertia::render()` instead of JSON for page views
- **Spatie Permissions**: Role-based access control via `spatie/laravel-permission`
- **Broadcasting**: Real-time updates via Laravel Echo + Pusher/WebSockets
- **Jobs**: Background processing via Laravel queues (Redis driver)
