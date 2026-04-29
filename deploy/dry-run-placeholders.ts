/**
 * Centralized placeholder strings emitted in dry-run output.
 *
 * Consistency rule: every placeholder uses the `<NAME>` shape. Angle brackets
 * are non-token characters so an operator skimming the dry-run log can
 * visually distinguish them from real-shaped values like a 64-hex SSM token
 * or a github PAT. The substring is also obvious in grep — `grep "DRY_RUN"`
 * finds every placeholder regardless of which module emitted it.
 *
 * Defense-in-depth note: callers that emit a placeholder into a string passed
 * to `bootstrap-repos.ts:buildCloneOrPullCommand` (or any other validator
 * that accepts a regex-narrow shape) MUST round-trip through that validator
 * during testing — the regex `/^[A-Za-z0-9_-]+$/` rejects `<` and `>`, so
 * bare `<DRY_RUN_GITHUB_TOKEN>` would throw. The exception is
 * `DRY_RUN_GITHUB_TOKEN`, which intentionally OMITS angle brackets so it
 * passes the GitHub-token regex; the placeholder is still recognizable
 * because it uses the `DRY_RUN_` prefix and uppercase-snake form, neither of
 * which a real PAT (`ghp_...` lowercase) ever exhibits.
 */

export const DRY_RUN_INSTANCE_ID = "<INSTANCE_ID>";
export const DRY_RUN_INSTANCE_IP = "<INSTANCE_IP>";
export const DRY_RUN_DOMAIN = "<DOMAIN>";
export const DRY_RUN_ECR_REPOSITORY_URL = "<ECR_REPOSITORY_URL>";
export const DRY_RUN_SSH_COMMAND = "<SSH_COMMAND>";
export const DRY_RUN_SECURITY_GROUP_ID = "<SECURITY_GROUP_ID>";
export const DRY_RUN_DATA_VOLUME_ID = "<DATA_VOLUME_ID>";
export const DRY_RUN_IAM_ROLE_ARN = "<IAM_ROLE_ARN>";

/** Dispatch-token placeholder — angle brackets safe (used inside `--value '<...>'` argv). */
export const DRY_RUN_DISPATCH_TOKEN = "<DRY_RUN_DISPATCH_TOKEN>";

/**
 * Short SHA placeholder used for the docker `--build-arg DANXBOT_COMMIT=<sha>`.
 * Skips angle brackets — a real short SHA is `[a-f0-9]{7}` and the
 * `DRY_RUN_SHA` substring is obvious without them.
 */
export const DRY_RUN_SHA = "DRY_RUN_SHA";

/**
 * GitHub PAT placeholder used inside the clone URL
 * `https://x-access-token:<TOKEN>@github.com/...`. Must satisfy the
 * `bootstrap-repos.ts:buildCloneOrPullCommand` regex `/^[A-Za-z0-9_-]+$/`,
 * which forbids `<` and `>`. The `DRY_RUN_` prefix + uppercase-snake form
 * keeps it visually distinct from a real `ghp_...` token.
 */
export const DRY_RUN_GITHUB_TOKEN = "DRY_RUN_GITHUB_TOKEN";
