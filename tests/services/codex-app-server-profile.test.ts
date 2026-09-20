/** @jest-environment node */
import { CodexAppServerProfileService } from "../../src/services/codex-app-server-profile";
import { saveCodexAppServerProfiles } from "../../src/config/config";

jest.mock("../../src/config/config", () => ({
  saveCodexAppServerProfiles: jest.fn(),
}));

const profiles = [
  { id: "default", name: "Default", url: "ws://127.0.0.1:4500" },
  { id: "remote", name: "Remote", url: "wss://codex.example.test/ws" },
];

function createService(switchServer = jest.fn()): {
  service: CodexAppServerProfileService;
  switchServer: jest.Mock;
} {
  return {
    service: new CodexAppServerProfileService({
      profiles,
      activeProfileId: "default",
      switchServer,
    }),
    switchServer,
  };
}

describe("CodexAppServerProfileService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("owns profile state and switches the active endpoint", () => {
    const { service, switchServer } = createService();

    expect(service.get()).toEqual({ profiles, activeProfileId: "default" });
    service.select("remote");

    expect(switchServer).toHaveBeenCalledWith("wss://codex.example.test/ws");
    expect(saveCodexAppServerProfiles).toHaveBeenCalledWith(profiles, "remote");
  });

  it("validates and persists profile changes", () => {
    const { service } = createService();

    service.add("Local", "ws://localhost:4501");
    expect(saveCodexAppServerProfiles).toHaveBeenCalled();
    expect(service.get().profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Local", url: "ws://localhost:4501" }),
      ]),
    );

    expect(() => service.add("local", "ws://localhost:4502")).toThrow(
      "A Codex app-server profile with this name already exists.",
    );
    expect(() => service.add("Invalid", "http://localhost:4502")).toThrow(
      "Codex app-server URL must start with ws:// or wss://.",
    );
  });

  it("prevents deleting the active or only profile", () => {
    const { service } = createService();

    expect(() => service.delete("default")).toThrow(
      "Select another Codex app-server before deleting this profile.",
    );

    const only = new CodexAppServerProfileService({
      profiles: [profiles[0]],
      activeProfileId: "default",
      switchServer: jest.fn(),
    });
    expect(() => only.delete("default")).toThrow(
      "At least one Codex app-server profile is required.",
    );
  });
});
