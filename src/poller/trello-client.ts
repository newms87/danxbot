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
