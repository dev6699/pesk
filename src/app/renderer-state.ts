/// <reference path="../renderer/shared/types.d.ts" />

import type { BrowserWindow } from "electron";
import type { ChatWebServer } from "../services/chat-web-server";
import type { CodexController } from "../codex";
import type { PeskSettings as AppSettings } from "../config/config";
import type { CodexState, CodexStreamDelta } from "../codex/types";
import type { RtermSnapshot } from "../features/remote-terminal";
import { themeNames, type RendererTheme } from "../config/themes";

/** The renderer payload is defined once in renderer/shared/types.d.ts. */
export type RendererState = globalThis.RendererState;

/** Combines Codex state with application settings and publishes it to clients. */
export class RendererStatePublisher {
  private publishTimer: NodeJS.Timeout | undefined;
  private latestCodexState: CodexState;

  constructor(
    private readonly codex: CodexController,
    private readonly getSettings: () => AppSettings,
    private readonly getStatusSoundUrl: () => string,
    private readonly getTheme: () => RendererTheme,
    private readonly getThemeName: () => string,
    private readonly getPetWindow: () => BrowserWindow | null,
    private readonly getChatWindow: () => BrowserWindow | null,
    private readonly webServer: ChatWebServer,
    private readonly features: RendererState["features"],
  ) {
    this.latestCodexState = this.codex.getState();
  }

  getState(): RendererState {
    return {
      settings: this.getSettings(),
      codex: this.latestCodexState,
      assets: {
        codexStatusSoundUrl: this.getStatusSoundUrl(),
        theme: this.getTheme(),
        themeName: this.getThemeName(),
        themeNames,
      },
      features: this.features,
    };
  }

  /** Publishes a non-Codex application update using the latest Codex state. */
  publish(): void {
    this.schedulePublish(this.latestCodexState);
  }

  /** Publishes a Codex update using its already-computed state snapshot. */
  publishCodex(codexState: CodexState): void {
    this.schedulePublish(codexState);
  }

  private schedulePublish(codexState: CodexState): void {
    this.latestCodexState = codexState;
    if (this.publishTimer !== undefined) return;
    // Batch rapid updates to at most one publication per approximately 60 FPS frame.
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      this.publishNow();
    }, 16);
  }

  publishStreamDelta(delta: CodexStreamDelta): void {
    for (const window of [this.getPetWindow(), this.getChatWindow()]) {
      if (window && !window.isDestroyed()) window.webContents.send("codex-stream-delta", delta);
    }
    this.webServer.broadcastStreamDelta(delta);
  }

  publishRterm(snapshot: RtermSnapshot): void {
    for (const window of [this.getPetWindow(), this.getChatWindow()]) {
      if (window && !window.isDestroyed()) window.webContents.send("rterm-changed", snapshot);
    }
  }

  publishRtermOutput(data: string): void {
    for (const window of [this.getPetWindow(), this.getChatWindow()]) {
      if (window && !window.isDestroyed()) window.webContents.send("rterm-output", data);
    }
  }

  private publishNow(): void {
    const state = this.getState();
    for (const window of [this.getPetWindow(), this.getChatWindow()]) {
      if (window && !window.isDestroyed()) window.webContents.send("settings-changed", state);
    }
    this.webServer.broadcast(state);
  }
}
