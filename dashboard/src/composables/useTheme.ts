import { ref } from "vue";

const isDark = ref(localStorage.getItem("flytebot-theme") !== "light");

function apply() {
  document.documentElement.classList.toggle("dark", isDark.value);
}

apply();

export function useTheme() {
  function toggleTheme() {
    isDark.value = !isDark.value;
    localStorage.setItem("flytebot-theme", isDark.value ? "dark" : "light");
    apply();
  }

  return { isDark, toggleTheme };
}
