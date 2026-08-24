export function defaultSettings(): PetSettings {
  return {
    animation: "idle",
    animationMode: "selected",
    scale: 1,
    paused: false,
    locked: false,
    wandering: true,
    visible: true,
    codexChatVisible: true,
    codexStatus: "idle",
    codexConnected: false,
    codexActivity: null,
    codexHistory: [],
    codexThreads: [],
  };
}
