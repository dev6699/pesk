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
import { getConfigDirectory } from "../../src/config/config";

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
});
