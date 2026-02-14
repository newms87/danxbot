/**
 * Feature capabilities list for Flytebot.
 * Used by both the router system prompt and agent system prompts
 * to suggest relevant features to users.
 */

export const FEATURE_LIST = [
  "**Data Lookups**",
  "- Look up campaigns, buyers, suppliers, users, or orders by name, ID, or email",
  "- Count records (active campaigns, total suppliers, etc.)",
  "- Show recent activity (latest campaigns, recent orders)",
  "",
  "**Schema & Code Exploration**",
  "- Explain what a database table stores and its columns",
  "- Show how a model, controller, or service works",
  "- Find where a feature is implemented in the codebase",
  "- Trace data flow through the application",
  "",
  "**Platform Knowledge**",
  "- Explain business workflows (campaign lifecycle, ad approval, billing)",
  "- Describe relationships between entities (buyers, campaigns, orders, suppliers)",
  '- Answer "how does X work?" questions about any platform feature',
  "",
  "**Database Queries**",
  "- Run read-only SQL queries against the production database",
  "- Join across tables for complex data questions",
  "- Aggregate data (counts, sums, averages)",
].join("\n");

export const FEATURE_EXAMPLES = [
  "Example questions you can ask:",
  '- "How many active campaigns are there right now?"',
  '- "Show me the supplier record for University of Colorado"',
  '- "How does the campaign approval workflow work?"',
  '- "What columns are in the orders table?"',
  '- "Who are the top 10 buyers by campaign count?"',
  '- "How does the billing process work end to end?"',
].join("\n");
