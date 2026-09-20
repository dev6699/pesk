import { randomUUID } from "node:crypto";
import {
  saveCodexAppServerProfiles,
  type CodexAppServerProfile,
  type CodexAppServerProfileState,
} from "../config/config";

export interface CodexAppServerProfileServiceOptions {
  profiles: CodexAppServerProfile[];
  activeProfileId: string;
  switchServer: (url: string) => void;
}

/** Owns named Codex app-server endpoints and their persisted selection. */
export class CodexAppServerProfileService {
  private profiles: CodexAppServerProfile[];
  private activeProfileId: string;

  constructor(private readonly options: CodexAppServerProfileServiceOptions) {
    this.profiles = structuredClone(options.profiles);
    this.activeProfileId = options.activeProfileId;
  }

  get(): CodexAppServerProfileState {
    return { profiles: structuredClone(this.profiles), activeProfileId: this.activeProfileId };
  }

  add(name: string, url: string): CodexAppServerProfileState {
    this.assertProfile(name, url);
    this.profiles.push({ id: randomUUID(), name: name.trim(), url: url.trim() });
    this.persist();
    return this.get();
  }

  update(id: string, name: string, url: string): CodexAppServerProfileState {
    this.assertProfile(name, url, id);
    const profile = this.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new Error("Codex app-server profile not found.");
    profile.name = name.trim();
    profile.url = url.trim();
    if (id === this.activeProfileId) this.options.switchServer(profile.url);
    this.persist();
    return this.get();
  }

  delete(id: string): CodexAppServerProfileState {
    if (this.profiles.length === 1)
      throw new Error("At least one Codex app-server profile is required.");
    if (id === this.activeProfileId)
      throw new Error("Select another Codex app-server before deleting this profile.");
    this.profiles = this.profiles.filter((profile) => profile.id !== id);
    this.persist();
    return this.get();
  }

  select(id: string): CodexAppServerProfileState {
    const profile = this.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new Error("Codex app-server profile not found.");
    if (id !== this.activeProfileId) {
      this.activeProfileId = id;
      this.options.switchServer(profile.url);
      this.persist();
    }
    return this.get();
  }

  private assertProfile(name: string, url: string, ignoredId?: string): void {
    if (!name.trim()) throw new Error("Codex app-server profile name is required.");
    if (!/^wss?:\/\//.test(url.trim()))
      throw new Error("Codex app-server URL must start with ws:// or wss://.");
    if (
      this.profiles.some(
        (profile) =>
          profile.id !== ignoredId &&
          profile.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
      )
    )
      throw new Error("A Codex app-server profile with this name already exists.");
  }

  private persist(): void {
    saveCodexAppServerProfiles(this.profiles, this.activeProfileId);
  }
}
