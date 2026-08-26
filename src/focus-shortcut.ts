interface ChatFocusTarget {
  readonly window: {
    isFocused(): boolean;
  } | null;
  focusForUserInput(): void;
  focusInput(): void;
}

interface PetFocusTarget {
  focus(): void;
}

/** Routes the global focus shortcut to the most relevant visible control. */
export function routePetFocusShortcut(
  chat: ChatFocusTarget,
  pet: PetFocusTarget,
  hasPendingUserInput: boolean,
): void {
  if (!chat.window?.isFocused()) {
    pet.focus();
    return;
  }

  if (hasPendingUserInput) {
    chat.focusForUserInput();
  } else {
    chat.focusInput();
  }
}
