export type ShortcutId = keyof typeof SHORTCUTS;

export interface ShortcutDefinition {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly ctrlOrMeta?: boolean;
  readonly ignoreModifiers?: boolean;
  readonly accelerator?: string;
}

export const SHORTCUTS = {
  menu: { key: "ArrowDown", accelerator: "Ctrl+Down" },
  petFocus: { key: "ArrowUp", accelerator: "Ctrl+Up" },
  sessionPrevious: { key: "ArrowLeft", ctrl: true },
  sessionNext: { key: "ArrowRight", ctrl: true },
  focusUserInput: { key: "ArrowUp", ctrl: true },
  copyMessage: { key: "c", ctrlOrMeta: true },
  historyTop: { key: "Home", alt: true },
  historyBottom: { key: "End", alt: true },
  copyMessageToInput: { key: "ArrowRight", alt: true },
  toggleMessage: { key: "Enter", shift: true },
  selectPreviousUserMessage: { key: "ArrowUp", alt: true, shift: true },
  selectNextUserMessage: { key: "ArrowDown", alt: true, shift: true },
  scrollHistoryUp: { key: "ArrowUp", shift: true },
  scrollHistoryDown: { key: "ArrowDown", shift: true },
  selectPreviousMessage: { key: "ArrowUp", alt: true },
  selectNextMessage: { key: "ArrowDown", alt: true },
  interrupt: { key: "c", ctrl: true },
  submit: { key: "Enter" },
  newline: { key: "Enter", ctrl: true },
  steer: { key: "Enter", alt: true },
  unfocusChat: { key: "Escape" },
  suggestionPrevious: { key: "ArrowUp" },
  suggestionNext: { key: "ArrowDown" },
  dismissSuggestions: { key: "Escape" },
  questionPrevious: { key: "ArrowUp" },
  questionNext: { key: "ArrowDown" },
  questionToNote: { key: "Tab" },
  questionFromNote: { key: "Tab", ignoreModifiers: true },
  closeMenu: { key: "Escape" },
  menuNextSection: { key: "Tab" },
  menuPreviousSection: { key: "Tab", shift: true },
  menuSearchBackspace: { key: "Backspace" },
  menuPreviousAction: { key: "ArrowUp" },
  menuNextAction: { key: "ArrowDown" },
  menuPreviousRowAction: { key: "ArrowLeft" },
  menuNextRowAction: { key: "ArrowRight" },
  pairingSubmit: { key: "Enter" },
  webStatusActivate: { key: "Enter" },
  webStatusActivateSpace: { key: " " },
} as const satisfies Record<string, ShortcutDefinition>;

export function matchesShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
  id: ShortcutId,
): boolean {
  const shortcut: ShortcutDefinition = SHORTCUTS[id];
  if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false;
  if (shortcut.ignoreModifiers) return true;
  const ctrlOrMeta = event.ctrlKey || event.metaKey;
  return (
    (shortcut.ctrlOrMeta ? ctrlOrMeta : event.ctrlKey === Boolean(shortcut.ctrl)) &&
    event.altKey === Boolean(shortcut.alt) &&
    event.shiftKey === Boolean(shortcut.shift) &&
    (shortcut.ctrlOrMeta || event.metaKey === Boolean(shortcut.meta))
  );
}

export function shortcutAccelerator(id: "menu" | "petFocus"): string {
  return SHORTCUTS[id].accelerator as string;
}
