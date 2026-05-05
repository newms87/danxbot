<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  text: string;
}>();

interface Block {
  kind: "h2" | "h3" | "p" | "ul" | "code";
  // For h*/p: rendered HTML string of inline-formatted text.
  // For ul: list of HTML strings (one per <li>).
  // For code: raw source (no inline formatting), plus optional language tag.
  html?: string;
  items?: string[];
  code?: string;
  lang?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Sentinels use Private Use Area chars (U+E000 / U+E001). escapeHtml does
// not touch them, but we strip any pre-existing PUA chars from source so
// user input cannot forge a placeholder.
const PLACEHOLDER_OPEN = "";
const PLACEHOLDER_CLOSE = "";

function inline(src: string): string {
  const cleaned = src.replace(/[-]/g, "");
  const codeSpans: string[] = [];
  let s = cleaned.replace(/`([^`\n]+)`/g, (_, code) => {
    const i = codeSpans.length;
    codeSpans.push(escapeHtml(code));
    return `${PLACEHOLDER_OPEN}${i}${PLACEHOLDER_CLOSE}`;
  });
  s = escapeHtml(s);
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(
    new RegExp(`${PLACEHOLDER_OPEN}(\\d+)${PLACEHOLDER_CLOSE}`, "g"),
    (_, i) => `<code>${codeSpans[Number(i)]}</code>`,
  );
  return s;
}

const blocks = computed<Block[]>(() => {
  const text = props.text ?? "";
  const lines = text.split("\n");
  const out: Block[] = [];
  let i = 0;
  let para: string[] = [];
  let list: string[] = [];

  function flushPara(): void {
    if (para.length === 0) return;
    out.push({ kind: "p", html: inline(para.join(" ").trim()) });
    para = [];
  }
  function flushList(): void {
    if (list.length === 0) return;
    out.push({ kind: "ul", items: list.map(inline) });
    list = [];
  }

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushPara();
      flushList();
      const lang = fence[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      out.push({ kind: "code", code: codeLines.join("\n"), lang });
      continue;
    }

    const h2 = line.match(/^##\s+(.*)$/);
    const h3 = line.match(/^###\s+(.*)$/);
    if (h2) {
      flushPara();
      flushList();
      out.push({ kind: "h2", html: inline(h2[1]) });
      i++;
      continue;
    }
    if (h3) {
      flushPara();
      flushList();
      out.push({ kind: "h3", html: inline(h3[1]) });
      i++;
      continue;
    }

    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      flushPara();
      list.push(li[1]);
      i++;
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushPara();
      flushList();
      i++;
      continue;
    }

    flushList();
    para.push(line);
    i++;
  }
  flushPara();
  flushList();
  return out;
});
</script>

<template>
  <div class="md">
    <template v-for="(b, i) in blocks" :key="i">
      <h2 v-if="b.kind === 'h2'" v-html="b.html" />
      <h3 v-else-if="b.kind === 'h3'" v-html="b.html" />
      <ul v-else-if="b.kind === 'ul'">
        <li v-for="(it, j) in b.items" :key="j" v-html="it" />
      </ul>
      <pre v-else-if="b.kind === 'code'" class="code"><code>{{ b.code }}</code></pre>
      <p v-else-if="b.kind === 'p'" v-html="b.html" />
    </template>
  </div>
</template>

<style scoped>
.md {
  font-size: 13px;
  color: #cbd5e1;
  line-height: 1.55;
  text-wrap: pretty;
}
.md > :first-child {
  margin-top: 0;
}
.md > :last-child {
  margin-bottom: 0;
}
.md h2 {
  font-size: 14px;
  font-weight: 600;
  color: #e2e8f0;
  margin: 14px 0 6px;
  letter-spacing: -0.01em;
}
.md h3 {
  font-size: 13px;
  font-weight: 600;
  color: #cbd5e1;
  margin: 12px 0 4px;
}
.md p {
  margin: 0 0 8px;
}
.md ul {
  margin: 0 0 8px;
  padding-left: 18px;
}
.md li {
  margin: 2px 0;
}
.md :deep(strong) {
  color: #e2e8f0;
  font-weight: 600;
}
.md :deep(em) {
  color: #e2e8f0;
  font-style: italic;
}
.md :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgb(15 23 42 / 0.8);
  color: #e2e8f0;
  border: 1px solid #1e293b;
}
.md pre.code {
  margin: 6px 0 10px;
  padding: 10px 12px;
  background: #020617;
  border: 1px solid #1e293b;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.5;
  color: #cbd5e1;
}
.md pre.code code {
  background: none;
  border: 0;
  padding: 0;
  color: inherit;
}
</style>
