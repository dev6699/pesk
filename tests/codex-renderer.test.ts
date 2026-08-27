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

function makeRenderer(
  settings: Settings = defaultSettings(),
  webChat = false,
): {
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
    suggestions: HTMLElement;
    userInput: HTMLElement;
  };
} {
  document.body.className = webChat ? "web-chat" : "";
  document.body.innerHTML = `
    <section id="chat"></section>
    <select id="select"></select>
    <button id="copy">Copy</button>
    <div id="error"></div>
    <div id="history"></div>
    <div id="working"><span></span><span id="elapsed"></span></div>
    <div id="usage"></div>
    <section id="user-input"></section>
    <form id="form">
      <textarea id="input"></textarea>
      <div id="suggestions"></div>
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
    form: document.querySelector("#form") as HTMLFormElement,
    input: document.querySelector("#input") as HTMLTextAreaElement,
    suggestions: document.querySelector("#suggestions") as HTMLElement,
    userInput: document.querySelector("#user-input") as HTMLElement,
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
    setCodexCollaborationMode: jest.fn(),
    focusCodexInput: jest.fn(),
    implementCodexPlan: jest.fn(async () => settings),
    interruptCodexTurn: jest.fn(async () => true),
    submitCodexPrompt: jest.fn(async () => settings),
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
    undefined,
    elements.userInput,
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
      last: { totalTokens: 4000, inputTokens: 500 },
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

test("renders readable keyboard-friendly user questions", () => {
  const { renderer, elements } = makeRenderer();
  const question = "Which implementation should we use? ".repeat(8);
  const settings: Settings = {
    ...defaultSettings(),
    codexPendingUserInput: {
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
          options: [
            { label: "Option A", description: "Use the first approach." },
          ],
        },
      ],
    },
  };

  renderer.updateSettings(settings);

  expect(elements.userInput.hidden).toBe(false);
  expect(elements.form.hidden).toBe(true);
  expect(elements.userInput.textContent).toContain(question);
  expect(document.activeElement).toBe(
    elements.userInput.querySelector("input[type='radio']"),
  );
  const input = elements.userInput.querySelector<HTMLInputElement>(
    "input[type='radio']",
  )!;
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
  expect(window.peskApi.respondCodexUserInput).toHaveBeenCalledWith(
    "request-1",
    { choice: ["Option A"] },
  );
  expect(window.peskApi.focusCodexInput).toHaveBeenCalled();
  expect(document.activeElement).toBe(elements.input);
});

test("preserves modified arrow shortcuts while a question is focused", () => {
  const { renderer, elements } = makeRenderer();
  const settings: Settings = {
    ...defaultSettings(),
    codexHistory: [
      { role: "user", text: "first" },
      { role: "assistant", text: "second" },
    ],
    codexPendingUserInput: {
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
  };
  renderer.updateSettings(settings);
  const option = elements.userInput.querySelector<HTMLInputElement>(
    "input[type='radio']",
  )!;
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
  const handleKeydown = (event: KeyboardEvent): void =>
    renderer.handleKeydown(event);
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
  expect(
    elements.history.querySelector(".codex-message-selected"),
  ).not.toBeNull();

  const plainArrow = new KeyboardEvent("keydown", {
    key: "ArrowDown",
    bubbles: true,
    cancelable: true,
  });
  option.dispatchEvent(plainArrow);
  expect(plainArrow.defaultPrevented).toBe(true);
  expect(
    elements.userInput.querySelectorAll<HTMLInputElement>(
      "input[type='radio']",
    )[1].checked,
  ).toBe(true);
  document.removeEventListener("keydown", handleKeydown, true);
});

test("Ctrl+Up refocuses the question after history navigation", () => {
  const { renderer, elements } = makeRenderer({
    ...defaultSettings(),
    codexPendingUserInput: {
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
  });
  renderer.updateSettings({
    ...defaultSettings(),
    codexPendingUserInput: {
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
  });
  const option = elements.userInput.querySelector<HTMLInputElement>(
    "input[type='radio']",
  )!;

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

test("scrolls to a new user question without repeating for the same request", () => {
  const { renderer, elements } = makeRenderer();
  const settings: Settings = {
    ...defaultSettings(),
    codexPendingUserInput: {
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
          options: [
            { label: "Option A", description: "Use the first approach." },
          ],
        },
      ],
    },
  };

  elements.history.scrollTop = 120;
  renderer.updateSettings(settings);

  expect(elements.history.scrollTop).toBe(elements.history.scrollHeight);
  expect(document.activeElement).toBe(
    elements.userInput.querySelector("input[type='radio']"),
  );

  elements.history.scrollTop = 120;
  renderer.updateSettings({ ...settings });

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
    ...defaultSettings(),
    codexHistory: [plan],
  };

  renderer.updateSettings(settings);
  const details = elements.history.querySelector<HTMLDetailsElement>(
    ".codex-plan-details",
  )!;
  expect(details.open).toBe(true);

  details.open = false;
  renderer.updateSettings({ ...settings, codexHistory: [plan] });
  expect(
    elements.history.querySelector<HTMLDetailsElement>(".codex-plan-details")!
      .open,
  ).toBe(false);
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
    renderer.updateSettings({ ...defaultSettings(), codexHistory: [plan] });
    expect(elements.history.scrollTop).toBe(elements.history.scrollHeight);

    elements.history.scrollTop = 120;
    renderer.updateSettings({
      ...defaultSettings(),
      codexHistory: [
        {
          ...plan,
          activity: { ...plan.activity, details: "Updated plan" },
        },
      ],
    });
    expect(elements.history.scrollTop).toBe(120);
    jest.advanceTimersByTime(100);
    expect(elements.history.scrollTop).toBe(elements.history.scrollHeight);

    elements.history.scrollTop = 120;
    renderer.updateSettings({
      ...defaultSettings(),
      codexHistory: [
        {
          ...plan,
          activity: {
            ...plan.activity,
            status: "completed",
            details: "Updated plan",
          },
        },
      ],
    });
    expect(
      elements.userInput.querySelector(".codex-plan-implementation-prompt"),
    ).not.toBeNull();
    expect(elements.history.scrollTop).toBe(elements.history.scrollHeight);

    elements.history.scrollTop = 120;
    renderer.updateSettings({
      ...defaultSettings(),
      codexHistory: [
        {
          ...plan,
          activity: {
            ...plan.activity,
            status: "completed",
            details: "Updated plan",
          },
        },
      ],
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
      ...defaultSettings(),
      codexHistory: [
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
    };
    renderer.updateSettings(initialSettings);
    const planDetails = elements.history.querySelector<HTMLDetailsElement>(
      "details[data-activity-key='plan-stream']",
    )!;
    const planContent = planDetails.querySelector<HTMLElement>(
      ".codex-plan-content",
    )!;
    const otherMessage = elements.history.querySelector<HTMLElement>(
      "[data-message-item-id='message-1']",
    );
    planDetails.open = false;

    renderer.updateSettings({
      ...initialSettings,
      codexHistory: [
        {
          ...initialSettings.codexHistory[0],
          text: "updated plan details",
          activity: {
            ...initialSettings.codexHistory[0].activity!,
            kind: "plan",
            status: "inProgress",
            details: "Updated plan",
          },
        },
        initialSettings.codexHistory[1],
      ],
    });

    expect(planContent.textContent).toContain("Initial plan");
    jest.advanceTimersByTime(100);
    expect(planContent.textContent).toContain("Updated plan");
    expect(
      elements.history.querySelector<HTMLElement>(
        "[data-message-item-id='message-1']",
      ),
    ).toBe(otherMessage);
    expect(planDetails.open).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test("shows the implementation question after a completed plan", async () => {
  const { renderer, elements } = makeRenderer();
  const settings: Settings = {
    ...defaultSettings(),
    codexHistory: [
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
  };

  renderer.updateSettings(settings);
  expect(
    elements.history.querySelector(".codex-plan-implementation-prompt"),
  ).toBeNull();
  const prompt = elements.userInput.querySelector<HTMLElement>(
    ".codex-plan-implementation-prompt",
  )!;
  expect(prompt.textContent).toContain("Implement this plan?");
  const form = prompt.querySelector("form") as HTMLFormElement;
  const clearContext = form.querySelector<HTMLInputElement>(
    "input[value='clear-context']",
  )!;
  clearContext.checked = true;
  form.requestSubmit();

  expect(window.peskApi.implementCodexPlan).toHaveBeenCalledWith(
    "1. Make the change",
    true,
  );
  await Promise.resolve();
  expect(window.peskApi.focusCodexInput).toHaveBeenCalled();
});

test("shows and focuses the chat input after staying in plan mode", () => {
  const { renderer, elements } = makeRenderer();
  const settings: Settings = {
    ...defaultSettings(),
    codexHistory: [
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
  };

  renderer.updateSettings(settings);
  const prompt = elements.userInput.querySelector<HTMLElement>(
    ".codex-plan-implementation-prompt",
  )!;
  const form = prompt.querySelector("form") as HTMLFormElement;
  const stayPlan = form.querySelector<HTMLInputElement>(
    "input[value='stay-plan']",
  )!;
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
    ...defaultSettings(),
    codexHistory: [
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
  };

  renderer.updateSettings(settings);

  expect(
    elements.userInput.querySelector(".codex-plan-implementation-prompt"),
  ).toBeNull();
});

test("navigates options with arrows and submits the selected option with a note", () => {
  const { renderer, elements } = makeRenderer();
  const settings: Settings = {
    ...defaultSettings(),
    codexPendingUserInput: {
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
  };

  renderer.updateSettings(settings);
  const options = elements.userInput.querySelectorAll<HTMLInputElement>(
    "input[type='radio']",
  );
  const note = elements.userInput.querySelector<HTMLInputElement>(
    "input[data-note='true']",
  )!;
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
  expect(
    elements.userInput.querySelector("input[data-other='true']"),
  ).toBeNull();
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

  expect(window.peskApi.respondCodexUserInput).toHaveBeenCalledWith(
    "request-2",
    { choice: ["Option B", "Keep the implementation simple."] },
  );
});

test("shows multiple questions one at a time and submits all answers at the end", () => {
  const { renderer, elements } = makeRenderer();
  const settings: Settings = {
    ...defaultSettings(),
    codexPendingUserInput: {
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
  };

  renderer.updateSettings(settings);
  expect(elements.userInput.textContent).toContain("First question");
  expect(elements.userInput.textContent).not.toContain("Second question");
  const firstOption = elements.userInput.querySelector<HTMLInputElement>(
    "input[type='radio']",
  )!;
  firstOption.checked = true;
  (elements.userInput.querySelector("form") as HTMLFormElement).requestSubmit();

  expect(elements.userInput.textContent).toContain("Second question");
  expect(elements.userInput.textContent).not.toContain("First question");
  const secondOption = elements.userInput.querySelector<HTMLInputElement>(
    "input[type='radio']",
  )!;
  secondOption.checked = true;
  (elements.userInput.querySelector("form") as HTMLFormElement).requestSubmit();

  expect(window.peskApi.respondCodexUserInput).toHaveBeenCalledWith(
    "request-3",
    { first: ["A"], second: ["B"] },
  );
});

test("searches and selects a file with the @ picker", async () => {
  const settings = {
    ...defaultSettings(),
    codexCwd: "/tmp/project",
  };
  const { elements } = makeRenderer(settings);
  elements.input.value = "Inspect @cod";
  elements.input.dispatchEvent(new Event("input", { bubbles: true }));
  await Promise.resolve();

  expect(elements.suggestions.hidden).toBe(false);
  expect(elements.suggestions.querySelectorAll("button")).toHaveLength(2);

  elements.input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  );
  elements.input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );

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
    [...elements.suggestions.querySelectorAll("button")].map(
      (button) => button.textContent,
    ),
  ).toEqual([
    "/planSwitch to Plan mode",
    "/defaultSwitch to Default mode",
    "/newStart a new Codex session",
  ]);

  elements.input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  );
  elements.input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );

  expect(elements.input.value).toBe("/default ");
  expect(elements.suggestions.hidden).toBe(true);
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
  expect(submit).toHaveBeenCalledTimes(1);
});

test("keeps web chat input focused before and after an async submission", async () => {
  const next = { ...defaultSettings(), codexThreadId: "thread-web" };
  const { renderer, elements } = makeRenderer(next, true);
  renderer.updateSettings(next);
  elements.history.scrollTop = 0;
  let resolveSubmit!: (settings: Settings) => void;
  const submit = window.peskApi.submitCodexPrompt as jest.Mock;
  submit.mockImplementation(
    () => new Promise<Settings>((resolve) => (resolveSubmit = resolve)),
  );
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

test("adjusts web chat form visibility on visual viewport resize", () => {
  const resizeListeners = new Set<() => void>();
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: {
      addEventListener: (_type: string, listener: () => void) =>
        resizeListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) =>
        resizeListeners.delete(listener),
    },
  });
  const { elements } = makeRenderer(defaultSettings(), true);

  for (const listener of resizeListeners) listener();

  expect(elements.history.scrollTop).toBe(elements.history.scrollHeight);
  expect(resizeListeners.size).toBe(1);
  window.dispatchEvent(new Event("pagehide"));
  expect(resizeListeners.size).toBe(0);
});

test("renders approval options and completed approval states", () => {
  const { renderer, elements } = makeRenderer();
  renderer.updateSettings({
    ...defaultSettings(),
    codexThreadId: "thread-1",
    codexPendingApproval: {
      requestId: 7,
      command: "permission",
      reason: "Needs approval",
      options: [
        { id: "accept", label: "Approve once", description: "" },
        { id: "decline", label: "Decline", description: "" },
      ],
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
  expect(window.peskApi.respondCodexPermission).toHaveBeenCalledWith(
    7,
    "accept",
  );
  expect(approve.value).toBe("accept");
  expect(deny.value).toBe("decline");
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

test("blurs the input when selecting a message with Alt+Up", () => {
  const { renderer, elements } = makeRenderer({
    ...defaultSettings(),
    codexHistory: [{ role: "user", text: "copy this" }],
  });
  renderer.updateSettings({
    ...defaultSettings(),
    codexHistory: [{ role: "user", text: "copy this" }],
  });
  elements.input.focus();
  (
    elements.history.querySelector(".codex-message") as HTMLElement
  ).scrollIntoView = jest.fn();

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

  renderer.updateSettings({
    ...defaultSettings(),
    codexWorkedElapsed: 1000,
    codexInterrupted: true,
  });
  expect(elements.workingStatus.textContent).toContain(
    "Conversation interrupted",
  );
  expect(
    elements.workingStatus.classList.contains(
      "codex-working-status-interrupted",
    ),
  ).toBe(true);
});
