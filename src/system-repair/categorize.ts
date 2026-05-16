import { createHash } from "crypto";
import type { Pool } from "pg";
import {
  REPAIR_CAP,
  type SystemErrorRow,
  type SystemErrorSamplePayload,
  type SystemErrorStatus,
} from "./types.js";
import { publishRepairErrorUpdated } from "./publish.js";

const VALID_STATUSES: ReadonlySet<SystemErrorStatus> = new Set([
  "open",
  "repairing",
  "fixed",
  "unfixable",
]);

/**
 * Pure error categorization + persistent deduped storage. `recordError`
 * is invoked from every callsite that surfaces a system error
 * (`reportSystemError`, `recordSystemError`); the dashboard reads via
 * `db-reads.ts`. Card-dispatcher (DX-560) was retired.
 *
 * Design rules:
 *
 * - `normalizeMessage` is deterministic + idempotent. Same raw message
 *   from different envs (different absolute paths, different timestamps,
 *   different UUIDs, different ports) MUST produce the same string so
 *   the signature hashes collide and the upsert dedupes.
 * - `signatureHash` is SHA-256 truncated to 16 hex chars. Truncation is
 *   safe at our scale (well under 2^64 entries — birthday-collision
 *   probability is negligible). The hash key is `component\0errClass\0
 *   normalizedMsg`; the `\0` separator prevents component/errClass
 *   string concatenation aliasing (`"a:b"` + `"c"` vs `"a"` + `":b:c"`).
 * - `recordError` uses Postgres's `INSERT ... ON CONFLICT DO UPDATE`
 *   keyed on `signature_hash` for atomic upsert — concurrent writers
 *   from different processes / workers do not race.
 */

// Absolute-path matcher — requires the basename to carry an extension
// (a `.` followed by word chars). Without that constraint, URL paths
// (`/api/foo`) would also collapse to their last segment; with it,
// `/home/foo/bar.ts` strips to `bar.ts` while `http://localhost:5555/
// api/foo` leaves `/api/foo` intact. Extensionless OS paths (`/etc/
// passwd`) are rare in error messages — accepted lossage.
const PATH_BASENAME_RE =
  /(?:\/(?:[\w.-]+\/)*([\w.-]*\.[\w-]+))(?::\d+(?::\d+)?)?/g;
const RELATIVE_FILE_LINE_RE = /\b([\w-]+\.[a-zA-Z]\w{0,5}):\d+(?::\d+)?\b/g;
const UUID_RE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const TIMESTAMP_RE =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const PORT_RE = /(?<=[a-zA-Z0-9_]):(\d{2,5})\b/g;
const LINE_PHRASE_RE = /\bline \d+\b/gi;

/**
 * Canonicalize a raw error message so the same underlying error, fired
 * from different envs, produces the same string. Strips, in order:
 *
 *   1. ISO 8601 timestamps         → <TS>
 *   2. UUIDs                       → <UUID>
 *   3. Absolute paths (+:line:col) → basename only
 *   4. Relative file:line:col      → filename only
 *   5. Bare ISO dates              → <DATE>
 *   6. host:port (not URL scheme)  → host:<PORT>
 *   7. `line N` phrasing           → `line <N>`
 *
 * Idempotent: `normalizeMessage(normalizeMessage(x)) === normalizeMessage(x)`.
 *
 * Order matters: timestamps are matched before bare dates so an ISO
 * datetime is consumed wholly (not as "date + leftover"). Paths are
 * matched before the relative `file:line:col` form so a path's trailing
 * `:42:13` is captured along with the path (and discarded with it).
 * Port matching uses a positive lookbehind on an alphanumeric so URL
 * schemes (`http:`) survive (the colon there is preceded by nothing or
 * a space — no alphanumeric just before).
 */
export function normalizeMessage(raw: string): string {
  let s = raw;
  s = s.replace(TIMESTAMP_RE, "<TS>");
  s = s.replace(UUID_RE, "<UUID>");
  s = s.replace(PATH_BASENAME_RE, "$1");
  s = s.replace(RELATIVE_FILE_LINE_RE, "$1");
  s = s.replace(DATE_RE, "<DATE>");
  s = s.replace(PORT_RE, ":<PORT>");
  s = s.replace(LINE_PHRASE_RE, "line <N>");
  return s;
}

export interface SignatureHashInput {
  component: string;
  errClass: string;
  normalizedMsg: string;
}

