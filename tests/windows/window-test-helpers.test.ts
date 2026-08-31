/// <reference types="jest" />

import { EventEmitter } from "node:events";
import { BrowserWindow, screen } from "electron";
import { defaultPeskSettings } from "../../src/renderer/shared/default-settings";

export class FakeWindow extends EventEmitter {
  visible = false;
  focused = false;
  position = [0, 0];
  bounds = { x: 100, y: 120, width: 180, height: 180 };
  webContents = { send: jest.fn(), focus: jest.fn(), openDevTools: jest.fn() };
  setMenu = jest.fn();
  setSkipTaskbar = jest.fn();
  setAlwaysOnTop = jest.fn();
  loadFile = jest.fn();
  setSize = jest.fn();
  moveTop = jest.fn();
  show = jest.fn(() => void (this.visible = true));
  showInactive = jest.fn(() => void (this.visible = true));
  hide = jest.fn(() => void (this.visible = false));
  close = jest.fn();
  focus = jest.fn(() => void (this.focused = true));
  isVisible = jest.fn(() => this.visible);
  isFocused = jest.fn(() => this.focused);
  getPosition = jest.fn(() => this.position);
  setPosition = jest.fn((x: number, y: number) => void (this.position = [x, y]));
  getBounds = jest.fn(() => this.bounds);
  setFocusable = jest.fn();
}

export function createWindowFactory(): { windows: FakeWindow[] } {
  const windows: FakeWindow[] = [];
  (BrowserWindow as unknown as jest.Mock).mockImplementation(() => {
    const window = new FakeWindow();
    windows.push(window);
    return window;
  });
  return { windows };
}

export function petOptions() {
  return {
    getSettings: () => ({ ...defaultPeskSettings(), visible: true }),
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

export function resetWindowMocks(): void {
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
}

test("provides shared window test fixtures", () => {
  expect(FakeWindow).toBeDefined();
});
