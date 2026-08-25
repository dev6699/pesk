/** @jest-environment jsdom */

/// <reference types="jest" />
/// <reference path="../src/renderer/types.d.ts" />

import { CodexRenderer } from "../src/renderer/codex-renderer";
import { defaultSettings } from "../src/renderer/default-settings";

jest.mock(
  "../src/renderer/vendor/marked.js",
  () => ({
    marked: {
      parse: (value: string) =>
        `<p>${value.replace("**world**", "<strong>world</strong>")}</p>`,
    },
  }),
  { virtual: true },
);

type Settings = ReturnType<typeof defaultSettings>;

function makeRenderer(settings: Settings = defaultSettings()): {
  renderer: CodexRenderer;
  elements: {
    chat: HTMLElement;
    select: HTMLSelectElement;
    copy: HTMLButtonElement;
    error: HTMLElement;
    history: HTMLElement;
    workingStatus: HTMLElement;
    workingElapsed: HTMLElement;
    tokenUsage: HTMLElement;
    form: HTMLFormElement;
    input: HTMLTextAreaElement;
  };
} {
  document.body.innerHTML = `
    <section id="chat"></section>
    <select id="select"></select>
    <button id="copy">Copy</button>
    <div id="error"></div>
    <div id="history"></div>
    <div id="working"><span></span><span id="elapsed"></span></div>
    <div id="usage"></div>
    <form id="form"><textarea id="input"></textarea></form>
  `;
  const elements = {
    chat: document.querySelector("#chat") as HTMLElement,
    select: document.querySelector("#select") as HTMLSelectElement,
    copy: document.querySelector("#copy") as HTMLButtonElement,
    error: document.querySelector("#error") as HTMLElement,
    history: document.querySelector("#history") as HTMLElement,
    workingStatus: document.querySelector("#working") as HTMLElement,
    workingElapsed: document.querySelector("#elapsed") as HTMLElement,
    tokenUsage: document.querySelector("#usage") as HTMLElement,
    form: document.querySelector("#form") as HTMLFormElement,
    input: document.querySelector("#input") as HTMLTextAreaElement,
  };
  Object.defineProperties(elements.history, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 800, writable: true },
  });
  Object.defineProperty(elements.input, "scrollHeight", {
    configurable: true,
    value: 40,
  });
  elements.history.scrollTo = jest.fn();
  elements.history.scrollBy = jest.fn();
  window.peskApi = {
    ...window.peskApi,
    selectCodexThread: jest.fn(),
    submitCodexPrompt: jest.fn(async () => settings),
    respondCodexPermission: jest.fn(),
  };
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof window.requestAnimationFrame;
  const renderer = new CodexRenderer(
    elements.chat,
    elements.select,
    elements.copy,
    elements.error,
    elements.history,
    elements.workingStatus,
    elements.workingElapsed,
    elements.tokenUsage,
    elements.form,
    elements.input,
    settings,
  );
  return { renderer, elements };
}

afterEach(() => {
  jest.useRealTimers();
  document.body.replaceChildren();
});

test("renders session state, history, activities, approvals, and token usage", () => {
  const { renderer, elements } = makeRenderer();
  const settings: Settings = {
    ...defaultSettings(),
    codexThreadId: "thread-1",
    codexError: "socket failed",
    codexThreads: [{ id: "thread-1", preview: "Inspect project" }],
    codexModelInfo: {
      model: "gpt-test",
      provider: "openai",
      reasoningEffort: "high",
    },
    codexTokenUsage: {
      total: { totalTokens: 12500, inputTokens: 1200, outputTokens: 3400 },
      lastTurn: { totalTokens: 4000, inputTokens: 500 },
      modelContextWindow: 1000,
    },
    codexHistory: [
      { role: "user", text: "hello" },
      { role: "assistant", text: "**world**" },
      {
        role: "system",
        text: "npm test",
        itemId: "command-1",
        activity: {
          kind: "command",
          command: "npm   test",
          cwd: "/tmp/project",
          status: "completed",
          output: "passed",
        },
      },
      {
        role: "system",
        text: "changed files",
        activity: {
          kind: "fileChange",
          status: "completed",
          changes: ["src/a.ts\n  +added\n  -removed\n  @@ hunk"],
        },
      },
      {
        role: "system",
        text: "searching",
        activity: { kind: "webSearch", summary: "docs", status: "done" },
      },
      {
        role: "system",
        text: "approve command",
        approval: { requestId: "approval-1", state: "pending" },
      },
    ],
  };

  renderer.updateSettings(settings);

  expect(elements.error.hidden).toBe(false);
  expect(elements.error.textContent).toBe("Codex connection error.");
  expect(elements.select.options[0].textContent).toContain("Inspect project");
  expect(elements.copy.disabled).toBe(false);
  expect(elements.history.querySelectorAll(".codex-message")).toHaveLength(6);
  expect(
    elements.history.querySelector(".codex-markdown")?.innerHTML,
  ).toContain("<strong>world</strong>");
  expect(
    elements.history.querySelector(".codex-command-details"),
  ).not.toBeNull();
  expect(
    elements.history.querySelector(".codex-file-change-details"),
  ).not.toBeNull();
  expect(
    elements.history.querySelector(".codex-approval-pending"),
  ).not.toBeNull();
  expect(elements.tokenUsage.textContent).toContain("12.5k");
  expect(elements.tokenUsage.textContent).toContain("gpt-test");
});

