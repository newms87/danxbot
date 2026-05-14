/**
 * Shared JSON-line logger for the SFC-deps stack. Every module emits
 * structured one-line JSON to stdout so the cron tick's redirect into
 * `/tmp/danxbot-cron.log` produces grep-friendly entries.
 */

export type JsonLogger = (line: object) => void;

export function jsonLineLogger(name: string): JsonLogger {
  return (line: object) => {
    process.stdout.write(`${JSON.stringify({ name, ...line })}\n`);
  };
}

/**
 * Resolve the canonical base dir from a deps override > env var >
 * default chain. Shared by the provisioner cron, the prune cron,
 * and the CLI.
 */
export function resolveBaseDir(
  env: NodeJS.ProcessEnv,
  override: string | undefined,
  fallback: string,
): string {
  return override ?? env.SFC_DEPS_BASE_DIR ?? fallback;
}
