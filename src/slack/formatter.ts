const SLACK_MAX_LENGTH = 4000;

const SEPARATOR_ROW_PATTERN = /^\|[\s:_-]+(\|[\s:_-]+)*\|?\s*$/;

/**
 * Parses a markdown table row into trimmed cell values.
 */
function parseRow(line: string): string[] {
  // Strip leading/trailing pipe, split by pipe, trim each cell
  const stripped = line.replace(/^\|/, "").replace(/\|$/, "");
  return stripped.split("|").map((cell) => cell.trim());
}

/**
 * Converts markdown tables to Slack-friendly monospace blocks.
 * Must run BEFORE bold/italic conversion to preserve formatting markers.
 */
function convertTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;

  // Track whether we're inside a code block to avoid converting pipes in code
  let inCodeBlock = false;

  while (i < lines.length) {
    const line = lines[i];

    // Track code block boundaries
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      i++;
      continue;
    }

    // Skip table detection inside code blocks
    if (inCodeBlock) {
      result.push(line);
      i++;
      continue;
    }

    // Detect start of a table: a line starting with | followed by a separator row
    if (
      line.trimStart().startsWith("|") &&
      i + 1 < lines.length &&
      SEPARATOR_ROW_PATTERN.test(lines[i + 1])
    ) {
      // Collect all consecutive pipe-starting lines (the table block)
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }

      // Filter out separator rows
      const dataLines = tableLines.filter(
        (l) => !SEPARATOR_ROW_PATTERN.test(l),
      );

      // Parse all rows into cells
      const rows = dataLines.map(parseRow);

      // Calculate max width per column
      const colCount = Math.max(...rows.map((r) => r.length));
      const colWidths: number[] = Array(colCount).fill(0);
      for (const row of rows) {
        for (let c = 0; c < colCount; c++) {
          const cellLen = (row[c] || "").length;
          if (cellLen > colWidths[c]) {
            colWidths[c] = cellLen;
          }
        }
      }

      // Build padded, aligned rows
      const formattedRows = rows.map((row) => {
        const cells = [];
        for (let c = 0; c < colCount; c++) {
          const cell = row[c] || "";
          cells.push(cell.padEnd(colWidths[c]));
        }
        return cells.join("  ");
      });

      result.push("```");
      result.push(...formattedRows);
      result.push("```");
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join("\n");
}

/**
 * Converts Claude's markdown output to Slack mrkdwn format.
 * Ported from FlytebotSlackApi::markdownToSlackMrkdwn() in the platform codebase.
 */
export function markdownToSlackMrkdwn(markdown: string): string {
  let text = markdown;

  // Convert tables BEFORE other conversions so bold/italic in cells aren't mangled
  text = convertTables(text);

  // Convert italics first to avoid overlapping syntax (single * → _)
  text = text.replace(/(^|[^*])\*(.*?)\*/gm, "$1_$2_");

  // Convert headers (all levels → bold)
  text = text.replace(/^#{1,6}\s+(.*)/gm, "*$1*");

  // Convert bold (**text** or __text__ → *text*)
  text = text.replace(/\*\*(.*?)\*\*/g, "*$1*");
  text = text.replace(/__(.*?)__/g, "*$1*");

  // Convert links [text](url) → <url|text>
  text = text.replace(/\[(.*?)\]\((.*?)\)/g, "<$2|$1>");

  // Convert unordered lists (- item → • item)
  text = text.replace(/^\s*-\s+(.*)/gm, "• $1");

  // Blockquotes are the same in both formats (> text)

  return text;
}

/**
 * Splits a message into chunks that fit within Slack's 4000 char limit.
 * Splits at newline boundaries to avoid breaking mid-sentence.
 */
export function splitMessage(text: string): string[] {
  if (text.length <= SLACK_MAX_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Find the last newline within the limit
    let splitAt = remaining.lastIndexOf("\n", SLACK_MAX_LENGTH);
    const isNewlineSplit = splitAt !== -1 && splitAt >= SLACK_MAX_LENGTH / 2;
    if (!isNewlineSplit) {
      // No good newline break — split at the limit
      splitAt = SLACK_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    // Skip the newline delimiter for newline splits; no skip for hard splits
    remaining = remaining.slice(splitAt + (isNewlineSplit ? 1 : 0));
  }

  return chunks;
}
