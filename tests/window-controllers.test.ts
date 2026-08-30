/// <reference types="jest" />

import { EventEmitter } from "node:events";

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/tmp/pesk-user-data"),
  },
  BrowserWindow: jest.fn(),
  screen: {
    getCursorScreenPoint: jest.fn(),
    getDisplayMatching: jest.fn(),
    getAllDisplays: jest.fn(),
    getPrimaryDisplay: jest.fn(),
  },
}));

jest.mock(
  "../src/config.js",
  () => ({
    loadRawConfig: jest.fn(() => ({
      chatWidth: 330,
      chatHeight: 360,
    })),
    getConfigDirectory: jest.fn(() => "/tmp/pesk"),
  }),
  { virtual: true },
);

jest.mock("node:fs", () => ({
  existsSync: jest.fn(() => false),
  readdirSync: jest.fn(() => []),
  readFileSync: jest.fn(() => ""),
}));

import { BrowserWindow, screen } from "electron";
import { ChatWindowController } from "../src/chat";
import { PetWindowController } from "../src/pet";
import { PetRenderer } from "../src/renderer/features/pet/pet-renderer";
import { defaultSettings } from "../src/renderer/shared/default-settings";

type Handler = (...args: unknown[]) => void;

class FakeWindow extends EventEmitter {
  visible = false;
  focused = false;
  position = [0, 0];
  bounds = { x: 100, y: 120, width: 180, height: 180 };
  webContents = {
    send: jest.fn(),
    focus: jest.fn(),
    openDevTools: jest.fn(),
  };

  setMenu = jest.fn();
  setSkipTaskbar = jest.fn();
  setAlwaysOnTop = jest.fn();
  loadFile = jest.fn();
  setSize = jest.fn();
  moveTop = jest.fn();
  show = jest.fn(() => {
    this.visible = true;
  });
  showInactive = jest.fn(() => {
    this.visible = true;
  });
  hide = jest.fn(() => {
    this.visible = false;
  });
  close = jest.fn(() => {
    this.emit("closed");
  });
  focus = jest.fn(() => {
    this.focused = true;
  });
  isVisible = jest.fn(() => this.visible);
  isFocused = jest.fn(() => this.focused);
  getPosition = jest.fn(() => this.position);
  setPosition = jest.fn((x: number, y: number) => {
    this.position = [x, y];
  });
  getBounds = jest.fn(() => this.bounds);
  setFocusable = jest.fn();
}

function createWindowFactory(): { windows: FakeWindow[]; factory: jest.Mock } {
  const windows: FakeWindow[] = [];
  const factory = BrowserWindow as unknown as jest.Mock;
  factory.mockImplementation(() => {
    const window = new FakeWindow();
    windows.push(window);
    return window;
  });
  return { windows, factory };
}

function petOptions() {
  return {
    getSettings: () => ({
      ...defaultSettings(),
      visible: true,
    }),
    saveSettings: jest.fn(),
    publishRendererState: jest.fn(),
    refreshTrayMenu: jest.fn(),
    positionChat: jest.fn(),
    showChat: jest.fn(),
    hideChat: jest.fn(),
    hideChatImmediately: jest.fn(),
    hideMenu: jest.fn(),
    focusChat: jest.fn(),
    isChatFocused: jest.fn(() => false),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1000, height: 800 },
    workArea: { x: 0, y: 0, width: 1000, height: 800 },
    scaleFactor: 1,
  };
  (screen.getDisplayMatching as jest.Mock).mockReturnValue(display);
  (screen.getAllDisplays as jest.Mock).mockReturnValue([display]);
  (screen.getPrimaryDisplay as jest.Mock).mockReturnValue(display);
});

