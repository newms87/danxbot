import { useAuth } from "../composables/useAuth";

export interface RepoInfo {
  name: string;
  url: string;
}

const AUTH_EXPIRED_EVENT = "auth:expired";

/**
 * Inject the current user's bearer on every dashboard API call. 401 →
 * `auth:expired` window event (App.vue listens → clears auth state →
 * Login). Auth model is binary; 403 has no path until role-based auth
 * lands.
 */
export async function fetchWithAuth(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const { token } = useAuth();
  const headers = new Headers(init.headers ?? {});
  if (token.value) headers.set("Authorization", `Bearer ${token.value}`);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
  }
  return res;
}

export interface ToggleError extends Error {
  status: number;
  serverMessage?: string;
}

export function toggleError(status: number, serverMessage?: string): ToggleError {
  const err = new Error(
    serverMessage || `patchToggle failed: ${status}`,
  ) as ToggleError;
  err.status = status;
  err.serverMessage = serverMessage;
  return err;
}

export async function readJsonError(res: Response): Promise<string | undefined> {
  try {
    const body = await res.json();
    if (body && typeof body.error === "string") return body.error;
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Lists routes return `{errors: string[]}` (one per invariant violation)
 * instead of the dashboard's common `{error: string}` shape — join them
 * so the operator sees every failed invariant at once.
 */
export async function readListsError(res: Response): Promise<string | undefined> {
  try {
    const body = await res.json();
    if (Array.isArray(body?.errors)) {
      const joined = body.errors
        .filter((s: unknown) => typeof s === "string")
        .join("; ");
      if (joined.length > 0) return joined;
    }
    if (typeof body?.error === "string") return body.error;
  } catch {
    /* ignore */
  }
  return undefined;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

function buildInit(method: Method, body: unknown): RequestInit {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return init;
}

async function parseOk<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Default JSON request — wraps non-2xx as `ToggleError` carrying `{error}`. */
export async function jsonRequest<T>(
  method: Method,
  url: string,
  body?: unknown,
): Promise<T> {
  const res = await fetchWithAuth(url, buildInit(method, body));
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return parseOk<T>(res);
}

/** Label-error JSON request — throws `new Error("<label> failed: <status>")`. */
export async function labelRequest<T>(
  label: string,
  method: Method,
  url: string,
  body?: unknown,
): Promise<T> {
  const res = await fetchWithAuth(url, buildInit(method, body));
  if (!res.ok) throw new Error(`${label} failed: ${res.status}`);
  return parseOk<T>(res);
}

/** Lists-routes JSON request — `ToggleError` carrying joined `{errors[]}`. */
export async function listsRequest<T>(
  method: Method,
  url: string,
  body?: unknown,
): Promise<T> {
  const res = await fetchWithAuth(url, buildInit(method, body));
  if (!res.ok) throw toggleError(res.status, await readListsError(res));
  return parseOk<T>(res);
}

export async function fetchRepos(): Promise<RepoInfo[]> {
  const res = await fetchWithAuth("/api/repos");
  return res.json();
}
