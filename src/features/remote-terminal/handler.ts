import type { DynamicToolCallParams, DynamicToolCallResponse } from "../../codex-schema/v2";
import type { RtermClient } from "./rterm-client";
import {
  REMOTE_TERMINAL_EXECUTE_TOOL,
  REMOTE_TERMINAL_NAMESPACE,
  REMOTE_TERMINAL_READ_TOOL,
} from "./tools";

interface ReadArguments {
  maxLines?: unknown;
}

interface ExecuteArguments {
  command?: unknown;
  reason?: unknown;
}

export interface RemoteTerminalToolHandlerDependencies {
  getRterm: (threadId: string) => RtermClient;
  requestApproval: (
    threadId: string,
    callId: string,
    command: string,
    reason: string,
  ) => Promise<boolean>;
}

/** Executes Remote Terminal dynamic tools at the application feature boundary. */
export class RemoteTerminalToolHandler {
  constructor(private readonly dependencies: RemoteTerminalToolHandlerDependencies) {}

  async handle(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const fail = (text: string): DynamicToolCallResponse => ({
      contentItems: [{ type: "inputText", text }],
      success: false,
    });
    if (params.namespace !== REMOTE_TERMINAL_NAMESPACE)
      return fail("Unsupported terminal namespace.");
    if (params.tool === REMOTE_TERMINAL_READ_TOOL) {
      const args = this.objectArguments(params.arguments) as ReadArguments;
      const maxLines =
        typeof args?.maxLines === "number" ? Math.min(200, Math.max(1, args.maxLines)) : 200;
      const rterm = this.dependencies.getRterm(params.threadId);
      const recent = rterm.readRecent(maxLines);
      return {
        contentItems: [
          {
            type: "inputText",
            text: `${rterm.getSnapshot().hostLabel || "remote shell"}\n${recent.output}${recent.truncated ? "\n[older output omitted]" : ""}`,
          },
        ],
        success: true,
      };
    }
    if (params.tool !== REMOTE_TERMINAL_EXECUTE_TOOL)
      return fail("Unsupported remote terminal tool.");
    const args = this.objectArguments(params.arguments) as ExecuteArguments;
    if (typeof args?.command !== "string" || !args.command.trim())
      return fail("A command is required.");
    const rterm = this.dependencies.getRterm(params.threadId);
    const host = rterm.getSnapshot().hostLabel || "remote shell";
    const approved = await this.dependencies.requestApproval(
      params.threadId,
      params.callId,
      args.command,
      typeof args.reason === "string" ? args.reason : `Run on ${host}.`,
    );
    if (!approved) return fail("The user rejected the terminal command.");
    const execution = rterm.execute(args.command);
    if (!execution) return fail("The terminal is not connected.");
    const completed = await rterm.wait(execution.id, 120_000);
    if (!completed || completed.status !== "completed")
      return fail(
        "The command did not finish within 120 seconds. Its output remains available in the terminal.",
      );
    return {
      contentItems: [
        {
          type: "inputText",
          text: `completed; exitCode=${completed.exitCode}\n${completed.output}`,
        },
      ],
      success: true,
    };
  }

  private objectArguments(value: DynamicToolCallParams["arguments"]): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
