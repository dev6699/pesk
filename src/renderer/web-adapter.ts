const listeners = new Set<(settings: PeskSettings) => void>();
const pendingFileSearches = new Map<
  number,
  (results: FuzzyFileSearchResult[]) => void
>();
let nextFileSearchId = 0;
let state: PeskSettings | undefined;
let socket: WebSocket;
let retryTimer: number | undefined;
let retryDelay = 1000;
let authenticated = false;
let resolveInitialState: ((settings: PeskSettings) => void) | undefined;
const initialState = new Promise<PeskSettings>((resolve) => {
  resolveInitialState = resolve;
});

function setConnectionStatus(
  status: "connecting" | "connected" | "reconnecting" | "failed",
): void {
  const element = document.getElementById("web-connection-status");
  if (!element) return;
  const labels = {
    connecting: "Connecting…",
    connected: "Connected",
    reconnecting: "Reconnecting…",
    failed: "Authentication failed",
  };
  element.textContent = labels[status];
  element.className = `web-connection-${status}`;
}

function showConnectionError(message: string): void {
  const error = document.getElementById("codex-error");
  if (!error) return;
  error.hidden = false;
  error.textContent = message;
}

function clearConnectionError(): void {
  const error = document.getElementById("codex-error");
  if (error && !state?.codexError) {
    error.hidden = true;
    error.textContent = "";
  }
}

function connect(): void {
  setConnectionStatus("connecting");
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/web-socket?token=${encodeURIComponent(new URLSearchParams(location.search).get("token") ?? "")}`,
  );

  socket.addEventListener("open", () => {
    authenticated = false;
    retryDelay = 1000;
    socket.send(
      JSON.stringify({
        type: "authenticate",
        token: new URLSearchParams(location.search).get("token"),
      }),
    );
  });

  socket.addEventListener("message", (event) => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const type = (message as { type?: unknown }).type;
    if (type === "fuzzyFileSearchResult") {
      const result = message as {
        requestId?: unknown;
        files?: unknown;
      };
      if (typeof result.requestId !== "number") return;
      const resolve = pendingFileSearches.get(result.requestId);
      if (!resolve) return;
      pendingFileSearches.delete(result.requestId);
      resolve(
        Array.isArray(result.files)
          ? (result.files as FuzzyFileSearchResult[])
          : [],
      );
      return;
    }
    if (type !== "state") return;
    authenticated = true;
    setConnectionStatus("connected");
    clearConnectionError();
    state = (message as { state: PeskSettings }).state;
    resolveInitialState?.(state);
    resolveInitialState = undefined;
    for (const listener of listeners) listener(state);
  });

  socket.addEventListener("close", (event) => {
    for (const resolve of pendingFileSearches.values()) resolve([]);
    pendingFileSearches.clear();
    if (event.code === 1008) {
      setConnectionStatus("failed");
      showConnectionError("Web access authentication failed.");
      return;
    }
    setConnectionStatus("reconnecting");
    showConnectionError(
      authenticated
        ? "Web chat disconnected. Reconnecting..."
        : "Connecting to web chat...",
    );
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10000);
  });
}

connect();

function send(type: string, data: Record<string, unknown> = {}): void {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ type, ...data }));
}

const webApi = {
  getSettings: () => (state ? Promise.resolve(state) : initialState),
  onSettingsChanged: (callback: (settings: PeskSettings) => void) =>
    listeners.add(callback),
  refreshCodexRateLimits: async () => send("refreshRateLimits"),
  getChatSize: async () => ({ width: innerWidth, height: innerHeight }),
  selectCodexThread: (threadId: string) => send("selectThread", { threadId }),
  setCodexCollaborationMode: (mode: "default" | "plan") =>
    send("setCollaborationMode", { mode }),
  submitCodexPrompt: async (prompt: string) => {
    send("submitPrompt", { prompt });
    return state!;
  },
  interruptCodexTurn: async () => {
    send("interruptTurn");
    return true;
  },
  respondCodexPermission: (requestId: string | number, optionId: string) =>
    send("respondPermission", { requestId, optionId }),
  respondCodexUserInput: (
    requestId: string | number,
    answers: Record<string, string[]>,
  ) => send("respondUserInput", { requestId, answers }),
  focusCodexInput: () =>
    document.querySelector<HTMLTextAreaElement>("#codex-chat-input")?.focus(),
  onCodexInputFocus: () => undefined,
  onCodexUserInputFocus: () => undefined,
  fuzzyFileSearch: (query: string, roots: string[]) => {
    if (socket.readyState !== WebSocket.OPEN) return Promise.resolve([]);
    const requestId = ++nextFileSearchId;
    return new Promise<FuzzyFileSearchResult[]>((resolve) => {
      pendingFileSearches.set(requestId, resolve);
      send("fuzzyFileSearch", { requestId, query, roots });
    });
  },
} as unknown as Window["peskApi"];

window.peskApi = webApi;
