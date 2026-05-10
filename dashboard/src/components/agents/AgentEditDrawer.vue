<script setup lang="ts">
/**
 * AgentEditDrawer — DX-160 Phase 2.
 *
 * Edit + Create drawer for an agent. The parent passes either an
 * existing record (edit mode) or `null` (create mode). On submit the
 * parent performs the API call and feeds errors back via `error`.
 *
 * Avatar upload runs as a separate API call after the create/update —
 * the file picker stages a `File` locally and the parent's submit
 * handler dispatches `uploadAgentAvatar` after the record save. The
 * avatar is therefore optional during create.
 *
 * Validation here is minimal — the backend re-validates everything
 * with explicit 400 errors; the drawer surfaces server-supplied error
 * strings so the UI stays in sync with the canonical validator.
 */
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { MarkdownEditor } from "@thehammer/danx-ui";
import type {
  AgentRecordWithName,
  AgentSchedule,
} from "../../types";
import AgentScheduleEditor from "./AgentScheduleEditor.vue";
import AgentAvatar from "./AgentAvatar.vue";

const props = defineProps<{
  agent: AgentRecordWithName | null; // null = create
  repo: string;
  busy: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  cancel: [];
  submit: [{
    name: string;
    bio: string;
    capabilities: string[];
    schedule: AgentSchedule;
    enabled: boolean;
    avatarFile: File | null;
  }];
}>();

const CAPABILITIES = ["issue-worker", "slack", "api"] as const;
type Capability = (typeof CAPABILITIES)[number];

const ALLOWED_AVATAR_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_AVATAR_BYTES = 1_000_000;

function emptySchedule(): AgentSchedule {
  // DX-247 temp impl: new agents default to 24/7 ON so they pick up work
  // immediately. Per-day windows still seed working hours so toggling 24/7
  // OFF reveals a usable starting state instead of an empty schedule.
  return {
    tz: "America/Chicago",
    always_on: true,
    mon: ["09:00-17:00"],
    tue: ["09:00-17:00"],
    wed: ["09:00-17:00"],
    thu: ["09:00-17:00"],
    fri: ["09:00-17:00"],
    sat: [],
    sun: [],
  };
}

interface FormState {
  name: string;
  bio: string;
  capabilities: Set<Capability>;
  schedule: AgentSchedule;
  enabled: boolean;
}

const form = reactive<FormState>({
  name: "",
  bio: "",
  capabilities: new Set<Capability>(["issue-worker"]),
  schedule: emptySchedule(),
  enabled: true,
});

const avatarFile = ref<File | null>(null);
const avatarPreview = ref<string | null>(null);
const avatarLocalError = ref<string | null>(null);
const dragOver = ref(false);

const isCreate = computed(() => props.agent === null);
const titleText = computed(() =>
  isCreate.value ? "New agent" : `Edit ${props.agent?.name}`,
);

// Hydrate form whenever the parent swaps the bound record.
watch(
  () => props.agent,
  (current) => {
    if (current) {
      form.name = current.name;
      form.bio = current.bio;
      form.capabilities = new Set<Capability>(
        current.capabilities.filter((c): c is Capability =>
          (CAPABILITIES as readonly string[]).includes(c),
        ),
      );
      form.schedule = JSON.parse(JSON.stringify(current.schedule));
      form.enabled = current.enabled;
    } else {
      form.name = "";
      form.bio = "";
      form.capabilities = new Set<Capability>(["issue-worker"]);
      form.schedule = emptySchedule();
      form.enabled = true;
    }
    revokeAvatarPreview();
    avatarFile.value = null;
    avatarLocalError.value = null;
  },
  { immediate: true },
);

function revokeAvatarPreview(): void {
  if (avatarPreview.value) {
    URL.revokeObjectURL(avatarPreview.value);
    avatarPreview.value = null;
  }
}

