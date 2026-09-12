/// <reference types="jest" />

jest.mock("electron", () => ({
  app: {
    getAppPath: jest.fn(() => "/app"),
    getPath: jest.fn(() => "/user-data"),
  },
}));
jest.mock("node:fs", () => ({
  readFileSync: jest.fn(),
}));

import * as fs from "node:fs";
import path from "node:path";
import { getConfigDirectory, loadConfig } from "../../src/config/config";

const readFileSync = fs.readFileSync as jest.Mock;

describe("configuration directory", () => {
  beforeEach(() => {
    readFileSync.mockReset();
  });

  test("keeps bundled paths when the user config only persists a theme", () => {
    readFileSync.mockReturnValue(JSON.stringify({ theme: "ocean" }));

    expect(getConfigDirectory()).toBe("/app");
  });

  test("uses the user directory when a path is explicitly overridden", () => {
    readFileSync.mockReturnValue(JSON.stringify({ codexStatusSound: "custom.mp3" }));

    expect(getConfigDirectory()).toBe("/user-data");
  });

  test("loads the remote terminal feature from the nested configuration group", () => {
    readFileSync.mockImplementation((filePath: string) => {
      if (filePath === path.join("/app", "config.json"))
        return JSON.stringify({
          features: { remoteTerminal: { enabled: true, url: "ws://remote:5000/bash/ws" } },
        });
      throw new Error("missing user config");
    });

    expect(loadConfig().features.remoteTerminal).toEqual({
      enabled: true,
      url: "ws://remote:5000/bash/ws",
    });
  });

  test("preserves bundled remote terminal settings when the user overrides one field", () => {
    readFileSync.mockImplementation((filePath: string) => {
      if (filePath === path.join("/app", "config.json"))
        return JSON.stringify({
          features: { remoteTerminal: { url: "ws://remote:5000/bash/ws" } },
        });
      return JSON.stringify({ features: { remoteTerminal: { enabled: true } } });
    });

    expect(loadConfig().features.remoteTerminal).toEqual({
      enabled: true,
      url: "ws://remote:5000/bash/ws",
    });
  });

  test("disables the remote terminal when the feature is omitted", () => {
    readFileSync.mockImplementation(() => {
      throw new Error("missing config");
    });

    expect(loadConfig().features.remoteTerminal).toEqual({ enabled: false, url: "" });
  });
});
