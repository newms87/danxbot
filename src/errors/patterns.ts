/**
 * Error patterns that indicate operational/infrastructure issues
 * (billing, auth, credits) rather than transient failures.
 * These errors should not be retried and require human intervention.
 */
export const OPERATIONAL_ERROR_PATTERNS = [
  /credit balance is too low/i,
  /billing/i,
  /authentication/i,
  /unauthorized/i,
];

/**
 * Returns true if the error message matches a known operational pattern
 * (billing, auth, credits) that cannot be resolved by retrying.
 */
export function isOperationalError(message: string): boolean {
  return OPERATIONAL_ERROR_PATTERNS.some((p) => p.test(message));
}