describe("ChatWindowController", () => {
  test("shows chat for a Codex update and marks the pet without stealing focus", () => {
    const { windows } = createWindowFactory();
    const pet = new FakeWindow();
    const options = {
      getPetWindow: () => pet as never,
      keepPetAbove: jest.fn(),
      setPetFocus: jest.fn(),
      setCodexUpdateIndicator: jest.fn(),
    };
    const controller = new ChatWindowController();

    controller.showInactive();

    expect(windows[0].showInactive).toHaveBeenCalled();
    expect(windows[0].focus).not.toHaveBeenCalled();
  });

  test("shows chat for an approval without taking focus", () => {
    const { windows } = createWindowFactory();
    const pet = new FakeWindow();
    const options = {
      getPetWindow: () => pet as never,
      keepPetAbove: jest.fn(),
      setPetFocus: jest.fn(),
      setCodexUpdateIndicator: jest.fn(),
    };
    const controller = new ChatWindowController();

    controller.showInactive();

    expect(windows[0].showInactive).toHaveBeenCalled();
    expect(windows[0].focus).not.toHaveBeenCalled();
  });

  test("shows chat without taking focus when the pet is focused", () => {
    const { windows } = createWindowFactory();
    const pet = new FakeWindow();
    pet.focused = true;
    const options = {
      getPetWindow: () => pet as never,
      keepPetAbove: jest.fn(),
      setPetFocus: jest.fn(),
      setCodexUpdateIndicator: jest.fn(),
    };
    const controller = new ChatWindowController();

    controller.showInactive();

    expect(windows[0].showInactive).toHaveBeenCalled();
  });

  test("does not coordinate pet focus on chat blur", () => {
    jest.useFakeTimers();
    const { windows } = createWindowFactory();
    const pet = new FakeWindow();
    pet.focused = true;
    const options = {
      getPetWindow: () => pet as never,
      keepPetAbove: jest.fn(),
      setPetFocus: jest.fn(),
      setCodexUpdateIndicator: jest.fn(),
    };
    const controller = new ChatWindowController();
    controller.create();
    const chat = windows[0];

    chat.emit("blur");
    jest.advanceTimersByTime(50);

    expect(chat.hide).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  test("does not hide chat or update pet focus on blur", () => {
    jest.useFakeTimers();
    const { windows } = createWindowFactory();
    const pet = new FakeWindow();
    const options = {
      getPetWindow: () => pet as never,
      keepPetAbove: jest.fn(),
      setPetFocus: jest.fn(),
      setCodexUpdateIndicator: jest.fn(),
    };
    const controller = new ChatWindowController();
    controller.create();
    const chat = windows[0];

    chat.emit("blur");
    jest.advanceTimersByTime(50);

    expect(chat.hide).not.toHaveBeenCalled();
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
    const options = petOptions();
    const controller = new PetWindowController(options);
    controller.create();
    const pet = windows[0];

    controller.setCodexUpdateIndicator(true);
    controller.setFocusIndicator(true);

    expect(pet.webContents.send).toHaveBeenCalledWith("pet-codex-update-changed", true);
    expect(pet.webContents.send).toHaveBeenCalledWith("pet-focus-changed", true);
    expect(pet.webContents.send).toHaveBeenCalledWith("pet-codex-update-changed", false);
  });

  test("clears the update indicator when focus arrives", () => {
    const { windows } = createWindowFactory();
    const controller = new PetWindowController(petOptions());
    controller.create();
    const pet = windows[0];

    controller.setBackgroundAttention(true);
    controller.setFocusIndicator(true);

    const updateMessages = pet.webContents.send.mock.calls.filter(
      ([channel]) => channel === "pet-codex-update-changed",
    );
    expect(updateMessages).toEqual([
      ["pet-codex-update-changed", true],
      ["pet-codex-update-changed", false],
    ]);

    controller.setCodexUpdateIndicator(false);
    controller.setFocusIndicator(true);
    const finalUpdateMessage = pet.webContents.send.mock.calls
      .filter(([channel]) => channel === "pet-codex-update-changed")
      .at(-1);
    expect(finalUpdateMessage).toEqual(["pet-codex-update-changed", false]);
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
    (screen.getCursorScreenPoint as jest.Mock).mockReturnValue({
      x: 120,
      y: 140,
    });
    const options = petOptions();
    const controller = new PetWindowController(options);
    controller.create();

    controller.startDragging();
    expect(options.hideChatImmediately).toHaveBeenCalled();

    controller.stopDragging();
    expect(options.focusChat).toHaveBeenCalled();
    expect(windows[0].setPosition).not.toHaveBeenCalled();
  });
});

class FakeClassList {
  private readonly values = new Set<string>();

  toggle(name: string, enabled: boolean): void {
    if (enabled) this.values.add(name);
    else this.values.delete(name);
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }
}

class FakeElement {
  classList = new FakeClassList();
  attributes = new Map<string, string>();
  style = {} as Record<string, string>;
  listeners = new Map<string, Handler>();

  addEventListener(name: string, handler: Handler): void {
    this.listeners.set(name, handler);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

describe("PetRenderer focus state", () => {
  const createStatusSound = () =>
    ({
      currentTime: 0,
      volume: 0,
      src: "",
      load: jest.fn(),
      pause: jest.fn(),
      play: jest.fn(async () => undefined),
    }) as unknown as HTMLAudioElement;

  test("does not play automatically when working becomes idle or waiting", () => {
    (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
    const sound = createStatusSound();

    const renderer = new PetRenderer({
      image: new FakeElement() as never,
      pet: new FakeElement() as never,
      status: new FakeElement() as never,
      statusLabel: { textContent: "" } as unknown as HTMLElement,
      statusSound: sound,
      chatOnly: false,
      settings: defaultSettings(),
    });
    renderer.updateSettings({
      ...defaultSettings(),
      codexStatus: "working",
      codexStatusSoundUrl: "file:///tmp/status.mp3",
    });
    renderer.updateSettings({
      ...defaultSettings(),
      codexStatus: "idle",
      codexStatusSoundUrl: "file:///tmp/status.mp3",
    });
    renderer.updateCodexUpdate(true);
    renderer.updateSettings({
      ...defaultSettings(),
      codexStatus: "waiting",
      codexStatusSoundUrl: "file:///tmp/status.mp3",
    });

    expect(sound.src).toBe("file:///tmp/status.mp3");
    expect(sound.load).toHaveBeenCalledTimes(1);
    expect(sound.play).not.toHaveBeenCalled();
  });

  test("does not play when the window is focused", () => {
    (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
    const sound = createStatusSound();
    const renderer = new PetRenderer({
      image: new FakeElement() as never,
      pet: new FakeElement() as never,
      status: new FakeElement() as never,
      statusLabel: { textContent: "" } as unknown as HTMLElement,
      statusSound: sound,
      chatOnly: false,
      settings: defaultSettings(),
    });

    renderer.updateFocus(true);
    renderer.updateSettings({
      ...defaultSettings(),
      codexStatus: "working",
      codexStatusSoundUrl: "file:///tmp/status.mp3",
    });
    renderer.updateSettings({
      ...defaultSettings(),
      codexStatus: "idle",
      codexStatusSoundUrl: "file:///tmp/status.mp3",
    });
    renderer.updateCodexUpdate(true);

    expect(sound.play).not.toHaveBeenCalled();
  });

  test("plays an explicit background notification while unfocused", () => {
    (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
    const sound = createStatusSound();
    const renderer = new PetRenderer({
      image: new FakeElement() as never,
      pet: new FakeElement() as never,
      status: new FakeElement() as never,
      statusLabel: { textContent: "" } as unknown as HTMLElement,
      statusSound: sound,
      chatOnly: false,
      settings: {
        ...defaultSettings(),
        codexStatusSoundUrl: "file:///tmp/status.mp3",
      },
    });

    renderer.playAttentionSound();

    expect(sound.play).toHaveBeenCalledTimes(1);
  });

  test("does not play automatically when the blue indicator activates", () => {
    (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
    const sound = createStatusSound();
    const pet = new FakeElement();
    const renderer = new PetRenderer({
      image: new FakeElement() as never,
      pet: pet as never,
      status: new FakeElement() as never,
      statusLabel: { textContent: "" } as unknown as HTMLElement,
      statusSound: sound,
      chatOnly: false,
      settings: defaultSettings(),
    });

    renderer.updateCodexUpdate(true);
    renderer.updateSettings({
      ...defaultSettings(),
      codexPendingApproval: {
        requestId: 1,
        command: "echo hi",
        reason: "Needs approval",
        options: [],
      },
    });

    expect(pet.classList.contains("codex-update")).toBe(true);
    expect(sound.play).not.toHaveBeenCalled();
  });

  test("does not play the notification when disabled", () => {
    (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
    const sound = createStatusSound();
    const renderer = new PetRenderer({
      image: new FakeElement() as never,
      pet: new FakeElement() as never,
      status: new FakeElement() as never,
      statusLabel: { textContent: "" } as unknown as HTMLElement,
      statusSound: sound,
      chatOnly: false,
      settings: { ...defaultSettings(), codexStatusSound: false },
    });

    renderer.updateSettings({
      ...defaultSettings(),
      codexStatusSound: false,
      codexStatus: "working",
    });
    renderer.updateSettings({
      ...defaultSettings(),
      codexStatusSound: false,
      codexStatus: "idle",
    });

    expect(sound.play).not.toHaveBeenCalled();
  });

  test("shows the aggregate active count in the pet status", () => {
    jest.useFakeTimers();
    (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
    const now = Date.now();
    jest.setSystemTime(now);
    const statusLabel = { textContent: "" } as unknown as HTMLElement;
    const renderer = new PetRenderer({
      image: new FakeElement() as never,
      pet: new FakeElement() as never,
      status: new FakeElement() as never,
      statusLabel,
      statusSound: createStatusSound(),
      chatOnly: false,
      settings: defaultSettings(),
    });

    renderer.updateSettings({
      ...defaultSettings(),
      codexStatus: "working",
      codexWorkingSince: now - 65000,
    });
    expect(statusLabel.textContent).toBe("Working · 1m 5s");

    jest.advanceTimersByTime(5000);
    expect(statusLabel.textContent).toBe("Working · 1m 10s");

    renderer.updateSettings(defaultSettings());
    expect(statusLabel.textContent).toBe("Idle");
    jest.useRealTimers();
  });

  test("uses one focused class and accessible label for pet focus", () => {
    const pet = new FakeElement();
    const image = new FakeElement();
    const status = new FakeElement();
    const statusLabel = { textContent: "" } as unknown as HTMLElement;
    const renderer = new PetRenderer({
      image: image as never,
      pet: pet as never,
      status: status as never,
      statusLabel,
      statusSound: createStatusSound(),
      chatOnly: false,
      settings: defaultSettings(),
    });

    renderer.updateFocus(true);
    expect(pet.classList.contains("focused")).toBe(true);
    expect(pet.classList.contains("codex-update")).toBe(false);
    expect(pet.attributes.get("aria-label")).toBe("Desktop pet (focused)");

    renderer.updateFocus(false);
    expect(pet.classList.contains("focused")).toBe(false);
    expect(pet.attributes.get("aria-label")).toBe("Desktop pet");
  });

  test("clears Codex update state when focus takes over", () => {
    const pet = new FakeElement();
    const renderer = new PetRenderer({
      image: new FakeElement() as never,
      pet: pet as never,
      status: new FakeElement() as never,
      statusLabel: { textContent: "" } as unknown as HTMLElement,
      statusSound: createStatusSound(),
      chatOnly: false,
      settings: defaultSettings(),
    });

    renderer.updateCodexUpdate(true);
    expect(pet.classList.contains("codex-update")).toBe(true);
    renderer.updateFocus(true);
    expect(pet.classList.contains("focused")).toBe(true);
    expect(pet.classList.contains("codex-update")).toBe(false);
  });
});
