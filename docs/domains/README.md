# Domain Reference Docs

This directory contains detailed reference documentation for each major domain in the Flytedesk platform. These docs serve the **running Flytebot Chat agent** — when a user asks about a specific domain, the agent reads the relevant doc to get detailed context before answering.

## How It Works

1. The system prompt (`src/agent/system-prompt.md`) tells the agent which doc to read for each domain
2. The agent uses the `Read` tool to load the doc when a user asks about that domain
3. The doc provides models, relationships, key tables, common queries, and business logic details

## Directory Structure

Each file covers one domain:
- `billing.md` — Invoicing, payments, billing profiles
- `campaigns.md` — Campaigns, flights, line items, targeting
- `school-data.md` — School data imports and processing
- etc.

## For the Ideator

The Ideator agent populates these docs by exploring the platform codebase and database. When creating a new domain doc, include:

- **Models**: Key Eloquent models with their table names and important columns
- **Relationships**: How models connect (belongsTo, hasMany, morphMany, etc.)
- **Key Tables**: Database schema highlights
- **Business Logic**: Important services, jobs, and workflows
- **Common Queries**: SQL examples for frequently asked questions
- **API Endpoints**: Relevant routes and controllers

## File Location

These files are volume-mounted into the Docker container at `/flytebot/app/docs/domains/`. The agent reads them using absolute paths like `/flytebot/app/docs/domains/billing.md`.
