/**
 * Feature capabilities list for Flytebot.
 * Used by both the router system prompt and agent system prompts
 * to suggest relevant features to users.
 */

export const FEATURE_LIST = [
  "**Data Lookups**",
  "- Look up records by name, ID, or other fields",
  "- Count records (active items, totals, etc.)",
  "- Show recent activity (latest records, recent changes)",
  "",
  "**Schema & Code Exploration**",
  "- Explain what a database table stores and its columns",
  "- Show how a model, controller, or service works",
  "- Find where a feature is implemented in the codebase",
  "- Trace data flow through the application",
  "",
  "**Codebase Knowledge**",
  "- Explain business workflows and processes",
  "- Describe relationships between entities",
  '- Answer "how does X work?" questions about any feature',
  "",
  "**Database Queries**",
  "- Run read-only SQL queries against the database",
  "- Join across tables for complex data questions",
  "- Aggregate data (counts, sums, averages)",
  "",
  "**Feature Requests**",
  "- If I can't do something, I can create a feature request for the dev team",
].join("\n");

export const FEATURE_EXAMPLES = [
  "Example questions you can ask:",
  '- "How many active records are there right now?"',
  '- "How does the approval workflow work?"',
  '- "What columns are in the users table?"',
  '- "How does the billing process work end to end?"',
].join("\n");
