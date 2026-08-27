const listeners = new Set<(settings: PeskSettings) => void>();
const pendingFileSearches = new Map<
  number,
  (results: FuzzyFileSearchResult[]) => void
>();
const pendingCommands = new Map<
  number,
  (result: { ok: boolean; state?: PeskSettings }) => void
>();
let nextFileSearchId = 0;
let nextCommandId = 0;
let state: PeskSettings | undefined;
let socket: WebSocket;
function readCredential(): string {
  try { return localStorage.getItem("pesk-device-credential") ?? ""; } catch { return ""; }
}

function saveCredential(value: string): void {
  try { localStorage.setItem("pesk-device-credential", value); } catch { /* optional */ }
}

function clearCredential(): void {
  credential = "";
  try { localStorage.removeItem("pesk-device-credential"); } catch { /* optional */ }
}

let credential = readCredential();
let retryTimer: number | undefined;
let retryDelay = 1000;
let authenticated = false;
let resolveInitialState: ((settings: PeskSettings) => void) | undefined;
let serviceWorkerRegistration: Promise<ServiceWorkerRegistration | undefined>;
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

function setNotificationStatus(
  status: "ready" | "not-configured" | "blocked" | "unavailable",
): void {
  const element = document.getElementById("web-notification-status");
  if (!element) return;
  const labels = {
    ready: "Web Push ready",
    "not-configured": "Web Push not configured",
    blocked: "Web Push blocked",
    unavailable: "Web Push unavailable",
  };
  element.textContent = labels[status];
  element.className = status === "ready" ? "web-notification-ready" : "";
  element.hidden = status === "ready";
}

