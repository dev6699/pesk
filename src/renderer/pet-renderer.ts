interface PetRendererOptions {
  image: HTMLImageElement;
  pet: HTMLElement;
  status: HTMLElement;
  statusLabel: HTMLElement;
  chatOnly: boolean;
  settings: PetSettings;
}

export class PetRenderer {
  private settings: PetSettings;
  private frame = 0;
  private lastFrame = performance.now();
  private lastWander = performance.now();
  private animationFrames = [
    "../../assets/pet-idle-1.svg",
    "../../assets/pet-idle-2.svg",
    "../../assets/pet-idle-3.svg",
    "../../assets/pet-idle-2.svg",
  ];
  private animationFps = 6;
  private movementSpeed = 1.2;
  private configuredPetSize = 180;
  private availableAnimations: AnimationFrames[] = [];
  private currentAnimationName = "idle";
  private focused = false;

  constructor(private readonly options: PetRendererOptions) {
    this.settings = options.settings;
    this.updateStatus(this.settings);
    options.pet.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if (event.target !== options.pet && event.target !== options.image)
        return;
      if (this.settings.locked) return;
      window.petApi.startDrag();
      window.getSelection()?.removeAllRanges();
    });
    options.pet.addEventListener("wheel", (event) => {
      event.preventDefault();
      const currentScale = this.settings.scale || 1;
      const nextScale = currentScale + (event.deltaY < 0 ? 0.1 : -0.1);
      window.petApi.zoomPet(nextScale);
    });
    options.pet.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      window.petApi.showPetMenu();
    });
    window.addEventListener("mouseup", () => window.petApi.endDrag());
    document.addEventListener("mouseup", () => window.petApi.endDrag());
  }

  get wasFocused(): boolean {
    return this.focused;
  }

  updateSettings(next: PetSettings): void {
    const animationChanged = next.animation !== this.settings.animation;
    const modeChanged = next.animationMode !== this.settings.animationMode;
    this.settings = next;
    this.updateStatus(next);
    if (
      animationChanged ||
      (modeChanged && next.animationMode === "selected")
    ) {
      void this.selectAnimation(next.animation);
    }
    this.resizeElement();
  }

  updateFocus(focused: boolean): void {
    this.focused = focused;
  }

  async loadAnimations(): Promise<void> {
    const animations = await window.petApi.getAnimations();
    this.availableAnimations = animations;
    const selected =
      animations.find(
        (animation) => animation.name === this.settings.animation,
      ) ??
      animations.find((animation) => animation.name.toLowerCase() === "idle") ??
      animations[0];
    if (selected?.frames.length) this.applyAnimation(selected);
  }

  animate(now: number): void {
    if (
      !this.settings.paused &&
      now - this.lastFrame > 1000 / this.animationFps
    ) {
      this.frame = (this.frame + 1) % this.animationFrames.length;
      this.options.image.src = this.animationFrames[this.frame];
      this.lastFrame = now;
      if (
        this.frame === 0 &&
        this.settings.animationMode === "shuffle" &&
        this.availableAnimations.length > 1
      ) {
        const candidates = this.availableAnimations.filter(
          (animation) => animation.name !== this.currentAnimationName,
        );
        const next = candidates[Math.floor(Math.random() * candidates.length)];
        if (next) this.applyAnimation(next);
      }
    }
    if (
      this.settings.wandering &&
      !this.settings.locked &&
      now - this.lastWander > 80
    ) {
      window.petApi.movePet(this.movementSpeed, this.movementSpeed);
      this.lastWander = now;
    }
  }

  private async selectAnimation(name: string): Promise<void> {
    const animations = await window.petApi.getAnimations();
    this.availableAnimations = animations;
    const selected = animations.find((animation) => animation.name === name);
    if (!selected?.frames.length) return;
    this.applyAnimation(selected);
  }

  private applyAnimation(selected: AnimationFrames): void {
    this.currentAnimationName = selected.name;
    this.frame = 0;
    this.animationFrames = selected.frames;
    this.animationFps = selected.fps;
    this.movementSpeed = selected.speed;
    this.configuredPetSize = selected.size;
    this.resizeElement();
    this.options.image.src = this.animationFrames[0];
  }

  private resizeElement(): void {
    if (this.options.chatOnly) return;
    this.options.pet.style.width = `${this.configuredPetSize * this.settings.scale}px`;
    this.options.pet.style.height = `${this.configuredPetSize * this.settings.scale}px`;
  }

  private updateStatus(next: PetSettings): void {
    this.options.statusLabel.textContent =
      next.codexStatus[0].toUpperCase() + next.codexStatus.slice(1);
    this.options.status.className = `status-${next.codexStatus}`;
    this.options.status.title = "";
    this.options.status.setAttribute(
      "aria-label",
      this.options.statusLabel.textContent,
    );
  }
}
