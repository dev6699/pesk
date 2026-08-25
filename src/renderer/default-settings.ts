export function defaultSettings(): PetSettings {
  return {
    animation: "idle",
    animationMode: "selected",
    scale: 1,
    paused: false,
    locked: false,
    visible: true,
    codexStatusSound: true,
    codexStatusSoundUrl: "",
    codexStatus: "idle",
    codexConnected: false,
    codexActivity: null,
    codexHistory: [],
    codexThreads: [],
  };
}
