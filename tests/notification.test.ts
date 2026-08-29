/** @jest-environment node */
/// <reference types="jest" />

import { NotificationController } from "../src/notification";

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
  const controller = new NotificationController(
    pet as never,
    chat as never,
    webServer as never,
  );
  return { controller, pet, chat, webServer };
}

test("coordinates every background attention effect", () => {
  const { controller, pet, chat, webServer } = createController();

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
  const { controller, pet } = createController();

  controller.clear();

  expect(pet.setCodexUpdateIndicator).toHaveBeenCalledWith(false);
});
