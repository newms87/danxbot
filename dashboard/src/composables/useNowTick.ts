import { onBeforeUnmount, onMounted, ref } from "vue";
import type { Ref } from "vue";

/**
 * `useNowTick` — single-source-of-truth for "I render an elapsed-time
 * label and want it to refresh while the component is mounted".
 *
 * Returns a reactive `now` ref that updates every `intervalMs` (default
 * 60s — matches the resolution of `relativeTime` / `relativeOld`, where
 * sub-minute changes are folded into "just now" / "new"). Cleared on
 * unmount. Multiple components mounting independently each get their
 * own timer, which is fine: the cost is a single `setInterval` per
 * elapsed-label-bearing component, dwarfed by the render cost itself.
 *
 * Default 60_000 chosen deliberately:
 *   - Matches the bucket resolution. Ticking faster gains nothing
 *     visible until we cross a minute boundary.
 *   - Avoids the per-second timer-storm anti-pattern that older
 *     dashboards fall into when they want "live" counters.
 *
 * NOT a polling fallback for SSE — see `.claude/rules/dashboard.md`. This
 * composable does NO server work. It only re-evaluates `Date.now()` so
 * computed labels recompute. If you find yourself reaching for this to
 * reload server data, you want SSE instead.
 */
export function useNowTick(intervalMs: number = 60_000): Ref<number> {
  const now = ref<number>(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;

  onMounted(() => {
    timer = setInterval(() => {
      now.value = Date.now();
    }, intervalMs);
  });

  onBeforeUnmount(() => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });

  return now;
}
