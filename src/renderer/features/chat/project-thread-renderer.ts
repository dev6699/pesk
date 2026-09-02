/** Renders the guided flow for creating a new thread in a project. */
export async function openProjectThreadPrompt(container: HTMLElement): Promise<void> {
  const state = await window.peskApi.getSettings();
  let projects = state.codex.projects ?? [];
  const currentThread = state.codex.threads.find((thread) => thread.id === state.codex.threadId);
  const currentCwd = state.codex.cwd;
  const currentProjectId =
    state.codex.projectId ??
    currentThread?.projectId ??
    projects.find((entry) =>
      currentCwd ? entry.roots.some((root) => root.path === currentCwd) : false,
    )?.id;
  const composer = document.getElementById("codex-chat-form");
  document.body.dataset.projectThread = "true";
  if (composer) composer.hidden = true;
  container.replaceChildren();
  container.hidden = false;
  container.dataset.projectThread = "true";

  const form = document.createElement("form");
  form.className = "codex-user-input-form codex-project-thread-form";
  const fieldset = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = "New project thread";
  fieldset.append(legend);

  const project = document.createElement("select");
  project.setAttribute("aria-label", "Project");
  const projectLabel = labelled("Project", project);
  fieldset.append(projectLabel);

  const rootsInfo = document.createElement("div");
  rootsInfo.className = "codex-project-roots";
  fieldset.append(rootsInfo);

  const root = document.createElement("select");
  root.setAttribute("aria-label", "Thread root");
  const rootLabel = labelled("Thread root", root);
  fieldset.append(rootLabel);

  const message = document.createElement("small");
  message.className = "codex-user-input-instructions";
  fieldset.append(message);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Continue";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.dataset.projectThreadCancel = "true";
  cancel.textContent = "Cancel";
  form.append(fieldset, submit, cancel);
  container.append(form);

  const selected = () => projects.find((entry) => entry.id === project.value);
  const update = (): void => {
    const preferredProjectId = project.value || currentProjectId;
    project.replaceChildren(...projects.map((entry) => new Option(entry.name, entry.id)));
    if (projects.some((entry) => entry.id === preferredProjectId)) {
      project.value = preferredProjectId ?? "";
    } else if (!project.value) {
      project.value = projects[0]?.id ?? "";
    }
    const next = selected();
    root.replaceChildren(...(next?.roots ?? []).map((entry) => new Option(entry.path, entry.path)));
    const preferredRoot =
      next &&
      next.id === currentProjectId &&
      currentCwd &&
      next.roots.some((entry) => entry.path === currentCwd)
        ? currentCwd
        : next?.roots[0]?.path;
    if (preferredRoot) root.value = preferredRoot;
    rootsInfo.replaceChildren();
    rootsInfo.hidden = !next;
    if (next) {
      const title = document.createElement("strong");
      title.textContent = "Roots";
      const list = document.createElement("ul");
      for (const entry of next.roots) {
        const item = document.createElement("li");
        item.textContent = entry.path;
        list.append(item);
      }
      rootsInfo.append(title, list);
    }
    message.textContent = projects.length
      ? "Choose the project and root for the new thread."
      : "No projects are available.";
  };

  project.addEventListener("change", update);
  cancel.addEventListener("click", () => closeProjectThreadPrompt(container, composer));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const current = selected();
    if (!current) {
      message.textContent = "Choose a project first.";
      return;
    }
    if (!root.value) {
      message.textContent = "The selected project has no configured roots.";
      return;
    }
    submit.disabled = true;
    const next = await window.peskApi.startCodexProjectThread(current.id, root.value);
    if (next.codex.error) {
      message.textContent = next.codex.error;
      submit.disabled = false;
      project.focus();
      return;
    }
    message.textContent = "Thread created successfully.";
    project.focus();
  });

  update();
  project.focus();
}

function closeProjectThreadPrompt(container: HTMLElement, composer: HTMLElement | null): void {
  container.replaceChildren();
  container.hidden = true;
  delete container.dataset.projectThread;
  delete document.body.dataset.projectThread;
  if (composer) composer.hidden = false;
  window.peskApi.focusCodexInput();
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement("label");
  const caption = document.createElement("span");
  caption.textContent = text;
  label.append(caption, control);
  return label;
}
