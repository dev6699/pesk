export class RtermRenderer {
  private snapshot: RtermSnapshot = {
    enabled: false,
    state: "disconnected",
    output: "",
    hostLabel: "",
    authFailed: false,
  };
  constructor(
    private readonly panel: HTMLElement,
    private frame: HTMLIFrameElement,
    private readonly refreshButton: HTMLButtonElement | undefined,
    private readonly closeButton: HTMLButtonElement,
    private readonly resizeHandle: HTMLElement,
    private visible = false,
  ) {}
  private threadId = "standalone";
  private readonly frames = new Map<string, HTMLIFrameElement>();
  private readonly visibility = new Map<string, boolean>();

  setup(): void {
    this.frames.set(this.threadId, this.frame);
    window.peskApi.onRtermChanged((snapshot) => this.render(snapshot));
    window.peskApi.onRtermSessionSelected?.(({ threadId, sessionId }) => {
      if (threadId !== this.threadId) return;
      this.frame.contentWindow?.postMessage({ source: "pesk", type: "select-session", sessionId }, "*");
    });
    this.refreshButton?.addEventListener("click", () => this.refreshFrame());
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
    this.render(this.snapshot);
  }

  private render(snapshot: RtermSnapshot): void {
    this.snapshot = snapshot;
    this.panel.hidden = !snapshot.enabled || !this.visible;
    if (this.visible) this.loadEmbedUrl();
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

  private refreshFrame(): void {
    const source = this.frame.src;
    if (!source) return;
    this.frame.src = "";
    this.frame.src = source;
  }

  private loadEmbedUrl(): void {
    window.peskApi.getRtermEmbedUrl().then((url) => {
      if (!url) return;
      const initialFrame = this.frames.get("standalone");
      if (initialFrame && this.threadId !== "standalone" && !this.frames.has(this.threadId)) {
        this.frames.delete("standalone");
        this.frames.set(this.threadId, initialFrame);
      }
      if (this.frame.src !== url) this.frame.src = url;
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
    const sourceThread =
      [...this.frames.entries()].find(([, frame]) => frame.contentWindow === event.source)?.[0] ??
      (event.source === null ? this.threadId : undefined);
    if (!sourceThread) return;
    const isCurrentFrame = sourceThread === this.threadId;
    switch (event.data.type) {
      case "disconnected":
      case "error":
        if (isCurrentFrame) {
          void window.peskApi.clearRtermProviderSession(
            typeof event.data.sessionId === "string" ? event.data.sessionId : undefined,
          );
        }
        break;
      case "session-ready":
        if (
          typeof event.data.sessionId === "string" &&
          typeof event.data.token === "string" &&
          typeof event.data.provider === "string" &&
          typeof event.data.target === "string" &&
          typeof event.data.user === "string"
        ) {
          const session = {
            sessionId: event.data.sessionId,
            token: event.data.token,
            provider: event.data.provider,
            target: event.data.target,
            user: event.data.user,
          };
          void window.peskApi.setRtermProviderSession(session, sourceThread);
        }
        break;
    }
  }
}

export function setupRtermRenderer(): RtermRenderer | undefined {
  const panel = document.getElementById("rterm-panel");
  const frame = document.getElementById("rterm-frame");
  const refreshButton = document.getElementById("rterm-refresh");
  const closeButton = document.getElementById("rterm-close");
  const resizeHandle = document.getElementById("rterm-resize-handle");
  if (
    !(panel instanceof HTMLElement) ||
    !(frame instanceof HTMLIFrameElement) ||
    !(closeButton instanceof HTMLButtonElement) ||
    !(resizeHandle instanceof HTMLElement)
  )
    return undefined;
  const renderer = new RtermRenderer(
    panel,
    frame,
    refreshButton instanceof HTMLButtonElement ? refreshButton : undefined,
    closeButton,
    resizeHandle,
  );
  renderer.setup();
  return renderer;
}
