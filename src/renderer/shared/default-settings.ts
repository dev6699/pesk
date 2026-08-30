export function defaultPeskSettings(): SavedPeskSettings {
  return {
    animation: "idle",
    animationMode: "selected",
    scale: 1,
    paused: false,
    locked: false,
    visible: true,
    codexStatusSound: true,
  };
}

export function defaultCodexRuntimeState(): CodexRuntimeState {
  return {
    codexStatusSoundUrl: "",
    codexStatus: "idle",
    codexAggregateStatus: "idle",
    codexConnected: false,
    codexReadOnly: false,
    codexHistory: [],
    codexThreads: [],
    codexThreadActivities: [],
    codexQueuedSubmissions: [],
    codexCollaborationMode: "default",
    codexHasOlderHistory: false,
    codexHistoryLoading: false,
  };
}

export function defaultSettings(): PeskSettings {
  return {
    ...defaultPeskSettings(),
    ...defaultCodexRuntimeState(),
  };
}