function pickAvatar(file: File | null): void {
  avatarLocalError.value = null;
  revokeAvatarPreview();
  if (!file) {
    avatarFile.value = null;
    return;
  }
  if (!ALLOWED_AVATAR_MIMES.has(file.type)) {
    avatarLocalError.value = `Unsupported type "${file.type || "unknown"}". Use PNG, JPEG, or WebP.`;
    avatarFile.value = null;
    return;
  }
  if (file.size > MAX_AVATAR_BYTES) {
    avatarLocalError.value = `File is ${Math.round(file.size / 1024)} KB; max is ${MAX_AVATAR_BYTES / 1000} KB.`;
    avatarFile.value = null;
    return;
  }
  avatarFile.value = file;
  avatarPreview.value = URL.createObjectURL(file);
}

function onFileInput(e: Event): void {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0] ?? null;
  pickAvatar(file);
  // Allow re-picking the same filename later by resetting the input.
  target.value = "";
}

function onDrop(e: DragEvent): void {
  e.preventDefault();
  dragOver.value = false;
  const file = e.dataTransfer?.files?.[0] ?? null;
  pickAvatar(file);
}

function toggleCap(c: Capability): void {
  if (form.capabilities.has(c)) {
    form.capabilities.delete(c);
  } else {
    form.capabilities.add(c);
  }
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const validation = computed<string | null>(() => {
  if (isCreate.value) {
    if (!form.name) return "Name is required.";
    if (!NAME_RE.test(form.name))
      return "Name must be lowercase letters, digits, '-' or '_', start with a letter, ≤32 chars.";
  }
  if (form.capabilities.size === 0) return "Pick at least one capability.";
  return null;
});

function onSubmit(): void {
  if (validation.value) return;
  emit("submit", {
    name: form.name,
    bio: form.bio,
    capabilities: Array.from(form.capabilities),
    schedule: form.schedule,
    enabled: form.enabled,
    avatarFile: avatarFile.value,
  });
}

onBeforeUnmount(revokeAvatarPreview);
</script>

<template>
  <aside
    class="drawer"
    role="dialog"
    aria-modal="true"
    :aria-label="titleText"
    data-test="agent-edit-drawer"
  >
    <div class="backdrop" @click="$emit('cancel')"></div>
    <form class="panel" @submit.prevent="onSubmit">
      <header class="head">
        <h2>{{ titleText }}</h2>
        <button
          type="button"
          class="close"
          aria-label="Close"
          @click="$emit('cancel')"
        >×</button>
      </header>
      <div class="body">
        <section class="field">
          <label class="lbl" for="agent-name">Name</label>
          <input
            id="agent-name"
            v-model="form.name"
            type="text"
            class="input"
            :readonly="!isCreate"
            placeholder="alice"
            data-test="agent-form-name"
            autocomplete="off"
          />
          <p v-if="!isCreate" class="hint">Name is immutable.</p>
        </section>

        <section class="field">
          <label class="lbl">Avatar</label>
          <div class="avatar-row">
            <div class="preview-box">
              <img
                v-if="avatarPreview"
                :src="avatarPreview"
                alt="Avatar preview"
              />
              <AgentAvatar
                v-else-if="props.agent"
                :repo="repo"
                :name="props.agent.name"
                :avatar-path="props.agent.avatar_path"
                :size="64"
              />
              <span v-else class="initials">
                {{ form.name.slice(0, 2).toUpperCase() || "?" }}
              </span>
            </div>
            <div
              class="dropzone"
              :class="{ dragging: dragOver }"
              @dragover.prevent="dragOver = true"
              @dragleave="dragOver = false"
              @drop="onDrop"
            >
              <p>Drop a PNG/JPEG/WebP here, or</p>
              <label class="file-btn">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  data-test="agent-form-avatar"
                  @change="onFileInput"
                />
                <span>browse…</span>
              </label>
              <p class="hint">≤ 1 MB</p>
            </div>
          </div>
          <p v-if="avatarLocalError" class="error" data-test="agent-form-avatar-error">
            {{ avatarLocalError }}
          </p>
        </section>

        <section class="field">
          <label class="lbl">Bio (markdown)</label>
          <MarkdownEditor
            v-model="form.bio"
            :placeholder="'A short description of the agent\'s persona, expertise, and tone.'"
            data-test="agent-form-bio"
          />
        </section>

        <section class="field">
          <label class="lbl">Capabilities</label>
          <div class="caps-row">
            <label
              v-for="cap in CAPABILITIES"
              :key="cap"
              class="cap-check"
              :data-test="`agent-form-cap-${cap}`"
            >
              <input
                type="checkbox"
                :checked="form.capabilities.has(cap)"
                @change="toggleCap(cap)"
              />
              <span>{{ cap }}</span>
            </label>
          </div>
        </section>

        <section class="field">
          <label class="lbl">Schedule</label>
          <AgentScheduleEditor v-model="form.schedule" />
        </section>

        <section class="field enabled">
          <label class="cap-check">
            <input
              v-model="form.enabled"
              type="checkbox"
              data-test="agent-form-enabled"
            />
            <span>Enabled</span>
          </label>
          <p class="hint">When disabled, the poller skips this agent.</p>
        </section>

        <p v-if="validation" class="error" data-test="agent-form-validation">
          {{ validation }}
        </p>
        <p v-if="error" class="error" data-test="agent-form-error">{{ error }}</p>
      </div>

      <footer class="foot">
        <button
          type="button"
          class="btn btn-cancel"
          :disabled="busy"
          @click="$emit('cancel')"
        >Cancel</button>
        <button
          type="submit"
          class="btn btn-save"
          :disabled="busy || !!validation"
          data-test="agent-form-submit"
        >
          {{ busy ? "Saving…" : isCreate ? "Create agent" : "Save changes" }}
        </button>
      </footer>
    </form>
  </aside>
</template>

<style scoped>
.drawer {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  justify-content: flex-end;
}
.backdrop {
  position: absolute;
  inset: 0;
  background: rgba(2, 6, 23, 0.6);
}
.panel {
  position: relative;
  width: min(560px, 100vw);
  height: 100vh;
  background: #0b1220;
  border-left: 1px solid #1e293b;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #1e293b;
}
.head h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #f1f5f9;
}
.close {
  background: transparent;
  color: #94a3b8;
  border: none;
  font-size: 24px;
  cursor: pointer;
  line-height: 1;
}
.close:hover {
  color: #f1f5f9;
}
.body {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  overflow-y: auto;
  flex: 1;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.lbl {
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
}
.input {
  padding: 8px 10px;
  font-size: 13px;
  border: 1px solid #334155;
  border-radius: 4px;
  background: #0f172a;
  color: #e2e8f0;
}
.input[readonly] {
  background: #1e293b;
  color: #94a3b8;
}
.hint {
  margin: 0;
  font-size: 11px;
  color: #64748b;
}
.error {
  margin: 0;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid #f87171;
  color: #fecaca;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 4px;
}
.avatar-row {
  display: flex;
  align-items: center;
  gap: 16px;
}
.preview-box {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: 1px solid #1e293b;
  overflow: hidden;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #1e293b;
  color: #cbd5e1;
  font-weight: 600;
  font-size: 22px;
}
.preview-box img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.initials {
  user-select: none;
}
.dropzone {
  flex: 1;
  border: 1px dashed #334155;
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  text-align: center;
  font-size: 12px;
  color: #94a3b8;
}
.dropzone.dragging {
  border-color: #60a5fa;
  background: rgba(96, 165, 250, 0.08);
}
.dropzone p {
  margin: 0;
}
.file-btn {
  display: inline-block;
  cursor: pointer;
  color: #60a5fa;
}
.file-btn input[type="file"] {
  display: none;
}
.file-btn span {
  text-decoration: underline;
}
.caps-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.cap-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #cbd5e1;
  cursor: pointer;
}
.cap-check input[type="checkbox"] {
  accent-color: #60a5fa;
}
.field.enabled .cap-check {
  font-weight: 600;
}
.foot {
  padding: 12px 20px;
  border-top: 1px solid #1e293b;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  background: #0b1220;
}
.btn {
  font-size: 13px;
  padding: 8px 16px;
  border-radius: 6px;
  border: 1px solid #334155;
  cursor: pointer;
  font-weight: 500;
}
.btn-cancel {
  background: transparent;
  color: #94a3b8;
}
.btn-cancel:hover {
  background: #1e293b;
}
.btn-save {
  background: #2563eb;
  color: white;
  border-color: #2563eb;
}
.btn-save:hover {
  background: #1d4ed8;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
