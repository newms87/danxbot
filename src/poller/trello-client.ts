import { config, TODO_LIST_ID } from "./config.js";

export interface TrelloCard {
  id: string;
  name: string;
}

export async function fetchTodoCards(): Promise<TrelloCard[]> {
  const url = `https://api.trello.com/1/lists/${TODO_LIST_ID}/cards?key=${config.trello.apiKey}&token=${config.trello.apiToken}&fields=id,name`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Trello API error: ${response.status} ${response.statusText}`);
  }

  const cards = (await response.json()) as Array<{ id: string; name: string }>;
  return cards.map((card) => ({ id: card.id, name: card.name }));
}
