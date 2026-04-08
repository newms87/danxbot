/**
 * Parse a simple YAML file into a flat key-value structure with dot-notation keys.
 * Handles scalar values and one level of nesting (e.g., config.yml, trello.yml).
 * Values are trimmed. Comments and empty lines are skipped.
 */
export function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  let currentSection = "";

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^(\w[\w_]*):\s*$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }

    const kvMatch = line.match(/^(\s*)(\w[\w_]*):\s*"?([^"]*)"?\s*$/);
    if (kvMatch) {
      const [, indent, key, value] = kvMatch;
      const prefix = indent && indent.length > 0 ? `${currentSection}.` : "";
      if (!indent || indent.length === 0) currentSection = "";
      result[`${prefix}${key}`] = value.trim();
    }
  }

  return result;
}
