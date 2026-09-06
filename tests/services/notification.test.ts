/** @jest-environment node */
/// <reference types="jest" />

import { NotificationController } from "../../src/services/notification";

function createController() {
  const pet = {
    show: jest.fn(),
    showForNotification: jest.fn(),
    setBackgroundAttention: jest.fn(),
    playCodexStatusSound: jest.fn(),
    setCodexUpdateIndicator: jest.fn(),
  };
  const chat = {
    window: {
      isVisible: jest.fn(() => false),
      isFocused: jest.fn(() => false),
    },
    showInactive: jest.fn(),
    focusInput: jest.fn(),
    focusForUserInput: jest.fn(),
  };
  const webServer = { notifyCodexAttention: jest.fn() };
  const codex = {
    selectThread: jest.fn(),
    selectNextAttentionThread: jest.fn(),
  };
  const controller = new NotificationController(pet as never, chat as never, webServer as never, {
    codex,
    isChatVisible: () => chat.window.isVisible(),
  });
  return { controller, pet, chat, webServer, codex };
}

test("coordinates every background attention effect", () => {
  const { controller, pet, chat, webServer, codex } = createController();

  controller.handle({
    event: "approvalRequested",
    threadId: "background",
    selectedThreadId: "selected",
  });

  expect(pet.setBackgroundAttention).toHaveBeenCalledWith(true);
  expect(pet.showForNotification).toHaveBeenCalled();
  expect(chat.showInactive).toHaveBeenCalled();
  expect(pet.playCodexStatusSound).toHaveBeenCalled();
  expect(webServer.notifyCodexAttention).toHaveBeenCalledWith("approval");
  expect(codex.selectThread).toHaveBeenCalledWith("background", false);
});

test("does not change the selected thread while chat is visible", () => {
  const { controller, chat, codex } = createController();
  chat.window.isVisible.mockReturnValue(true);

  controller.handle({
    event: "userInputRequested",
    threadId: "background",
    selectedThreadId: "selected",
  });

  expect(codex.selectThread).not.toHaveBeenCalled();
});

test("does not alert for a focused selected thread", () => {
  const { controller, pet, chat, webServer } = createController();
  chat.window.isFocused.mockReturnValue(true);

  controller.handle({
    event: "userInputRequested",
    threadId: "selected",
    selectedThreadId: "selected",
  });

  expect(pet.setBackgroundAttention).not.toHaveBeenCalled();
  expect(chat.showInactive).toHaveBeenCalled();
  expect(chat.focusForUserInput).not.toHaveBeenCalled();
  expect(pet.playCodexStatusSound).not.toHaveBeenCalled();
  expect(webServer.notifyCodexAttention).not.toHaveBeenCalled();
});

test("alerts for an unfocused selected-thread update", () => {
  const { controller, pet, chat, webServer } = createController();

  controller.handle({
    event: "turnCompleted",
    threadId: "selected",
    selectedThreadId: "selected",
  });

  expect(chat.showInactive).toHaveBeenCalled();
  expect(pet.setBackgroundAttention).toHaveBeenCalledWith(true);
  expect(pet.playCodexStatusSound).toHaveBeenCalled();
  expect(webServer.notifyCodexAttention).toHaveBeenCalledWith("finished");
});

test("keeps a focused chat on the focus color for background updates", () => {
  const { controller, pet, chat, webServer } = createController();
  chat.window.isFocused.mockReturnValue(true);

  controller.handle({
    event: "turnCompleted",
    threadId: "background",
    selectedThreadId: "selected",
  });

  expect(pet.setBackgroundAttention).not.toHaveBeenCalled();
  expect(pet.setCodexUpdateIndicator).not.toHaveBeenCalled();
  expect(pet.playCodexStatusSound).not.toHaveBeenCalled();
  expect(webServer.notifyCodexAttention).not.toHaveBeenCalled();
});

test("shows a completed update without focusing the composer", () => {
  const { controller, chat } = createController();

  controller.handle({
    event: "turnCompleted",
    threadId: "background",
    selectedThreadId: "selected",
  });

  expect(chat.showInactive).toHaveBeenCalled();
  expect(chat.focusInput).not.toHaveBeenCalled();
  expect(chat.focusForUserInput).not.toHaveBeenCalled();
});

test("alerts again while an unfocused background update is already blue", () => {
  const { controller, pet, chat, webServer } = createController();

  const request = {
    event: "turnCompleted" as const,
    threadId: "background",
    selectedThreadId: "selected",
  };
  controller.handle(request);
  controller.handle(request);

  expect(chat.showInactive).toHaveBeenCalledTimes(2);
  expect(pet.setBackgroundAttention).toHaveBeenCalledTimes(2);
  expect(pet.playCodexStatusSound).toHaveBeenCalledTimes(2);
  expect(webServer.notifyCodexAttention).toHaveBeenCalledTimes(2);
});

test("clears the pet attention indicator", () => {
  const { controller, pet, codex } = createController();

  controller.clear();

  expect(pet.setCodexUpdateIndicator).toHaveBeenCalledWith(false);
  expect(codex.selectNextAttentionThread).toHaveBeenCalled();
});
