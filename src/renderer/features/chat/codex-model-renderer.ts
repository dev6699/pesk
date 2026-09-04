import { matchesShortcut } from "../../shared/shortcuts.js";

export class CodexModelRenderer {
  private renderedKey = "";
  private index = 0;

  constructor(
    private readonly container: HTMLElement | undefined,
    private readonly getState: () => RendererState,
    private readonly updateState: (state: RendererState) => void,
  ) {}

  render(): void {
    const picker = this.getState().codex.modelPicker;
    if (!this.container || !picker) {
      if (this.renderedKey) this.clear();
      return;
    }
    const options =
      picker.stage === "model"
        ? picker.models.map((model) => ({
            value: model.model,
            label: model.displayName || model.model,
            description: model.description,
          }))
        : (picker.selectedModel?.supportedReasoningEfforts ?? []).map((effort) => ({
            value: effort.reasoningEffort,
            label: formatEffort(effort.reasoningEffort),
            description: effort.description,
          }));
    const key = `${picker.stage}:${options.map((option) => option.value).join(",")}`;
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    this.index = 0;
    this.container.replaceChildren();
    this.container.hidden = false;
    const title = document.createElement("strong");
    title.textContent =
      picker.stage === "model"
        ? "Select Model and Effort"
        : `Select Reasoning Level for ${picker.selectedModel?.model ?? "model"}`;
    this.container.append(title);
    const instructions = document.createElement("small");
    instructions.className = "codex-user-input-instructions";
    instructions.textContent = "Use ↑/↓ to select and Enter to confirm. Escape to cancel.";
    this.container.append(instructions);
    const form = document.createElement("form");
    form.className = "codex-user-input-form codex-model-picker";
    const fieldset = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = picker.stage === "model" ? "Models" : "Reasoning levels";
    fieldset.append(legend);
    options.forEach((option, optionIndex) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "codex-model-option";
      input.value = option.value;
      input.checked = optionIndex === this.index;
      input.tabIndex = optionIndex === this.index ? 0 : -1;
      input.addEventListener("change", () => {
        this.index = optionIndex;
      });
      label.append(input, document.createTextNode(` ${option.label}`));
      const description = document.createElement("small");
      description.className = "codex-user-input-option-description";
      description.textContent = option.description;
      label.append(description);
      fieldset.append(label);
    });
    form.append(fieldset);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = picker.stage === "model" ? "Next" : "Apply";
    form.append(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = options[this.index]?.value;
      if (!value) return;
      const model = picker.stage === "model" ? value : picker.selectedModel?.model;
      if (!model) return;
      void window.peskApi
        .selectCodexModel(model, picker.stage === "model" ? "" : value)
        .then((state) => this.updateState(state));
    });
    form.addEventListener("keydown", (event) => {
      if (
        !matchesShortcut(event, "suggestionNext") &&
        !matchesShortcut(event, "suggestionPrevious")
      )
        return;
      event.preventDefault();
      const direction = matchesShortcut(event, "suggestionNext") ? 1 : -1;
      this.index = (this.index + direction + options.length) % options.length;
      const radios = [...fieldset.querySelectorAll<HTMLInputElement>("input[type='radio']")];
      radios.forEach((radio, radioIndex) => {
        radio.checked = radioIndex === this.index;
      });
      radios[this.index]?.focus();
    });
    this.container.append(form);
    fieldset.querySelector<HTMLInputElement>("input[type='radio']")?.focus();
  }

  cancel(): void {
    if (!this.getState().codex.modelPicker) return;
    this.clear();
    void window.peskApi.cancelCodexModel().then((state) => this.updateState(state));
  }

  private clear(): void {
    this.renderedKey = "";
    this.container?.replaceChildren();
    if (this.container) this.container.hidden = true;
  }
}

function formatEffort(value: string): string {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase());
}
