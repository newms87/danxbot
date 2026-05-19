import { ref, type Ref } from "vue";
import {
  createHydrationBuffer,
  useStream,
  type HydrationBuffer,
  type StreamEvent,
  type UseStreamReturn,
} from "./useStream";

/**
 * DX-689 — `createStreamCache` + `createKeyedStreamCache` collapse the
 * five near-identical SSE-backed composable skeletons
 * (`useDispatches`, `useSelfRepairErrors`, `useAgents`,
 * `useListColors`, `useTrelloListMapping`) onto one factory. Each
 * consumer becomes a thin wrapper that supplies `topic` / `fetchFn` /
 * `applyOne` (plus, for keyed callers, a `key` per `getOrCreate(key)`
 * call) and adds its own mutation methods alongside the returned
 * standard surface.
 *
 * Two modes:
 *
 *  - **`createStreamCache(config)`** — module-singleton. One state ref,
 *    one stream subscription, one hydration buffer; `init()` /
 *    `destroy()` are idempotent across N facade callers. The natural
 *    fit for app-wide caches (dispatches list, agents list, self-repair
 *    queue).
 *
 *  - **`createKeyedStreamCache(config)`** — returns a per-key factory
 *    `(key) => instance` backed by `Map<K, SharedInstance>` with
 *    refcount. The first `init()` for a key opens that key's stream +
 *    hydrates; subsequent facades for the same key reuse the instance
 *    and bump the refcount. The last `destroy()` per key tears the
 *    instance's stream down. Different keys are fully independent.
 *
 * `applyOne` receives the live `StreamEvent`; multi-topic buffers feed
 * every topic into the same reducer so the caller dispatches on
 * `event.topic`. In keyed mode `applyOne` also receives the per-instance
 * `key` so the consumer can ignore events whose payload references a
 * different key (per-repo filter pattern).
 */

export interface StreamCacheInstance<T> {
  state: Ref<T>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  /** Re-run the REST fetch; queued SSE events are re-applied on top. */
  hydrate: () => Promise<void>;
  /** Open the SSE subscription + fire the initial hydrate. Idempotent. */
  init: () => void;
  /** Tear down the SSE subscription. Idempotent. */
  destroy: () => void;
}

export interface CreateStreamCacheConfig<T> {
  topic: string | string[];
  /** Factory for the initial state — called once per cache. */
  initialState: () => T;
  fetchFn: () => Promise<T>;
  applyOne: (state: T, event: StreamEvent) => T;
}

/**
 * Module-singleton cache. Each `createStreamCache(...)` call produces
 * ONE instance — callers wrap it in their own `useX()` accessor that
 * returns this singleton.
 */
export function createStreamCache<T>(
  config: CreateStreamCacheConfig<T>,
): StreamCacheInstance<T> {
  const state = ref<T>(config.initialState()) as Ref<T>;
  const loading = ref(false);
  const error = ref<string | null>(null);

  let stream: UseStreamReturn | null = null;
  let buffer: HydrationBuffer<T> | null = null;

  async function hydrate(): Promise<void> {
    if (!buffer) return;
    loading.value = true;
    error.value = null;
    try {
      state.value = await buffer.hydrate(config.fetchFn, config.applyOne);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  function init(): void {
    if (stream) return;
    stream = useStream();
    buffer = createHydrationBuffer<T>(stream, config.topic);
    buffer.onLiveEvent((event) => {
      state.value = config.applyOne(state.value, event);
    });
    void hydrate();
  }

  function destroy(): void {
    buffer?.close();
    buffer = null;
    stream?.disconnect();
    stream = null;
  }

  return { state, loading, error, hydrate, init, destroy };
}

export interface CreateKeyedStreamCacheConfig<T, K extends string | number> {
  topic: string | string[];
  initialState: () => T;
  fetchFn: (key: K) => Promise<T>;
  /**
   * Pure reducer over `(state, event, key)`. The `key` is passed so
   * the consumer can short-circuit events whose payload references a
   * different key (per-repo filter pattern). Returns the new state
   * (or the same reference for a no-op).
   */
  applyOne: (state: T, event: StreamEvent, key: K) => T;
}

export interface KeyedStreamCacheFactory<T, K extends string | number> {
  (key: K): StreamCacheInstance<T>;
  /**
   * Test-only: drop every shared per-key instance + tear down their
   * streams. Tests call this in `beforeEach` so refcount / cached
   * state / streams do not leak across cases.
   */
  __resetForTesting: () => void;
}

interface SharedKeyedInstance<T> {
  state: Ref<T>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  hydrate: () => Promise<void>;
  applyOne: (state: T, event: StreamEvent) => T;
  topic: string | string[];
  refCount: number;
  stream: UseStreamReturn | null;
  buffer: HydrationBuffer<T> | null;
}

export function createKeyedStreamCache<T, K extends string | number>(
  config: CreateKeyedStreamCacheConfig<T, K>,
): KeyedStreamCacheFactory<T, K> {
  const sharedByKey = new Map<K, SharedKeyedInstance<T>>();

  function getOrCreateShared(key: K): SharedKeyedInstance<T> {
    const cached = sharedByKey.get(key);
    if (cached) return cached;

    const state = ref<T>(config.initialState()) as Ref<T>;
    const loading = ref(false);
    const error = ref<string | null>(null);
    const applyOne = (s: T, ev: StreamEvent): T =>
      config.applyOne(s, ev, key);

    const instance: SharedKeyedInstance<T> = {
      state,
      loading,
      error,
      applyOne,
      topic: config.topic,
      refCount: 0,
      stream: null,
      buffer: null,
      hydrate: async () => {
        if (!instance.buffer) return;
        loading.value = true;
        error.value = null;
        try {
          state.value = await instance.buffer.hydrate(
            () => config.fetchFn(key),
            applyOne,
          );
        } catch (err) {
          error.value = err instanceof Error ? err.message : String(err);
        } finally {
          loading.value = false;
        }
      },
    };

    sharedByKey.set(key, instance);
    return instance;
  }

  const factory = ((key: K): StreamCacheInstance<T> => {
    const shared = getOrCreateShared(key);
    // Per-facade attach flag so `destroy()` decrements exactly once
    // even on double-destroy calls.
    let attached = false;

    function init(): void {
      if (attached) return;
      attached = true;
      shared.refCount++;
      if (shared.refCount === 1) {
        shared.stream = useStream();
        shared.buffer = createHydrationBuffer<T>(shared.stream, shared.topic);
        shared.buffer.onLiveEvent((event) => {
          shared.state.value = shared.applyOne(shared.state.value, event);
        });
        void shared.hydrate();
      }
    }

    function destroy(): void {
      if (!attached) return;
      attached = false;
      shared.refCount--;
      if (shared.refCount <= 0) {
        shared.refCount = 0;
        shared.buffer?.close();
        shared.buffer = null;
        shared.stream?.disconnect();
        shared.stream = null;
      }
    }

    return {
      state: shared.state,
      loading: shared.loading,
      error: shared.error,
      hydrate: shared.hydrate,
      init,
      destroy,
    };
  }) as KeyedStreamCacheFactory<T, K>;

  factory.__resetForTesting = (): void => {
    for (const inst of sharedByKey.values()) {
      inst.buffer?.close();
      inst.stream?.disconnect();
    }
    sharedByKey.clear();
  };

  return factory;
}
