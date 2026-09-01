import { marked } from "../../vendor/marked.js";

export type CodexHistory = RendererState["codex"]["history"];
export type CodexActivity = NonNullable<CodexHistory[number]["activity"]>;

export function activityLabel(kind: CodexActivity["kind"]): string {
  switch (kind) {
    case "webSearch":
      return "Web search";
    case "tool":
      return "Tool";
    case "plan":
      return "Plan";
    case "other":
      return "Activity";
    default:
      return kind === "fileChange" ? "File change" : "Command";
  }
}

export function isReviewActivity(activity: CodexActivity): boolean {
  return activity.label === "enteredReviewMode" || activity.label === "exitedReviewMode";
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainderSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return `${hours}h ${remainderMinutes}m ${seconds % 60}s`;
}

export function historyStructureKey(history: CodexHistory): string {
  let first = 2166136261;
  let second = 2246822519;
  const add = (value: unknown): void => {
    const text = `${value ?? ""}|`;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ code, 2246822519);
    }
  };
  const addApproval = (approval: NonNullable<CodexHistory[number]["approval"]>): void => {
    add(approval.requestId);
    add(approval.state);
    for (const option of approval.options ?? []) {
      add(option.id);
      add(option.label);
      add(option.description);
    }
  };
  for (const message of history ?? []) {
    add(message.role);
    add(message.itemId);
    add(message.timestamp);
    add(message.temporary);
    if (message.approval) addApproval(message.approval);
    if (message.activity?.kind !== "plan" && message.activity?.kind !== "command") {
      if (message.activity || message.role !== "assistant") add(message.text);
    }
    for (const image of message.images ?? []) {
      add(image.url);
      add(image.name);
    }
    const activity = message.activity;
    if (!activity) continue;
    add(activity.kind);
    add(activity.source);
    add(activity.userInitiated);
    add(activity.label);
    add(activity.status);
    add(activity.command);
    add(activity.cwd);
    add(activity.summary);
    for (const change of activity.changes ?? []) add(change);
    if (activity.kind !== "plan") add(activity.details);
    if (activity.kind !== "command") add(activity.output);
  }
  return `${history?.length ?? 0}:${first >>> 0}:${second >>> 0}`;
}

export function historyMessageKeyForRenderer(message: CodexHistory[number], index: number): string {
  return (
    message.itemId ?? `${message.turnId ?? "history"}:${message.role}:${message.timestamp ?? index}`
  );
}

export function isPrefix(previous: string[], next: string[]): boolean {
  if (previous.length > next.length) return false;
  return previous.every((key, index) => key === next[index]);
}

export function isSuffix(previous: string[], next: string[]): boolean {
  if (previous.length > next.length) return false;
  const offset = next.length - previous.length;
  return previous.every((key, index) => key === next[offset + index]);
}

export function renderMarkdown(value: string): string {
  const html = marked.parse(value, { async: false, breaks: true, gfm: true });
  return sanitizeMarkdownHtml(String(html));
}

export function sanitizeMarkdownHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const allowed = new Set([
    "A",
    "BLOCKQUOTE",
    "BR",
    "CODE",
    "DEL",
    "EM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HR",
    "IMG",
    "LI",
    "OL",
    "P",
    "PRE",
    "STRONG",
    "TABLE",
    "TBODY",
    "TD",
    "TFOOT",
    "TH",
    "THEAD",
    "TR",
    "UL",
  ]);
  const visit = (element: Element): void => {
    for (const child of [...element.children]) {
      if (!allowed.has(child.tagName)) {
        child.remove();
        continue;
      }
      for (const attribute of [...child.attributes]) {
        const name = attribute.name.toLowerCase();
        const keep =
          child.tagName === "A"
            ? (name === "href" && /^(https?:|mailto:|#)/i.test(attribute.value)) || name === "title"
            : child.tagName === "IMG"
              ? (name === "src" &&
                  /^(https?:|data:image\/(?:png|jpe?g|gif|webp|avif);)/i.test(attribute.value)) ||
                name === "alt" ||
                name === "title"
              : false;
        if (!keep) child.removeAttribute(attribute.name);
      }
      if (child.tagName === "IMG" && !child.getAttribute("src")) {
        child.remove();
        continue;
      }
      if (child.tagName === "A") {
        child.setAttribute("target", "_blank");
        child.setAttribute("rel", "noreferrer");
      }
      visit(child);
    }
  };
  visit(template.content as unknown as Element);
  return template.innerHTML;
}

export function formatCommandActivity(activity: CodexActivity): string {
  return [
    activity.command ? `$ ${activity.command}` : "",
    activity.cwd ? `cwd: ${activity.cwd}` : "",
    activity.output ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function fileChangeLineClass(line: string): string {
  if (line.startsWith("  +") && !line.startsWith("  +++")) return "codex-file-change-added";
  if (line.startsWith("  -") && !line.startsWith("  ---")) return "codex-file-change-removed";
  if (line.startsWith("  @@")) return "codex-file-change-hunk";
  return "codex-file-change-context";
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}m`;
}

export function formatReset(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatPlan(plan: string): string {
  return plan.replaceAll("_", " ").replace(/(^| )\S/g, (letter) => letter.toUpperCase());
}

export function formatRateLimitDetails(
  limits: NonNullable<RendererState["codex"]["rateLimits"]>,
): string[] {
  const formatWindow = (label: string, window: typeof limits.primary): string => {
    if (!window) return `${label}: unavailable`;
    const reset = window.resetsAt ? ` · resets ${formatReset(window.resetsAt)}` : "";
    return `${label}: ${Math.round(window.usedPercent)}% used${reset}`;
  };
  return [
    formatWindow("Quota", limits.primary),
    limits.secondary ? formatWindow("Secondary", limits.secondary) : "",
    limits.credits?.unlimited
      ? "Credits: unlimited"
      : limits.credits?.balance
        ? `Credits: ${limits.credits.balance}`
        : "",
    limits.individualLimit
      ? `Monthly: ${Math.round(limits.individualLimit.remainingPercent)}% remaining`
      : "",
    limits.planType ? `Plan: ${formatPlan(limits.planType)}` : "",
    limits.rateLimitReachedType
      ? `Status: ${formatPlan(limits.rateLimitReachedType)}`
      : limits.spendControlReached
        ? "Status: spend control reached"
        : "",
  ].filter(Boolean);
}
