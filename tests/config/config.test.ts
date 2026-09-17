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
          features: { remoteTerminal: { enabled: true, url: "http://remote:5000/provider/ssh" } },
        });
      throw new Error("missing user config");
    });

    expect(loadConfig().features.remoteTerminal).toEqual({
      enabled: true,
      url: "http://remote:5000/provider/ssh",
    });
  });

  test("preserves bundled remote terminal settings when the user overrides one field", () => {
    readFileSync.mockImplementation((filePath: string) => {
      if (filePath === path.join("/app", "config.json"))
        return JSON.stringify({
          features: { remoteTerminal: { url: "http://remote:5000/provider/ssh" } },
        });
      return JSON.stringify({ features: { remoteTerminal: { enabled: true } } });
    });

    expect(loadConfig().features.remoteTerminal).toEqual({
      enabled: true,
      url: "http://remote:5000/provider/ssh",
    });
  });

  test("disables the remote terminal when the feature is omitted", () => {
    readFileSync.mockImplementation(() => {
      throw new Error("missing config");
    });

    expect(loadConfig().features.remoteTerminal).toEqual({ enabled: false, url: "" });
  });

  test("rejects legacy remote terminal WebSocket URLs", () => {
    readFileSync.mockImplementation((filePath: string) => {
      if (filePath === path.join("/app", "config.json"))
        return JSON.stringify({
          features: { remoteTerminal: { enabled: true, url: "ws://remote:5000/bash/ws" } },
        });
      throw new Error("missing user config");
    });

    expect(loadConfig().features.remoteTerminal).toEqual({ enabled: true, url: "" });
  });

  test("loads named Codex app-server profiles and the active profile", () => {
    readFileSync.mockImplementation((filePath: string) => {
      if (filePath === path.join("/app", "config.json"))
        return JSON.stringify({
          codexAppServerProfiles: [
            { id: "local", name: "Local", url: "ws://127.0.0.1:4500" },
            { id: "remote", name: "Remote", url: "wss://codex.example.test/ws" },
          ],
          activeCodexAppServerProfileId: "remote",
        });
      throw new Error("missing user config");
    });

    expect(loadConfig().codexAppServerProfiles[1].url).toBe("wss://codex.example.test/ws");
    expect(loadConfig().activeCodexAppServerProfileId).toBe("remote");
    expect(loadConfig().codexAppServerProfiles).toHaveLength(2);
  });

  test("uses the built-in profile when named profiles are missing", () => {
    readFileSync.mockImplementation((filePath: string) => {
      if (filePath === path.join("/app", "config.json")) return JSON.stringify({});
      throw new Error("missing user config");
    });

    expect(loadConfig().codexAppServerProfiles).toEqual([
      { id: "default", name: "Default", url: "ws://127.0.0.1:4500" },
    ]);
    expect(loadConfig().activeCodexAppServerProfileId).toBe("default");
  });
});
