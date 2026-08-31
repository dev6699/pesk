/// <reference types="jest" />

import { FocusController } from "../../src/app/focus";

function makeTargets(focused: boolean) {
  return {
    chat: {
      window: { isFocused: jest.fn(() => focused) },
      focusForUserInput: jest.fn(),
      focusInput: jest.fn(),
      hide: jest.fn(),
    },
    pet: { window: null, focus: jest.fn() },
  };
}

test("focuses the pending question when chat is focused", () => {
  const { chat, pet } = makeTargets(true);

  new FocusController(chat as never, pet as never).routeGlobalShortcut(true);

  expect(chat.focusForUserInput).toHaveBeenCalledTimes(1);
  expect(chat.focusInput).not.toHaveBeenCalled();
  expect(pet.focus).not.toHaveBeenCalled();
});

test("focuses the normal input when focused chat has no pending question", () => {
  const { chat, pet } = makeTargets(true);

  new FocusController(chat as never, pet as never).routeGlobalShortcut(false);

  expect(chat.focusInput).toHaveBeenCalledTimes(1);
  expect(chat.focusForUserInput).not.toHaveBeenCalled();
  expect(pet.focus).not.toHaveBeenCalled();
});

test("focuses the pet when chat is not focused", () => {
  const { chat, pet } = makeTargets(false);

  new FocusController(chat as never, pet as never).routeGlobalShortcut(true);

  expect(pet.focus).toHaveBeenCalledTimes(1);
  expect(chat.focusForUserInput).not.toHaveBeenCalled();
  expect(chat.focusInput).not.toHaveBeenCalled();
});

test("does not hide chat while a file dialog is open", () => {
  const { chat, pet } = makeTargets(true);
  const chatWindow = {
    isFocused: jest.fn(() => false),
    on: jest.fn((event: string, callback: () => void) => {
      if (event === "blur") callback();
    }),
  };
  chat.window = chatWindow as never;
  const petWindow = { isFocused: jest.fn(() => false) };
  pet.window = petWindow as never;
  const controller = new FocusController(chat as never, pet as never);

  controller.setFileDialogOpen(true);
  controller.wireChatWindow();

  expect(chat.hide).not.toHaveBeenCalled();
});
