import { existsSync, readFileSync } from "node:fs";

/**
 * Parse a .env file into a key-value map.
 * Handles comments, blank lines, and quoted values.
 * Throws if the file does not exist.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    throw new Error(`Environment file not found: ${filePath}`);
  }
  const content = readFileSync(filePath, "utf-8");
  return parseEnvContent(content);
}

/**
 * Parse .env content string into a key-value map.
 */
export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
