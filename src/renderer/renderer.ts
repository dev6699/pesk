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

window.peskApi.onSettingsChanged((next) => pet.updateSettings(next));
window.peskApi.onPetFocusChanged((focused) => pet.updateFocus(focused));

document.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    window.peskApi.toggleCodexChat();
  }
});

void window.peskApi.getSettings().then(async (next) => {
  pet.updateSettings(next);
  await pet.loadAnimations();
});

function animate(now: number): void {
  pet.animate(now);
  requestAnimationFrame(animate);
}

requestAnimationFrame(animate);
