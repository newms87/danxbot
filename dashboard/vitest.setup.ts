import { afterEach } from "vitest";
import { enableAutoUnmount } from "@vue/test-utils";

// Auto-unmount any wrapper a test mounted, even when the test throws or
// times out before reaching its own `w.unmount()`. Prevents leaked
// `onMounted`/`onUnmounted` side-effects (window event listeners, watch
// callbacks tied to module-scoped refs) from cascading into later tests in
// the same file. DX-253 root-caused App.test.ts's flake to this: under the
// full suite the first dynamic `import("./App.vue")` blew past the default
// 5s timeout, test 1's mount leaked, and every subsequent test in the file
// saw the prior mount's listeners fire on top of its own.
enableAutoUnmount(afterEach);
