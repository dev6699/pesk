/** @jest-environment jsdom */

/// <reference types="jest" />
/// <reference path="../../../../src/renderer/shared/types.d.ts" />

import { CodexChangesRenderer } from "../../../../src/renderer/features/chat/codex-changes-renderer";

jest.mock(
  "../../../../src/renderer/vendor/marked.js",
  () => ({ marked: { parse: (value: string) => value } }),
  { virtual: true },
);

type Message = RendererState["codex"]["threads"]["current"]["thread"]["messages"][number];

function message(overrides: Partial<Message> = {}): Message {
  return {
    role: "assistant",
    text: "",
    ...overrides,
  };
}

function fileChange(
  turnId: string,
  timestamp: number,
  changes: string[],
  overrides: Partial<NonNullable<Message["activity"]>> = {},
): Message {
  return message({
    role: "system",
    turnId,
    timestamp,
    activity: {
      kind: "fileChange",
      changes,
      status: "completed",
      ...overrides,
    },
  });
}

function makeRenderer() {
  document.body.innerHTML = `
    <button id="toggle" type="button"></button>
    <section id="panel" hidden>
      <button data-changes-close type="button">Close</button>
      <div data-changes-content></div>
      <div data-changes-backdrop></div>
    </section>
  `;
  const panel = document.querySelector<HTMLElement>("#panel")!;
  const toggle = document.querySelector<HTMLButtonElement>("#toggle")!;
  const navigateToTurn = jest.fn();
  const fillPrompt = jest.fn();
  const renderer = new CodexChangesRenderer(panel, toggle, navigateToTurn, fillPrompt);
  return { renderer, panel, toggle, navigateToTurn, fillPrompt };
}

afterEach(() => {
  document.body.replaceChildren();
});

test("renders recent turns first with prompts and per-kind file counts", () => {
  const { renderer, panel, toggle } = makeRenderer();
  renderer.render([
    message({ role: "user", turnId: "old", timestamp: 1, text: "old prompt" }),
    fileChange("old", 2, ["modified: old.ts\n@@ -1 +1 @@"]),
    message({ role: "user", turnId: "new", timestamp: 10, text: "fix the new files" }),
    fileChange("new", 11, ["added: new.ts\n+new", "deleted: removed.ts\n-old"]),
  ]);

  const turns = panel.querySelectorAll<HTMLElement>(".codex-changes-turn");
  expect(turns).toHaveLength(2);
  expect(turns[0]?.querySelector(".codex-changes-turn-prompt")?.textContent).toBe(
    "fix the new files",
  );
  expect(
    turns[0]?.querySelectorAll(".codex-changes-turn-label .codex-changes-kind-new"),
  ).toHaveLength(1);
  expect(
    turns[0]?.querySelectorAll(".codex-changes-turn-label .codex-changes-kind-deleted"),
  ).toHaveLength(1);
  expect(
    turns[0]?.querySelector(".codex-changes-turn-label .codex-changes-kind-new")?.textContent,
  ).toBe("1 New");
  expect(
    turns[0]?.querySelector(".codex-changes-turn-label .codex-changes-kind-deleted")?.textContent,
  ).toBe("1 Deleted");
  expect(turns[1]?.querySelector(".codex-changes-kind-modified")?.textContent).toBe("1 Modified");
  expect(toggle.disabled).toBe(false);
});

test("ignores failed or declined file changes and non-file activities", () => {
  const { renderer, panel } = makeRenderer();
  renderer.render([
    message({ role: "system", activity: { kind: "command", changes: ["added: command.ts"] } }),
    fileChange("failed", 2, ["added: failed.ts"], { status: "FAILED" }),
    fileChange("declined", 3, ["added: declined.ts"], { status: "DECLINED" }),
  ]);

  expect(panel.querySelector(".codex-changes-empty")?.textContent).toBe(
    "No file changes in the loaded history.",
  );
});

