import type {
  ClientNotification,
  ClientRequest,
  RequestId,
  ServerNotification,
  ServerRequest,
} from "../codex-schema";
import type { CollaborationMode } from "../codex-schema/CollaborationMode";
import type { Thread } from "../codex-schema/v2";
import type {
  CommandExecutionRequestApprovalResponse,
  FileChangeRequestApprovalResponse,
} from "../codex-schema/v2";
import type { ApprovalDecision } from "./types";

// Temporarily disabled because reconciling the full thread history on idle is
// too heavy during normal use. Re-enable after a lighter reconciliation path
// is available.
const RECONCILE_ON_IDLE = false;

export interface JsonRpcResponse<TResult = unknown> {
  [key: string]: unknown;
  id: RequestId;
  result?: TResult;
  error?: unknown;
}

export type ServerMessage = ServerNotification | ServerRequest;
export type IncomingMessage = JsonRpcResponse | ServerMessage;

export type PermissionApprovalResponse =
  CommandExecutionRequestApprovalResponse | FileChangeRequestApprovalResponse;

export function requestIdKey(requestId: RequestId): string {
  return `${typeof requestId}:${String(requestId)}`;
}

export function approvalDecisions(
  message: Extract<
    ServerMessage,
    {
      method:
        | "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval";
    }
  >,
): Map<string, ApprovalDecision> {
  const decisions = new Map<string, ApprovalDecision>([
    ["accept", "accept"],
    ["acceptForSession", "acceptForSession"],
    ["decline", "decline"],
    ["cancel", "cancel"],
  ]);
  if (message.method === "item/commandExecution/requestApproval") {
    if (message.params.proposedExecpolicyAmendment) {
      decisions.set("acceptWithExecpolicyAmendment", {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: message.params.proposedExecpolicyAmendment,
        },
      });
    }
    for (const [index, amendment] of (
      message.params.proposedNetworkPolicyAmendments ?? []
    ).entries()) {
      decisions.set(`applyNetworkPolicyAmendment:${index}`, {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: amendment,
        },
      });
    }
  }
  return decisions;
}

type RequestOf<Method extends ClientRequest["method"]> = Extract<
  ClientRequest,
  { method: Method }
>;
export type InitializeRequest = RequestOf<"initialize">;
export type ThreadStartRequest = RequestOf<"thread/start">;
export type ThreadResumeRequest = RequestOf<"thread/resume">;
export type ThreadListRequest = RequestOf<"thread/list">;
export type ThreadReadRequest = RequestOf<"thread/read">;
export type TurnStartRequest = RequestOf<"turn/start">;
export type ReviewStartRequest = RequestOf<"review/start">;
export type PlanTurnStartParams = TurnStartRequest["params"] & {
  collaborationMode?: CollaborationMode | null;
};
export type AccountRateLimitsRequest = RequestOf<"account/rateLimits/read">;
export type TurnInterruptRequest = RequestOf<"turn/interrupt">;
export type ThreadShellCommandRequest = RequestOf<"thread/shellCommand">;
export type CommandExecRequest = RequestOf<"command/exec">;
export type FuzzyFileSearchRequest = RequestOf<"fuzzyFileSearch">;

type LocalTextInput = { type: "text"; text: string; text_elements: [] };
export type TurnSteerRequest = {
  method: "turn/steer";
  id: number;
  params: {
    threadId: string;
    input: LocalTextInput[];
    expectedTurnId: string;
    clientUserMessageId: string;
  };
};
export type LocalQueueAddRequest = {
  method: "thread/queue/add";
  id: number;
  params: {
    threadId: string;
    input: LocalTextInput[];
    clientUserMessageId: string;
  };
};
export type LocalQueueListRequest = {
  method: "thread/queue/list";
  id: number;
  params: { threadId: string; cursor?: string | null; limit?: number | null };
};
export type LocalQueueAddResponse = {
  queuedSubmission?: {
    id: string;
    input: LocalTextInput[];
    clientUserMessageId: string;
  };
};
export type LocalQueueListResponse = {
  data?: Array<{
    id: string;
    input: LocalTextInput[];
    clientUserMessageId: string;
  }>;
  nextCursor?: string | null;
};

export type OutgoingMessage =
  | ClientRequest
  | ClientNotification
  | LocalQueueAddRequest
  | LocalQueueListRequest
  | JsonRpcResponse;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function records(value: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(value) ? value : []).filter(
    (entry): entry is Record<string, unknown> => isRecord(entry),
  );
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isRecord(value) && "id" in value && !("method" in value);
}

export function messageThreadId(message: ServerMessage): string | undefined {
  const params = message.params as unknown;
  if (!isRecord(params)) return undefined;
  if (typeof params.threadId === "string") return params.threadId;
  if (message.method === "thread/started" && isRecord(params.thread)) {
    return typeof params.thread.id === "string" ? params.thread.id : undefined;
  }
  return undefined;
}

export function isThread(value: unknown): value is Thread {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isRecord(value.status) &&
    typeof value.status.type === "string"
  );
}

export function describeSocketError(error: unknown, url: string): string {
  if (error instanceof Error) {
    return `url=${url}; name=${error.name}; message=${error.message}`;
  }
  if (error && typeof error === "object") {
    const event = error as {
      type?: unknown;
      message?: unknown;
      error?: unknown;
    };
    const nestedError =
      event.error && typeof event.error === "object"
        ? (event.error as { name?: unknown; message?: unknown })
        : undefined;
    const details = [
      `url=${url}`,
      typeof event.type === "string" ? `type=${event.type}` : "",
      typeof event.message === "string" && event.message
        ? `message=${event.message}`
        : "",
      typeof nestedError?.name === "string" ? `name=${nestedError.name}` : "",
      typeof nestedError?.message === "string" && nestedError.message
        ? `error=${nestedError.message}`
        : "",
    ].filter(Boolean);
    return details.join("; ");
  }
  return `url=${url}; error=${String(error)}`;
}

export interface ThreadStatusLike {
  type?: unknown;
}

/** Whether an active remote thread should be resumed by Pesk. */
export function shouldResumeOnActiveStatus(
  connected: boolean,
  status: ThreadStatusLike | undefined,
): boolean {
  return !connected && status?.type === "active";
}

/** Whether an idle transition should trigger a fresh history read. */
export function shouldReconcileOnIdle(
  previousStatus: string,
  status: ThreadStatusLike | undefined,
  needsReconcile: boolean,
): boolean {
  return (
    RECONCILE_ON_IDLE &&
    status?.type === "idle" &&
    (previousStatus === "working" || needsReconcile)
  );
}
