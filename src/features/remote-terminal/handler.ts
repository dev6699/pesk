import type { DynamicToolCallParams, DynamicToolCallResponse } from "../../codex-schema/v2";
import type { RtermClient } from "./rterm-client";
import type { DynamicApprovalKind } from "../../codex/dynamic-tools";
import {
  REMOTE_TERMINAL_EXECUTE_TOOL,
  REMOTE_TERMINAL_NAMESPACE,
  REMOTE_TERMINAL_READ_TOOL,
  REMOTE_TERMINAL_SESSIONS_TOOL,
  REMOTE_TERMINAL_UPLOAD_TOOL,
  REMOTE_TERMINAL_DOWNLOAD_TOOL,
} from "./tools";

interface ReadArguments {
  maxLines?: unknown;
  sessionId?: unknown;
}

interface ExecuteArguments {
  command?: unknown;
  reason?: unknown;
  sessionId?: unknown;
}

interface TransferArguments {
  workspacePath?: unknown;
  remotePath?: unknown;
  filename?: unknown;
  sessionId?: unknown;
}

function workspaceFilename(workspacePath: string): string {
  const normalized = workspacePath.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || "upload";
}

function remoteApprovalReason(host: string, reason: string): string {
  return `Remote host: ${host}\n${reason}`;
}

export interface RemoteTerminalToolHandlerDependencies {
  getRterm: (threadId: string) => RtermClient;
  readWorkspaceFile: (path: string) => Promise<string>;
  writeWorkspaceFile: (path: string, dataBase64: string) => Promise<void>;
  requestApproval: (
    threadId: string,
    callId: string,
    command: string,
    reason: string,
    kind?: DynamicApprovalKind,
    toolName?: string,
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
    if (params.tool === REMOTE_TERMINAL_SESSIONS_TOOL) {
      const sessions = this.dependencies
        .getRterm(params.threadId)
        .getProviderSessions()
        .map(({ sessionId, provider, target, user }) => ({ sessionId, provider, target, user }));
      return {
        contentItems: [{ type: "inputText", text: JSON.stringify(sessions) }],
        success: true,
      };
    }
    if (params.tool === REMOTE_TERMINAL_READ_TOOL) {
      const args = this.objectArguments(params.arguments) as ReadArguments;
      const maxLines =
        typeof args?.maxLines === "number" ? Math.min(200, Math.max(1, args.maxLines)) : 200;
      const sessionId = typeof args?.sessionId === "string" ? args.sessionId : undefined;
      const rterm = this.dependencies.getRterm(params.threadId);
      if (sessionId && !this.selectSession(rterm, params.threadId, sessionId))
        return fail("The provider session does not exist.");
      let recent;
      try {
        recent = await rterm.readProvider(maxLines, sessionId);
      } catch (error) {
        return fail(
          `Unable to read the provider terminal: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!recent) return fail(this.missingSessionMessage(rterm, sessionId));
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
    if (
      params.tool === REMOTE_TERMINAL_UPLOAD_TOOL ||
      params.tool === REMOTE_TERMINAL_DOWNLOAD_TOOL
    ) {
      const args = this.objectArguments(params.arguments) as TransferArguments;
      if (typeof args.workspacePath !== "string" || !args.workspacePath.trim())
        return fail("A workspace path is required.");
      if (typeof args.remotePath !== "string" || !args.remotePath.trim())
        return fail("A remote path is required.");
      if (
        args.filename !== undefined &&
        (typeof args.filename !== "string" || !args.filename.trim())
      )
        return fail("Filename must be a non-empty string.");
      const rterm = this.dependencies.getRterm(params.threadId);
      const sessionId = typeof args.sessionId === "string" ? args.sessionId : undefined;
      if (sessionId && !this.selectSession(rterm, params.threadId, sessionId))
        return fail("The provider session does not exist.");
      const host = rterm.getSnapshot().hostLabel || "remote shell";
      const upload = params.tool === REMOTE_TERMINAL_UPLOAD_TOOL;
      const source = upload ? args.workspacePath : args.remotePath;
      const destination = upload ? args.remotePath : args.workspacePath;
      const approved = await this.dependencies.requestApproval(
        params.threadId,
        params.callId,
        `${upload ? "Upload" : "Download"} ${source} -> ${destination}`,
        remoteApprovalReason(host, "Transfer files."),
        "remote",
        `${REMOTE_TERMINAL_NAMESPACE}.${params.tool}`,
      );
      if (!approved) return fail("The user rejected the file transfer.");
      try {
        if (upload) {
          const dataBase64 = await this.dependencies.readWorkspaceFile(args.workspacePath);
          const bytes = await rterm.uploadProviderBytes(
            Uint8Array.from(Buffer.from(dataBase64, "base64")),
            args.remotePath,
            typeof args.filename === "string"
              ? args.filename
              : workspaceFilename(args.workspacePath),
            sessionId,
          );
          if (bytes === undefined) return fail(this.missingSessionMessage(rterm, sessionId));
          return {
            contentItems: [{ type: "inputText", text: `Uploaded ${bytes} bytes.` }],
            success: true,
          };
        }
        const data = await rterm.downloadProviderBytes(args.remotePath, sessionId);
        if (!data) return fail(this.missingSessionMessage(rterm, sessionId));
        await this.dependencies.writeWorkspaceFile(
          args.workspacePath,
          Buffer.from(data).toString("base64"),
        );
        return {
          contentItems: [{ type: "inputText", text: `Downloaded ${data.byteLength} bytes.` }],
          success: true,
        };
      } catch (error) {
        return fail(
          `Unable to ${upload ? "upload" : "download"} through the provider: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (params.tool !== REMOTE_TERMINAL_EXECUTE_TOOL)
      return fail("Unsupported remote terminal tool.");
    const args = this.objectArguments(params.arguments) as ExecuteArguments;
    if (typeof args?.command !== "string" || !args.command.trim())
      return fail("A command is required.");
    const rterm = this.dependencies.getRterm(params.threadId);
    const sessionId = typeof args?.sessionId === "string" ? args.sessionId : undefined;
    if (sessionId && !this.selectSession(rterm, params.threadId, sessionId))
      return fail("The provider session does not exist.");
    const host = rterm.getSnapshot().hostLabel || "remote shell";
    const approved = await this.dependencies.requestApproval(
      params.threadId,
      params.callId,
      args.command,
      typeof args.reason === "string"
        ? remoteApprovalReason(host, args.reason)
        : remoteApprovalReason(host, "Run command."),
      "remote",
      `${REMOTE_TERMINAL_NAMESPACE}.${params.tool}`,
    );
    if (!approved) return fail("The user rejected the terminal command.");
    try {
      const result = await rterm.executeProvider(args.command, sessionId);
      if (!result) return fail(this.missingSessionMessage(rterm, sessionId));
      return {
        contentItems: [
          { type: "inputText", text: `completed; exitCode=${result.exitCode}\n${result.output}` },
        ],
        success: result.exitCode === 0,
      };
    } catch (error) {
      return fail(
        `Unable to execute through the provider: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private objectArguments(value: DynamicToolCallParams["arguments"]): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private missingSessionMessage(rterm: RtermClient, sessionId?: string): string {
    if (sessionId) return "The provider session is not connected or does not exist.";
    return "The provider session is not connected.";
  }

  private selectSession(rterm: RtermClient, threadId: string, sessionId: string): boolean {
    if (!rterm.selectProviderSession(sessionId)) return false;
    return true;
  }
}
