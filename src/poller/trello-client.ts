import type { TrelloConfig } from "../types.js";
import { DANXBOT_COMMENT_MARKER } from "./constants.js";

export interface TrelloCard {
  id: string;
  name: string;
}

export interface TrelloComment {
  id: string;
  data: { text: string };
}

function authParams(trello: TrelloConfig): string {
  return `key=${trello.apiKey}&token=${trello.apiToken}`;
}

async function fetchCardsFromList(trello: TrelloConfig, listId: string): Promise<TrelloCard[]> {
  const url = `https://api.trello.com/1/lists/${listId}/cards?${authParams(trello)}&fields=id,name`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Trello API error: ${response.status} ${response.statusText}`);
  }

  const cards = (await response.json()) as Array<{ id: string; name: string }>;
  return cards.map((card) => ({ id: card.id, name: card.name }));
}

export async function fetchReviewCards(trello: TrelloConfig): Promise<TrelloCard[]> {
  return fetchCardsFromList(trello, trello.reviewListId);
}

export async function fetchTodoCards(trello: TrelloConfig): Promise<TrelloCard[]> {
  return fetchCardsFromList(trello, trello.todoListId);
}

export async function fetchNeedsHelpCards(trello: TrelloConfig): Promise<TrelloCard[]> {
  return fetchCardsFromList(trello, trello.needsHelpListId);
}

export async function fetchLatestComment(trello: TrelloConfig, cardId: string): Promise<TrelloComment | null> {
  const url = `https://api.trello.com/1/cards/${cardId}/actions?${authParams(trello)}&filter=commentCard&limit=1`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Trello API error: ${response.status} ${response.statusText}`);
  }

  const actions = (await response.json()) as TrelloComment[];
  return actions.length > 0 ? actions[0] : null;
}

export async function moveCardToList(trello: TrelloConfig, cardId: string, listId: string, position: string = "top"): Promise<void> {
  const url = `https://api.trello.com/1/cards/${cardId}?${authParams(trello)}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idList: listId, pos: position }),
  });

  if (!response.ok) {
    throw new Error(`Trello API error: ${response.status} ${response.statusText}`);
  }
}

export async function fetchInProgressCards(trello: TrelloConfig): Promise<TrelloCard[]> {
  return fetchCardsFromList(trello, trello.inProgressListId);
}

/**
 * Card detail including its current `idList`. Used by the post-dispatch
 * "did the card actually move?" check — see the halt-flag contract in
 * `.claude/rules/agent-dispatch.md`.
 */
export interface TrelloCardDetail {
  id: string;
  name: string;
  idList: string;
}

/**
 * Fetch a single card by id, returning its current list. Lets the
 * poller detect dispatches where the agent never moved the card out of
 * ToDo — the signature of an env-level blocker.
 */
export async function fetchCard(
  trello: TrelloConfig,
  cardId: string,
): Promise<TrelloCardDetail> {
  const url = `https://api.trello.com/1/cards/${cardId}?${authParams(trello)}&fields=id,name,idList`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Trello API error: ${response.status} ${response.statusText}`,
    );
  }
  const card = (await response.json()) as Partial<TrelloCardDetail>;

  // Fail loud on a malformed response shape. The caller is the
  // post-dispatch halt check — if `idList` is missing/empty, the
  // comparison `card.idList !== todoListId` would silently evaluate
  // truthy and SUPPRESS the halt flag. Throwing here pushes the failure
  // into the caller's try/catch, which logs and skips the check —
  // preferable to falsely deciding "card moved" from garbage.
  if (typeof card.id !== "string" || !card.id) {
    throw new Error(`Trello API returned card without id (cardId=${cardId})`);
  }
  if (typeof card.name !== "string") {
    throw new Error(`Trello API returned card without name (cardId=${cardId})`);
  }
  if (typeof card.idList !== "string" || !card.idList) {
    throw new Error(
      `Trello API returned card without idList (cardId=${cardId}) — cannot determine current list`,
    );
  }
  return { id: card.id, name: card.name, idList: card.idList };
}

export async function addComment(trello: TrelloConfig, cardId: string, text: string): Promise<void> {
  const url = `https://api.trello.com/1/cards/${cardId}/actions/comments?${authParams(trello)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(`Trello API error: ${response.status} ${response.statusText}`);
  }
}

export function isUserResponse(comment: TrelloComment | null): boolean {
  if (!comment) return false;
  return !comment.data.text.includes(DANXBOT_COMMENT_MARKER);
}
