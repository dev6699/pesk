function isOpenableImageUrl(url: string): boolean {
  return /^(https?:|data:image\/)/i.test(url);
}

function openDataImage(url: string): void {
  const separator = url.indexOf(",");
  const metadata = separator >= 0 ? url.slice(0, separator) : "";
  const encoded = separator >= 0 ? url.slice(separator + 1) : "";
  const mimeType = /^data:(image\/[a-z0-9.+-]+);base64$/i.exec(metadata)?.[1];
  if (!mimeType) return;

  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    const opened = window.open(objectUrl, "_blank", "noopener,noreferrer");
    if (!opened) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch {
    // Ignore malformed data images.
  }
}

function openImage(url: string): void {
  if (!isOpenableImageUrl(url)) return;
  if (/^data:image\//i.test(url)) {
    openDataImage(url);
    return;
  }
  void window.peskApi.openExternalUrl(url).catch(() => {
    // Ignore failures to hand the image URL to the system browser.
  });
}

/** Makes an image open at its full source size when activated. */
export function makeImageOpenable(image: HTMLImageElement): HTMLImageElement {
  image.classList.add("codex-image-link");
  image.title = "Open image";
  image.addEventListener("click", (event) => {
    event.preventDefault();
    openImage(image.src);
  });
  return image;
}

/** Adds the same behavior to images produced by sanitized Markdown. */
export function makeMarkdownImagesOpenable(container: HTMLElement): void {
  container.querySelectorAll<HTMLImageElement>("img").forEach(makeImageOpenable);
}

/** Opens remote Markdown links outside Electron windows with the preload API. */
export function makeMarkdownLinksOpenable(container: HTMLElement): void {
  container
    .querySelectorAll<HTMLAnchorElement>('a[href^="http:"], a[href^="https:"]')
    .forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const href = link.getAttribute("href");
        if (href) void window.peskApi.openExternalUrl(href).catch(() => {});
      });
    });
}
