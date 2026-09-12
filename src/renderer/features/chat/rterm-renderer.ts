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
    private readonly status: HTMLElement,
    private readonly frame: HTMLIFrameElement,
    private readonly connection: HTMLButtonElement,
    private readonly closeButton: HTMLButtonElement,
    private readonly resizeHandle: HTMLElement,
    private visible = false,
  ) {}
  private threadId = "standalone";
  private readonly visibility = new Map<string, boolean>();

  setup(): void {
    window.peskApi.onRtermChanged((snapshot) => this.render(snapshot));
    window.peskApi.onRtermOutput((data) => this.post({ type: "output", data }));
    this.connection.addEventListener("click", () => window.peskApi.toggleRtermConnection());
    this.closeButton.addEventListener("click", () => this.hide());
    document.addEventListener("toggle-rterm", () => this.toggleVisibility());
    this.resizeHandle.addEventListener("pointerdown", (event) => this.startResize(event));
    window.addEventListener("message", (event) => this.handleFrameMessage(event));
    this.frame.addEventListener("load", () => {
      this.postCurrentState();
      if (this.snapshot.output)
        this.post({ type: "output", data: this.encode(this.snapshot.output) });
    });
    window.peskApi.getRterm().then((snapshot) => this.render(snapshot));
  }

  setThread(threadId: string | undefined): void {
    this.threadId = threadId ?? "standalone";
    this.visible = this.visibility.get(this.threadId) ?? false;
    this.render(this.snapshot);
    this.post({ type: "reset" });
    if (this.snapshot.output)
      this.post({ type: "output", data: this.encode(this.snapshot.output) });
  }

  private render(snapshot: RtermSnapshot): void {
    const previousState = this.snapshot.state;
    this.snapshot = snapshot;
    this.panel.hidden = !snapshot.enabled || !this.visible;
    this.status.textContent = `${snapshot.hostLabel || "Remote shell"} · ${snapshot.state}`;
    this.connection.textContent = snapshot.state === "disconnected" ? "Reconnect" : "Disconnect";
    this.connection.disabled = snapshot.state === "disconnected" && !this.snapshot.hostLabel;
    if (this.visible) this.loadEmbedUrl(snapshot.state === "connecting");
    if (snapshot.state === "connecting") this.post({ type: "reset" });
    if (snapshot.state === "authenticating")
      this.post({
        type: snapshot.authFailed ? "authentication-failed" : "authentication-required",
      });
    if (snapshot.state === "connected") {
      if (previousState !== "connected") {
        this.post({ type: "reset" });
        this.post({ type: "authenticated" });
        this.postSnapshotOutput();
      }
    }
    if (snapshot.state === "disconnected") {
      if (previousState !== "disconnected") {
        this.post({ type: "reset" });
        this.post({ type: "disconnected" });
      }
    }
  }

  private toggleVisibility(): void {
    this.visible = !this.visible;
    this.visibility.set(this.threadId, this.visible);
    this.panel.hidden = !this.snapshot.enabled || !this.visible;
    if (this.visible) {
      this.render(this.snapshot);
      if (this.snapshot.state === "disconnected") window.peskApi.toggleRtermConnection();
    }
  }

  private hide(): void {
    this.visible = false;
    this.visibility.set(this.threadId, false);
    this.panel.hidden = true;
  }

  private loadEmbedUrl(force = false): void {
    window.peskApi.getRtermEmbedUrl().then((url) => {
      if (url && (force || this.frame.src !== url)) this.frame.src = url;
    });
  }

  private post(data: Record<string, unknown>): void {
    this.frame.contentWindow?.postMessage({ source: "pesk", ...data }, "*");
  }

  private postCurrentState(): void {
    const type =
      this.snapshot.state === "disconnected"
        ? "disconnected"
        : this.snapshot.state === "authenticating"
          ? this.snapshot.authFailed
            ? "authentication-failed"
            : "authentication-required"
          : "authenticated";
    this.post({ type });
  }

  private postSnapshotOutput(): void {
    if (this.snapshot.output)
      this.post({ type: "output", data: this.encode(this.snapshot.output) });
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

  private encode(value: string): string {
    return btoa(unescape(encodeURIComponent(value)));
  }

  private handleFrameMessage(event: MessageEvent): void {
    if (event.data?.source !== "rterm") return;
    switch (event.data.type) {
      case "loaded":
        this.postCurrentState();
        break;
      case "input":
        if (typeof event.data.data === "string") window.peskApi.writeRterm(event.data.data);
        break;
      case "authenticate":
        if (typeof event.data.code === "string") window.peskApi.authenticateRterm(event.data.code);
        break;
      case "terminal-resized":
        if (Number.isInteger(event.data.cols) && Number.isInteger(event.data.rows))
          window.peskApi.resizeRterm(event.data.cols, event.data.rows);
        break;
    }
  }
}

export function setupRtermRenderer(): RtermRenderer | undefined {
  const panel = document.getElementById("rterm-panel");
  const status = document.getElementById("rterm-status");
  const frame = document.getElementById("rterm-frame");
  const connection = document.getElementById("rterm-connection");
  const closeButton = document.getElementById("rterm-close");
  const resizeHandle = document.getElementById("rterm-resize-handle");
  if (
    !(panel instanceof HTMLElement) ||
    !(status instanceof HTMLElement) ||
    !(frame instanceof HTMLIFrameElement) ||
    !(connection instanceof HTMLButtonElement) ||
    !(closeButton instanceof HTMLButtonElement) ||
    !(resizeHandle instanceof HTMLElement)
  )
    return undefined;
  const renderer = new RtermRenderer(panel, status, frame, connection, closeButton, resizeHandle);
  renderer.setup();
  return renderer;
}
