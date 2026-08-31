/// <reference path="../renderer/shared/types.d.ts" />

import type { BrowserWindow } from "electron";
import type { ChatWebServer } from "../services/chat-web-server";
import type { CodexController } from "../codex";
import type { PeskSettings as AppSettings } from "../config/config";

/** The renderer payload is defined once in renderer/shared/types.d.ts. */
export type RendererState = PeskSettings;

export class RendererStatePublisher {
  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly codex: CodexController,
    private readonly getStatusSoundUrl: () => string,
    private readonly getPetWindow: () => BrowserWindow | null,
    private readonly getChatWindow: () => BrowserWindow | null,
    private readonly webServer: ChatWebServer,
  ) {}

  getState(): RendererState {
    const state = this.codex.getState();
    return {
      ...this.getSettings(),
      codexThreadId: state.threadId,
      codexReadOnly: state.readOnly,
      codexCwd: state.cwd,
      codexError: state.error,
      codexStatus: state.status,
      codexAggregateStatus: state.aggregateStatus,
      codexConnected: state.connected,
      codexHistory: state.history,
      codexThreads: state.threads,
      codexThreadActivities: state.threadActivities,
      codexWorkingSince: state.workingSince,
      codexWorkedElapsed: state.workedElapsed,
      codexInterrupted: state.interrupted,
      codexTokenUsage: state.tokenUsage,
      codexModelInfo: state.modelInfo,
      codexRateLimits: state.rateLimits,
      codexCollaborationMode: state.collaborationMode,
      codexPendingUserInput: state.pendingUserInput,
      codexPendingApproval: state.pendingApproval,
      codexQueuedSubmissions: state.queuedSubmissions,
      codexGoal: state.goal,
      codexCommandNotice: state.commandNotice,
      codexHasOlderHistory: state.hasOlderHistory,
      codexHistoryLoading: state.historyLoading,
      codexStatusSoundUrl: this.getStatusSoundUrl(),
    };
  }

  publish(): void {
    const state = this.getState();
    for (const window of [this.getPetWindow(), this.getChatWindow()]) {
      if (window && !window.isDestroyed()) window.webContents.send("settings-changed", state);
    }
    this.webServer.broadcast(state);
  }
}
