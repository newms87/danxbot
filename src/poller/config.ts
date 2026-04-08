import { required, optional } from "../env.js";

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

export {
  BOARD_ID,
  REVIEW_LIST_ID,
  TODO_LIST_ID,
  IN_PROGRESS_LIST_ID,
  NEEDS_HELP_LIST_ID,
  DONE_LIST_ID,
  CANCELLED_LIST_ID,
  ACTION_ITEMS_LIST_ID,
  BUG_LABEL_ID,
  FEATURE_LABEL_ID,
  EPIC_LABEL_ID,
  NEEDS_HELP_LABEL_ID,
  REVIEW_MIN_CARDS,
  DANXBOT_COMMENT_MARKER,
} from "./constants.js";
