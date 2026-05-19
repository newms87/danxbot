import { onBeforeUnmount, readonly, ref, type Ref } from "vue";

/**
 * `useDebouncedFn` — collapse rapid calls to `fn` into a single deferred
 * invocation `ms` after the last `trigger()`. `cancel()` drops any pending
 * call without invoking it; `pending` reflects whether a fire is scheduled.
 *
 * Auto-cancels on unmount.
 *
 * Two shapes:
 *
 *   useDebouncedFn(fn, ms)
 *     fn(...args) — `trigger(...args)` passes args through verbatim.
 *
 *   useDebouncedFn(fn, ms, { abortPrevious: true })
 *     fn(signal, ...args) — a fresh AbortController is created per fire;
 *     the previous one is aborted when a new trigger fires OR when
 *     cancel() runs. Used for fetch-debouncing where the in-flight
 *     request should be cancelled the moment a newer one supersedes it.
 */

export interface DebouncedFn<A extends unknown[]> {
  trigger: (...args: A) => void;
  cancel: () => void;
  pending: Readonly<Ref<boolean>>;
}

export function useDebouncedFn<A extends unknown[]>(
  fn: (...args: A) => unknown,
  ms: number,
): DebouncedFn<A>;
export function useDebouncedFn<A extends unknown[]>(
  fn: (signal: AbortSignal, ...args: A) => unknown,
  ms: number,
  options: { abortPrevious: true },
): DebouncedFn<A>;
export function useDebouncedFn(
  fn: (...args: never[]) => unknown,
  ms: number,
  options: { abortPrevious?: boolean } = {},
): DebouncedFn<unknown[]> {
  const fnUntyped = fn as (...args: unknown[]) => unknown;
  const abortPrevious = options.abortPrevious === true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeController: AbortController | null = null;
  let nextArgs: unknown[] = [];
  const pending = ref(false);

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function cancel(): void {
    clearTimer();
    if (abortPrevious && activeController !== null) {
      activeController.abort();
      activeController = null;
    }
    pending.value = false;
  }

  function trigger(...args: unknown[]): void {
    clearTimer();
    nextArgs = args;
    pending.value = true;
    timer = setTimeout(() => {
      timer = null;
      pending.value = false;
      if (abortPrevious) {
        if (activeController !== null) activeController.abort();
        const controller = new AbortController();
        activeController = controller;
        fnUntyped(controller.signal, ...nextArgs);
      } else {
        fnUntyped(...nextArgs);
      }
    }, ms);
  }

  onBeforeUnmount(cancel);

  return { trigger, cancel, pending: readonly(pending) };
}
