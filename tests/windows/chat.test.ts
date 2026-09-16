/// <reference types="jest" />

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/tmp/pesk-user-data") },
  BrowserWindow: jest.fn(),
  screen: {
    getCursorScreenPoint: jest.fn(),
    getDisplayMatching: jest.fn(),
    getAllDisplays: jest.fn(),
    getPrimaryDisplay: jest.fn(),
  },
}));
jest.mock(
  "../../src/config/config.js",
  () => ({
    loadRawConfig: jest.fn(() => ({})),
    getConfigDirectory: jest.fn(() => "/tmp/pesk"),
  }),
  { virtual: true },
);
jest.mock("node:fs", () => ({
  existsSync: jest.fn(() => false),
  readdirSync: jest.fn(() => []),
  readFileSync: jest.fn(() => ""),
}));

import { ChatWindowController } from "../../src/windows/chat";
import type { PeskSettings } from "../../src/config/config";
import { createWindowFactory, FakeWindow, resetWindowMocks } from "./window-test-helpers.test";

beforeEach(resetWindowMocks);

describe("ChatWindowController", () => {
  function createController() {
    const settings = {} as PeskSettings;
    const saveSettings = jest.fn();
    return {
      controller: new ChatWindowController({
        getSettings: () => settings,
        saveSettings,
      }),
      settings,
      saveSettings,
    };
  }

  test("shows chat without taking focus", () => {
    const { windows } = createWindowFactory();
    const { controller } = createController();

    controller.showInactive();

    expect(windows[0].showInactive).toHaveBeenCalled();
    expect(windows[0].loadURL).toHaveBeenCalledWith("pesk://renderer/chat.html");
    expect(windows[0].focus).not.toHaveBeenCalled();
  });

  test("shows chat for a Codex update without stealing focus", () => {
    const { windows } = createWindowFactory();
    const { controller } = createController();

    controller.showInactive();

    expect(windows[0].showInactive).toHaveBeenCalled();
    expect(windows[0].focus).not.toHaveBeenCalled();
  });

  test("shows chat for an approval without taking focus", () => {
    const { windows } = createWindowFactory();
    const { controller } = createController();

    controller.showInactive();

    expect(windows[0].showInactive).toHaveBeenCalled();
    expect(windows[0].focus).not.toHaveBeenCalled();
  });

  test("does not coordinate pet focus on chat blur", () => {
    jest.useFakeTimers();
    const { windows } = createWindowFactory();
    const { controller } = createController();
    controller.create();

    windows[0].emit("blur");
    jest.advanceTimersByTime(50);

    expect(windows[0].hide).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  test("does not hide chat or update pet focus on blur", () => {
    jest.useFakeTimers();
    const { windows } = createWindowFactory();
    const { controller } = createController();
    controller.create();

    windows[0].emit("blur");
    jest.advanceTimersByTime(50);

    expect(windows[0].hide).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  test("clamps chat beside the pet within the display work area", () => {
    const { windows } = createWindowFactory();
    const pet = new FakeWindow();
    pet.bounds = { x: 900, y: 700, width: 180, height: 180 };
    const { controller } = createController();

    controller.create();
    controller.position(pet.bounds);

    expect(windows[0].setPosition).toHaveBeenLastCalledWith(540, 500, false);
  });

  test("allows resizing and remembers the latest native dimensions", () => {
    const { windows } = createWindowFactory();
    const { controller, settings, saveSettings } = createController();

    controller.create();
    windows[0].setSize(720, 540);
    windows[0].emit("resize");

    expect(controller.getSize()).toEqual({ width: 720, height: 540 });
    expect(settings).toMatchObject({ chatWidth: 720, chatHeight: 540 });
    expect(saveSettings).toHaveBeenCalled();
  });

  test("keeps the chat attached to the pet while resizing", () => {
    const { windows } = createWindowFactory();
    const pet = new FakeWindow();
    pet.bounds = { x: 100, y: 100, width: 180, height: 180 };
    const { controller } = createController();

    controller.create();
    controller.position(pet.bounds);
    windows[0].setPosition(400, 100);
    windows[0].setSize(720, 540);
    windows[0].emit("resize");

    expect(windows[0].setPosition).toHaveBeenLastCalledWith(280, 100, false);
  });

  test("restores saved dimensions over the configured defaults", () => {
    const settings = { chatWidth: 720, chatHeight: 540 } as PeskSettings;
    const controller = new ChatWindowController({
      getSettings: () => settings,
      saveSettings: jest.fn(),
    });

    expect(controller.getSize()).toEqual({ width: 720, height: 540 });
  });
});
