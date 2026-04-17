import { readFile } from "fs/promises";
import { join } from "path";
import type { RepoContext } from "../types.js";
import { FEATURE_LIST } from "./features.js";
import { createLogger } from "../logger.js";

const log = createLogger("system-prompt");

let systemPromptTemplate: string | null = null;
let fastSystemPromptTemplate: string | null = null;
const descriptionCache = new Map<string, string>();

/**
 * Extract the repo description from its overview.md — the first non-blank,
 * non-heading line. Empty string when the file has no paragraph content.
 */
export function extractDescription(overviewMd: string): string {
  for (const rawLine of overviewMd.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    return line;
  }
  return "";
}

interface PromptVars {
  repoName: string;
  repoDescription: string;
  reviewListId: string;
  featureList: string;
}

export function renderSystemPrompt(template: string, vars: PromptVars): string {
  return template
    .replace(/\{\{REPO_NAME\}\}/g, vars.repoName)
    .replace(/\{\{REPO_DESCRIPTION\}\}/g, vars.repoDescription)
    .replace(/\{\{REVIEW_LIST_ID\}\}/g, vars.reviewListId)
    .replace(/\{\{FEATURE_LIST\}\}/g, vars.featureList);
}

async function loadDescription(repoContext: RepoContext): Promise<string> {
  const cached = descriptionCache.get(repoContext.localPath);
  if (cached !== undefined) return cached;
  const overviewPath = join(
    repoContext.localPath,
    ".danxbot",
    "config",
    "overview.md",
  );
  let description = "";
  try {
    const raw = await readFile(overviewPath, "utf-8");
    description = extractDescription(raw);
  } catch (err) {
    log.warn(
      `Could not read overview.md for ${repoContext.name} at ${overviewPath} — using fallback description`,
      err,
    );
  }
  if (!description) {
    description = `the ${repoContext.name} codebase`;
  }
  descriptionCache.set(repoContext.localPath, description);
  return description;
}

export async function loadSystemPrompt(repoContext: RepoContext): Promise<string> {
  if (!systemPromptTemplate) {
    systemPromptTemplate = await readFile(
      new URL("./system-prompt.md", import.meta.url),
      "utf-8",
    );
  }
  const repoDescription = await loadDescription(repoContext);
  return renderSystemPrompt(systemPromptTemplate, {
    repoName: repoContext.name,
    repoDescription,
    reviewListId: repoContext.trello.reviewListId,
    featureList: FEATURE_LIST,
  });
}

export async function loadFastSystemPrompt(repoContext: RepoContext): Promise<string> {
  if (!fastSystemPromptTemplate) {
    fastSystemPromptTemplate = await readFile(
      new URL("./fast-system-prompt.md", import.meta.url),
      "utf-8",
    );
  }
  const repoDescription = await loadDescription(repoContext);
  return renderSystemPrompt(fastSystemPromptTemplate, {
    repoName: repoContext.name,
    repoDescription,
    reviewListId: repoContext.trello.reviewListId,
    featureList: FEATURE_LIST,
  });
}
