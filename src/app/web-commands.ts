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
  switch (command.type) {
    case "submitPrompt":
      replyCommand(
        typeof command.prompt === "string" &&
          context.codex.submitPromptWithImages(command.prompt, validImageInputs(command.images)),
      );
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
  }
}
