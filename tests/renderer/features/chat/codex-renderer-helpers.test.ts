/** @jest-environment jsdom */
/// <reference types="jest" />

import { renderMarkdown } from "../../../../src/renderer/features/chat/codex-renderer-helpers";

jest.mock(
  "../../../../src/renderer/vendor/marked.js",
  () => ({
    marked: {
      parse: (value: string) => {
        if (value === "bash")
          return '<pre><code class="language-bash">echo &lt;ok&gt;</code></pre>';
        if (value === "shell") return '<pre><code class="language-shell">pwd</code></pre>';
        if (value === "sh") return '<pre><code class="language-sh">printf ok</code></pre>';
        return '<pre><code class="language-javascript">alert(1)</code></pre>';
      },
    },
  }),
  { virtual: true },
);

test.each(["bash", "shell", "sh"])("adds a copy button to %s code blocks", (language) => {
  const template = document.createElement("template");
  template.innerHTML = renderMarkdown(language);

  expect(template.content.querySelector("pre")?.classList.contains("codex-markdown-code")).toBe(
    true,
  );
  const copyButton = template.content.querySelector<HTMLButtonElement>(".codex-code-copy");
  expect(copyButton?.type).toBe("button");
  expect(copyButton?.querySelector("svg")).not.toBeNull();
  expect(copyButton?.getAttribute("aria-label")).toBe("Copy code");
});

test("does not add a copy button to unrelated code blocks", () => {
  const template = document.createElement("template");
  template.innerHTML = renderMarkdown("javascript");

  expect(template.content.querySelector("pre")?.classList.contains("codex-markdown-code")).toBe(
    false,
  );
  expect(template.content.querySelector(".codex-code-copy")).toBeNull();
});
