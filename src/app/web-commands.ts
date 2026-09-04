import type { CodexController } from "../codex";
import { isRequestId, validAnswers, validImageInputs, validRoots } from "./validation";
import type { RendererState } from "./renderer-state";

export interface WebCommandContext {
  codex: CodexController;
  getState: () => RendererState;
}

export function handleWebCommand(
  context: WebCommandContext,
  message: unknown,
  reply: (message: unknown) => void,
): void {
  if (!message || typeof message !== "object") return;
  const command = message as Record<string, unknown>;
  const requestId = command.requestId;
  const replyCommand = (ok: boolean): void => {
    if (typeof requestId !== "number") return;
    reply({ type: "commandResult", requestId, ok, state: context.getState() });
  };
  const replyProject = (operation: Promise<boolean>): void => {
    if (typeof requestId !== "number") return;
    void operation.then((ok) =>
      reply({ type: "commandResult", requestId, ok, state: context.getState() }),
    );
  };
  switch (command.type) {
    case "submitPrompt":
      replyCommand(
        typeof command.prompt === "string" &&
          context.codex.submitPromptWithImages(command.prompt, validImageInputs(command.images)),
      );
      break;
    case "selectModel":
      if (typeof command.model === "string" && typeof command.effort === "string") {
        context.codex.selectModel(command.model, command.effort);
        replyCommand(true);
      }
      break;
    case "cancelModel":
      context.codex.cancelModelPicker();
      replyCommand(true);
      break;
    case "startProjectThread":
      if (typeof command.projectId === "string" && typeof command.cwd === "string")
        replyCommand(context.codex.startProjectThread(command.projectId, command.cwd));
      break;
    case "startReview":
      replyCommand(
        typeof command.instructions === "string" && context.codex.startReview(command.instructions),
      );
      break;
    case "implementPlan":
      replyCommand(
        typeof command.planText === "string" &&
          typeof command.clearContext === "boolean" &&
          context.codex.implementPlan(command.planText, command.clearContext),
      );
      break;
    case "selectThread":
      if (typeof command.threadId === "string") context.codex.selectThread(command.threadId);
      break;
    case "loadOlderHistory":
      void context.codex.loadOlderHistory().then(replyCommand);
      break;
    case "setCollaborationMode":
      if (command.mode === "default" || command.mode === "plan") {
        context.codex.setCollaborationMode(command.mode);
      }
      break;
    case "interruptTurn":
      replyCommand(context.codex.interruptTurn());
      break;
    case "steerTurn":
      replyCommand(typeof command.prompt === "string" && context.codex.steerPrompt(command.prompt));
      break;
    case "respondPermission":
      if (isRequestId(command.requestId) && typeof command.optionId === "string") {
        context.codex.respondPermission(command.requestId, command.optionId);
      }
      break;
    case "respondUserInput":
      if (isRequestId(command.requestId)) {
        const answers = validAnswers(command.answers);
        if (answers) context.codex.respondUserInput(answers);
      }
      break;
    case "refreshRateLimits":
      context.codex.refreshRateLimits();
      break;
    case "fuzzyFileSearch": {
      const roots = validRoots(command.roots);
      if (isRequestId(command.requestId) && typeof command.query === "string" && roots) {
        void context.codex
          .fuzzyFileSearch(command.query, roots)
          .then((files) =>
            reply({ type: "fuzzyFileSearchResult", requestId: command.requestId, files }),
          );
      }
      break;
    }
    case "listProjects":
      replyProject(context.codex.listProjects());
      break;
    case "readProject":
      if (typeof command.projectId === "string")
        replyProject(context.codex.readProject(command.projectId));
      break;
    case "createProject":
      if (typeof command.name === "string" && typeof command.root === "string")
        replyProject(
          context.codex.createProject(
            command.name,
            [command.root],
            {},
            typeof command.idempotencyKey === "string" ? command.idempotencyKey : undefined,
          ),
        );
      break;
    case "importProject":
      if (
        typeof command.name === "string" &&
        Array.isArray(command.roots) &&
        command.roots.every((root) => typeof root === "string") &&
        Array.isArray(command.threadIds) &&
        command.threadIds.every((threadId) => typeof threadId === "string")
      )
        replyProject(
          context.codex.importProject(
            command.name,
            command.roots,
            command.threadIds,
            {},
            typeof command.idempotencyKey === "string" ? command.idempotencyKey : undefined,
          ),
        );
      break;
    case "updateProject":
      if (
        typeof command.projectId === "string" &&
        command.changes &&
        typeof command.changes === "object"
      )
        replyProject(
          context.codex.updateProject(
            command.projectId,
            command.changes as {
              name?: string;
              roots?: string[];
              metadata?: Record<string, string>;
            },
          ),
        );
      break;
    case "moveProject":
      if (
        typeof command.projectId === "string" &&
        (typeof command.beforeProjectId === "string" || command.beforeProjectId === null)
      )
        replyProject(context.codex.moveProject(command.projectId, command.beforeProjectId));
      break;
    case "deleteProject":
      if (typeof command.projectId === "string")
        replyProject(context.codex.deleteProject(command.projectId));
      break;
  }
}
