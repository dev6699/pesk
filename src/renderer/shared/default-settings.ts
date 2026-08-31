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
    status: "idle",
    aggregateStatus: "idle",
    connected: false,
    readOnly: false,
    history: [],
    threads: [],
    threadActivities: [],
    queuedSubmissions: [],
    collaborationMode: "default",
    hasOlderHistory: false,
    historyLoading: false,
    cwd: undefined,
    interrupted: false,
  };
}

export function defaultRendererState(): RendererState {
  return {
    settings: defaultPeskSettings(),
    codex: defaultCodexRuntimeState(),
    assets: { codexStatusSoundUrl: "" },
  };
}
