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
    connection: { status: "disconnected" },
    account: {},
    projects: { items: [] },
    threads: {
      items: [],
      activities: [],
      backgroundWork: { completed: 0, total: 0 },
      current: {
        readOnly: false,
        history: { loading: false, hasOlder: false },
        thread: {
          status: "idle",
          connected: false,
          messages: [],
          queuedSubmissions: [],
          collaborationMode: "default",
          interrupted: false,
        },
      },
    },
  };
}

export function defaultRendererState(): RendererState {
  return {
    settings: defaultPeskSettings(),
    codex: defaultCodexRuntimeState(),
    assets: { codexStatusSoundUrl: "" },
  };
}
