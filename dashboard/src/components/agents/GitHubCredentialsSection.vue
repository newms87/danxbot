<script setup lang="ts">
import { computed, ref } from "vue";
import { DanxButton } from "@thehammer/danx-ui";
import type { AgentSnapshot } from "../../types";
import type { GithubCredentialsSnapshot } from "../../api";
import GitHubCredentialsModal from "./GitHubCredentialsModal.vue";

// DX-649 — GitHub credentials section on the Settings page. Reads the
// per-repo `githubCredentials` snapshot from the agent SSE feed (Phase 2
// aggregation surfaces it on every `/api/agents` snapshot push); the
// component is reactive on that prop so SSE updates re-render the badge
// without any local polling. The Register/Rotate modal owns the PATCH;
// on success the parent refresh re-hydrates the snapshot so the badge
// + last-validated label update from the canonical source.

const props = defineProps<{
  agent: AgentSnapshot;
}>();

const emit = defineEmits<{
  refresh: [repo: string];
}>();

const modalOpen = ref<boolean>(false);
const instructionsExpanded = ref<boolean>(false);

const snapshot = computed<GithubCredentialsSnapshot>(
  () => props.agent.githubCredentials,
);

type BadgeKind = "ok" | "warn" | "missing";

interface Badge {
  kind: BadgeKind;
  glyph: string;
  label: string;
  reason: string | null;
}

const badge = computed<Badge>(() => {
  const s = snapshot.value;
  if (!s.registered) {
    return {
      kind: "missing",
      glyph: "✕",
      label: "Not registered",
      reason: null,
    };
  }
  if (!s.token_shape_valid) {
    return {
      kind: "warn",
      glyph: "!",
      label: "Registered (invalid shape)",
      reason: s.last_validation_error,
    };
  }
  if (s.last_validation_error) {
    return {
      kind: "warn",
      glyph: "!",
      label: "Registered (validation failed)",
      reason: s.last_validation_error,
    };
  }
  if (s.last_validated_at === null) {
    return {
      kind: "warn",
      glyph: "·",
      label: "Registered (not yet validated)",
      reason: null,
    };
  }
  return {
    kind: "ok",
    glyph: "✓",
    label: "Registered + Validated",
    reason: null,
  };
});

const badgeClasses = computed<string>(() => {
  switch (badge.value.kind) {
    case "ok":
      return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200";
    case "warn":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
    case "missing":
      return "bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200";
  }
});