test("keeps repeated file changes as raw records and derives the aggregate kind", () => {
  const { renderer, panel } = makeRenderer();
  renderer.render([
    fileChange("turn-1", 1, ["added: src/app.ts\n+first"]),
    fileChange("turn-1", 2, ["modified: src/app.ts\n+second"]),
    fileChange("turn-1", 3, ["modified: src/other.ts\n+other"]),
  ]);

  const files = panel.querySelectorAll<HTMLElement>(".codex-changes-file");
  expect(files).toHaveLength(2);
  const app = files[0]!;
  expect(app.querySelector("strong")?.textContent).toBe("src/app.ts");
  expect(app.querySelector(".codex-changes-file-header .codex-changes-kind")?.textContent).toBe(
    "New",
  );
  expect(app.querySelector(".codex-changes-raw")?.hasAttribute("open")).toBe(true);
  expect(app.querySelectorAll(".codex-changes-raw-record")).toHaveLength(2);
  expect(app.textContent).toContain("Change 1");
  expect(app.textContent).toContain("Change 2");
  expect(files[1]?.querySelector(".codex-changes-kind")?.textContent).toBe("Modified");
});

test("uses Deleted when the final raw change deletes the file", () => {
  const { renderer, panel } = makeRenderer();
  renderer.render([
    fileChange("turn-1", 1, ["added: src/app.ts\n+first"]),
    fileChange("turn-1", 2, ["deleted: src/app.ts\n-first"]),
  ]);

  expect(panel.querySelector(".codex-changes-file-header .codex-changes-kind")?.textContent).toBe(
    "Deleted",
  );
});

test("navigates to a turn edge without closing the panel", () => {
  const { renderer, panel, navigateToTurn } = makeRenderer();
  renderer.render([fileChange("turn-1", 1, ["modified: src/app.ts\n+new"])]);
  const turn = panel.querySelector<HTMLElement>(".codex-changes-turn")!;
  turn.querySelector<HTMLButtonElement>(".codex-changes-turn-actions button")?.click();
  turn.querySelectorAll<HTMLButtonElement>(".codex-changes-turn-actions button")[1]?.click();

  expect(navigateToTurn).toHaveBeenNthCalledWith(1, "turn-1", "start");
  expect(navigateToTurn).toHaveBeenNthCalledWith(2, "turn-1", "end");
  expect(panel.hidden).toBe(true);
});

test("fills a structured prompt containing every raw change for a file", () => {
  const { renderer, panel, fillPrompt } = makeRenderer();
  renderer.render([
    fileChange("turn-1", 1, ["modified: src/app.ts\n@@ -1 +1 @@\n-old\n+one"]),
    fileChange("turn-1", 2, ["modified: src/app.ts\n@@ -5 +5 @@\n-old\n+two"]),
  ]);

  panel.querySelector<HTMLButtonElement>(".codex-changes-fill")?.click();

  expect(fillPrompt).toHaveBeenCalledWith(
    expect.stringContaining("`src/app.ts`\n\n### Change 1 (Modified)"),
  );
  const prompt = fillPrompt.mock.calls[0]?.[0] as string;
  expect(prompt).toContain("### Change 2 (Modified)");
  expect(prompt).toContain("+one");
  expect(prompt).toContain("+two");
});

test("opens and closes the panel while preserving rendered state on unchanged updates", () => {
  const { renderer, panel, toggle } = makeRenderer();
  const changes = [fileChange("turn-1", 1, ["modified: src/app.ts\n+new"])];
  renderer.render(changes);
  const turn = panel.querySelector<HTMLElement>(".codex-changes-turn")!;
  (turn as HTMLDetailsElement).open = true;
  toggle.click();
  expect(panel.hidden).toBe(false);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  renderer.render(changes);
  expect(panel.querySelector<HTMLDetailsElement>(".codex-changes-turn")?.open).toBe(true);
  panel.querySelector<HTMLButtonElement>("[data-changes-close]")?.click();
  expect(panel.hidden).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
});

test("disables the toggle when there are no usable file changes", () => {
  const { renderer, toggle } = makeRenderer();
  renderer.render([]);

  expect(toggle.disabled).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBeNull();
});
