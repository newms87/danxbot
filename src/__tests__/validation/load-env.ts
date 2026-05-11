/**
 * Vitest setup file for validation tests.
 *
 * Loads the project's `.env` into `process.env` BEFORE any test file imports
 * run, so `ANTHROPIC_API_KEY` (and any other `.env`-declared vars) are visible
 * to `hasApiKey()` and to `describe.skipIf(!hasApiKey())` gates. Without this,
 * `make test-validate` would silently skip every API-gated scenario unless the
 * user manually `export`-ed the key into their shell.
 *
 * Resolved absolutely from this file's location: validation runs with
 * `root: "src"` in `vitest.validation.config.ts`, so a cwd-relative
 * resolve would land in the wrong directory. Uses the shared
 * `loadEnvFile` helper which works on Node 18 — pre-DX-244 this called
 * `process.loadEnvFile` (Node 20.12+) which threw on the host's
 * Node 18.x and silently broke the whole validation harness.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../helpers/load-env-file.js";

// src/__tests__/validation/load-env.ts → repo root = up four levels
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
loadEnvFile(resolve(repoRoot, ".env"));
