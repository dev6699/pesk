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
    loadRawConfig: jest.fn(() => ({ chatWidth: 330, chatHeight: 360 })),
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
import { createWindowFactory, FakeWindow, resetWindowMocks } from "./window-test-helpers.test";

beforeEach(resetWindowMocks);

describe("ChatWindowController", () => {
  test("shows chat without taking focus", () => {
    const { windows } = createWindowFactory();
    const controller = new ChatWindowController();

    controller.showInactive();

    expect(windows[0].showInactive).toHaveBeenCalled();
    expect(windows[0].focus).not.toHaveBeenCalled();
  });

  test("shows chat for a Codex update without stealing focus", () => {
    const { windows } = createWindowFactory();
    const controller = new ChatWindowController();

    controller.showInactive();

    expect(windows[0].showInactive).toHaveBeenCalled();
    expect(windows[0].focus).not.toHaveBeenCalled();
  });

  test("shows chat for an approval without taking focus", () => {
    const { windows } = createWindowFactory();
    const controller = new ChatWindowController();

    controller.showInactive();

    expect(windows[0].showInactive).toHaveBeenCalled();
    expect(windows[0].focus).not.toHaveBeenCalled();
  });

  test("does not coordinate pet focus on chat blur", () => {
    jest.useFakeTimers();
    const { windows } = createWindowFactory();
    const controller = new ChatWindowController();
    controller.create();

    windows[0].emit("blur");
    jest.advanceTimersByTime(50);

    expect(windows[0].hide).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  test("does not hide chat or update pet focus on blur", () => {
    jest.useFakeTimers();
    const { windows } = createWindowFactory();
    const controller = new ChatWindowController();
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
    const controller = new ChatWindowController();

    controller.create();
    controller.position(pet.bounds);

    expect(windows[0].setPosition).toHaveBeenLastCalledWith(570, 440, false);
  });
});
