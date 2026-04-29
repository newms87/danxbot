/**
 * Health check verification for the deployed danxbot instance.
 * Polls the HTTPS endpoint until it responds or times out.
 */

import { isDryRun } from "./exec.js";

export interface HealthResult {
  healthy: boolean;
  statusCode: number | null;
  error: string | null;
  attempts: number;
}

/**
 * Poll the health endpoint until it responds 200 or we hit maxAttempts.
 * Waits intervalMs between attempts.
 *
 * In dry-run, prints the URL that would be polled and returns a synthetic
 * healthy result. Without this short-circuit, a dry-run deploy would actually
 * fetch `https://<DOMAIN>/health` (the placeholder string from
 * DRY_RUN_TERRAFORM_OUTPUTS), wait through `maxAttempts * intervalMs` of DNS
 * failures, then mark the deploy as unhealthy — wasting two minutes on
 * something dry-run is meant to avoid.
 */
export async function waitForHealthy(
  url: string,
  maxAttempts: number = 30,
  intervalMs: number = 5000,
): Promise<HealthResult> {
  console.log(`\n── Health check: ${url} ──`);

  if (isDryRun()) {
    console.log(`  [dry-run] would poll ${url}/health`);
    return { healthy: true, statusCode: 200, error: null, attempts: 0 };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${url}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        console.log(
          `  ✓ Healthy (attempt ${attempt}/${maxAttempts}, status ${response.status})`,
        );
        return {
          healthy: true,
          statusCode: response.status,
          error: null,
          attempts: attempt,
        };
      }

      console.log(
        `  Attempt ${attempt}/${maxAttempts}: status ${response.status}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  Attempt ${attempt}/${maxAttempts}: ${message}`);
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return {
    healthy: false,
    statusCode: null,
    error: `Health check failed after ${maxAttempts} attempts`,
    attempts: maxAttempts,
  };
}
