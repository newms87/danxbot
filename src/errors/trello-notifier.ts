import type { TrelloConfig } from "../types.js";
import { createLogger } from "../logger.js";
import { DANXBOT_COMMENT_MARKER } from "../poller/constants.js";

const log = createLogger("trello-notifier");

const MAX_CARD_NAME_LENGTH = 100;

function buildCardName(errorType: string, errorMessage: string): string {
  const prefix = `[Danxbot > Error] ${errorType}: `;
  const maxMessageLength = MAX_CARD_NAME_LENGTH - prefix.length;

  if (errorMessage.length > maxMessageLength) {
    return prefix + errorMessage.slice(0, maxMessageLength - 3) + "...";
  }

  return prefix + errorMessage;
}

function buildCardDescription(
  errorType: string,
  errorMessage: string,
  context: Record<string, string>,
): string {
  const lines: string[] = [
    `## ${errorType}`,
    "",
    `**Error:** ${errorMessage}`,
    "",
  ];

  const contextEntries = Object.entries(context);
  if (contextEntries.length > 0) {
    lines.push("**Context:**");
    for (const [key, value] of contextEntries) {
      lines.push(`- ${key}: ${value}`);
    }
    lines.push("");
  }

  lines.push(`**Timestamp:** ${new Date().toISOString()}`);

  return lines.join("\n");
}

export interface NotifyErrorOptions {
  listId?: string;
  labelId?: string;
}

export async function notifyError(
  trello: TrelloConfig,
  errorType: string,
  errorMessage: string,
  context: Record<string, string>,
  options?: NotifyErrorOptions,
): Promise<void> {
  try {
    const { apiKey, apiToken, todoListId, bugLabelId } = trello;

    if (!apiKey || !apiToken) {
      log.debug("Trello creds not configured, skipping error notification");
      return;
    }

    const targetListId = options?.listId || todoListId;
    const targetLabelId = options?.labelId || bugLabelId;
    const cardName = buildCardName(errorType, errorMessage);

    // Fetch existing cards in target list to check for duplicates
    const listUrl = `https://api.trello.com/1/lists/${targetListId}/cards?key=${apiKey}&token=${apiToken}&fields=id,name`;
    const listResponse = await fetch(listUrl);

    if (!listResponse.ok) {
      log.error(`Failed to fetch list cards: ${listResponse.status} ${listResponse.statusText}`);
      return;
    }

    const existingCards = (await listResponse.json()) as Array<{ id: string; name: string }>;
    const isDuplicate = existingCards.some((card) => card.name === cardName);

    if (isDuplicate) {
      log.info(`Duplicate error card already exists: ${cardName}`);
      return;
    }

    // Create the card
    const desc = buildCardDescription(errorType, errorMessage, context);
    const params = new URLSearchParams({
      key: apiKey,
      token: apiToken,
      idList: targetListId,
      name: cardName,
      desc,
      pos: "top",
      idLabels: targetLabelId,
    });

    const createUrl = `https://api.trello.com/1/cards?${params.toString()}`;
    const createResponse = await fetch(createUrl, { method: "POST" });

    if (!createResponse.ok) {
      log.error(`Failed to create Trello card: ${createResponse.status} ${createResponse.statusText}`);
      return;
    }

    const createdCard = (await createResponse.json()) as { id: string };
    log.info(`Created error card: ${cardName}`);

    // Add a danxbot marker comment so the poller can distinguish bot vs user comments
    const commentParams = new URLSearchParams({
      key: apiKey,
      token: apiToken,
      text: `This card was automatically created by Danxbot.\n\n${DANXBOT_COMMENT_MARKER}`,
    });
    const commentUrl = `https://api.trello.com/1/cards/${createdCard.id}/actions/comments?${commentParams.toString()}`;
    const commentResponse = await fetch(commentUrl, { method: "POST" });
    if (!commentResponse.ok) {
      log.warn(`Failed to add marker comment: ${commentResponse.status} ${commentResponse.statusText}`);
    }
  } catch (error) {
    log.error(
      "Failed to send error notification to Trello",
      error,
    );
  }
}