const buttonLabel = computed<string>(() =>
  snapshot.value.registered ? "Rotate token" : "Register token",
);

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.max(0, Math.round((now - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

const lastValidatedRelative = computed<string | null>(() => {
  const at = snapshot.value.last_validated_at;
  return at === null ? null : formatRelative(at);
});

// DX-661 — masked token + expiry + authenticated-as lines.
//
// `maskedToken` only renders when the operator has actually registered
// SOMETHING (prefix is non-empty); the modal's empty-input state stays
// quiet rather than rendering a stray ellipsis.
const maskedToken = computed<string | null>(() => {
  const s = snapshot.value;
  if (s.token_prefix.length === 0) return null;
  return s.token_suffix.length > 0
    ? `${s.token_prefix}…${s.token_suffix}`
    : s.token_prefix;
});

const EXPIRY_WARN_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface ExpiryLine {
  text: string;
  warn: boolean;
}

function formatYmd(date: Date): string {
  // UTC slicing keeps the displayed date deterministic regardless of
  // the operator's host TZ — the snapshot ships an ISO string and the
  // expiry concept is calendar-day-level, not minute-level.
  return date.toISOString().slice(0, 10);
}

const expiryLine = computed<ExpiryLine | null>(() => {
  const iso = snapshot.value.token_expires_at;
  if (iso === null) return null;
  const expiresAt = new Date(iso);
  if (Number.isNaN(expiresAt.getTime())) return null;
  const ymd = formatYmd(expiresAt);
  // Day-level diff so an expiry at 23:59:00 UTC reads as "in Nd" not
  // "in N-1d" on the same-day-but-earlier render.
  const diffDays = Math.round(
    (expiresAt.getTime() - Date.now()) / MS_PER_DAY,
  );
  if (diffDays < 0) {
    const ago = Math.abs(diffDays);
    return { text: `Expired ${ago}d ago (${ymd})`, warn: true };
  }
  return {
    text: `Expires in ${diffDays}d (${ymd})`,
    warn: diffDays <= EXPIRY_WARN_DAYS,
  };
});

const userLogin = computed<string | null>(
  () => snapshot.value.token_user_login,
);

function openModal(): void {
  modalOpen.value = true;
}

function toggleInstructions(): void {
  instructionsExpanded.value = !instructionsExpanded.value;
}

function onSaved(_next: GithubCredentialsSnapshot): void {
  // Tell the parent to re-hydrate the agents list so the SSE-driven
  // snapshot prop refreshes through the canonical channel. The PATCH
  // response IS the same shape, but routing through the parent keeps
  // the single-source-of-truth invariant (no local mutation).
  emit("refresh", props.agent.name);
}
</script>

<template>
  <article
    class="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm"
    data-test="github-credentials-section"
  >
    <header class="mb-3 flex items-center justify-between">
      <h3 class="text-base font-bold text-gray-900 dark:text-white">
        GitHub
      </h3>
      <span
        class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
        :class="badgeClasses"
        :data-test="`github-credentials-badge-${badge.kind}`"
      >
        <span aria-hidden="true">{{ badge.glyph }}</span>
        <span>{{ badge.label }}</span>
      </span>
    </header>

    <div class="space-y-3 text-sm">
      <p
        v-if="badge.reason"
        class="rounded bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
        data-test="github-credentials-reason"
      >
        {{ badge.reason }}
      </p>

      <p
        v-if="maskedToken"
        class="text-xs text-gray-700 dark:text-gray-200 font-mono"
        data-test="github-credentials-masked-token"
      >
        {{ maskedToken }}
      </p>

      <p
        v-if="userLogin"
        class="text-xs italic text-gray-500 dark:text-gray-400"
        data-test="github-credentials-user-login"
      >
        Authenticated as @{{ userLogin }}
      </p>

      <p
        v-if="expiryLine"
        :class="[
          'text-xs',
          expiryLine.warn
            ? 'text-amber-700 dark:text-amber-300 font-medium'
            : 'text-gray-500 dark:text-gray-400',
        ]"
        :data-test="
          expiryLine.warn
            ? 'github-credentials-expiry-warn'
            : 'github-credentials-expiry'
        "
      >
        {{ expiryLine.text }}
      </p>

      <p
        v-if="lastValidatedRelative"
        class="text-xs text-gray-500 dark:text-gray-400"
        data-test="github-credentials-last-validated"
      >
        Last validated {{ lastValidatedRelative }}.
      </p>

      <div class="flex items-center gap-3">
        <DanxButton
          type="primary"
          data-test="github-credentials-register-button"
          @click="openModal"
        >
          {{ buttonLabel }}
        </DanxButton>
        <DanxButton
          variant="muted"
          size="xs"
          class="github-credentials-instructions-toggle-btn"
          data-test="github-credentials-instructions-toggle"
          @click="toggleInstructions"
        >
          {{ instructionsExpanded ? "Hide" : "How do I create a GitHub token?" }}
        </DanxButton>
      </div>

      <div
        v-if="instructionsExpanded"
        class="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3"
        data-test="github-credentials-instructions"
      >
        <ol
          class="list-decimal list-inside space-y-1 text-xs text-gray-700 dark:text-gray-300"
        >
          <li>
            Visit
            <a
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-600 dark:text-blue-400 hover:underline"
              data-test="github-credentials-instructions-link"
            >GitHub fine-grained PAT creation</a>.
          </li>
          <li>
            Token name: <code>danxbot-{{ agent.name }}-&lt;host&gt;</code>.
          </li>
          <li>Expiration: 90 days (recommended).</li>
          <li>
            Repository access: <em>Only select repositories</em> → pick the
            repo this dashboard manages.
          </li>
          <li>
            Permissions → Repository permissions →
            <code>Contents: Read and write</code> +
            <code>Metadata: Read-only</code>.
          </li>
          <li>Click <strong>Generate token</strong> and paste it above.</li>
        </ol>
        <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
          A click-to-authorize OAuth flow will replace this manual paste
          path once that ships (separate Review card).
        </p>
      </div>
    </div>

    <GitHubCredentialsModal
      v-model:open="modalOpen"
      :repo="agent.name"
      @saved="onSaved"
    />
  </article>
</template>
