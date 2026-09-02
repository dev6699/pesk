/** Guided project management rendered in the same inline prompt surface as questions. */
export async function openProjectManager(container: HTMLElement): Promise<void> {
  let state = await window.peskApi.getSettings();
  let projects = state.codex.projects ?? [];
  const composer = document.getElementById("codex-chat-form");
  document.body.dataset.projectManager = "true";
  if (composer) composer.hidden = true;
  container.replaceChildren();
  container.hidden = false;
  container.dataset.projectManager = "true";
  const form = document.createElement("form");
  form.className = "codex-user-input-form codex-project-manager-form";
  const fieldset = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = "Project manager";
  fieldset.append(legend);
  const action = document.createElement("select");
  action.innerHTML = `<option value="create">Create project</option><option value="rename">Rename project</option><option value="add-root">Add root</option><option value="remove-root">Remove root</option><option value="move">Move project</option><option value="delete">Delete project</option>`;
  action.setAttribute("aria-label", "Project action");
  fieldset.append(labelled("Action", action));
  const project = document.createElement("select");
  project.setAttribute("aria-label", "Project");
  project.replaceChildren(...projects.map((entry) => new Option(entry.name, entry.id)));
  const projectLabel = labelled("Project", project);
  fieldset.append(projectLabel);
  const rootsInfo = document.createElement("div");
  rootsInfo.className = "codex-project-roots";
  fieldset.append(rootsInfo);
  const value = document.createElement("input");
  value.type = "text";
  value.autocomplete = "off";
  const valueLabel = labelled("Value", value);
  fieldset.append(valueLabel);
  const rootChoice = document.createElement("select");
  rootChoice.setAttribute("aria-label", "Root to remove");
  const rootChoiceLabel = labelled("Root to remove", rootChoice);
  rootChoiceLabel.hidden = true;
  fieldset.append(rootChoiceLabel);
  const position = document.createElement("input");
  position.type = "number";
  position.min = "1";
  const positionLabel = labelled("Position", position);
  positionLabel.hidden = true;
  fieldset.append(positionLabel);
  const name = document.createElement("input");
  name.type = "text";
  name.autocomplete = "off";
  const nameLabel = labelled("Name", name);
  fieldset.insertBefore(nameLabel, valueLabel);
  const choose = document.createElement("button");
  choose.type = "button";
  choose.textContent = "Choose folder";
  fieldset.append(choose);
  const message = document.createElement("small");
  message.className = "codex-user-input-instructions";
  fieldset.append(message);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Continue";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.dataset.projectCancel = "true";
  cancel.textContent = "Cancel";
  form.append(fieldset, submit, cancel);
  container.append(form);

  const selected = () => projects.find((entry) => entry.id === project.value);
  const update = (): void => {
    const mode = action.value;
    const current = selected();
    projectLabel.hidden = mode === "create";
    projectLabel.style.display = mode === "create" ? "none" : "";
    choose.hidden = !["create", "add-root"].includes(mode);
    nameLabel.hidden = mode !== "create";
    nameLabel.style.display = mode === "create" ? "" : "none";
    const usesValue = ["create", "rename", "add-root", "remove-root"].includes(mode);
    const removingRoot = mode === "remove-root";
    valueLabel.hidden = !usesValue;
    valueLabel.style.display = usesValue && !removingRoot ? "" : "none";
    rootChoiceLabel.hidden = !removingRoot;
    rootChoiceLabel.style.display = removingRoot ? "" : "none";
    rootChoice.replaceChildren(...(current?.roots ?? []).map((entry) => new Option(entry.path, entry.path)));
    rootsInfo.replaceChildren();
    rootsInfo.hidden = !current || mode === "create";
    if (current && mode !== "create") {
      const title = document.createElement("strong");
      title.textContent = "Roots";
      rootsInfo.append(title);
      const list = document.createElement("ul");
      for (const entry of current.roots) {
        const item = document.createElement("li");
        item.textContent = entry.path;
        list.append(item);
      }
      rootsInfo.append(list);
    }
    positionLabel.hidden = mode !== "move";
    positionLabel.style.display = mode === "move" ? "" : "none";
    position.max = String(Math.max(projects.length, 1));
    valueLabel.childNodes[0].textContent = mode === "rename" ? "Name" : "Root";
    value.type = "text";
    value.placeholder = mode === "rename" ? "New name" : "Absolute app-server root path";
    if (["create", "add-root", "rename"].includes(mode)) value.value = "";
    if (mode === "move") value.placeholder = `Position 1-${projects.length}`;
    message.textContent = "";
    submit.textContent = "Continue";
    delete form.dataset.confirmDelete;
  };
  const refreshProjects = async (): Promise<void> => {
    const previousId = project.value;
    const next = await window.peskApi.listCodexProjects();
    if (next.codex.error) return;
    state = next;
    projects = next.codex.projects ?? [];
    project.replaceChildren(...projects.map((entry) => new Option(entry.name, entry.id)));
    project.value = projects.some((entry) => entry.id === previousId)
      ? previousId
      : projects[0]?.id ?? "";
    update();
  };
  action.addEventListener("change", update);
  project.addEventListener("change", update);
  choose.addEventListener("click", async () => {
    window.peskApi.setChatFileDialogOpen(true);
    try {
      const path = await window.peskApi.chooseCodexProjectRoot();
      if (path) value.value = path;
      value.focus();
    } finally {
      window.peskApi.setChatFileDialogOpen(false);
    }
  });
  cancel.addEventListener("click", () => {
    container.replaceChildren();
    container.hidden = true;
    delete container.dataset.projectManager;
    delete document.body.dataset.projectManager;
    if (composer) composer.hidden = false;
    window.peskApi.focusCodexInput();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const mode = action.value;
    const current = selected();
    if (mode === "delete") {
      if (!current) return;
      if (!form.dataset.confirmDelete) {
        form.dataset.confirmDelete = "true";
        message.textContent = `Delete ${current.name}? Threads and files will not be deleted.`;
        submit.textContent = "Confirm delete";
        return;
      }
      const result = await window.peskApi.deleteCodexProject(current.id);
      if (!result.codex.error) {
        await refreshProjects();
        message.textContent = "Project deleted successfully.";
        submit.disabled = false;
        cancel.textContent = "Cancel";
        delete form.dataset.confirmDelete;
        action.focus();
      } else message.textContent = result.codex.error;
      return;
    }
    let result: RendererState | undefined;
    if (mode === "create" && value.value.trim() && name.value.trim()) result = await window.peskApi.createCodexProject(name.value.trim(), value.value.trim());
    else if (mode === "rename" && current && value.value.trim()) result = await window.peskApi.updateCodexProject(current.id, { name: value.value.trim() });
    else if (mode === "add-root" && current && value.value.trim()) result = await window.peskApi.updateCodexProject(current.id, { roots: [...current.roots.map((entry) => entry.path), value.value.trim()] });
    else if (mode === "remove-root" && current && rootChoice.value) result = await window.peskApi.updateCodexProject(current.id, { roots: current.roots.map((entry) => entry.path).filter((entry) => entry !== rootChoice.value) });
    else if (mode === "move" && current) {
      const requested = Number(position.value) - 1;
      const currentIndex = projects.findIndex((entry) => entry.id === current.id);
      if (!Number.isInteger(requested) || requested < 0 || requested >= projects.length) { message.textContent = `Position must be between 1 and ${projects.length}.`; return; }
      if (requested === currentIndex) { cancel.click(); return; }
      const before = requested < currentIndex ? projects[requested] : projects[requested + 1];
      result = await window.peskApi.moveCodexProject(current.id, before?.id ?? null);
    }
    else { message.textContent = "Complete the required field."; return; }
    if (result?.codex.error) message.textContent = result.codex.error;
    else {
      await refreshProjects();
      name.value = "";
      value.value = "";
      position.value = "";
      message.textContent = `${mode === "move" ? "Project moved" : mode === "create" ? "Project created" : "Project updated"} successfully.`;
      submit.disabled = false;
      cancel.textContent = "Cancel";
      action.focus();
    }
  });
  update();
  action.focus();
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement("label");
  const caption = document.createElement("span");
  caption.textContent = text;
  label.append(caption);
  label.append(control);
  return label;
}
