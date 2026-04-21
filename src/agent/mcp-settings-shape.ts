/**
 * Shape of Claude Code's MCP settings file — shared between the producer
 * (`buildMcpSettings` in launcher.ts) and the consumer (`probeAllMcpServers`
 * in mcp-server-probe.ts). Declaring it once prevents silent drift: if the
 * producer adds a field the probe doesn't expect (or vice versa), the
 * compiler catches it at build time instead of the probe failing at runtime.
 */

export interface McpServerConfig {
  command: string;
  args: string[];
  /**
   * Environment variables passed to the MCP server subprocess. Empty object
   * means "inherit nothing beyond the parent process env." Required field
   * rather than optional so callers can't accidentally omit it and rely on
   * an implicit default — the probe and the launcher must agree on exactly
   * what the spawned server sees.
   */
  env: Record<string, string>;
}

export interface McpSettingsFile {
  mcpServers: Record<string, McpServerConfig>;
}
