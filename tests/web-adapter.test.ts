/** @jest-environment jsdom */
/// <reference types="jest" />
/// <reference path="../src/renderer/types.d.ts" />

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: string, callback: (event: any) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  emit(event: string, value: unknown = {}): void {
    for (const callback of this.listeners.get(event) ?? []) callback(value);
  }
}

function state(): PeskSettings {
  return {
    animation: "idle",
    animationMode: "selected",
    scale: 1,
    paused: false,
    locked: false,
    visible: true,
    codexStatusSound: true,
    codexStatusSoundUrl: "",
    codexStatus: "idle",
    codexConnected: true,
    codexThreads: [],
    codexHistory: [],
    codexCollaborationMode: "default",
  };
}

function loadAdapter(): Window["peskApi"] {
  window.history.replaceState({}, "", "/web-chat.html?token=test-token");
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket;
  jest.isolateModules(() => {
    jest.requireActual("../src/renderer/web-adapter.ts");
  });
  return window.peskApi;
}

beforeEach(() => {
  document.body.innerHTML =
    '<div id="web-connection-status"></div><div id="codex-error"></div>';
  FakeWebSocket.instances = [];
  jest.useRealTimers();
});

afterEach(() => {
  jest.resetModules();
});

test("authenticates and publishes the initial state", async () => {
  const api = loadAdapter();
  const socket = FakeWebSocket.instances[0];
  socket.emit("open");
  expect(JSON.parse(socket.sent[0])).toEqual({
    type: "authenticate",
    token: "test-token",
  });

  const next = state();
  const settings = api.getSettings();
  socket.emit("message", {
    data: JSON.stringify({ type: "state", state: next }),
  });

  await expect(settings).resolves.toEqual(next);
  expect(document.getElementById("web-connection-status")?.textContent).toBe(
    "Connected",
  );
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

test("reconnects after a transient socket close", () => {
  jest.useFakeTimers();
  loadAdapter();
  const first = FakeWebSocket.instances[0];
  first.emit("close", { code: 1006 });

  expect(document.getElementById("web-connection-status")?.textContent).toBe(
    "Reconnecting…",
  );
  jest.advanceTimersByTime(1000);

  expect(FakeWebSocket.instances).toHaveLength(2);
  expect(FakeWebSocket.instances[1].url).toContain("token=test-token");
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
