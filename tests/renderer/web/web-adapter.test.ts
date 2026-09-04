/** @jest-environment jsdom */
/// <reference types="jest" />
/// <reference path="../../../src/renderer/shared/types.d.ts" />

type FakeWebSocketEvent = {
  data?: unknown;
  [key: string]: unknown;
};

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: FakeWebSocketEvent) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: string, callback: (event: FakeWebSocketEvent) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  emit(event: string, value: unknown = {}): void {
    for (const callback of this.listeners.get(event) ?? []) {
      callback((value ?? {}) as FakeWebSocketEvent);
    }
  }
}

function state(): RendererState {
  return {
    settings: {
      animation: "idle",
      animationMode: "selected",
      scale: 1,
      paused: false,
      locked: false,
      visible: true,
      codexStatusSound: true,
    },
    codex: {
      status: "idle",
      aggregateStatus: "idle",
      connected: true,
      readOnly: false,
      threads: [],
      threadActivities: [],
      backgroundWork: { completed: 0, total: 0 },
      history: [],
      hasOlderHistory: false,
      historyLoading: false,
      queuedSubmissions: [],
      collaborationMode: "default",
    },
    assets: { codexStatusSoundUrl: "" },
  };
}

function loadAdapter(): Window["peskApi"] {
  window.history.replaceState({}, "", "/web-chat.html");
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket;
  jest.isolateModules(() => {
    jest.requireActual("../../../src/renderer/web/web-adapter.ts");
  });
  return window.peskApi;
}

beforeEach(() => {
  document.body.innerHTML =
    '<div id="codex-chat-header"></div><span id="web-notification-status"></span><span id="web-connection-status"></span><div id="codex-error"></div>';
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ publicKey: "test-public-key" }),
      }),
    ),
  });
  jest.useRealTimers();
});

afterEach(() => {
  jest.resetModules();
  delete (window as { Notification?: unknown }).Notification;
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

test("authenticates and publishes the initial state", async () => {
  const api = loadAdapter();
  const socket = FakeWebSocket.instances[0];
  socket.emit("open");
  expect(JSON.parse(socket.sent[0])).toEqual({
    type: "authenticate",
    credential: "",
  });

  const next = state();
  const settings = api.getSettings();
  socket.emit("message", {
    data: JSON.stringify({ type: "state", state: next }),
  });

  await expect(settings).resolves.toEqual(next);
  expect(document.getElementById("web-connection-status")?.textContent).toBe("Connected");
});

test("round-trips fuzzy file search results", async () => {
  const api = loadAdapter();
  const socket = FakeWebSocket.instances[0];
  socket.emit("open");

  const search = api.fuzzyFileSearch("main", ["C:\\project"]);
  const request = JSON.parse(socket.sent.at(-1) as string);
  expect(request).toEqual({
    type: "fuzzyFileSearch",
    requestId: 1,
    query: "main",
    roots: ["C:\\project"],
  });

  const files = [
    {
      root: "C:\\project",
      path: "C:\\project\\src\\main.ts",
      match_type: "file",
      file_name: "main.ts",
      score: 1,
      indices: [0],
    },
  ];
  socket.emit("message", {
    data: JSON.stringify({
      type: "fuzzyFileSearchResult",
      requestId: 1,
      files,
    }),
  });

  await expect(search).resolves.toEqual(files);
});

test("round-trips web commands and returns the server result", async () => {
  const api = loadAdapter();
  const socket = FakeWebSocket.instances[0];
  socket.emit("open");

  const next = { ...state(), codex: { ...state().codex, status: "working" as const } };
  const interrupt = api.interruptCodexTurn();
  const request = JSON.parse(socket.sent.at(-1) as string);
  expect(request).toMatchObject({ type: "interruptTurn", requestId: 1 });
  socket.emit("message", {
    data: JSON.stringify({
      type: "commandResult",
      requestId: 1,
      ok: true,
      state: next,
    }),
  });
  await expect(interrupt).resolves.toBe(true);

  const plan = api.implementCodexPlan("Do it", false);
  const planRequest = JSON.parse(socket.sent.at(-1) as string);
  expect(planRequest).toMatchObject({
    type: "implementPlan",
    requestId: 2,
    planText: "Do it",
    clearContext: false,
  });
  socket.emit("message", {
    data: JSON.stringify({
      type: "commandResult",
      requestId: 2,
      ok: true,
      state: next,
    }),
  });
  await expect(plan).resolves.toEqual(next);

  const review = api.startCodexReview("Review styles.css changes");
  const reviewRequest = JSON.parse(socket.sent.at(-1) as string);
  expect(reviewRequest).toMatchObject({
    type: "startReview",
    requestId: 3,
    instructions: "Review styles.css changes",
  });
  socket.emit("message", {
    data: JSON.stringify({
      type: "commandResult",
      requestId: 3,
      ok: true,
      state: next,
    }),
  });
  await expect(review).resolves.toEqual(next);
});

test("reconnects after a transient socket close", () => {
  jest.useFakeTimers();
  loadAdapter();
  const first = FakeWebSocket.instances[0];
  first.emit("close", { code: 1006 });

  expect(document.getElementById("web-connection-status")?.textContent).toBe("Reconnecting…");
  jest.advanceTimersByTime(1000);

  expect(FakeWebSocket.instances).toHaveLength(2);
  expect(FakeWebSocket.instances[1].url).not.toContain("token=");
});

test("does not retry authentication failures", () => {
  jest.useFakeTimers();
  loadAdapter();
  FakeWebSocket.instances[0].emit("close", { code: 1008 });
  jest.advanceTimersByTime(10000);

  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(document.getElementById("web-connection-status")?.textContent).toBe(
    "Authentication failed",
  );
});

test("prompts when notification permission is undecided", () => {
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: { permission: "default" },
  });

  loadAdapter();

  const prompt = document.getElementById("web-notification-prompt");
  expect(prompt?.textContent).toBe("Enable notifications");
  expect((prompt as HTMLButtonElement | null)?.disabled).toBe(false);
  expect(document.getElementById("web-notification-status")?.textContent).toBe(
    "Web Push not configured",
  );
  expect(document.getElementById("web-notification-status")?.hasAttribute("hidden")).toBe(false);
});
