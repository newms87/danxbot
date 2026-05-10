/**
 * Pure helper: derive an Issue's creation time without touching the DB or
 * config. Lives in its own file (rather than alongside `issues-reader.ts`)
 * so unit tests can import it without dragging in the `pg` connection
 * pool that the reader requires at module load.
 */

const OBJECT_ID_SHAPE = /^[a-f0-9]{24}$/i;

/**
 * Best-known creation time for an Issue, in epoch ms.
 *
 * Prefers a deterministic parse out of an ObjectId-shaped `external_id`
 * (Trello card ids today; any future tracker that uses ObjectIds picks
 * up the same path). Falls back to the mirror's first-seen mtime when
 * no usable id exists yet — the value stabilizes once the card is
 * mirrored outbound and the next read picks up the deterministic
 * id-derived value.
 */
export function deriveCreatedAt(
  externalId: string,
  mirrorUpdatedAtMs: number,
): number {
  if (OBJECT_ID_SHAPE.test(externalId)) {
    const seconds = Number.parseInt(externalId.slice(0, 8), 16);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  return mirrorUpdatedAtMs;
}
