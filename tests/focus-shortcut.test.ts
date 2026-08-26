/// <reference types="jest" />

import { routePetFocusShortcut } from "../src/focus-shortcut";

function makeTargets(focused: boolean) {
  return {
    chat: {
      window: { isFocused: jest.fn(() => focused) },
      focusForUserInput: jest.fn(),
      focusInput: jest.fn(),
    },
    pet: { focus: jest.fn() },
  };
}

test("focuses the pending question when chat is focused", () => {
  const { chat, pet } = makeTargets(true);

  routePetFocusShortcut(chat, pet, true);

  expect(chat.focusForUserInput).toHaveBeenCalledTimes(1);
  expect(chat.focusInput).not.toHaveBeenCalled();
  expect(pet.focus).not.toHaveBeenCalled();
});

test("focuses the normal input when focused chat has no pending question", () => {
  const { chat, pet } = makeTargets(true);

  routePetFocusShortcut(chat, pet, false);

  expect(chat.focusInput).toHaveBeenCalledTimes(1);
  expect(chat.focusForUserInput).not.toHaveBeenCalled();
  expect(pet.focus).not.toHaveBeenCalled();
});

test("focuses the pet when chat is not focused", () => {
  const { chat, pet } = makeTargets(false);

  routePetFocusShortcut(chat, pet, true);

  expect(pet.focus).toHaveBeenCalledTimes(1);
  expect(chat.focusForUserInput).not.toHaveBeenCalled();
  expect(chat.focusInput).not.toHaveBeenCalled();
});
