interface PetRendererOptions {
  image: HTMLImageElement;
  pet: HTMLElement;
  status: HTMLElement;
  statusLabel: HTMLElement;
  aggregateStatusLabel?: HTMLElement;
  statusSound: HTMLAudioElement;
  chatOnly: boolean;
  state: RendererState;
}

export class PetRenderer {
  private state: RendererState;
  private frame = 0;
  private lastFrame = performance.now();
  private animationFrames = [
    "../../assets/pet-idle-1.svg",
    "../../assets/pet-idle-2.svg",
    "../../assets/pet-idle-3.svg",
    "../../assets/pet-idle-2.svg",
  ];
  private animationFps = 6;
  private configuredPetSize = 180;
  private availableAnimations: AnimationFrames[] = [];
  private animationLoadPromise: Promise<void> | undefined;
  private animationsLoaded = false;
  private currentAnimationName = "idle";
  private focused = false;
  private statusTimer: number | undefined;
  private statusSoundUrl = "";
  private lastReportedSize = "";

  constructor(private readonly options: PetRendererOptions) {
    this.state = options.state;
    this.updateStatus(this.state);
    options.pet.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if (event.target !== options.pet && event.target !== options.image) return;
      if (this.state.settings.locked) return;
      window.peskApi.startDrag();
      window.getSelection()?.removeAllRanges();
    });
    options.pet.addEventListener("wheel", (event) => {
      event.preventDefault();
      const currentScale = this.state.settings.scale || 1;
      const nextScale = currentScale + (event.deltaY < 0 ? 0.1 : -0.1);
      window.peskApi.zoomPet(nextScale);
    });
    options.pet.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      window.peskApi.showPetMenu();
    });
    options.pet.addEventListener("click", (event) => {
      if (event.button !== 0) return;
      if (event.target !== options.pet && event.target !== options.image) return;
      window.peskApi.focusPet();
    });
    options.pet.addEventListener("mouseup", () => window.peskApi.endDrag());
  }

  get wasFocused(): boolean {
    return this.focused;
  }

  updateState(next: RendererState): void {
    const animationChanged = next.settings.animation !== this.state.settings.animation;
    const modeChanged = next.settings.animationMode !== this.state.settings.animationMode;
    this.state = next;
    this.updateStatusSound(next.assets.codexStatusSoundUrl);
    this.updateStatus(next);
    this.updateAggregateStatus(next);
    if (
      this.animationsLoaded &&
      (animationChanged || (modeChanged && next.settings.animationMode === "selected"))
    ) {
      this.selectAnimation(next.settings.animation);
    }
    this.resizeElement();
  }

  updateFocus(focused: boolean): void {
    this.focused = focused;
    if (focused) {
      this.stopStatusSound();
      this.options.pet.classList.toggle("codex-update", false);
    }
    this.options.pet.classList.toggle("focused", focused);
    this.options.pet.setAttribute("aria-label", focused ? "Desktop pet (focused)" : "Desktop pet");
  }

  updateCodexUpdate(active: boolean): void {
    if (!active) {
      this.stopStatusSound();
    }
    this.options.pet.classList.toggle("codex-update", active);
  }

  playAttentionSound(): void {
    this.playStatusChangeSound();
  }

  async loadAnimations(): Promise<void> {
    if (this.animationLoadPromise) return this.animationLoadPromise;
    this.animationLoadPromise = window.peskApi
      .getAnimations()
      .then((animations) => {
        this.availableAnimations = animations;
        this.animationsLoaded = true;
        const selected =
          animations.find((animation) => animation.name === this.state.settings.animation) ??
          animations[0];
        if (selected?.frames.length) this.applyAnimation(selected);
        else this.showFallbackAnimation();
      })
      .catch(() => {
        this.animationsLoaded = true;
        this.showFallbackAnimation();
      });
    return this.animationLoadPromise;
  }

  animate(now: number): void {
    if (!this.state.settings.paused && now - this.lastFrame > 1000 / this.animationFps) {
      this.frame = (this.frame + 1) % this.animationFrames.length;
      this.options.image.src = this.animationFrames[this.frame];
      this.lastFrame = now;
      if (
        this.frame === 0 &&
        this.state.settings.animationMode === "shuffle" &&
        this.availableAnimations.length > 1
      ) {
        const candidates = this.availableAnimations.filter(
          (animation) => animation.name !== this.currentAnimationName,
        );
        const next = candidates[Math.floor(Math.random() * candidates.length)];
        if (next) this.applyAnimation(next);
      }
    }
  }

  private selectAnimation(name: string): void {
    const selected = this.availableAnimations.find((animation) => animation.name === name);
    if (!selected?.frames.length) return;
    this.applyAnimation(selected);
  }

  private applyAnimation(selected: AnimationFrames): void {
    this.currentAnimationName = selected.name;
    this.frame = 0;
    this.animationFrames = selected.frames;
    this.animationFps = selected.fps;
    this.configuredPetSize = selected.size;
    this.resizeElement();
    this.options.image.src = this.animationFrames[0];
    this.options.image.hidden = false;
  }

  private showFallbackAnimation(): void {
    this.options.image.hidden = false;
  }

  private resizeElement(): void {
    if (this.options.chatOnly) return;
    const artSize = this.configuredPetSize * this.state.settings.scale;
    this.options.pet.style.setProperty("--pet-art-size", `${artSize}px`);
    const statusBounds = this.options.status.getBoundingClientRect?.() ?? { width: 0, height: 0 };
    const width = Math.ceil(Math.max(artSize, statusBounds.width + 8));
    const height = Math.ceil(Math.max(artSize, statusBounds.height + 8));
    this.options.pet.style.width = `${width}px`;
    this.options.pet.style.height = `${height}px`;
    const measuredSize = `${width}x${height}`;
    if (this.lastReportedSize !== measuredSize) {
      this.lastReportedSize = measuredSize;
      window.peskApi.resizePetContent(width, height);
    }
  }

  private updateStatus(next: RendererState): void {
    if (this.statusTimer !== undefined) {
      window.clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    const render = (): void => {
      const label =
        next.codex.threads.current.thread.status[0].toUpperCase() +
        next.codex.threads.current.thread.status.slice(1);
      const elapsed =
        next.codex.threads.current.thread.workingSince !== undefined
          ? ` · ${formatElapsed(Date.now() - next.codex.threads.current.thread.workingSince)}`
          : "";
      this.options.statusLabel.textContent = `${label}${elapsed}`;
      this.options.status.setAttribute("aria-label", this.options.statusLabel.textContent);
      this.options.status.title = next.codex.threads.selectedId
        ? `Selected thread: ${next.codex.threads.selectedId}`
        : "Selected thread";
      this.resizeElement();
    };
    render();
    if (
      next.codex.threads.current.thread.status === "working" &&
      next.codex.threads.current.thread.workingSince !== undefined
    ) {
      this.statusTimer = window.setInterval(render, 1000);
    }
    this.options.status.className = `status-${next.codex.threads.current.thread.status}`;
  }

  private updateAggregateStatus(next: RendererState): void {
    const label = this.options.aggregateStatusLabel;
    if (!label) return;
    const otherThreads = next.codex.threads.activities.filter(
      (activity) =>
        activity.threadId !== next.codex.threads.selectedId && activity.status !== "idle",
    );
    const waitingCount = otherThreads.filter((activity) => activity.status === "waiting").length;
    const { completed, total } = next.codex.threads.backgroundWork;
    const separator = document.createElement("span");
    separator.className = "aggregate-status-separator";
    separator.textContent = "|";
    label.replaceChildren(`Wait ${waitingCount}`, separator, `Work ${completed}/${total}`);
    label.className = "";
    label.hidden = false;
    label.style.display = "inline-flex";
    label.title = otherThreads
      .map((activity) => {
        const threadStatus = activity.status[0].toUpperCase() + activity.status.slice(1);
        const elapsed =
          activity.workingSince !== undefined
            ? ` · ${formatElapsed(Date.now() - activity.workingSince)}`
            : "";
        const attention = activity.attention
          ? ` · needs ${activity.attention === "userInput" ? "input" : "approval"}`
          : "";
        return `${activity.preview || activity.threadId}: ${threadStatus}${elapsed}${attention}`;
      })
      .join("\n");
  }

  private playStatusChangeSound(): void {
    if (this.focused || !this.state.settings.codexStatusSound) return;

    const sound = this.options.statusSound;
    sound.currentTime = 0;
    sound.volume = 1;
    void sound.play().catch(() => undefined);
  }

  private stopStatusSound(): void {
    this.options.statusSound.pause();
    this.options.statusSound.currentTime = 0;
  }

  private updateStatusSound(url: string): void {
    if (url === this.statusSoundUrl) return;
    this.statusSoundUrl = url;
    this.options.statusSound.src = url;
    if (url) this.options.statusSound.load();
  }
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainderSeconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return `${hours}h ${remainderMinutes}m ${remainderSeconds}s`;
}
