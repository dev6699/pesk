/** Renders the inline form for renaming the selected thread. */
export async function openRenamePrompt(container: HTMLElement): Promise<void> {
  const state = await window.peskApi.getSettings();
  const selected = state.codex.threads.items.find(
    (thread) => thread.id === state.codex.threads.selectedId,
  );
  const composer = document.getElementById("codex-chat-form");
  document.body.dataset.renameThread = "true";
  if (composer) composer.hidden = true;
  container.replaceChildren();
  container.hidden = false;
  container.dataset.renameThread = "true";

  const form = document.createElement("form");
  form.className = "codex-user-input-form codex-rename-thread-form";
  const fieldset = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = "Rename thread";
  fieldset.append(legend);
  const name = document.createElement("input");
  name.type = "text";
  name.autocomplete = "off";
  name.value = selected?.name || selected?.preview || "";
  const label = document.createElement("label");
  const caption = document.createElement("span");
  caption.textContent = "Name";
  label.append(caption, name);
  fieldset.append(label);
  const message = document.createElement("small");
  message.className = "codex-user-input-instructions";
  fieldset.append(message);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  form.append(fieldset, submit, cancel);
  container.append(form);

  const close = (): void => {
    container.replaceChildren();
    container.hidden = true;
    delete container.dataset.renameThread;
    delete document.body.dataset.renameThread;
    if (composer) composer.hidden = false;
    window.peskApi.focusCodexInput();
  };
  cancel.addEventListener("click", close);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = name.value.trim();
    if (!state.codex.threads.selectedId) {
      message.textContent = "Select a thread first.";
      return;
    }
    if (!value) {
      message.textContent = "Enter a thread name.";
      name.focus();
      return;
    }
    submit.disabled = true;
    const next = await window.peskApi.renameCodexThread(value);
    if (next.codex.connection.error) {
      message.textContent = next.codex.connection.error;
      submit.disabled = false;
      name.focus();
      return;
    }
    close();
  });
  name.focus();
  name.select();
}
