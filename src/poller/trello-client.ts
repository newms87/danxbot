import { config, REVIEW_LIST_ID, TODO_LIST_ID, NEEDS_HELP_LIST_ID, DANXBOT_COMMENT_MARKER } from "./config.js";

export interface TrelloCard {
  id: string;
  name: string;
}

export interface TrelloComment {
  id: string;
  data: { text: string };
}

function authParams(): string {
  return `key=${config.trello.apiKey}&token=${config.trello.apiToken}`;
}

async function fetchCardsFromList(listId: string): Promise<TrelloCard[]> {
  const url = `https://api.trello.com/1/lists/${listId}/cards?${authParams()}&fields=id,name`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Trello API error: ${response.status} ${response.statusText}`);
  }

  const cards = (await response.json()) as Array<{ id: string; name: string }>;
  return cards.map((card) => ({ id: card.id, name: card.name }));
}

export async function fetchReviewCards(): Promise<TrelloCard[]> {
  return fetchCardsFromList(REVIEW_LIST_ID);
}

export async function fetchTodoCards(): Promise<TrelloCard[]> {
  return fetchCardsFromList(TODO_LIST_ID);
}

export async function fetchNeedsHelpCards(): Promise<TrelloCard[]> {
  return fetchCardsFromList(NEEDS_HELP_LIST_ID);
}

export async function fetchLatestComment(cardId: string): Promise<TrelloComment | null> {
  const url = `https://api.trello.com/1/cards/${cardId}/actions?${authParams()}&filter=commentCard&limit=1`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Trello API error: ${response.status} ${response.statusText}`);
  }

  const actions = (await response.json()) as TrelloComment[];
  return actions.length > 0 ? actions[0] : null;
}

export async function moveCardToList(cardId: string, listId: string, position: string = "top"): Promise<void> {
  const url = `https://api.trello.com/1/cards/${cardId}?${authParams()}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idList: listId, pos: position }),
  });

  if (!response.ok) {
    throw new Error(`Trello API error: ${response.status} ${response.statusText}`);
  }
}

export function isUserResponse(comment: TrelloComment | null): boolean {
  if (!comment) return false;
  return !comment.data.text.includes(DANXBOT_COMMENT_MARKER);
}
