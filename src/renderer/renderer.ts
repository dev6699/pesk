import { defaultSettings } from "./default-settings.js";
import { PetRenderer } from "./pet-renderer.js";

const image = document.getElementById("pet-image") as HTMLImageElement;
const petElement = document.getElementById("pet") as HTMLElement;
const status = document.getElementById("codex-status") as HTMLElement;
const statusLabel = document.getElementById(
  "codex-status-label",
) as HTMLElement;
const pet = new PetRenderer({
  image,
  pet: petElement,
  status,
  statusLabel,
  chatOnly: false,
  settings: defaultSettings(),
});

window.petApi.onSettingsChanged((next) => pet.updateSettings(next));
window.petApi.onPetFocusChanged((focused) => pet.updateFocus(focused));

void window.petApi.getSettings().then(async (next) => {
  pet.updateSettings(next);
  await pet.loadAnimations();
});

function animate(now: number): void {
  pet.animate(now);
  requestAnimationFrame(animate);
}

requestAnimationFrame(animate);
