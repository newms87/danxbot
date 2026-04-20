<script setup lang="ts">
import { ref } from "vue";
import { useAuth } from "../../composables/useAuth";

const { login, initError } = useAuth();

const username = ref("");
const password = ref("");
const error = ref<string | null>(null);
const submitting = ref(false);

async function onSubmit(): Promise<void> {
  if (submitting.value) return;
  error.value = null;
  submitting.value = true;
  try {
    await login(username.value, password.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Login failed";
    password.value = "";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div
    class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4"
  >
    <form
      class="w-full max-w-sm rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-lg px-6 py-8"
      @submit.prevent="onSubmit"
    >
      <div class="mb-6 text-center">
        <h1 class="text-xl font-bold text-gray-900 dark:text-white">
          Danxbot Dashboard
        </h1>
        <p class="text-gray-500 dark:text-gray-400 text-sm mt-1">
          Sign in to continue
        </p>
      </div>

      <div
        v-if="initError"
        data-test="init-error"
        class="mb-4 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
      >
        {{ initError }}
      </div>

      <label class="block mb-4">
        <span class="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
          Username
        </span>
        <input
          v-model="username"
          type="text"
          autocomplete="username"
          required
          :disabled="submitting"
          class="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60"
        />
      </label>

      <label class="block mb-4">
        <span class="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
          Password
        </span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          :disabled="submitting"
          class="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60"
        />
      </label>

      <p
        v-if="error"
        data-test="login-error"
        role="alert"
        class="mb-4 text-sm text-red-600 dark:text-red-400"
      >
        {{ error }}
      </p>

      <button
        type="submit"
        :disabled="submitting"
        class="w-full rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium py-2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {{ submitting ? "Signing in…" : "Sign in" }}
      </button>
    </form>
  </div>
</template>
