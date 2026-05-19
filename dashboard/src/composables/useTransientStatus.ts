import { onBeforeUnmount, readonly, ref, type Ref } from "vue";

/**
 * `useTransientStatus` — short-lived status that auto-resets to an idle
 * value after `idleMs`. Used for "Copied → idle" / "Failed → idle" UI
 * feedback that flashes for a couple seconds then disappears.
 *
 * Default `set(value)` schedules the auto-reset. `set(value, { autoReset:
 * false })` holds the value indefinitely until the next `set()` or
 * `clear()` (useful for intermediate states like "copying" that should
 * persist until a terminal value replaces them).
 *
 * Auto-cancels its timer on unmount.
 */

export interface UseTransientStatusOptions<S extends string> {
  idleMs: number;
  idleValue?: S;
}

export interface TransientStatus<S extends string> {
  status: Readonly<Ref<S>>;
  set: (value: S, options?: { autoReset?: boolean }) => void;
  clear: () => void;
  pending: Readonly<Ref<boolean>>;
}

export function useTransientStatus<S extends string = "idle">(
  options: UseTransientStatusOptions<S>,
): TransientStatus<S> {
  const idleValue = (options.idleValue ?? ("idle" as S)) as S;
  const status = ref(idleValue) as Ref<S>;
  const pending = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending.value = false;
  }

  function clear(): void {
    clearTimer();
    status.value = idleValue;
  }

  function set(value: S, opts: { autoReset?: boolean } = {}): void {
    const autoReset = opts.autoReset !== false;
    clearTimer();
    status.value = value;
    if (autoReset && value !== idleValue) {
      pending.value = true;
      timer = setTimeout(() => {
        timer = null;
        pending.value = false;
        status.value = idleValue;
      }, options.idleMs);
    }
  }

  onBeforeUnmount(clearTimer);

  return {
    status: readonly(status) as Readonly<Ref<S>>,
    set,
    clear,
    pending: readonly(pending),
  };
}
