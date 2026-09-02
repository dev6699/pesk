/** @jest-environment jsdom */

/// <reference types="jest" />
/// <reference path="../../../../src/renderer/shared/types.d.ts" />

import { CodexRenderer } from "../../../../src/renderer/features/chat/codex-renderer";
import { defaultRendererState } from "../../../../src/renderer/shared/default-settings";

jest.mock(
  "../../../../src/renderer/vendor/marked.js",
  () => ({
    marked: {
      parse: (value: string) =>
        `<p>${value
          .replace("**world**", "<strong>world</strong>")
          .replace(
            /!\[([^\]]*)\]\((https?:[^ )]+)(?:\s+"([^"]*)")?\)/g,
            (_match, alt, src, title) =>
              `<img src="${src}" alt="${alt}"${title ? ` title="${title}"` : ""}>`,
          )}</p>`,
    },
  }),
  { virtual: true },
);

type Settings = RendererState;

function makeRenderer(
  settings: Settings = defaultRendererState(),
  webChat = false,
): {
  renderer: CodexRenderer & {
    updateState: (state: RendererState) => void;
  };
  elements: {
    chat: HTMLElement;
    select: HTMLSelectElement;
    copy: HTMLButtonElement;
    error: HTMLElement;
    history: HTMLElement;
    workingStatus: HTMLElement;
    workingElapsed: HTMLElement;
    tokenUsage: HTMLElement;
    statusDock: HTMLElement;
    form: HTMLFormElement;
    input: HTMLTextAreaElement;
    suggestions: HTMLElement;
    userInput: HTMLElement;
    commandMode: HTMLElement;
    modeToggle: HTMLElement;
    steerButton: HTMLButtonElement;
  };
} {
  document.body.className = webChat ? "web-chat" : "";
  document.body.innerHTML = `
    <section id="chat"></section>
    <select id="select"></select>
    <button id="copy">Copy</button>
    <div id="error"></div>
    <div id="history"></div>
    <div id="codex-status-dock" hidden>
      <div id="codex-command-notice" hidden></div>
      <div id="working"><span></span><span id="elapsed"></span></div>
    </div>
    <div id="token-row"><div id="usage"></div></div>
    <section id="user-input"></section>
    <form id="form">
      <div id="command-mode" hidden></div>
      <div id="mode-toggle"></div>
      <button id="steer" type="button"></button>
      <textarea id="input"></textarea>
      <div id="suggestions"></div>
      <input id="codex-image-input" type="file" />
      <div id="codex-image-attachments"></div>
      <button id="codex-image-select" type="button"></button>
    </form>
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
    statusDock: document.querySelector("#codex-status-dock") as HTMLElement,
    form: document.querySelector("#form") as HTMLFormElement,
    input: document.querySelector("#input") as HTMLTextAreaElement,
    suggestions: document.querySelector("#suggestions") as HTMLElement,
    userInput: document.querySelector("#user-input") as HTMLElement,
    commandMode: document.querySelector("#command-mode") as HTMLElement,
    modeToggle: document.querySelector("#mode-toggle") as HTMLElement,
    steerButton: document.querySelector("#steer") as HTMLButtonElement,
  };
  Object.defineProperties(elements.history, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 800, writable: true },
  });
  Object.defineProperty(elements.input, "scrollHeight", {
    configurable: true,
    value: 40,
  });
  HTMLElement.prototype.scrollIntoView = jest.fn();
  elements.history.scrollTo = jest.fn();
  elements.history.scrollBy = jest.fn();
  window.peskApi = {
    ...window.peskApi,
    selectCodexThread: jest.fn(),
    loadOlderCodexHistory: jest.fn(async () => false),
    setCodexCollaborationMode: jest.fn(),
    focusCodexInput: jest.fn(),
    implementCodexPlan: jest.fn(async () => settings),
    interruptCodexTurn: jest.fn(async () => true),
    submitCodexPrompt: jest.fn(async () => settings),
    getSettings: jest.fn(async () => settings),
    listCodexProjects: jest.fn(async () => settings),
    startCodexProjectThread: jest.fn(async () => settings),
    startCodexReview: jest.fn(async () => settings),
    fuzzyFileSearch: jest.fn(async (): Promise<FuzzyFileSearchResult[]> => [
      {
        root: "/tmp/project",
        path: "src/codex.ts",
        match_type: "file",
        file_name: "codex.ts",
        score: 1,
        indices: [0],
      },
      {
        root: "/tmp/project",
        path: "src/config.ts",
        match_type: "file",
        file_name: "config.ts",
        score: 0.8,
        indices: [0],
      },
    ]),
    respondCodexPermission: jest.fn(),
    respondCodexUserInput: jest.fn(),
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
    undefined,
    elements.suggestions,
    elements.modeToggle,
    elements.userInput,
    elements.steerButton,
    elements.commandMode,
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
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      threadId: "thread-1",
      error: "socket failed",
      threads: [{ id: "thread-1", preview: "Inspect project", projectId: "project-1" }],
      projects: [
        {
          id: "project-1",
          name: "Frontend",
          roots: [{ path: "/tmp/project" }],
          metadata: {},
          position: 0,
          createdAt: 1,
          updatedAt: 1,
          recencyAt: null,
        },
      ],
      modelInfo: {
        model: "gpt-test",
        provider: "openai",
        reasoningEffort: "high",
      },
      tokenUsage: {
        total: { totalTokens: 12500, inputTokens: 1200, outputTokens: 3400 },
        last: { totalTokens: 4000, inputTokens: 500 },
        modelContextWindow: 1000,
      },
      history: [
        { role: "user", text: "hello" },
        {
          role: "assistant",
          text: "**world**\n\n![Cat](https://petsplanet.pk/wp-content/uploads/2024/06/cat-breed.jpg)",
        },
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
    },
  };

  renderer.updateState(settings);

  expect(elements.error.hidden).toBe(false);
  expect(elements.error.textContent).toBe("Codex connection error.");
  expect(elements.select.options[0].textContent).toContain("Inspect project");
  expect(elements.copy.disabled).toBe(false);
  expect(elements.history.querySelectorAll(".codex-message")).toHaveLength(6);
  expect(elements.history.querySelector(".codex-markdown")?.innerHTML).toContain(
    "<strong>world</strong>",
  );
  expect(elements.history.querySelector(".codex-markdown img")).toMatchObject({
    src: "https://petsplanet.pk/wp-content/uploads/2024/06/cat-breed.jpg",
    alt: "Cat",
  });
  expect(elements.history.querySelector(".codex-command-details")).not.toBeNull();
  expect(elements.history.querySelector(".codex-file-change-details")).not.toBeNull();
  expect(elements.history.querySelector(".codex-approval-pending")).not.toBeNull();
  expect(elements.tokenUsage.textContent).toContain("12.5k");
  expect(elements.tokenUsage.textContent).toContain("gpt-test");
});

test("appends new history without recreating existing message nodes", () => {
  const { renderer, elements } = makeRenderer();
  const firstState: Settings = {
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [
        { role: "assistant", text: "**world**", itemId: "assistant-1" },
        { role: "user", text: "continue", itemId: "user-1" },
      ],
    },
  };
  renderer.updateState(firstState);
  const firstMessage = elements.history.querySelector<HTMLElement>(
    '[data-message-item-id="assistant-1"]',
  );
  expect(firstMessage).not.toBeNull();

  renderer.updateState({
    ...firstState,
    codex: {
      ...firstState.codex,
      history: [
        ...firstState.codex.history,
        { role: "assistant", text: "done", itemId: "assistant-2" },
      ],
    },
  });

  expect(elements.history.querySelector('[data-message-item-id="assistant-1"]')).toBe(firstMessage);
  expect(elements.history.querySelectorAll(".codex-message")).toHaveLength(3);
});

test("removes empty-history placeholders when the first message arrives", () => {
  const { renderer, elements } = makeRenderer();
  const emptyState = defaultRendererState();
  emptyState.codex.threadId = "thread-1";
  renderer.updateState(emptyState);

  expect(elements.history.querySelector(".codex-empty-history")).not.toBeNull();
  expect(elements.history.querySelector(".codex-session-connected")).not.toBeNull();

  renderer.updateState({
    ...emptyState,
    codex: {
      ...emptyState.codex,
      history: [{ role: "user", text: "hello", itemId: "user-1" }],
    },
  });

  expect(elements.history.querySelector(".codex-empty-history")).toBeNull();
  expect(elements.history.querySelector(".codex-session-connected")).toBeNull();
  expect(elements.history.textContent).toContain("hello");
});

test("shows loading while session history is being fetched", () => {
  const { renderer, elements } = makeRenderer();
  const loadingState = defaultRendererState();
  loadingState.codex.threadId = "thread-1";
  loadingState.codex.connected = true;
  loadingState.codex.historyLoading = true;

  renderer.updateState(loadingState);

  expect(elements.history.querySelector(".codex-loading-history")?.textContent).toBe(
    "Loading messages…",
  );
  expect(elements.history.querySelector(".codex-empty-history")).toBeNull();
  expect(elements.history.querySelector(".codex-session-connected")).toBeNull();

  renderer.updateState({
    ...loadingState,
    codex: { ...loadingState.codex, historyLoading: false },
  });

  expect(elements.history.querySelector(".codex-loading-history")).toBeNull();
  expect(elements.history.querySelector(".codex-empty-history")).not.toBeNull();
  expect(elements.history.querySelector(".codex-session-connected")).not.toBeNull();
});

test("prepends older history without recreating newer message nodes", () => {
  const { renderer, elements } = makeRenderer();
  const currentHistory = [
    { role: "user" as const, text: "new prompt", itemId: "user-1" },
    { role: "assistant" as const, text: "new answer", itemId: "assistant-1" },
  ];
  renderer.updateState({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, history: currentHistory },
  });
  const newerMessage = elements.history.querySelector<HTMLElement>(
    '[data-message-item-id="user-1"]',
  );
  elements.history.scrollTop = 100;

  renderer.updateState({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [{ role: "user", text: "old prompt", itemId: "user-0" }, ...currentHistory],
    },
  });

  expect(elements.history.querySelector('[data-message-item-id="user-1"]')).toBe(newerMessage);
  expect(elements.history.querySelector(".codex-message")?.textContent).toContain("old prompt");
});

test("updates streamed assistant text without rebuilding a long history", () => {
  const { renderer, elements } = makeRenderer();
  const history = Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: index === 79 ? "streaming" : `message ${index}`,
    itemId: `message-${index}`,
  }));

  renderer.updateState({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, history: history },
  });
  const unchangedMessage = elements.history.querySelector<HTMLElement>(
    "[data-message-item-id='message-0']",
  );
  const streamedMessage = elements.history.querySelector<HTMLElement>(
    "[data-message-item-id='message-79']",
  );

  renderer.updateState({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [...history.slice(0, -1), { ...history.at(-1)!, text: "streaming update" }],
    },
  });

  expect(elements.history.querySelector<HTMLElement>("[data-message-item-id='message-0']")).toBe(
    unchangedMessage,
  );
  expect(elements.history.querySelector<HTMLElement>("[data-message-item-id='message-79']")).toBe(
    streamedMessage,
  );
  expect(streamedMessage?.textContent).toContain("streaming update");
});

test("updates streamed command output without rebuilding history", () => {
  const { renderer, elements } = makeRenderer();
  const state = defaultRendererState();
  state.codex.history = [
    {
      role: "system",
      text: "$ npm test",
      itemId: "command-1",
      activity: {
        kind: "command",
        label: "commandExecution",
        command: "npm test",
        output: "first line",
      },
    },
  ];

  renderer.updateState(state);
  const bubble = elements.history.querySelector<HTMLElement>("[data-message-item-id='command-1']");
  const details = bubble?.querySelector<HTMLElement>(".codex-activity-details");

  renderer.updateState({
    ...state,
    codex: {
      ...state.codex,
      history: [
        {
          ...state.codex.history[0],
          text: "$ npm test\nfirst line\nsecond line",
          activity: { ...state.codex.history[0].activity!, output: "first line\nsecond line" },
        },
      ],
    },
  });

  expect(elements.history.querySelector("[data-message-item-id='command-1']")).toBe(bubble);
  expect(elements.history.querySelector(".codex-activity-details")).toBe(details);
  expect(details?.textContent).toContain("second line");
});

test("applies stream deltas without requiring a full state payload", () => {
  const { renderer, elements } = makeRenderer();
  const state = defaultRendererState();
  state.codex.history = [{ role: "assistant", text: "partial", itemId: "assistant-delta" }];
  state.codex.status = "working";
  renderer.updateState(state);

  renderer.applyStreamDelta({
    threadId: undefined,
    itemId: "assistant-delta",
    kind: "assistant",
    delta: " output",
  });

  expect(elements.history.textContent).toContain("partial output");
});

test("keeps the history pinned while an assistant response streams", () => {
  const { renderer, elements } = makeRenderer();
  const state = defaultRendererState();
  state.codex.status = "working";
  state.codex.history = [{ role: "assistant", text: "partial", itemId: "assistant-scroll" }];
  renderer.updateState(state);

  elements.history.scrollTop = elements.history.scrollHeight - elements.history.clientHeight;
  renderer.applyStreamDelta({
    threadId: undefined,
    itemId: "assistant-scroll",
    kind: "assistant",
    delta: " output",
  });

  expect(elements.history.scrollTop).toBe(elements.history.scrollHeight);
});

test("does not pull the reader to the bottom during assistant streaming", () => {
  const { renderer, elements } = makeRenderer();
  const state = defaultRendererState();
  state.codex.status = "working";
  state.codex.history = [{ role: "assistant", text: "partial", itemId: "assistant-reader" }];
  renderer.updateState(state);

  elements.history.scrollTop = 120;
  renderer.applyStreamDelta({
    threadId: undefined,
    itemId: "assistant-reader",
    kind: "assistant",
    delta: " output",
  });

  expect(elements.history.scrollTop).toBe(120);
});

test("blocks pending autoscroll after manual scrolling", () => {
  const { renderer, elements } = makeRenderer();
  const state = defaultRendererState();
  state.codex.status = "working";
  state.codex.history = [{ role: "assistant", text: "partial", itemId: "manual-scroll" }];
  renderer.updateState(state);

  elements.history.scrollTop = 120;
  elements.history.dispatchEvent(new WheelEvent("wheel"));
  renderer.applyStreamDelta({
    threadId: undefined,
    itemId: "manual-scroll",
    kind: "assistant",
    delta: " output",
  });

  expect(elements.history.scrollTop).toBe(120);
});

test("resumes autoscroll after the reader returns to the bottom", () => {
  const { renderer, elements } = makeRenderer();
  const state = defaultRendererState();
  state.codex.status = "working";
  state.codex.history = [{ role: "assistant", text: "partial", itemId: "resume-scroll" }];
  renderer.updateState(state);

  elements.history.dispatchEvent(new WheelEvent("wheel"));
  elements.history.scrollTop = elements.history.scrollHeight - elements.history.clientHeight;
  elements.history.dispatchEvent(new Event("scroll"));
  renderer.applyStreamDelta({
    threadId: undefined,
    itemId: "resume-scroll",
    kind: "assistant",
    delta: " output",
  });

  expect(elements.history.scrollTop).toBe(elements.history.scrollHeight);
});

test("blocks autoscroll after Shift+Up or Shift+Down history scrolling", () => {
  const { renderer, elements } = makeRenderer();
  const state = defaultRendererState();
  state.codex.status = "working";
  state.codex.history = [{ role: "assistant", text: "partial", itemId: "keyboard-scroll" }];
  renderer.updateState(state);

  elements.history.scrollTop = 120;
  renderer.handleKeydown(
    new KeyboardEvent("keydown", {
      key: "ArrowUp",
      shiftKey: true,
      cancelable: true,
    }),
  );
  renderer.applyStreamDelta({
    threadId: undefined,
    itemId: "keyboard-scroll",
    kind: "assistant",
    delta: " output",
  });

  expect(elements.history.scrollTop).toBe(120);
});

test("Alt+Home blocks autoscroll and Alt+End resumes it at the bottom", () => {
  const { renderer, elements } = makeRenderer();
  const state = defaultRendererState();
  state.codex.status = "working";
  state.codex.history = [{ role: "assistant", text: "partial", itemId: "home-end-scroll" }];
  renderer.updateState(state);

  renderer.handleKeydown(
    new KeyboardEvent("keydown", { key: "Home", altKey: true, cancelable: true }),
  );
  elements.history.scrollTop = 120;
  renderer.applyStreamDelta({
    threadId: undefined,
    itemId: "home-end-scroll",
    kind: "assistant",
    delta: " output",
  });
  expect(elements.history.scrollTop).toBe(120);

  renderer.handleKeydown(
    new KeyboardEvent("keydown", { key: "End", altKey: true, cancelable: true }),
  );
  elements.history.scrollTop = elements.history.scrollHeight;
  elements.history.dispatchEvent(new Event("scroll"));
  renderer.applyStreamDelta({
    threadId: undefined,
    itemId: "home-end-scroll",
    kind: "assistant",
    delta: " again",
  });
  expect(elements.history.scrollTop).toBe(elements.history.scrollHeight);
});

test("parses streamed assistant Markdown when the turn completes", () => {
  const { renderer, elements } = makeRenderer();
  const state = defaultRendererState();
  state.codex.status = "working";
  state.codex.history = [{ role: "assistant", text: "", itemId: "assistant-markdown" }];
  renderer.updateState(state);

  renderer.applyStreamDelta({
    threadId: undefined,
    itemId: "assistant-markdown",
    kind: "assistant",
    delta: "**world**",
  });

  const completedState = {
    ...state,
    codex: {
      ...state.codex,
      status: "idle" as const,
      history: [{ role: "assistant" as const, text: "**world**", itemId: "assistant-markdown" }],
    },
  };
  renderer.updateState(completedState);

  expect(elements.history.querySelector("strong")?.textContent).toBe("world");
});

test("keeps streamed assistant text when history is re-rendered before completion", () => {
  const { renderer, elements } = makeRenderer();
  const state = defaultRendererState();
  state.codex.status = "working";
  state.codex.history = [{ role: "user", text: "hello", itemId: "user-1" }];
  renderer.updateState(state);

  renderer.applyStreamDelta({
    threadId: undefined,
    itemId: "assistant-1",
    kind: "assistant",
    delta: "first",
  });
  renderer.applyStreamDelta({
    threadId: undefined,
    itemId: "assistant-1",
    kind: "assistant",
    delta: " partial",
  });
  expect(elements.history.textContent).toContain("first partial");

  renderer.updateState({
    ...state,
    codex: {
      ...state.codex,
      history: [{ role: "user", text: "other thread", itemId: "other-1" }],
    },
  });
  renderer.updateState(state);
  renderer.applyStreamDelta({
    threadId: undefined,
    itemId: "assistant-1",
    kind: "assistant",
    delta: " response",
  });

  expect(elements.history.textContent).toContain("first partial response");
});

test("windows very long history without truncating renderer state", () => {
  const { renderer, elements } = makeRenderer();
  const history = Array.from({ length: 400 }, (_, index) => ({
    role: "user" as const,
    text: `message ${index}`,
    itemId: `message-${index}`,
  }));
  const state = defaultRendererState();
  state.codex.history = history;

  renderer.updateState(state);

  expect(state.codex.history).toHaveLength(400);
  expect(elements.history.querySelectorAll(".codex-message")).toHaveLength(100);
  expect(elements.history.querySelector("[data-message-item-id='message-0']")).toBeNull();
  expect(elements.history.querySelector("[data-message-item-id='message-399']")).not.toBeNull();

  elements.history.scrollTop = 2_000;
  elements.history.dispatchEvent(new Event("scroll"));

  expect(elements.history.querySelector("[data-message-item-id='message-7']")).not.toBeNull();
  expect(elements.history.querySelectorAll(".codex-message")).toHaveLength(100);
});

test("preserves scroll position when appending while reading older history", () => {
  const { renderer, elements } = makeRenderer();
  const initialHistory = [{ role: "user" as const, text: "first", itemId: "user-1" }];
  renderer.updateState({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, history: initialHistory },
  });
  elements.history.scrollTop = 120;

  renderer.updateState({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [...initialHistory, { role: "assistant", text: "new", itemId: "assistant-1" }],
    },
  });

  expect(elements.history.scrollTop).toBe(120);
});

test("renders readable keyboard-friendly user questions", () => {
  const { renderer, elements } = makeRenderer();
  const question = "Which implementation should we use? ".repeat(8);
  const settings: Settings = {
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      pendingUserInput: {
        requestId: "request-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        isBlocking: true,
        questions: [
          {
            id: "choice",
            header: "Implementation choice",
            question,
            isOther: false,
            isSecret: false,
            options: [{ label: "Option A", description: "Use the first approach." }],
          },
        ],
      },
    },
  };

  renderer.updateState(settings);

  expect(elements.userInput.hidden).toBe(false);
  expect(elements.form.hidden).toBe(true);
  expect(elements.userInput.textContent).toContain(question);
  expect(document.activeElement).toBe(elements.userInput.querySelector("input[type='radio']"));
  const input = elements.userInput.querySelector<HTMLInputElement>("input[type='radio']")!;
  expect(elements.userInput.textContent).toContain(
    "Use ↑/↓ to select, Tab to add a note, and Enter to submit.",
  );
  input.checked = true;
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(window.peskApi.respondCodexUserInput).toHaveBeenCalledWith("request-1", {
    choice: ["Option A"],
  });
  expect(window.peskApi.focusCodexInput).toHaveBeenCalled();
  expect(document.activeElement).toBe(elements.input);
});

test("refocuses the text input when a submitted question is resolved", () => {
  const { renderer, elements } = makeRenderer();
  const pendingState: Settings = {
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      pendingUserInput: {
        requestId: "request-resolve",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        isBlocking: true,
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Choose one",
            isOther: false,
            isSecret: false,
            options: [{ label: "Option A", description: "" }],
          },
        ],
      },
    },
  };
  renderer.updateState(pendingState);
  elements.userInput.querySelector<HTMLInputElement>("input[type='radio']")?.focus();

  renderer.updateState(defaultRendererState());

  expect(document.activeElement).toBe(elements.input);
  expect(window.peskApi.focusCodexInput).toHaveBeenCalled();
});

test("can show the same command notice again after it is cleared", () => {
  const { renderer } = makeRenderer();
  const notice = document.querySelector("#codex-command-notice") as HTMLElement;
  const settings: Settings = {
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      commandNotice: "Usage: /goal [<objective>|clear|edit|pause|resume]",
    },
  };

  renderer.updateState(settings);
  expect(notice.hidden).toBe(false);

  renderer.updateState({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, commandNotice: undefined },
  });
  expect(notice.hidden).toBe(true);

  renderer.updateState(settings);
  expect(notice.hidden).toBe(false);
});

test("preserves modified arrow shortcuts while a question is focused", () => {
  const { renderer, elements } = makeRenderer();
  const settings: Settings = {
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [
        { role: "user", text: "first" },
        { role: "assistant", text: "second" },
      ],
      pendingUserInput: {
        requestId: "request-arrows",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        isBlocking: true,
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Choose one",
            isOther: false,
            isSecret: false,
            options: [
              { label: "A", description: "First" },
              { label: "B", description: "Second" },
            ],
          },
        ],
      },
    },
  };
  renderer.updateState(settings);
  const option = elements.userInput.querySelector<HTMLInputElement>("input[type='radio']")!;
  const dispatchThroughDocument = (event: KeyboardEvent): void => {
    option.dispatchEvent(event);
  };

  elements.history.setAttribute("tabindex", "0");
  elements.history.focus();
  const scrollEvent = new KeyboardEvent("keydown", {
    key: "ArrowDown",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  const handleKeydown = (event: KeyboardEvent): void => renderer.handleKeydown(event);
  document.addEventListener("keydown", handleKeydown, true);
  elements.history.dispatchEvent(scrollEvent);
  expect(scrollEvent.defaultPrevented).toBe(true);
  expect(elements.history.scrollBy).toHaveBeenCalledWith({
    top: 64,
    behavior: "smooth",
  });

  option.focus();
  const selectEvent = new KeyboardEvent("keydown", {
    key: "ArrowUp",
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  dispatchThroughDocument(selectEvent);
  expect(selectEvent.defaultPrevented).toBe(true);
  expect(elements.history.querySelector(".codex-message-selected")).not.toBeNull();

  const plainArrow = new KeyboardEvent("keydown", {
    key: "ArrowDown",
    bubbles: true,
    cancelable: true,
  });
  option.dispatchEvent(plainArrow);
  expect(plainArrow.defaultPrevented).toBe(true);
  expect(
    elements.userInput.querySelectorAll<HTMLInputElement>("input[type='radio']")[1].checked,
  ).toBe(true);
  document.removeEventListener("keydown", handleKeydown, true);
});

test("Ctrl+Up refocuses the question after history navigation", () => {
  const { renderer, elements } = makeRenderer({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      pendingUserInput: {
        requestId: "request-focus",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        isBlocking: true,
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Choose one",
            isOther: false,
            isSecret: false,
            options: [
              { label: "A", description: "First" },
              { label: "B", description: "Second" },
            ],
          },
        ],
      },
    },
  });
  renderer.updateState({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      pendingUserInput: {
        requestId: "request-focus",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        isBlocking: true,
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Choose one",
            isOther: false,
            isSecret: false,
            options: [
              { label: "A", description: "First" },
              { label: "B", description: "Second" },
            ],
          },
        ],
      },
    },
  });
  const option = elements.userInput.querySelector<HTMLInputElement>("input[type='radio']")!;

  elements.history.setAttribute("tabindex", "0");
  elements.history.focus();
  const fromHistory = new KeyboardEvent("keydown", {
    key: "ArrowUp",
    ctrlKey: true,
    cancelable: true,
  });
  renderer.handleKeydown(fromHistory);

  expect(fromHistory.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(option);

  elements.input.focus();
  const afterRefocus = new KeyboardEvent("keydown", {
    key: "ArrowUp",
    ctrlKey: true,
    cancelable: true,
  });
  renderer.handleKeydown(afterRefocus);

  expect(afterRefocus.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(option);
});

test("Ctrl+Left and Ctrl+Right switch between threads", () => {
  const settings = {
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      threadId: "thread-2",
      threads: [
        { id: "thread-1", preview: "Previous" },
        { id: "thread-2", preview: "Current" },
        { id: "thread-3", preview: "Next" },
      ],
    },
  };
  const { renderer } = makeRenderer(settings);
  renderer.updateState(settings);
  const selectThread = window.peskApi.selectCodexThread as jest.Mock;

  const previous = new KeyboardEvent("keydown", {
    key: "ArrowLeft",
    ctrlKey: true,
    cancelable: true,
  });
  renderer.handleKeydown(previous);
  expect(previous.defaultPrevented).toBe(true);
  expect(selectThread).toHaveBeenCalledWith("thread-1");

  const next = new KeyboardEvent("keydown", {
    key: "ArrowRight",
    ctrlKey: true,
    cancelable: true,
  });
  renderer.handleKeydown(next);
  expect(next.defaultPrevented).toBe(true);
  expect(selectThread).toHaveBeenLastCalledWith("thread-2");

  renderer.updateState({
    ...settings,
    codex: {
      ...settings.codex,
      threadId: "thread-2",
      threads: [
        { id: "thread-1", preview: "Previous" },
        { id: "thread-2", preview: "Current" },
        { id: "thread-3", preview: "Next" },
      ],
    },
  });
  const forward = new KeyboardEvent("keydown", {
    key: "ArrowRight",
    ctrlKey: true,
    cancelable: true,
  });
  renderer.handleKeydown(forward);
  expect(forward.defaultPrevented).toBe(true);
  expect(selectThread).toHaveBeenLastCalledWith("thread-3");

  renderer.updateState({
    ...settings,
    codex: {
      ...settings.codex,
      threadId: "thread-3",
      threads: [
        { id: "thread-3", preview: "Next" },
        { id: "thread-1", preview: "Previous" },
        { id: "thread-2", preview: "Current" },
      ],
    },
  });
  const back = new KeyboardEvent("keydown", {
    key: "ArrowLeft",
    ctrlKey: true,
    cancelable: true,
  });
  renderer.handleKeydown(back);
  expect(back.defaultPrevented).toBe(true);
  expect(selectThread).toHaveBeenLastCalledWith("thread-2");
});

test("does not jump to the first thread when no current thread is selected", () => {
  const settings = {
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threads: [{ id: "thread-1", preview: "First" }] },
  };
  const { renderer } = makeRenderer(settings);
  renderer.updateState(settings);
  const selectThread = window.peskApi.selectCodexThread as jest.Mock;
  const next = new KeyboardEvent("keydown", {
    key: "ArrowRight",
    ctrlKey: true,
    cancelable: true,
  });

  renderer.handleKeydown(next);

  expect(next.defaultPrevented).toBe(false);
  expect(selectThread).not.toHaveBeenCalled();
});

test("keeps the selected thread visible when the thread list is temporarily stale", () => {
  const settings = {
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "selected-thread", threads: [] },
  };
  const { renderer, elements } = makeRenderer(settings);

  renderer.updateState(settings);

  expect(elements.select.value).toBe("selected-thread");
  expect(elements.select.options[0].value).toBe("selected-thread");
});

test("requests older history when scrolled to the top", () => {
  const { renderer, elements } = makeRenderer({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "thread-1", hasOlderHistory: true },
  });
  const loadOlder = window.peskApi.loadOlderCodexHistory as jest.Mock;

  renderer.updateState({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "thread-1", hasOlderHistory: true },
  });
  elements.history.scrollTop = 0;
  elements.history.dispatchEvent(new Event("scroll"));

  expect(loadOlder).toHaveBeenCalledTimes(1);
});

test("scrolls to a new user question without repeating for the same request", () => {
  const { renderer, elements } = makeRenderer();
  const settings: Settings = {
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      pendingUserInput: {
        requestId: "request-scroll",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        isBlocking: true,
        questions: [
          {
            id: "choice",
            header: "Implementation choice",
            question: "Which implementation should we use?",
            isOther: false,
            isSecret: false,
            options: [{ label: "Option A", description: "Use the first approach." }],
          },
        ],
      },
    },
  };

  elements.history.scrollTop = 120;
  renderer.updateState(settings);

  expect(elements.history.scrollTop).toBe(elements.history.scrollHeight);
  expect(document.activeElement).toBe(elements.userInput.querySelector("input[type='radio']"));

  elements.history.scrollTop = 120;
  renderer.updateState({ ...settings });

  expect(elements.history.scrollTop).toBe(120);
});

test("opens new plan activities by default and preserves manual collapse", () => {
  const { renderer, elements } = makeRenderer();
  const plan = {
    role: "system" as const,
    text: "plan details",
    itemId: "plan-1",
    activity: {
      kind: "plan" as const,
      status: "inProgress",
      details: "1. Inspect the project",
    },
  };
  const settings: Settings = {
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, history: [plan] },
  };

  renderer.updateState(settings);
  const details = elements.history.querySelector<HTMLDetailsElement>(".codex-plan-details")!;
  expect(details.open).toBe(true);

  details.open = false;
  renderer.updateState({ ...settings, codex: { ...settings.codex, history: [plan] } });
  expect(elements.history.querySelector<HTMLDetailsElement>(".codex-plan-details")!.open).toBe(
    false,
  );
});

test("scrolls when a plan appears, streams, and asks to implement", () => {
  jest.useFakeTimers();
  try {
    const { renderer, elements } = makeRenderer();
    const plan = {
      role: "system" as const,
      text: "plan details",
      itemId: "plan-scroll",
      activity: {
        kind: "plan" as const,
        status: "inProgress",
        details: "Initial plan",
      },
    };

    elements.history.scrollTop = 120;
    renderer.updateState({
      ...defaultRendererState(),
      codex: { ...defaultRendererState().codex, history: [plan] },
    });
    expect(elements.history.scrollTop).toBe(elements.history.scrollHeight);

    elements.history.scrollTop = 120;
    renderer.updateState({
      ...defaultRendererState(),
      codex: {
        ...defaultRendererState().codex,
        history: [
          {
            ...plan,
            activity: { ...plan.activity, details: "Updated plan" },
          },
        ],
      },
    });
    expect(elements.history.scrollTop).toBe(120);
    jest.advanceTimersByTime(100);
    expect(elements.history.scrollTop).toBe(elements.history.scrollHeight);

    elements.history.scrollTop = 120;
    renderer.updateState({
      ...defaultRendererState(),
      codex: {
        ...defaultRendererState().codex,
        history: [
          {
            ...plan,
            activity: {
              ...plan.activity,
              status: "completed",
              details: "Updated plan",
            },
          },
        ],
      },
    });
    expect(elements.userInput.querySelector(".codex-plan-implementation-prompt")).not.toBeNull();
    expect(elements.history.scrollTop).toBe(elements.history.scrollHeight);

    elements.history.scrollTop = 120;
    renderer.updateState({
      ...defaultRendererState(),
      codex: {
        ...defaultRendererState().codex,
        history: [
          {
            ...plan,
            activity: {
              ...plan.activity,
              status: "completed",
              details: "Updated plan",
            },
          },
        ],
      },
    });
    expect(elements.history.scrollTop).toBe(120);
  } finally {
    jest.useRealTimers();
  }
});

test("updates only streamed plan content after the batching window", () => {
  jest.useFakeTimers();
  try {
    const { renderer, elements } = makeRenderer();
    const initialSettings: Settings = {
      ...defaultRendererState(),
      codex: {
        ...defaultRendererState().codex,
        history: [
          {
            role: "system",
            text: "plan details",
            itemId: "plan-stream",
            activity: {
              kind: "plan",
              status: "inProgress",
              details: "Initial plan",
            },
          },
          { role: "assistant", text: "Unchanged message", itemId: "message-1" },
        ],
      },
    };
    renderer.updateState(initialSettings);
    const planDetails = elements.history.querySelector<HTMLDetailsElement>(
      "details[data-activity-key='plan-stream']",
    )!;
    const planContent = planDetails.querySelector<HTMLElement>(".codex-plan-content")!;
    const otherMessage = elements.history.querySelector<HTMLElement>(
      "[data-message-item-id='message-1']",
    );
    planDetails.open = false;

    renderer.updateState({
      ...initialSettings,
      codex: {
        ...initialSettings.codex,
        history: [
          {
            ...initialSettings.codex.history[0],
            text: "updated plan details",
            activity: {
              ...initialSettings.codex.history[0].activity!,
              kind: "plan",
              status: "inProgress",
              details: "Updated plan",
            },
          },
          initialSettings.codex.history[1],
        ],
      },
    });

    expect(planContent.textContent).toContain("Initial plan");
    jest.advanceTimersByTime(100);
    expect(planContent.textContent).toContain("Updated plan");
    expect(elements.history.querySelector<HTMLElement>("[data-message-item-id='message-1']")).toBe(
      otherMessage,
    );
    expect(planDetails.open).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test("shows the implementation question after a completed plan", async () => {
  const { renderer, elements } = makeRenderer();
  const settings: Settings = {
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [
        {
          role: "system",
          text: "plan details",
          itemId: "plan-2",
          activity: {
            kind: "plan",
            status: "completed",
            details: "1. Make the change",
          },
        },
      ],
    },
  };

  renderer.updateState(settings);
  expect(elements.history.querySelector(".codex-plan-implementation-prompt")).toBeNull();
  const prompt = elements.userInput.querySelector<HTMLElement>(
    ".codex-plan-implementation-prompt",
  )!;
  expect(prompt.textContent).toContain("Implement this plan?");
  const form = prompt.querySelector("form") as HTMLFormElement;
  const clearContext = form.querySelector<HTMLInputElement>("input[value='clear-context']")!;
  clearContext.checked = true;
  form.requestSubmit();

  expect(window.peskApi.implementCodexPlan).toHaveBeenCalledWith("1. Make the change", true);
  await Promise.resolve();
  expect(window.peskApi.focusCodexInput).toHaveBeenCalled();
});

test("shows and focuses the chat input after staying in plan mode", () => {
  const { renderer, elements } = makeRenderer();
  const settings: Settings = {
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [
        {
          role: "system",
          text: "plan details",
          itemId: "plan-stay",
          activity: {
            kind: "plan",
            status: "completed",
            details: "1. Make the change",
          },
        },
      ],
    },
  };

  renderer.updateState(settings);
  const prompt = elements.userInput.querySelector<HTMLElement>(
    ".codex-plan-implementation-prompt",
  )!;
  const form = prompt.querySelector("form") as HTMLFormElement;
  const stayPlan = form.querySelector<HTMLInputElement>("input[value='stay-plan']")!;
  stayPlan.checked = true;
  form.requestSubmit();

  expect(elements.userInput.hidden).toBe(true);
  expect(elements.form.hidden).toBe(false);
  expect(window.peskApi.focusCodexInput).toHaveBeenCalled();
  expect(document.activeElement).toBe(elements.input);
});

test("does not show the implementation question when another message follows the plan", () => {
  const { renderer, elements } = makeRenderer();
  const settings: Settings = {
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [
        {
          role: "system",
          text: "plan details",
          itemId: "plan-3",
          activity: {
            kind: "plan",
            status: "completed",
            details: "1. Make the change",
          },
        },
        { role: "assistant", text: "A later message" },
      ],
    },
  };

  renderer.updateState(settings);

  expect(elements.userInput.querySelector(".codex-plan-implementation-prompt")).toBeNull();
});

test("navigates options with arrows and submits the selected option with a note", () => {
  const { renderer, elements } = makeRenderer();
  const settings: Settings = {
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      pendingUserInput: {
        requestId: "request-2",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        isBlocking: true,
        questions: [
          {
            id: "choice",
            header: "Implementation choice",
            question: "Which implementation should we use?",
            isOther: true,
            isSecret: false,
            options: [
              { label: "Option A", description: "Use the first approach." },
              { label: "Option B", description: "Use the second approach." },
            ],
          },
        ],
      },
    },
  };

  renderer.updateState(settings);
  const options = elements.userInput.querySelectorAll<HTMLInputElement>("input[type='radio']");
  const note = elements.userInput.querySelector<HTMLInputElement>("input[data-note='true']")!;
  options[0].dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    }),
  );

  expect(options[1].checked).toBe(true);
  expect(document.activeElement).toBe(options[1]);
  expect(options).toHaveLength(3);
  expect(options[0].tabIndex).toBe(-1);
  expect(options[1].tabIndex).toBe(0);
  expect(options[2].value).toBe("Other");
  expect(elements.userInput.querySelector("input[data-other='true']")).toBeNull();
  expect(note.hidden).toBe(false);
  note.click();
  note.focus();
  expect(document.activeElement).toBe(note);
  options[1].dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(document.activeElement).toBe(note);
  note.value = "Discard this note.";
  note.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(note.value).toBe("");
  expect(document.activeElement).toBe(options[1]);
  renderer.handleKeydown(
    new KeyboardEvent("keydown", {
      key: "ArrowUp",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(document.activeElement).toBe(options[1]);
  options[1].dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    }),
  );
  note.value = "Keep the implementation simple.";
  note.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );

  expect(window.peskApi.respondCodexUserInput).toHaveBeenCalledWith("request-2", {
    choice: ["Option B", "Keep the implementation simple."],
  });
});

test("shows multiple questions one at a time and submits all answers at the end", () => {
  const { renderer, elements } = makeRenderer();
  const settings: Settings = {
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      pendingUserInput: {
        requestId: "request-3",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        isBlocking: true,
        questions: [
          {
            id: "first",
            header: "First question",
            question: "Choose the first value.",
            isOther: false,
            isSecret: false,
            options: [{ label: "A", description: "First" }],
          },
          {
            id: "second",
            header: "Second question",
            question: "Choose the second value.",
            isOther: false,
            isSecret: false,
            options: [{ label: "B", description: "Second" }],
          },
        ],
      },
    },
  };

  renderer.updateState(settings);
  expect(elements.userInput.textContent).toContain("First question");
  expect(elements.userInput.textContent).not.toContain("Second question");
  const firstOption = elements.userInput.querySelector<HTMLInputElement>("input[type='radio']")!;
  firstOption.checked = true;
  (elements.userInput.querySelector("form") as HTMLFormElement).requestSubmit();

  expect(elements.userInput.textContent).toContain("Second question");
  expect(elements.userInput.textContent).not.toContain("First question");
  const secondOption = elements.userInput.querySelector<HTMLInputElement>("input[type='radio']")!;
  secondOption.checked = true;
  (elements.userInput.querySelector("form") as HTMLFormElement).requestSubmit();

  expect(window.peskApi.respondCodexUserInput).toHaveBeenCalledWith("request-3", {
    first: ["A"],
    second: ["B"],
  });
});

test("searches and selects a file with the @ picker", async () => {
  const settings = {
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, cwd: "/tmp/project" },
  };
  const { elements } = makeRenderer(settings);
  elements.input.value = "Inspect @cod";
  elements.input.dispatchEvent(new Event("input", { bubbles: true }));
  await Promise.resolve();

  expect(elements.suggestions.hidden).toBe(false);
  expect(elements.suggestions.querySelectorAll("button")).toHaveLength(2);

  elements.input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  elements.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  expect(elements.input.value).toBe("Inspect src/config.ts ");
  expect(elements.suggestions.hidden).toBe(true);
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
});

test("shows and selects slash commands", () => {
  const { elements } = makeRenderer();
  elements.input.value = "/";
  elements.input.dispatchEvent(new Event("input", { bubbles: true }));

  expect(elements.suggestions.hidden).toBe(false);
  expect(
    [...elements.suggestions.querySelectorAll("button")].map((button) => button.textContent),
  ).toEqual([
    "/planSwitch to Plan mode",
    "/goalUsage: /goal [<objective>|clear|edit|pause|resume]",
    "/projectManage projects",
    "/defaultSwitch to Default mode",
    "/newStart a new Codex session",
    "/forkFork the current session",
    "/archiveArchive the current session",
    "/deletePermanently delete the current session",
    "/reviewReview current changes",
    "/execRun a sandboxed command",
  ]);

  elements.input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  elements.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  expect(elements.input.value).toBe("/goal ");
  expect(elements.suggestions.hidden).toBe(true);
});

test("shows the exec indicator immediately after slash suggestion selection", () => {
  const { elements } = makeRenderer();
  elements.input.value = "/exec";
  elements.input.dispatchEvent(new Event("input", { bubbles: true }));
  const execIndex = [...elements.suggestions.querySelectorAll("button")].findIndex((button) =>
    button.textContent?.startsWith("/exec"),
  );

  elements.suggestions
    .querySelectorAll("button")
    .item(execIndex)
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  expect(elements.input.value).toBe("/exec ");
  expect(elements.commandMode.hidden).toBe(false);
  expect(elements.commandMode.textContent).toBe("Exec · sandboxed");
});

test("shows the execution mode above the composer", () => {
  const { elements } = makeRenderer();

  expect(elements.commandMode.hidden).toBe(true);

  elements.input.value = "!git status";
  elements.input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(elements.commandMode).toMatchObject({
    hidden: false,
    textContent: "Shell · full access",
  });
  expect(elements.commandMode.dataset.mode).toBe("shell");

  elements.input.value = "/exec ls -la";
  elements.input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(elements.commandMode).toMatchObject({
    hidden: false,
    textContent: "Exec · sandboxed",
  });
  expect(elements.commandMode.dataset.mode).toBe("exec");

  elements.input.value = "hello";
  elements.input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(elements.commandMode.hidden).toBe(true);
});

test("marks failed command activity in red", () => {
  const { renderer, elements } = makeRenderer();
  renderer.updateState({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [
        {
          role: "system",
          text: "Command failed",
          itemId: "failed-command",
          activity: {
            kind: "command",
            command: "ejc",
            status: "failed",
          },
        },
      ],
    },
  });

  expect(elements.history.querySelector(".codex-activity-command-failed")).not.toBeNull();
});

test("expands user commands but collapses agent commands", () => {
  const { renderer, elements } = makeRenderer();
  renderer.updateState({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [
        {
          role: "system",
          text: "User shell command",
          itemId: "user-command",
          activity: {
            kind: "command",
            source: "userShell",
            userInitiated: true,
            command: "echo hi",
            status: "completed",
          },
        },
        {
          role: "system",
          text: "Agent command",
          itemId: "agent-command",
          activity: {
            kind: "command",
            source: "agent",
            command: "npm test",
            status: "completed",
          },
        },
      ],
    },
  });

  const details = [...elements.history.querySelectorAll("details")];
  expect(details[0]?.open).toBe(true);
  expect(details[1]?.open).toBe(false);
});

test("uses the documented default expansion for every activity type", () => {
  const { renderer, elements } = makeRenderer();
  renderer.updateState({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [
        {
          role: "system",
          text: "agent command",
          itemId: "command",
          activity: { kind: "command", source: "agent", command: "npm test" },
        },
        {
          role: "system",
          text: "file change",
          itemId: "file",
          activity: {
            kind: "fileChange",
            changes: ["src/app.ts\n+change"],
          },
        },
        {
          role: "system",
          text: "search",
          itemId: "search",
          activity: { kind: "webSearch", summary: "query" },
        },
        {
          role: "system",
          text: "tool",
          itemId: "tool",
          activity: { kind: "tool", label: "mcpToolCall" },
        },
        {
          role: "system",
          text: "plan",
          itemId: "plan",
          activity: { kind: "plan", details: "plan details" },
        },
        {
          role: "system",
          text: "review started",
          itemId: "review",
          activity: {
            kind: "other",
            label: "enteredReviewMode",
            status: "completed",
          },
        },
        {
          role: "system",
          text: "context compacted",
          itemId: "context-compaction",
          activity: {
            kind: "other",
            label: "contextCompaction",
            status: "completed",
          },
        },
        { role: "assistant", text: "ordinary response", itemId: "message" },
      ],
    },
  });

  const details = [...elements.history.querySelectorAll("details")];
  expect(details.map((item) => item.className)).toEqual([
    "codex-command-details",
    "codex-file-change-details",
    "codex-activity-details-block",
    "codex-activity-details-block",
    "codex-plan-details",
    "codex-activity-details-block",
    "codex-activity-details-block",
  ]);
  expect(details.map((item) => item.open)).toEqual([false, true, false, false, true, true, true]);
  expect(elements.history.querySelectorAll(".codex-message-assistant")).toHaveLength(1);
});

test("opens and submits the custom review form", async () => {
  const next = {
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "thread-review" },
  };
  const { elements } = makeRenderer(next);
  const startReview = window.peskApi.startCodexReview as jest.Mock;

  elements.input.value = "/review";
  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));

  const reviewForm = elements.userInput.querySelector("form");
  expect(reviewForm).not.toBeNull();
  expect(elements.form.hidden).toBe(true);
  expect(elements.userInput.textContent).toContain("What would you like Codex to review?");
  const reviewInput = reviewForm?.querySelector("textarea");
  expect(reviewInput).not.toBeNull();
  reviewInput!.value = "@cod";
  reviewInput!.selectionStart = reviewInput!.value.length;
  reviewInput!.selectionEnd = reviewInput!.value.length;
  reviewInput!.dispatchEvent(new Event("input"));
  await Promise.resolve();
  await Promise.resolve();
  expect(elements.suggestions.hidden).toBe(false);
  reviewInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
  expect(reviewInput!.value).toBe("src/codex.ts ");
  reviewInput!.value = "Check the changes for bugs and missing tests.";
  reviewForm!.dispatchEvent(new Event("submit", { cancelable: true }));
  await Promise.resolve();

  expect(startReview).toHaveBeenCalledWith("Check the changes for bugs and missing tests.");
  expect(elements.userInput.hidden).toBe(true);
  expect(elements.form.hidden).toBe(false);
});

test("does not open the review form without a selected thread", () => {
  const { renderer, elements } = makeRenderer(defaultRendererState());
  renderer.updateState(defaultRendererState());

  elements.input.value = "/review";
  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));

  expect(elements.userInput.hidden).toBe(true);
  expect(elements.form.hidden).toBe(false);
  expect(elements.input.value).toBe("/review");
});

test("cancels the custom review form and restores chat input", () => {
  const { elements } = makeRenderer({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "thread-review" },
  });

  elements.input.value = "/review";
  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  const reviewForm = elements.userInput.querySelector("form");
  reviewForm?.querySelector<HTMLButtonElement>("button[type='button']")?.click();

  expect(elements.userInput.hidden).toBe(true);
  expect(elements.form.hidden).toBe(false);
});

test("supports keyboard controls in the custom review form", async () => {
  const next = {
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "thread-review" },
  };
  const { elements } = makeRenderer(next);
  const startReview = window.peskApi.startCodexReview as jest.Mock;

  elements.input.value = "/review";
  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  const reviewForm = elements.userInput.querySelector("form")!;
  const reviewInput = reviewForm.querySelector("textarea")!;
  reviewInput.value = "line";
  reviewInput.selectionStart = 4;
  reviewInput.selectionEnd = 4;
  const newline = new KeyboardEvent("keydown", {
    key: "Enter",
    ctrlKey: true,
    cancelable: true,
  });
  reviewInput.dispatchEvent(newline);
  expect(newline.defaultPrevented).toBe(true);
  expect(reviewInput.value).toBe("line\n");

  reviewInput.value = "Submit this review";
  const submit = new KeyboardEvent("keydown", {
    key: "Enter",
    cancelable: true,
  });
  reviewInput.dispatchEvent(submit);
  await Promise.resolve();
  expect(submit.defaultPrevented).toBe(true);
  expect(startReview).toHaveBeenCalledWith("Submit this review");

  elements.input.value = "/review";
  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  const secondInput = elements.userInput.querySelector("textarea")!;
  const escape = new KeyboardEvent("keydown", {
    key: "Escape",
    cancelable: true,
  });
  secondInput.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(elements.userInput.hidden).toBe(true);
});

test("keeps Enter as a newline in the web review textarea", () => {
  const next = {
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "thread-review" },
  };
  const { elements } = makeRenderer(next, true);
  const startReview = window.peskApi.startCodexReview as jest.Mock;

  elements.input.value = "/review";
  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  const reviewInput = elements.userInput.querySelector("textarea")!;
  reviewInput.value = "line";
  reviewInput.selectionStart = reviewInput.value.length;
  reviewInput.selectionEnd = reviewInput.value.length;
  const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
  reviewInput.dispatchEvent(enter);

  expect(enter.defaultPrevented).toBe(true);
  expect(reviewInput.value).toBe("line\n");
  expect(startReview).not.toHaveBeenCalled();
});

test("styles and expands review activities by default", () => {
  const settings = {
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      threadId: "thread-review",
      history: [
        {
          role: "system" as const,
          text: "Activity",
          itemId: "review-enter",
          activity: {
            kind: "other" as const,
            label: "enteredReviewMode",
            summary: "review changes in codex.ts",
          },
        },
      ],
    },
  };
  const { renderer, elements } = makeRenderer(settings);

  renderer.updateState(settings);

  const bubble = elements.history.querySelector(".codex-message");
  expect(bubble?.classList.contains("codex-activity-review")).toBe(true);
  expect(bubble?.querySelector("details")?.open).toBe(true);
});

test("submits a prompt, queues while working, and handles input shortcuts", async () => {
  const next = {
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "thread-2" },
  };
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

  renderer.updateState({ ...next, codex: { ...next.codex, status: "working" } });
  const interrupt = window.peskApi.interruptCodexTurn as jest.Mock;
  const interruptEvent = new KeyboardEvent("keydown", {
    key: "c",
    ctrlKey: true,
    cancelable: true,
  });
  elements.input.dispatchEvent(interruptEvent);
  expect(interruptEvent.defaultPrevented).toBe(true);
  expect(interrupt).toHaveBeenCalledTimes(1);

  elements.input.value = "blocked";
  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await Promise.resolve();
  expect(submit).toHaveBeenCalledTimes(2);
  expect(submit).toHaveBeenLastCalledWith("blocked");
});

test("opens the guided project flow for /new", async () => {
  const { elements } = makeRenderer({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      projects: [
        {
          id: "project-1",
          name: "Workspace",
          roots: [{ path: "/workspace" }],
          metadata: {},
          position: 0,
          createdAt: 1,
          updatedAt: 1,
          recencyAt: null,
        },
      ],
    },
  });
  elements.input.value = "/new /ignored-path";
  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await Promise.resolve();
  await Promise.resolve();
  expect(elements.input.value).toBe("");
  expect(elements.userInput.querySelector("legend")?.textContent).toBe("New project thread");
  expect(elements.userInput.querySelector("select[aria-label='Thread root']")).not.toBeNull();
});

test("refocuses the composer after a project thread is selected", () => {
  const { renderer, elements } = makeRenderer({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "old-thread" },
  });
  document.body.dataset.projectThread = "true";
  elements.userInput.dataset.projectThread = "true";
  renderer.updateState({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "new-thread" },
  });
  expect(window.peskApi.focusCodexInput).toHaveBeenCalled();
  expect(elements.form.hidden).toBe(false);
});

test("cycles through submitted prompt history and restores the draft", async () => {
  const { renderer, elements } = makeRenderer({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "thread-2" },
  });
  const submit = window.peskApi.submitCodexPrompt as jest.Mock;

  for (const prompt of ["first", "/plan"]) {
    elements.input.value = prompt;
    elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
    await Promise.resolve();
  }

  elements.input.value = "draft";
  elements.input.setSelectionRange(elements.input.value.length, elements.input.value.length);
  const previous = new KeyboardEvent("keydown", {
    key: "ArrowUp",
    cancelable: true,
  });
  elements.input.dispatchEvent(previous);
  expect(previous.defaultPrevented).toBe(true);
  expect(elements.input.value).toBe("/plan");

  elements.input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
  expect(elements.input.value).toBe("first");

  elements.input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  expect(elements.input.value).toBe("/plan");
  elements.input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  expect(elements.input.value).toBe("draft");
  expect(submit).toHaveBeenCalledTimes(2);
  void renderer;
});

test("keeps normal multiline arrow movement away from prompt history boundaries", async () => {
  const { elements } = makeRenderer({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "thread-2" },
  });
  elements.input.value = "previous";
  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await Promise.resolve();

  elements.input.value = "first line\nsecond line";
  elements.input.setSelectionRange("first line\n".length + 3, "first line\n".length + 3);
  const up = new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true });
  elements.input.dispatchEvent(up);
  expect(up.defaultPrevented).toBe(false);
  expect(elements.input.value).toBe("first line\nsecond line");

  elements.input.setSelectionRange(3, 3);
  const down = new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true });
  elements.input.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(false);
});

test("deduplicates consecutive prompts and caps prompt history at 100 entries", async () => {
  const { elements } = makeRenderer({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "thread-2" },
  });
  for (let index = 0; index < 102; index += 1) {
    elements.input.value = index === 1 ? "prompt-0" : `prompt-${index}`;
    elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
    await Promise.resolve();
  }

  elements.input.value = "";
  elements.input.setSelectionRange(0, 0);
  for (let index = 0; index < 100; index += 1) {
    elements.input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
  }
  expect(elements.input.value).toBe("prompt-2");

  elements.input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
  expect(elements.input.value).toBe("prompt-2");
});

test("renders attached images in user message history", () => {
  const { renderer, elements } = makeRenderer({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [
        {
          role: "user",
          text: "inspect this",
          images: [{ url: "data:image/png;base64,abc", name: "screen.png" }],
        },
      ],
    },
  });

  renderer.updateState({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [
        {
          role: "user",
          text: "inspect this",
          images: [{ url: "data:image/png;base64,abc", name: "screen.png" }],
        },
      ],
    },
  });

  expect(elements.history.querySelector(".codex-message-image")).toMatchObject({
    src: "data:image/png;base64,abc",
    alt: "Attached image: screen.png",
  });
});

test("keeps web chat input focused before and after an async submission", async () => {
  const next = {
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "thread-web" },
  };
  const { renderer, elements } = makeRenderer(next, true);
  renderer.updateState(next);
  elements.history.scrollTop = 0;
  let resolveSubmit!: (settings: Settings) => void;
  const submit = window.peskApi.submitCodexPrompt as jest.Mock;
  submit.mockImplementation(() => new Promise<Settings>((resolve) => (resolveSubmit = resolve)));
  elements.input.value = "hello";
  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await Promise.resolve();

  expect(document.activeElement).toBe(elements.input);
  expect(submit).toHaveBeenCalledWith("hello");

  resolveSubmit(next);
  await Promise.resolve();
  expect(elements.history.scrollTop).toBe(elements.history.scrollHeight);
  expect(document.activeElement).toBe(elements.input);
});

test("keeps Enter as a newline in the web chat input", async () => {
  const next = {
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "thread-web" },
  };
  const { elements } = makeRenderer(next, true);
  const submit = window.peskApi.submitCodexPrompt as jest.Mock;

  elements.input.value = "line";
  elements.input.selectionStart = elements.input.value.length;
  elements.input.selectionEnd = elements.input.value.length;
  const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
  elements.input.dispatchEvent(enter);

  expect(enter.defaultPrevented).toBe(true);
  expect(elements.input.value).toBe("line\n");
  expect(submit).not.toHaveBeenCalled();

  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await Promise.resolve();
  expect(submit).toHaveBeenCalledWith("line");
});

test("adjusts web chat form visibility on visual viewport resize", () => {
  const resizeListeners = new Set<() => void>();
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: {
      addEventListener: (_type: string, listener: () => void) => resizeListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) =>
        resizeListeners.delete(listener),
    },
  });
  const { elements } = makeRenderer(defaultRendererState(), true);

  for (const listener of resizeListeners) listener();

  expect(elements.history.scrollTop).toBe(elements.history.scrollHeight);
  expect(resizeListeners.size).toBe(1);
  window.dispatchEvent(new Event("pagehide"));
  expect(resizeListeners.size).toBe(0);
});

test("renders approval options and completed approval states", () => {
  const { renderer, elements } = makeRenderer();
  renderer.updateState({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      threadId: "thread-1",
      pendingApproval: {
        requestId: 7,
        command: "permission",
        reason: "Needs approval",
        options: [
          { id: "accept", label: "Approve once", description: "" },
          { id: "decline", label: "Decline", description: "" },
        ],
      },
    },
  });
  const approve = elements.userInput.querySelector(
    "input[type='radio'][value='accept']",
  ) as HTMLInputElement;
  const deny = elements.userInput.querySelector(
    "input[type='radio'][value='decline']",
  ) as HTMLInputElement;
  approve.click();
  (elements.userInput.querySelector("form") as HTMLFormElement).requestSubmit();
  expect(window.peskApi.respondCodexPermission).toHaveBeenCalledWith(7, "accept");
  expect(approve.value).toBe("accept");
  expect(deny.value).toBe("decline");
  expect(approve).toBeTruthy();
  expect(deny).toBeTruthy();

  renderer.updateState({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [
        {
          role: "system",
          text: "permission",
          approval: { requestId: 7, state: "approved" },
        },
      ],
    },
  });
  expect(elements.history.textContent).toContain("Approved");
});

test("blurs the input when selecting a message with Alt+Up", () => {
  const { renderer, elements } = makeRenderer({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, history: [{ role: "user", text: "copy this" }] },
  });
  renderer.updateState({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, history: [{ role: "user", text: "copy this" }] },
  });
  elements.input.focus();
  (elements.history.querySelector(".codex-message") as HTMLElement).scrollIntoView = jest.fn();

  const event = new KeyboardEvent("keydown", {
    key: "ArrowUp",
    altKey: true,
    cancelable: true,
  });
  renderer.handleKeydown(event);

  expect(event.defaultPrevented).toBe(true);
  expect(document.activeElement).not.toBe(elements.input);
});

test("renders working and completed elapsed states", () => {
  jest.useFakeTimers();
  const { renderer, elements } = makeRenderer();
  const now = Date.now();
  jest.setSystemTime(now);
  renderer.updateState({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, workingSince: now - 65000 },
  });
  expect(elements.workingStatus.hidden).toBe(false);
  expect(elements.workingElapsed.textContent).toBe("1m 5s");
  jest.advanceTimersByTime(220 * 10);
  jest.advanceTimersByTime(220 * 5);

  renderer.updateState({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, workedElapsed: 3661000 },
  });
  expect(elements.workingStatus.hidden).toBe(false);
  expect(elements.workingStatus.textContent).toContain("Worked for");
  expect(elements.workingElapsed.textContent).toBe("1h 1m 1s");

  renderer.updateState({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, workedElapsed: 1000, interrupted: true },
  });
  expect(elements.workingStatus.hidden).toBe(false);
  expect(elements.workingStatus.textContent).toContain("Conversation interrupted");
  expect(elements.workingStatus.classList.contains("codex-working-status-interrupted")).toBe(true);
});

test("renders complete usage, rate-limit, and goal details", () => {
  const { renderer, elements } = makeRenderer();
  renderer.updateState({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      threadId: "thread-1",
      cwd: "/tmp/project",
      threads: [{ id: "thread-1", projectId: "project-1" }],
      projects: [
        {
          id: "project-1",
          name: "Frontend",
          roots: [{ path: "/tmp/project" }],
          metadata: {},
          position: 0,
          createdAt: 1,
          updatedAt: 1,
          recencyAt: null,
        },
      ],
      modelInfo: {
        model: "model",
        provider: "provider",
        reasoningEffort: "high",
        serviceTier: "fast",
      },
      tokenUsage: {
        total: {
          totalTokens: 1_500_000,
          inputTokens: 1_200_000,
          outputTokens: 300_000,
          cachedInputTokens: 12_000,
          reasoningOutputTokens: 8_000,
        },
        last: { totalTokens: 2_000, inputTokens: 2_000 },
        modelContextWindow: 1_000,
      },
      rateLimits: {
        primary: { usedPercent: 85.4, windowDurationMins: 60, resetsAt: 1_700_000_000 },
        secondary: { usedPercent: 20, windowDurationMins: 1_440, resetsAt: null },
        credits: { hasCredits: true, unlimited: false, balance: "10" },
        individualLimit: {
          limit: "100",
          used: "25",
          remainingPercent: 75,
          resetsAt: 1_700_000_000,
        },
        spendControlReached: false,
        planType: "pro_plan",
        rateLimitReachedType: null,
      },
      goal: {
        threadId: "thread-1",
        objective: "Improve coverage",
        status: "active",
        tokenBudget: 1_500_000,
        tokensUsed: 1_200,
        timeUsedSeconds: 3661,
      },
    },
  });

  expect(elements.tokenUsage.textContent).toContain("1.50m");
  expect(elements.tokenUsage.textContent).toContain("/tmp/project");
  expect(elements.tokenUsage.textContent).toContain("Frontend");
  expect(elements.tokenUsage.textContent).toContain("Reasoning 8.0k");
  const modelLine = elements.tokenUsage.querySelector(".codex-model-line");
  expect(modelLine?.textContent).toContain("Reasoning high");
  expect(modelLine?.textContent?.indexOf("Reasoning high")).toBeLessThan(
    modelLine?.textContent?.indexOf("Context") ?? -1,
  );
  expect(modelLine?.textContent?.indexOf("Frontend")).toBeLessThan(
    modelLine?.textContent?.indexOf("/tmp/project") ?? -1,
  );
  expect((renderer as any).goal.textContent).toContain("Improve coverage");
});

test("keeps the project name when the thread list entry has no project field", () => {
  const { renderer, elements } = makeRenderer();
  renderer.updateState({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      threadId: "thread-2",
      projectId: "project-1",
      cwd: "/tmp/project",
      modelInfo: { model: "model" },
      threads: [{ id: "thread-2" }],
      projects: [
        {
          id: "project-1",
          name: "Frontend",
          roots: [{ path: "/tmp/project" }],
          metadata: {},
          position: 0,
          createdAt: 1,
          updatedAt: 1,
          recencyAt: null,
        },
      ],
    },
  });
  expect(elements.tokenUsage.querySelector(".codex-project-name")?.textContent).toBe("Frontend ·");
});

test("keeps a thread project name after switching away and back", () => {
  const { renderer, elements } = makeRenderer();
  const projectState = {
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      threadId: "thread-1",
      projectId: "project-1",
      cwd: "/tmp/project",
      threads: [{ id: "thread-1", projectId: "project-1" }],
      projects: [
        {
          id: "project-1",
          name: "Frontend",
          roots: [{ path: "/tmp/project" }],
          metadata: {},
          position: 0,
          createdAt: 1,
          updatedAt: 1,
          recencyAt: null,
        },
      ],
      modelInfo: { model: "model" },
    },
  };
  renderer.updateState(projectState);
  renderer.updateState({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "thread-2" },
  });
  renderer.updateState({
    ...projectState,
    codex: { ...projectState.codex, projectId: undefined, threads: [{ id: "thread-1" }] },
  });
  expect(elements.tokenUsage.querySelector(".codex-project-name")?.textContent).toBe("Frontend ·");
});

test("falls back to the project root for an empty thread", () => {
  const { renderer, elements } = makeRenderer();
  renderer.updateState({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      threadId: "empty-thread",
      cwd: "/tmp/project",
      threads: [{ id: "empty-thread" }],
      projects: [
        {
          id: "project-1",
          name: "Frontend",
          roots: [{ path: "/tmp/project" }],
          metadata: {},
          position: 0,
          createdAt: 1,
          updatedAt: 1,
          recencyAt: null,
        },
      ],
      modelInfo: { model: "model" },
    },
  });
  expect(elements.tokenUsage.querySelector(".codex-project-name")?.textContent).toBe("Frontend ·");
});

test("handles history keyboard actions and sanitizes message markup", async () => {
  const { renderer, elements } = makeRenderer({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [
        { role: "user", text: "copy me", itemId: "user-1" },
        {
          role: "system",
          text: "activity",
          itemId: "activity-1",
          activity: { kind: "command", status: "completed", command: "echo hi" },
        },
        {
          role: "assistant",
          text: '<a href="javascript:bad" onclick="bad()">link</a><img src="bad">',
          itemId: "assistant-1",
        },
      ],
    },
  });
  renderer.updateState({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [
        { role: "user", text: "copy me", itemId: "user-1" },
        {
          role: "system",
          text: "activity",
          itemId: "activity-1",
          activity: { kind: "command", status: "completed", command: "echo hi" },
        },
        {
          role: "assistant",
          text: '<a href="javascript:bad" onclick="bad()">link</a><img src="bad">',
          itemId: "assistant-1",
        },
      ],
    },
  });
  const messages = elements.history.querySelectorAll<HTMLElement>(".codex-message");
  messages[0].scrollIntoView = jest.fn();
  messages[1].querySelector("summary")?.dispatchEvent(new MouseEvent("click"));

  renderer.handleKeydown(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true }));
  renderer.handleKeydown(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true }));
  renderer.handleKeydown(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
  renderer.handleKeydown(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true }));
  await Promise.resolve();

  expect(elements.input.value).toBe("copy me");
  expect(elements.history.querySelector("a")?.getAttribute("href")).toBeNull();
  expect(elements.history.querySelector("img")).toBeNull();
});

test("handles global history shortcuts and selected-message actions", async () => {
  const { renderer, elements } = makeRenderer({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [
        { role: "user", text: "first", itemId: "user-1" },
        { role: "assistant", text: "answer", itemId: "assistant-1" },
      ],
    },
  });
  renderer.updateState({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      history: [
        { role: "user", text: "first", itemId: "user-1" },
        {
          role: "system",
          text: "activity",
          itemId: "activity-1",
          activity: { kind: "command", status: "completed" },
        },
        { role: "assistant", text: "answer", itemId: "assistant-1" },
      ],
    },
  });
  const internal = renderer as any;
  internal.selectedMessageIndex = 0;
  const clipboard = { writeText: jest.fn(async () => undefined) };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

  const copy = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, cancelable: true });
  renderer.handleKeydown(copy);
  await Promise.resolve();
  expect(clipboard.writeText).toHaveBeenCalledWith("first");

  const copyToInput = new KeyboardEvent("keydown", {
    key: "ArrowRight",
    altKey: true,
    cancelable: true,
  });
  renderer.handleKeydown(copyToInput);
  expect(elements.input.value).toBe("first");

  const top = new KeyboardEvent("keydown", { key: "Home", altKey: true, cancelable: true });
  renderer.handleKeydown(top);
  const bottom = new KeyboardEvent("keydown", { key: "End", altKey: true, cancelable: true });
  renderer.handleKeydown(bottom);
  expect(elements.history.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  expect(elements.history.scrollTo).toHaveBeenCalledWith({ top: 800, behavior: "smooth" });

  const selectUser = new KeyboardEvent("keydown", {
    key: "ArrowDown",
    altKey: true,
    shiftKey: true,
    cancelable: true,
  });
  renderer.handleKeydown(selectUser);
  const scroll = new KeyboardEvent("keydown", {
    key: "ArrowDown",
    shiftKey: true,
    cancelable: true,
  });
  renderer.handleKeydown(scroll);
  expect(elements.history.scrollBy).toHaveBeenCalledWith({ top: 64, behavior: "smooth" });

  internal.selectedMessageIndex = 1;
  const toggle = new KeyboardEvent("keydown", {
    key: "Enter",
    shiftKey: true,
    cancelable: true,
  });
  renderer.handleKeydown(toggle);
  expect(toggle.defaultPrevented).toBe(true);
});

test("renders optional controls and handles image attachment events", async () => {
  const { renderer, elements } = makeRenderer();
  const internal = renderer as any;
  const imageInput = document.querySelector("#codex-image-input") as HTMLInputElement;
  const imageAttachments = document.querySelector("#codex-image-attachments") as HTMLElement;
  const imageSelect = document.querySelector("#codex-image-select") as HTMLButtonElement;
  (window.peskApi as any).setChatFileDialogOpen = jest.fn();
  (window.peskApi as any).steerCodexTurn = jest.fn(async () => state);
  const readAsDataURL = jest
    .spyOn(FileReader.prototype, "readAsDataURL")
    .mockImplementation(function (this: FileReader) {
      Object.defineProperty(this, "result", {
        configurable: true,
        value: "data:image/png;base64,x",
      });
      this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
    });

  imageSelect.click();
  expect(window.peskApi.setChatFileDialogOpen).toHaveBeenCalledWith(true);
  const file = new File(["image"], "screen.png", { type: "image/png" });
  const paste = new Event("paste", { bubbles: true, cancelable: true }) as any;
  paste.clipboardData = {
    items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
  };
  elements.input.dispatchEvent(paste);
  await Promise.resolve();
  await Promise.resolve();
  expect(imageAttachments.querySelector("img")).not.toBeNull();
  expect(readAsDataURL).toHaveBeenCalled();

  const state = {
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      threadId: "thread-1",
      status: "working" as const,
      collaborationMode: "plan" as const,
    },
  };
  renderer.updateState(state);
  expect(internal.steerButton.disabled).toBe(false);
  expect(internal.modeToggle.textContent).toBe("Plan");
  elements.input.value = "continue";
  elements.steerButton.click();
  await Promise.resolve();
  expect(window.peskApi.steerCodexTurn).toHaveBeenCalledWith("continue");

  const imageTransfer = {
    items: [{ kind: "file", type: "image/png" }],
    files: [file],
  };
  const dragover = new Event("dragover", { bubbles: true, cancelable: true }) as any;
  dragover.dataTransfer = imageTransfer;
  elements.form.dispatchEvent(dragover);
  expect(elements.form.classList.contains("codex-drop-active")).toBe(true);
  const dragleave = new Event("dragleave", { bubbles: true }) as any;
  dragleave.relatedTarget = document.body;
  elements.form.dispatchEvent(dragleave);
  const drop = new Event("drop", { bubbles: true, cancelable: true }) as any;
  drop.dataTransfer = imageTransfer;
  elements.form.dispatchEvent(drop);
  await Promise.resolve();

  renderer.updateState({
    ...state,
    codex: {
      ...state.codex,
      queuedSubmissions: [
        {
          id: "queued-1",
          clientUserMessageId: "client-1",
          text: "queued",
          images: [{ url: "data:image/png;base64,q" }],
        },
      ],
    },
  });
  expect(elements.history.querySelector(".codex-queued-submission-image")).not.toBeNull();
  readAsDataURL.mockRestore();
});

test("handles submit, steer, and suggestion dismissal shortcuts", async () => {
  const { renderer, elements } = makeRenderer({
    ...defaultRendererState(),
    codex: { ...defaultRendererState().codex, threadId: "thread-1", status: "working" },
  });
  const submit = window.peskApi.submitCodexPrompt as jest.Mock;
  (window.peskApi as any).steerCodexTurn = jest.fn(async () => defaultRendererState());
  elements.input.value = "/plan";
  elements.input.dispatchEvent(new Event("input", { bubbles: true }));
  elements.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(elements.suggestions.hidden).toBe(true);

  elements.input.value = "prompt";
  elements.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
  await Promise.resolve();
  expect(submit).toHaveBeenCalled();

  elements.input.value = "steer me";
  elements.input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", altKey: true, cancelable: true }),
  );
  await Promise.resolve();
  expect(window.peskApi.steerCodexTurn).toHaveBeenCalledWith("steer me");
});

test("renders free-text questions and file-change details", () => {
  const { renderer, elements } = makeRenderer();
  renderer.updateState({
    ...defaultRendererState(),
    codex: {
      ...defaultRendererState().codex,
      pendingUserInput: {
        requestId: "request-text",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        isBlocking: true,
        questions: [
          {
            id: "secret",
            header: "Secret",
            question: "Enter a secret",
            isOther: true,
            isSecret: true,
            options: [],
          },
        ],
      },
      history: [
        {
          role: "system",
          text: "file change",
          itemId: "file-1",
          activity: {
            kind: "fileChange",
            status: "completed",
            changes: ["src/app.ts\n  +added\n  -removed\n  @@ hunk\n  context"],
          },
        },
      ],
    },
  });

  const input = elements.userInput.querySelector<HTMLInputElement>("input[data-other='true']");
  expect(input?.type).toBe("password");
  expect(elements.history.querySelector(".codex-file-change-added")).not.toBeNull();
  expect(elements.history.querySelector(".codex-file-change-removed")).not.toBeNull();
  expect(elements.history.querySelector(".codex-file-change-hunk")).not.toBeNull();
  expect(elements.history.querySelector(".codex-file-change-context")).not.toBeNull();
});
