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
    private readonly closeButton: HTMLButtonElement,
    private readonly resizeHandle: HTMLElement,
    private readonly refreshButton?: HTMLButtonElement,
    private readonly layoutButton?: HTMLButtonElement,
    private visible = false,
  ) {}
  private threadId = "standalone";
  private sideLayout = false;
  private sideWidth = 40;
  private layoutObserver?: MutationObserver;
  private readonly frames = new Map<string, HTMLIFrameElement>();
  private readonly bridgeTokens = new WeakMap<HTMLIFrameElement, string>();
  private readonly visibility = new Map<string, boolean>();

  setup(): void {
    this.frames.set(this.threadId, this.frame);
    window.peskApi.onRtermSessionsRequest?.((threadId, request) => {
      const frame = this.frames.get(threadId);
      if (!frame?.contentWindow || !frame.src) {
        window.peskApi.sendRtermSessionsResponse?.(threadId, {
          requestId: request.requestId,
          ok: false,
          connected: false,
          unavailable: true,
          error: "The rterm iframe is not loaded.",
        });
        return;
      }
      try {
        const bridgeToken = this.bridgeTokens.get(frame);
        frame.contentWindow.postMessage(
          {
            source: "pesk",
            type: "sessions-request",
            ...request,
            ...(bridgeToken ? { bridgeToken } : {}),
          },
          new URL(frame.src).origin,
        );
      } catch {
        window.peskApi.sendRtermSessionsResponse?.(threadId, {
          requestId: request.requestId,
          ok: false,
          connected: false,
          unavailable: true,
          error: "The rterm iframe could not receive the request.",
        });
      }
    });
    window.peskApi.onRtermSessionSelection?.((threadId, sessionId) => {
      const frame = this.frames.get(threadId);
      if (!frame?.contentWindow || !frame.src) return;
      try {
        const bridgeToken = this.bridgeTokens.get(frame);
        frame.contentWindow.postMessage(
          {
            source: "pesk",
            type: "select-session",
            sessionId,
            ...(bridgeToken ? { bridgeToken } : {}),
          },
          new URL(frame.src).origin,
        );
      } catch {
        // Ignore selection requests for an unloaded frame.
      }
    });
    window.addEventListener("message", (event) => {
      if (event.data?.source !== "rterm" || event.data.type !== "sessions-response") return;
      const match = [...this.frames.entries()].find(
        ([, frame]) => event.source === frame.contentWindow,
      );
      if (!match) return;
      const [threadId, frame] = match;
      let responseOrigin: string;
      try {
        responseOrigin = new URL(frame.src).origin;
      } catch {
        return;
      }
      if (
        event.origin !== responseOrigin ||
        (this.bridgeTokens.has(frame) && event.data.bridgeToken !== this.bridgeTokens.get(frame)) ||
        typeof event.data.requestId !== "string"
      )
        return;
      window.peskApi.sendRtermSessionsResponse?.(threadId, {
        requestId: event.data.requestId,
        ok: event.data.ok === true,
        connected: event.data.connected === true,
        result: event.data.result,
        error: typeof event.data.error === "string" ? event.data.error : undefined,
      });
    });
    this.closeButton.addEventListener("click", () => this.hide());
    this.refreshButton?.addEventListener("click", () => this.refresh());
    this.layoutButton?.addEventListener("click", () => this.toggleLayout());
    document.addEventListener("toggle-rterm", () => this.toggleVisibility());
    this.resizeHandle.addEventListener("pointerdown", (event) => this.startResize(event));
    const chat = this.chatElement;
    if (chat && typeof MutationObserver !== "undefined") {
      this.layoutObserver = new MutationObserver(() => this.updateSideLayoutPosition());
      for (const id of ["codex-chat-header", "codex-rate-limit", "codex-error"]) {
        const element = chat.querySelector(`#${id}`);
        if (element)
          this.layoutObserver.observe(element, {
            attributes: true,
            childList: true,
            subtree: true,
          });
      }
    }
    window.peskApi.getRterm().then((snapshot) => this.render(snapshot));
  }

  setThread(threadId: string | undefined): void {
    const nextThreadId = threadId ?? "standalone";
    if (this.threadId === nextThreadId) return;
    this.threadId = nextThreadId;
    this.visible = this.visibility.get(this.threadId) ?? false;
    if (!this.visible && this.sideLayout) this.toggleLayout();
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
    this.snapshot = snapshot;
    this.panel.hidden = !snapshot.enabled || !this.visible;
    if (this.panel.hidden && this.sideLayout) this.toggleLayout();
    this.updateSideLayoutPosition();
    if (this.visible && (!this.frame.src || (stateChanged && snapshot.state !== "connected")))
      this.loadEmbedUrl();
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
    if (this.sideLayout) this.toggleLayout();
    this.visible = false;
    this.visibility.set(this.threadId, false);
    this.panel.hidden = true;
  }

  private loadEmbedUrl(): void {
    const threadId = this.threadId;
    const frame = this.frame;
    window.peskApi.getRtermEmbedUrl().then((url) => {
      if (this.threadId !== threadId || this.frame !== frame) return;
      if (!url) return;
      try {
        const embedUrl = new URL(url);
        const bridgeToken = crypto.randomUUID();
        this.bridgeTokens.set(frame, bridgeToken);
        embedUrl.searchParams.set("bridgeToken", bridgeToken);
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

  private refresh(): void {
    if (!this.frame.src) return;
    const currentSrc = this.frame.src;
    this.frame.src = currentSrc;
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
    const startCoordinate = this.sideLayout ? event.clientX : event.clientY;
    const startSize = this.sideLayout
      ? this.panel.getBoundingClientRect().width
      : this.panel.getBoundingClientRect().height;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      const coordinate = this.sideLayout ? moveEvent.clientX : moveEvent.clientY;
      const size = this.sideLayout
        ? Math.min(
            70,
            Math.max(
              25,
              (startSize / Math.max(this.chatElement?.getBoundingClientRect().width ?? 0, 1)) *
                100 +
                ((startCoordinate - coordinate) /
                  Math.max(this.chatElement?.getBoundingClientRect().width ?? 0, 1)) *
                  100,
            ),
          )
        : Math.min(420, Math.max(90, startSize - coordinate + startCoordinate));
      if (this.sideLayout) {
        this.sideWidth = size;
        this.chatElement?.style.setProperty("--rterm-side-width", `${size}%`);
      } else {
        this.panel.style.height = `${size}px`;
        this.panel.style.flexBasis = `${size}px`;
      }
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

  private get chatElement(): HTMLElement | null {
    return this.panel.closest("#codex-chat");
  }

  private updateSideLayoutPosition(): void {
    if (!this.sideLayout) return;
    const chat = this.chatElement;
    if (!chat) return;
    const chatTop = chat.getBoundingClientRect().top;
    let top = 0;
    for (const id of ["codex-chat-header", "codex-rate-limit", "codex-error"]) {
      const element = chat.querySelector<HTMLElement>(`#${id}`);
      if (!element || element.hidden) continue;
      top = Math.max(top, element.getBoundingClientRect().bottom - chatTop);
    }
    this.panel.style.top = `${Math.max(0, top + 8)}px`;
  }

  private toggleLayout(): void {
    this.sideLayout = !this.sideLayout;
    this.chatElement?.classList.toggle("rterm-side-layout", this.sideLayout);
    this.chatElement?.style.setProperty("--rterm-side-width", `${this.sideWidth}%`);
    if (this.sideLayout) {
      this.panel.style.removeProperty("height");
      this.panel.style.removeProperty("flex-basis");
    } else {
      this.panel.style.removeProperty("top");
    }
    this.updateSideLayoutPosition();
    this.resizeHandle.setAttribute("aria-orientation", this.sideLayout ? "vertical" : "horizontal");
    this.resizeHandle.setAttribute(
      "aria-label",
      this.sideLayout ? "Resize remote terminal width" : "Resize remote terminal height",
    );
    if (this.layoutButton) {
      this.layoutButton.innerHTML = this.sideLayout
        ? '<svg class="rterm-layout-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M3 15h18"></path></svg>'
        : '<svg class="rterm-layout-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M15 3v18"></path></svg>';
      this.layoutButton.setAttribute(
        "aria-label",
        this.sideLayout
          ? "Move remote terminal below the chat"
          : "Move remote terminal to the right side",
      );
      this.layoutButton.title = this.layoutButton.getAttribute("aria-label") ?? "";
    }
  }
}

export function setupRtermRenderer(): RtermRenderer | undefined {
  const panel = document.getElementById("rterm-panel");
  const frame = document.getElementById("rterm-frame");
  const closeButton = document.getElementById("rterm-close");
  const resizeHandle = document.getElementById("rterm-resize-handle");
  const refreshButton = document.getElementById("rterm-refresh");
  const layoutButton = document.getElementById("rterm-layout");
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
    closeButton,
    resizeHandle,
    refreshButton instanceof HTMLButtonElement ? refreshButton : undefined,
    layoutButton instanceof HTMLButtonElement ? layoutButton : undefined,
  );
  renderer.setup();
  return renderer;
}
