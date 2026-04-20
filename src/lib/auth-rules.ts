/**
 * Single source of truth for dashboard-user credential rules.
 *
 * Both the worker CLI (src/cli/create-user.ts, runs inside the dashboard
 * container) and the deploy CLI helper (deploy/create-user.ts, runs on the
 * operator's host before SSHing into EC2) validate against these constants.
 * Two layers of defense — same rules, no drift.
 */

export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const USERNAME_MIN_LEN = 3;
export const USERNAME_MAX_LEN = 64;
export const PASSWORD_MIN_LEN = 12;

export function validateUsername(name: string): void {
  if (name.length < USERNAME_MIN_LEN || name.length > USERNAME_MAX_LEN) {
    throw new Error(
      `Username must be ${USERNAME_MIN_LEN}-${USERNAME_MAX_LEN} characters (got ${name.length})`,
    );
  }
  if (!USERNAME_PATTERN.test(name)) {
    throw new Error(
      "Username may only contain letters, numbers, underscore, and hyphen",
    );
  }
}

export function validatePassword(password: string): void {
  if (password.length < PASSWORD_MIN_LEN) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LEN} characters`);
  }
}
