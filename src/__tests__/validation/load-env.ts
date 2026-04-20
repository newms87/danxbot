/**
 * Vitest setup file for validation tests.
 *
 * Loads the project's `.env` into `process.env` BEFORE any test file imports
 * run, so `ANTHROPIC_API_KEY` (and any other `.env`-declared vars) are visible
 * to `hasApiKey()` and to `describe.skipIf(!hasApiKey())` gates. Without this,
 * `make test-validate` would silently skip every API-gated scenario unless the
 * user manually `export`-ed the key into their shell.
 *
 * Node 20.12+ ships `process.loadEnvFile` natively; resolved absolutely from
 * this file's location so it works regardless of the test runner's cwd.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/__tests__/validation/load-env.ts → repo root = up four levels
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const envPath = resolve(repoRoot, ".env");

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