test("submits a prompt, rejects empty or working input, and handles input shortcuts", async () => {
  const next = { ...defaultSettings(), codexThreadId: "thread-2" };
  const { renderer, elements } = makeRenderer(next);
  const submit = window.peskApi.submitCodexPrompt as jest.Mock;

  elements.input.value = "  hello  ";
  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await Promise.resolve();
  expect(submit).toHaveBeenCalledWith("hello");
  expect(elements.input.value).toBe("");

  elements.input.value = "line";
  elements.input.selectionStart = 4;
  elements.input.selectionEnd = 4;
  const newline = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true });
  elements.input.dispatchEvent(newline);
  expect(elements.input.value).toBe("line\n");

  const shiftEnter = new KeyboardEvent("keydown", {
    key: "Enter",
    shiftKey: true,
    cancelable: true,
  });
  elements.input.dispatchEvent(shiftEnter);
  expect(shiftEnter.defaultPrevented).toBe(true);

  renderer.updateSettings({ ...next, codexStatus: "working" });
  elements.input.value = "blocked";
  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await Promise.resolve();
  expect(submit).toHaveBeenCalledTimes(1);
});

test("handles approval keyboard shortcuts and completed approval states", () => {
  const { renderer, elements } = makeRenderer();
  renderer.updateSettings({
    ...defaultSettings(),
    codexThreadId: "thread-1",
    codexHistory: [
      {
        role: "system",
        text: "permission",
        approval: { requestId: 7, state: "pending" },
      },
    ],
  });
  const approve = elements.history.querySelector(
    "[data-decision='allow']",
  ) as HTMLButtonElement;
  const deny = elements.history.querySelector(
    "[data-decision='deny']",
  ) as HTMLButtonElement;
  const y = new KeyboardEvent("keydown", { key: "y", cancelable: true });
  renderer.handleKeydown(y);
  expect(y.defaultPrevented).toBe(true);
  expect(window.peskApi.respondCodexPermission).toHaveBeenCalledWith(
    7,
    "allow",
  );

  const n = new KeyboardEvent("keydown", { key: "n", cancelable: true });
  renderer.handleKeydown(n);
  expect(n.defaultPrevented).toBe(true);
  expect(window.peskApi.respondCodexPermission).toHaveBeenCalledWith(7, "deny");
  expect(approve).toBeTruthy();
  expect(deny).toBeTruthy();

  renderer.updateSettings({
    ...defaultSettings(),
    codexHistory: [
      {
        role: "system",
        text: "permission",
        approval: { requestId: 7, state: "approved" },
      },
    ],
  });
  expect(elements.history.textContent).toContain("Approved");
});

test("renders working and completed elapsed states", () => {
  jest.useFakeTimers();
  const { renderer, elements } = makeRenderer();
  const now = Date.now();
  jest.setSystemTime(now);
  renderer.updateSettings({
    ...defaultSettings(),
    codexWorkingSince: now - 65000,
  });
  expect(elements.workingStatus.hidden).toBe(false);
  expect(elements.workingElapsed.textContent).toBe("1m 5s");

  renderer.updateSettings({
    ...defaultSettings(),
    codexWorkedElapsed: 3661000,
  });
  expect(elements.workingStatus.textContent).toContain("Worked for");
  expect(elements.workingElapsed.textContent).toBe("1h 1m 1s");
});
