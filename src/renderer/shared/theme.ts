export function applyRendererTheme(theme: Record<string, string> | undefined): void {
  if (!theme) return;
  for (const [property, value] of Object.entries(theme)) {
    document.documentElement.style.setProperty(property, value);
  }
}