/**
 * 16-char lowercase hex SHA-256 of `component\0errClass\0normalizedMsg`.
 * The NUL separator prevents string-concat aliasing across the three
 * fields. Truncation to 16 hex chars (64 bits) gives <1 collision per
 * ~4 billion distinct signatures — well clear of the table's expected
 * cardinality (tens of thousands lifetime).
 */
export function signatureHash(input: SignatureHashInput): string {
  const { component, errClass, normalizedMsg } = input;
  return createHash("sha256")
    .update(`${component}\0${errClass}\0${normalizedMsg}`)
    .digest("hex")
    .slice(0, 16);
}

export interface RecordErrorInput {
  db: Pool;
  repo: string;
  component: string;
  err: Error;
  samplePayload: SystemErrorSamplePayload;
}

/**
 * Upsert a system_errors row keyed on signature_hash. First occurrence:
 * INSERT with count=1, first_seen=last_seen=now, recurrence_count=0.
 * Subsequent occurrences: count++, last_seen=now, sample_payload=
 * excluded (latest sample wins for context freshness).
 *
 * Status transitions on conflict:
 *  - When existing `status='fixed'` — a previously-fixed signature is
 *    firing again. Flip back to `open` AND bump `recurrence_count`. If
 *    the bumped count >= 3, flip to `unfixable` instead.
 *  - When existing status is `open` / `repairing` / `unfixable` —
 *    leave status + recurrence_count alone.
 *
 * NOTE: the card-creating dispatcher (DX-560) was retired; no code
 * writes `'repairing'` or `'fixed'` today. The 'fixed'-flip branch
 * lies dormant until the DX-580 worker-fault rebuild lands. The
 * remaining live transition is `open → unfixable` via the operator's
 * `markUnfixable` route in `db-reads.ts`.
 */
export async function recordError(
  input: RecordErrorInput,
): Promise<SystemErrorRow> {
  const { db, repo, component, err, samplePayload } = input;
  const errClass = err.name || "Error";
  const normalizedMsg = normalizeMessage(err.message);
  const sigHash = signatureHash({ component, errClass, normalizedMsg });
  const categoryKey = `${component}:${errClass}`;

  const { rows } = await db.query<SystemErrorRowFromDb>(
    `
    INSERT INTO system_errors (
      signature_hash, category_key, component, err_class,
      normalized_msg, sample_payload, count, first_seen, last_seen,
      status, repo
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, NOW(), NOW(), 'open', $7)
    ON CONFLICT (signature_hash) DO UPDATE SET
      count            = system_errors.count + 1,
      last_seen        = NOW(),
      sample_payload   = EXCLUDED.sample_payload,
      repo             = EXCLUDED.repo,
      recurrence_count = CASE
        WHEN system_errors.status = 'fixed'
          THEN system_errors.recurrence_count + 1
        ELSE system_errors.recurrence_count
      END,
      status = CASE
        WHEN system_errors.status = 'fixed'
             AND system_errors.recurrence_count + 1 >= $8
          THEN 'unfixable'
        WHEN system_errors.status = 'fixed'
          THEN 'open'
        ELSE system_errors.status
      END
    RETURNING
      id, signature_hash, category_key, component, err_class,
      normalized_msg, sample_payload, count, first_seen, last_seen,
      status, repo, recurrence_count
    `,
    [
      sigHash,
      categoryKey,
      component,
      errClass,
      normalizedMsg,
      JSON.stringify(samplePayload),
      repo,
      REPAIR_CAP,
    ],
  );
  const row = rowToSystemError(rows[0]);
  // DX-565: fan out to the Self-Repair tab. Fire-and-forget; the
  // publisher never throws, and the underlying upsert has already
  // committed by the time we get here.
  void publishRepairErrorUpdated({ db, errorId: row.id });
  return row;
}

type SystemErrorRowFromDb = Omit<SystemErrorRow, "status"> & {
  status: string;
};

function rowToSystemError(r: SystemErrorRowFromDb): SystemErrorRow {
  if (!VALID_STATUSES.has(r.status as SystemErrorStatus)) {
    // Fail loud — a value outside the enum means schema drift between
    // this code and the DB (someone added a status without updating
    // the type). Throwing here surfaces the mismatch immediately
    // instead of letting a typed consumer downstream consume garbage.
    throw new Error(
      `system_errors row id=${r.id} carries unknown status="${r.status}"`,
    );
  }
  return { ...r, status: r.status as SystemErrorStatus };
}
