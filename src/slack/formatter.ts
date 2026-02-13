const SLACK_MAX_LENGTH = 4000;

/**
 * Converts Claude's markdown output to Slack mrkdwn format.
 * Ported from FlytebotSlackApi::markdownToSlackMrkdwn() in the platform codebase.
 */
export function markdownToSlackMrkdwn(markdown: string): string {
  let text = markdown;

  // Convert italics first to avoid overlapping syntax (single * → _)
  text = text.replace(/([^*])\*(.*?)\*/g, "$1_$2_");

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
    if (splitAt === -1 || splitAt < SLACK_MAX_LENGTH / 2) {
      // No good newline break — split at the limit
      splitAt = SLACK_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt + 1);
  }

  return chunks;
}
