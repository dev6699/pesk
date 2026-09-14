export class RtermRenderer {
  private snapshot: RtermSnapshot = {
    enabled: false,
    sessions: [],
    state: "disconnected",
    output: "",
    hostLabel: "",
    authFailed: false,
  };
  constructor(
    private readonly panel: HTMLElement,
    private frame: HTMLIFrameElement,
    private readonly closeButton: HTMLButtonElement,
    private readonly resizeHandle: HTMLElement,
    private visible = false,
  ) {}
  private threadId = "standalone";
  private readonly frames = new Map<string, HTMLIFrameElement>();
  private readonly visibility = new Map<string, boolean>();

  private frameOrigin(frame: HTMLIFrameElement): string | undefined {
    if (!frame.src) return undefined;
    try {
      return new URL(frame.src).origin;
    } catch {
      return undefined;
    }
  }

  setup(): void {
    this.frames.set(this.threadId, this.frame);
    window.peskApi.onRtermChanged((snapshot) => this.render(snapshot));
    this.closeButton.addEventListener("click", () => this.hide());
    document.addEventListener("toggle-rterm", () => this.toggleVisibility());
    this.resizeHandle.addEventListener("pointerdown", (event) => this.startResize(event));
    window.addEventListener("message", (event) => this.handleFrameMessage(event));
    window.peskApi.getRterm().then((snapshot) => this.render(snapshot));
  }

  setThread(threadId: string | undefined): void {
    const nextThreadId = threadId ?? "standalone";
    if (this.threadId === nextThreadId) return;
    this.threadId = nextThreadId;
    this.visible = this.visibility.get(this.threadId) ?? false;
    this.switchProviderFrame(this.threadId);
    const selectedThreadId = this.threadId;
    const selectedFrame = this.frame;
    window.peskApi.getRterm().then((snapshot) => {
      if (this.threadId !== selectedThreadId || this.frame !== selectedFrame) return;
      this.render(snapshot);
    });
  }

  private render(snapshot: RtermSnapshot): void {
    const stateChanged = this.snapshot.state !== snapshot.state;
    const activeSessionChanged = this.snapshot.activeSessionId !== snapshot.activeSessionId;
    this.snapshot = snapshot;
    this.panel.hidden = !snapshot.enabled || !this.visible;
    this.syncFrameSessions();
    if (this.visible && (!this.frame.src || (stateChanged && snapshot.state !== "connected")))
      this.loadEmbedUrl();
    if (this.visible && activeSessionChanged) this.attachFrameSessions();
  }

  private toggleVisibility(): void {
    this.visible = !this.visible;
    this.visibility.set(this.threadId, this.visible);
    this.panel.hidden = !this.snapshot.enabled || !this.visible;
    if (this.visible) {
      this.render(this.snapshot);
    }
  }

  private hide(): void {
    this.visible = false;
    this.visibility.set(this.threadId, false);
    this.panel.hidden = true;
  }

  private attachFrameSessions(): void {
    const threadId = this.threadId;
    const frame = this.frame;
    const origin = this.frameOrigin(frame);
    if (!origin || !frame.contentWindow) return;
    window.peskApi.getRtermEmbedUrl().then((url) => {
      if (this.threadId !== threadId || this.frame !== frame) return;
      try {
        const embed = new URL(url);
        const sessions = embed.searchParams.getAll("attachSession");
        const handoffs = embed.searchParams.getAll("handoff");
        const targets = embed.searchParams.getAll("target");
        const users = embed.searchParams.getAll("user");
        for (let index = 0; index < sessions.length && index < handoffs.length; index++) {
          frame.contentWindow?.postMessage(
            {
              source: "pesk",
              type: "attach-session",
              sessionId: sessions[index],
              handoff: handoffs[index],
              target: targets[index] ?? sessions[index],
              user: users[index] ?? "",
              active: sessions[index] === this.snapshot.activeSessionId,
            },
            origin,
          );
        }
      } catch {
        // Ignore an unavailable or malformed embed URL.
      }
    });
  }

  private syncFrameSessions(): void {
    const origin = this.frameOrigin(this.frame);
    if (!origin || !this.frame.contentWindow) return;
    try {
      this.frame.contentWindow.postMessage(
        {
          source: "pesk",
          type: "sync-sessions",
          sessions: this.snapshot.sessions,
          activeSessionId: this.snapshot.activeSessionId,
        },
        origin,
      );
    } catch {
      // The iframe may not have a live browsing context while it is reloading.
    }
  }

  private loadEmbedUrl(): void {
    const threadId = this.threadId;
    const frame = this.frame;
    window.peskApi.getRtermEmbedUrl().then((url) => {
      if (this.threadId !== threadId || this.frame !== frame) return;
      if (!url) return;
      try {
        const embedUrl = new URL(url);
        embedUrl.searchParams.set("parentOrigin", window.location.origin);
        url = embedUrl.toString();
      } catch {
        return;
      }
      const initialFrame = this.frames.get("standalone");
      if (initialFrame && this.threadId !== "standalone" && !this.frames.has(this.threadId)) {
        this.frames.delete("standalone");
        this.frames.set(this.threadId, initialFrame);
      }
      if (frame.src !== url) frame.src = url;
    });
  }

  private switchProviderFrame(threadId: string): void {
    let frame = this.frames.get(threadId);
    if (!frame) {
      const initialFrame = this.frames.get("standalone");
      if (initialFrame && this.threadId !== "standalone") {
        frame = initialFrame;
        this.frames.delete("standalone");
      } else {
        frame = this.frame.cloneNode(false) as HTMLIFrameElement;
        frame.removeAttribute("src");
        frame.hidden = true;
        this.frame.parentElement?.appendChild(frame);
      }
      this.frames.set(threadId, frame);
    }
    for (const candidate of this.frames.values()) candidate.hidden = candidate !== frame;
    this.frame = frame;
  }

  private startResize(event: PointerEvent): void {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = this.panel.getBoundingClientRect().height;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      const height = Math.min(420, Math.max(90, startHeight - moveEvent.clientY + startY));
      this.panel.style.height = `${height}px`;
      this.panel.style.flexBasis = `${height}px`;
    };
    const stop = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  private handleFrameMessage(event: MessageEvent): void {
    if (event.data?.source !== "rterm") return;
    const sourceEntry = [...this.frames.entries()].find(
      ([, frame]) => frame.contentWindow === event.source,
    );
    if (event.source !== null && !sourceEntry) return;
    const expectedOrigin = sourceEntry ? this.frameOrigin(sourceEntry[1]) : undefined;
    if (!sourceEntry || !expectedOrigin || event.origin !== expectedOrigin) return;
    const sourceThread = sourceEntry?.[0] ?? (event.source === null ? this.threadId : undefined);
    if (!sourceThread) return;
    const isCurrentFrame = sourceThread === this.threadId;
    switch (event.data.type) {
      case "loaded":
        if (isCurrentFrame) this.syncFrameSessions();
        break;
      case "disconnected":
      case "error":
        if (isCurrentFrame) {
          window.peskApi.clearRtermProviderSession(
            typeof event.data.sessionId === "string" ? event.data.sessionId : undefined,
          );
        }
        break;
      case "session-ready":
        if (
          typeof event.data.sessionId === "string" &&
          typeof event.data.handoff === "string" &&
          typeof event.data.provider === "string" &&
          typeof event.data.target === "string" &&
          typeof event.data.user === "string"
        ) {
          const session = {
            sessionId: event.data.sessionId,
            provider: event.data.provider,
            target: event.data.target,
            user: event.data.user,
          };
          window.peskApi.setRtermProviderSession(session, event.data.handoff, sourceThread);
        }
        break;
      case "session-selected":
        if (typeof event.data.sessionId === "string" && isCurrentFrame)
          window.peskApi.selectRtermProviderSession(event.data.sessionId, sourceThread);
        break;
    }
  }
}

export function setupRtermRenderer(): RtermRenderer | undefined {
  const panel = document.getElementById("rterm-panel");
  const frame = document.getElementById("rterm-frame");
  const closeButton = document.getElementById("rterm-close");
  const resizeHandle = document.getElementById("rterm-resize-handle");
  if (
    !(panel instanceof HTMLElement) ||
    !(frame instanceof HTMLIFrameElement) ||
    !(closeButton instanceof HTMLButtonElement) ||
    !(resizeHandle instanceof HTMLElement)
  )
    return undefined;
  const renderer = new RtermRenderer(panel, frame, closeButton, resizeHandle);
  renderer.setup();
  return renderer;
}
