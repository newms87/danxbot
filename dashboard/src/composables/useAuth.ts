import { ref } from "vue";
import type { Ref } from "vue";

/**
 * Human-user auth state for the dashboard SPA.
 *
 * - `token` is backed by `sessionStorage['danxbot.authToken']`: survives a
 *   page reload, cleared on browser close, isolated per incognito window.
 *   This is deliberate — `loginDashboardUser` rotates tokens on every login
 *   (single-session-per-user, see `src/dashboard/auth-db.ts::issueFreshToken`),
 *   so persisting in `localStorage` across browser restarts would reliably
 *   yield 401s on the next open and cause operator confusion.
 *
 * - `currentUser` mirrors whoever the backend says this token belongs to.
 *   `null` until `init()` or `login()` fills it; cleared on `logout()` or a
 *   401 from `/api/auth/me`.
 *
 * - `init()` is called from `App.vue::onMounted`. If a token exists in
 *   storage, it calls `/api/auth/me` to confirm it's still valid. A 401
 *   there means the token was rotated (login from another session) or
 *   revoked; we wipe local state and let `App.vue` render Login.
 *
 * - `fetchWithAuth` in `api.ts` dispatches a `window 'auth:expired'` event
 *   on any 401; `App.vue` listens and calls `logout()` to reset state.
 *
 * The composable returns a singleton: the state refs are module-scoped so
 * the login page and header see the same `currentUser` without prop
 * threading or provide/inject.
 */

const TOKEN_STORAGE_KEY = "danxbot.authToken";

export interface CurrentUser {
  username: string;
}

function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredToken(value: string): void {
  try {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
  } catch {
    /* ignore — SSR / sandboxed */
  }
}

function clearStoredToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

const token = ref<string | null>(readStoredToken());
const currentUser = ref<CurrentUser | null>(null);
/**
 * Surfaced to Login.vue so an operator hitting a backend outage during
 * the initial `/api/auth/me` check sees "dashboard unreachable" rather
 * than a bare Login form that misleads them into typing credentials.
 */
const initError = ref<string | null>(null);

/**
 * Monotonic generation counter used to discard stale `init()` responses
 * when `login()`, `logout()`, or `handleExpired()` intervene while the
 * `/api/auth/me` fetch is inflight. Without this, an in-flight init can
 * overwrite a fresh login (or resurrect a just-logged-out session).
 *
 * HMR hazard: when Vite re-evaluates this module, consumers holding the
 * old refs (via `const { currentUser } = useAuth()`) will see stale
 * state. A full page reload clears it.
 */
let authGeneration = 0;

function setToken(next: string | null): void {
  token.value = next;
  if (next) writeStoredToken(next);
  else clearStoredToken();
}

function clearLocal(): void {
  authGeneration += 1;
  setToken(null);
  currentUser.value = null;
  initError.value = null;
}

async function init(): Promise<void> {
  // Re-read storage so tests + multi-tab scenarios see the latest token
  // without relying on module-load timing.
  token.value = readStoredToken();
  initError.value = null;
  const t = token.value;
  if (!t) {
    currentUser.value = null;
    return;
  }
  const generation = ++authGeneration;
  try {
    const res = await fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${t}` },
    });
    // Drop the response if `login`, `logout`, or `handleExpired` ran
    // while this fetch was inflight — their state is more recent.
    if (generation !== authGeneration) return;
    if (res.status === 200) {
      const body = (await res.json()) as { user: CurrentUser };
      currentUser.value = body.user ?? null;
      return;
    }
    if (res.status === 401) {
      clearLocal();
      return;
    }
    // Transient server errors (5xx) leave the token intact so a reload
    // can retry rather than forcing re-login. Surface the condition so
    // Login.vue can show "dashboard unreachable" instead of a bare form.
    initError.value = "Dashboard unreachable — try reloading.";
  } catch {
    if (generation !== authGeneration) return;
    initError.value = "Dashboard unreachable — try reloading.";
  }
}

export class LoginError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "LoginError";
  }
}

async function login(username: string, password: string): Promise<void> {
  authGeneration += 1;
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status === 200) {
    const body = (await res.json()) as { token: string; user: CurrentUser };
    setToken(body.token);
    currentUser.value = body.user;
    return;
  }
  if (res.status === 401) {
    throw new LoginError("Invalid username or password", 401);
  }
  if (res.status === 400) {
    throw new LoginError("Username and password are required", 400);
  }
  throw new LoginError(`Login failed (${res.status})`, res.status);
}

async function logout(): Promise<void> {
  const t = token.value;
  if (t) {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${t}` },
      });
    } catch {
      // Server unreachable: still clear local state so the user returns
      // to Login. Any lingering server-side token rots via the next
      // rotate-on-login or Phase 3 admin tooling.
    }
  }
  clearLocal();
}

export interface UseAuth {
  token: Ref<string | null>;
  currentUser: Ref<CurrentUser | null>;
  initError: Ref<string | null>;
  init: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Clear local state without hitting `/api/auth/logout`. Called by the
   * `auth:expired` listener in `App.vue` — the backend has already
   * invalidated the token so a logout round-trip would just 401.
   */
  handleExpired: () => void;
}

export function useAuth(): UseAuth {
  return {
    token,
    currentUser,
    initError,
    init,
    login,
    logout,
    handleExpired: clearLocal,
  };
}
