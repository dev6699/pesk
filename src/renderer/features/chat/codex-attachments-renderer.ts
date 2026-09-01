export class CodexAttachmentRenderer {
  private pendingImages: Array<{ url: string; name: string }> = [];

  constructor(
    private readonly form: HTMLFormElement,
    private readonly input: HTMLTextAreaElement,
    private readonly imageInput: HTMLInputElement | null,
    private readonly imageAttachments: HTMLElement | null,
  ) {}

  get images(): Array<{ url: string; name: string }> {
    return this.pendingImages;
  }

  clear(): void {
    this.pendingImages = [];
    this.renderImageAttachments();
  }

  setup(): void {
    const dropTarget = this.form;
    this.imageInput?.addEventListener("change", () => {
      void this.addImageFiles(this.imageInput?.files);
      window.peskApi.setChatFileDialogOpen(false);
      if (this.imageInput) this.imageInput.value = "";
    });
    this.input.addEventListener("paste", (event) => {
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (!files.length) return;
      event.preventDefault();
      void this.addImageFiles(files);
    });
    document.getElementById("codex-image-select")?.addEventListener("click", () => {
      window.peskApi.setChatFileDialogOpen(true);
      this.imageInput?.click();
    });
    dropTarget.addEventListener("dragover", (event) => {
      if (!this.hasImageFiles(event.dataTransfer)) return;
      event.preventDefault();
      dropTarget.classList.add("codex-drop-active");
    });
    dropTarget.addEventListener("dragleave", (event) => {
      if (event.relatedTarget instanceof Node && dropTarget.contains(event.relatedTarget)) return;
      dropTarget.classList.remove("codex-drop-active");
    });
    dropTarget.addEventListener("drop", (event) => {
      if (!this.hasImageFiles(event.dataTransfer)) return;
      event.preventDefault();
      dropTarget.classList.remove("codex-drop-active");
      void this.addImageFiles(event.dataTransfer?.files);
    });
  }

  /** Reports whether a data transfer contains image files. */
  private hasImageFiles(dataTransfer: DataTransfer | null): boolean {
    return Boolean(
      Array.from(dataTransfer?.items ?? []).some(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      ),
    );
  }

  /** Converts accepted image files to data URLs for pending attachments. */
  private async addImageFiles(files: Iterable<File> | null | undefined): Promise<void> {
    for (const file of Array.from(files ?? [])) {
      if (!file.type.startsWith("image/")) continue;
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      }).catch(() => "");
      if (url) this.pendingImages.push({ url, name: file.name });
    }
    this.renderImageAttachments();
  }

  /** Renders the current pending image attachments. */
  private renderImageAttachments(): void {
    if (!this.imageAttachments) return;
    this.imageAttachments.replaceChildren();
    this.imageAttachments.hidden = !this.pendingImages.length;
    this.pendingImages.forEach((image, index) => {
      const item = document.createElement("div");
      item.className = "codex-image-attachment";
      const preview = document.createElement("img");
      preview.src = image.url;
      preview.alt = "";
      const name = document.createElement("span");
      name.textContent = image.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${image.name}`);
      remove.addEventListener("click", () => {
        this.pendingImages.splice(index, 1);
        this.renderImageAttachments();
      });
      item.append(preview, name, remove);
      this.imageAttachments?.append(item);
    });
  }
}
