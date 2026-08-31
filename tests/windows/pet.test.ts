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

import { screen } from "electron";
import { PetWindowController } from "../../src/windows/pet";
import { createWindowFactory, petOptions, resetWindowMocks } from "./window-test-helpers.test";

beforeEach(resetWindowMocks);

describe("PetWindowController", () => {
  test("focuses chat input when the pet window receives focus", () => {
    const { windows } = createWindowFactory();
    const options = petOptions();
    const controller = new PetWindowController(options);
    controller.create();

    windows[0].emit("focus");

    expect(options.showChat).toHaveBeenCalled();
    expect(options.focusChat).toHaveBeenCalled();
  });

  test("forwards focus and Codex-update state to the renderer", () => {
    const { windows } = createWindowFactory();
    const controller = new PetWindowController(petOptions());
    controller.create();

    controller.setCodexUpdateIndicator(true);
    controller.setFocusIndicator(true);

    expect(windows[0].webContents.send).toHaveBeenCalledWith("pet-codex-update-changed", true);
    expect(windows[0].webContents.send).toHaveBeenCalledWith("pet-focus-changed", true);
  });

  test("clears the update indicator when focus arrives", () => {
    const { windows } = createWindowFactory();
    const controller = new PetWindowController(petOptions());
    controller.create();

    controller.setBackgroundAttention(true);
    controller.setFocusIndicator(true);

    const updates = windows[0].webContents.send.mock.calls.filter(
      ([channel]) => channel === "pet-codex-update-changed",
    );
    expect(updates).toEqual([
      ["pet-codex-update-changed", true],
      ["pet-codex-update-changed", false],
    ]);
  });

  test("focuses chat when the pet is already focused", () => {
    const { windows } = createWindowFactory();
    const options = petOptions();
    const controller = new PetWindowController(options);
    controller.create();
    windows[0].focused = true;

    controller.focus();

    expect(options.focusChat).toHaveBeenCalled();
  });

  test("hides chat during dragging and focuses it after drag ends", () => {
    const { windows } = createWindowFactory();
    (screen.getCursorScreenPoint as jest.Mock).mockReturnValue({ x: 120, y: 140 });
    const options = petOptions();
    const controller = new PetWindowController(options);
    controller.create();

    controller.startDragging();
    controller.stopDragging();

    expect(options.hideChatImmediately).toHaveBeenCalled();
    expect(options.focusChat).toHaveBeenCalled();
    expect(windows[0].setPosition).not.toHaveBeenCalled();
  });
});