function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) {
    setNotificationStatus("unavailable");
    return;
  }
  serviceWorkerRegistration = navigator.serviceWorker
    .register("web-sw.js")
    .then(async (registration) => {
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const response = await fetch("/web-push/subscribe", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${credential}`,
          },
          body: JSON.stringify(subscription),
        });
        if (!response.ok) throw new Error("Unable to save push subscription");
        setNotificationStatus("ready");
      } else {
        setNotificationStatus("not-configured");
      }
      return registration;
    })
    .catch(() => {
      setNotificationStatus("not-configured");
      return undefined;
    });
}

async function enableNotifications(): Promise<void> {
  const status = document.getElementById("web-connection-status");
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    if (status) status.textContent = "Push notifications unsupported";
    setNotificationStatus("unavailable");
    updateNotificationPrompt();
    return;
  }
  if (Notification.permission !== "granted") {
    setNotificationStatus(Notification.permission === "denied" ? "blocked" : "not-configured");
    await Notification.requestPermission();
  }
  if (Notification.permission !== "granted") {
    updateNotificationPrompt();
    return;
  }
  try {
    const registration = await serviceWorkerRegistration;
    if (!registration) throw new Error("Service worker unavailable");
    const configResponse = await fetch(
      "/web-push/config",
      { headers: { Authorization: `Bearer ${credential}` } },
    );
    if (configResponse.status === 401) {
      throw new Error("This device pairing is no longer authorized. Pair it again.");
    }
    if (!configResponse.ok) throw new Error("Unable to load push settings");
    const config = (await configResponse.json()) as { publicKey?: string };
    if (!config.publicKey) throw new Error("Push is not configured");
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeBase64(
          config.publicKey,
        ) as unknown as BufferSource,
      }));
    const response = await fetch(
      "/web-push/subscribe",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
        body: JSON.stringify(subscription),
      },
    );
    if (response.status === 401) {
      throw new Error("This device pairing is no longer authorized. Pair it again.");
    }
    if (!response.ok) throw new Error("Unable to save push subscription");
    setNotificationStatus("ready");
    document.getElementById("web-notification-prompt")?.remove();
  } catch (error) {
    setNotificationStatus("not-configured");
    if (status)
      status.textContent = `Push setup failed: ${error instanceof Error ? error.message : "unknown error"}`;
  }
  updateNotificationPrompt();
}

function updateNotificationPrompt(): void {
  const header = document.getElementById("codex-chat-header");
  if (!header || !("Notification" in window)) return;
  document.getElementById("web-notification-prompt")?.remove();
  if (Notification.permission === "granted") return;
  setNotificationStatus(Notification.permission === "denied" ? "blocked" : "not-configured");
  const button = document.createElement("button");
  button.id = "web-notification-prompt";
  button.type = "button";
  if (Notification.permission === "denied") {
    button.disabled = true;
    button.textContent = "Notifications blocked";
  } else {
    button.textContent = "Enable notifications";
    button.addEventListener("click", () => void enableNotifications());
  }
  header.append(button);
}

async function pairFromUrl(): Promise<void> {
  const code = new URLSearchParams(location.search).get("code");
  if (!code) return;
  clearCredential();
  const response = await fetch("/pair/exchange", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) throw new Error("Pairing code expired or invalid");
  const result = (await response.json()) as { credential?: string };
  if (!result.credential) throw new Error("Pairing did not return a credential");
  credential = result.credential;
  saveCredential(credential);
  history.replaceState({}, "", "/web-chat.html");
}

function decodeBase64(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function connect(): void {
  setConnectionStatus("connecting");
  const connection = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/web-socket`);
  socket = connection;

  connection.addEventListener("open", () => {
    if (connection !== socket) return;
    authenticated = false;
    retryDelay = 1000;
    connection.send(
      JSON.stringify({
        type: "authenticate",
        credential,
      }),
    );
  });

  connection.addEventListener("message", (event) => {
    if (connection !== socket) return;
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
    if (type === "commandResult") {
      const result = message as {
        requestId?: unknown;
        ok?: unknown;
        state?: PeskSettings;
      };
      if (typeof result.requestId !== "number") return;
      const resolve = pendingCommands.get(result.requestId);
      if (!resolve) return;
      pendingCommands.delete(result.requestId);
      resolve({
        ok: result.ok === true,
        state: result.state,
      });
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

  connection.addEventListener("close", (event) => {
    if (connection !== socket) return;
    for (const resolve of pendingFileSearches.values()) resolve([]);
    pendingFileSearches.clear();
    for (const resolve of pendingCommands.values()) {
      resolve({ ok: false, state });
    }
    pendingCommands.clear();
    if (event.code === 1008) {
      clearCredential();
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

const pairingCode = new URLSearchParams(location.search).get("code");
if (!pairingCode || credential) {
  registerServiceWorker();
  connect();
} else {
  void pairFromUrl()
    .then(() => {
      registerServiceWorker();
      connect();
      void enableNotifications();
    })
    .catch((error) => {
      showConnectionError(error instanceof Error ? error.message : "Pairing failed");
      setConnectionStatus("failed");
  });
  }
  updateNotificationPrompt();
  if (credential && "Notification" in window && Notification.permission === "granted") {
    void enableNotifications();
  }
  const connectionStatus = document.getElementById("web-connection-status");
connectionStatus?.addEventListener("click", () => location.reload());
connectionStatus?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  location.reload();
});

function send(type: string, data: Record<string, unknown> = {}): void {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ type, ...data }));
}

function sendCommand(
  type: string,
  data: Record<string, unknown> = {},
): Promise<{ ok: boolean; state?: PeskSettings }> {
  const requestId = ++nextCommandId;
  if (socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ ok: false, state });
  }
  return new Promise((resolve) => {
    pendingCommands.set(requestId, resolve);
    send(type, { ...data, requestId });
  });
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
  submitCodexPrompt: async (prompt: string) =>
    (await sendCommand("submitPrompt", { prompt })).state ?? state!,
  implementCodexPlan: async (planText: string, clearContext: boolean) =>
    (await sendCommand("implementPlan", { planText, clearContext })).state ?? state!,
  interruptCodexTurn: async () =>
    (await sendCommand("interruptTurn")).ok,
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
