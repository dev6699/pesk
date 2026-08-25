export function defaultSettings(): PetSettings {
  return {
    animation: "idle",
    animationMode: "selected",
    scale: 1,
    paused: false,
    locked: false,
    visible: true,
    codexStatus: "idle",
    codexConnected: false,
    codexActivity: null,
    codexHistory: [],
    codexThreads: [],
  };
}
