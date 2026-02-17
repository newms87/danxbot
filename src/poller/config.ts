function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export interface PollerConfig {
  trello: { apiKey: string; apiToken: string };
  pollerIntervalMs: number;
}

export function createConfig(): PollerConfig {
  return {
    trello: {
      apiKey: required("TRELLO_API_KEY"),
      apiToken: required("TRELLO_API_TOKEN"),
    },
    pollerIntervalMs: parseInt(optional("POLLER_INTERVAL_MS", "60000"), 10),
  };
}

export const config = createConfig();

export { BOARD_ID, TODO_LIST_ID, NEEDS_HELP_LIST_ID, FLYTEBOT_COMMENT_MARKER } from "./constants.js";
