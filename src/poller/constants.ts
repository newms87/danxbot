function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const BOARD_ID = required("TRELLO_BOARD_ID");
export const REVIEW_LIST_ID = required("TRELLO_REVIEW_LIST_ID");
export const TODO_LIST_ID = required("TRELLO_TODO_LIST_ID");
export const IN_PROGRESS_LIST_ID = required("TRELLO_IN_PROGRESS_LIST_ID");
export const NEEDS_HELP_LIST_ID = required("TRELLO_NEEDS_HELP_LIST_ID");
export const DONE_LIST_ID = required("TRELLO_DONE_LIST_ID");
export const CANCELLED_LIST_ID = required("TRELLO_CANCELLED_LIST_ID");
export const ACTION_ITEMS_LIST_ID = required("TRELLO_ACTION_ITEMS_LIST_ID");

export const BUG_LABEL_ID = required("TRELLO_BUG_LABEL_ID");
export const FEATURE_LABEL_ID = required("TRELLO_FEATURE_LABEL_ID");
export const EPIC_LABEL_ID = required("TRELLO_EPIC_LABEL_ID");
export const NEEDS_HELP_LABEL_ID = required("TRELLO_NEEDS_HELP_LABEL_ID");

export const REVIEW_MIN_CARDS = parseInt(process.env.TRELLO_REVIEW_MIN_CARDS || "10", 10);

/** Marker appended to all Danxbot-posted Trello comments. The poller uses this to distinguish bot comments from user responses. */
export const DANXBOT_COMMENT_MARKER = "<!-- danxbot -->";
