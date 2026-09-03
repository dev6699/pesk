import { defaultRendererState } from "../../shared/default-settings.js";
import { PetRenderer } from "./pet-renderer.js";
import { applyRendererTheme } from "../../shared/theme.js";

const image = document.getElementById("pet-image") as HTMLImageElement;
const petElement = document.getElementById("pet") as HTMLElement;
const status = document.getElementById("codex-status") as HTMLElement;
const statusLabel = document.getElementById("codex-status-label") as HTMLElement;
const aggregateStatusLabel = document.getElementById("codex-aggregate-status-label") as HTMLElement;
const statusSound = document.getElementById("codex-status-sound") as HTMLAudioElement;
const pet = new PetRenderer({
  image,
  pet: petElement,
  status,
  statusLabel,
  aggregateStatusLabel,
  statusSound,
  chatOnly: false,
  state: defaultRendererState(),
});

window.peskApi.onSettingsChanged((state) => {
  applyRendererTheme(state.assets.theme);
  pet.updateState(state);
});
window.peskApi.onPetFocusChanged((focused) => pet.updateFocus(focused));
window.peskApi.onPetCodexUpdateChanged((active) => pet.updateCodexUpdate(active));
window.peskApi.onPetCodexStatusSound(() => pet.playAttentionSound());

void window.peskApi.getSettings().then(async (state) => {
  applyRendererTheme(state.assets.theme);
  pet.updateState(state);
  await pet.loadAnimations();
});

function animate(now: number): void {
  pet.animate(now);
  requestAnimationFrame(animate);
}

requestAnimationFrame(animate);
