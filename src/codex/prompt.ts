import type { UserInput } from "../codex-schema/v2/UserInput";

export interface PromptImage {
  url: string;
  name: string;
}

export type PromptImages = PromptImage[];

export type ParsedPrompt =
  | { kind: "invalid" }
  | { kind: "model" }
  | { kind: "goal"; command: string }
  | { kind: "project"; command: string }
  | { kind: "compact" }
  | { kind: "mode"; mode: "plan" | "default" }
  | { kind: "fork" }
  | { kind: "archive" }
  | { kind: "delete" }
  | { kind: "shell"; command: string }
  | { kind: "exec"; commandText: string; argv: string[] }
  | {
      kind: "text";
      text: string;
      inputs: UserInput[];
      metadata: Array<{ url: string; name?: string }>;
    };

/** Converts client input into a command or a normal turn submission. */
export function parsePrompt(value: string, images: PromptImages): ParsedPrompt {
  if (!value.trim() && !images.length) return { kind: "invalid" };
  const prompt = value.trim();
  if (/^\/model$/i.test(prompt)) return { kind: "model" };
  const goal = prompt.match(/^\/goal(?:\s+(.+))?$/is);
  if (goal) return { kind: "goal", command: goal[1] ?? "" };
  const project = prompt.match(/^\/project(?:\s+(.+))?$/is);
  if (project) return { kind: "project", command: project[1] ?? "" };
  if (/^\/compact$/i.test(prompt)) return { kind: "compact" };
  const mode = prompt.match(/^\/(plan|default)$/i);
  if (mode) return { kind: "mode", mode: mode[1].toLowerCase() as "plan" | "default" };
  if (/^\/fork$/i.test(prompt)) return { kind: "fork" };
  if (/^\/archive$/i.test(prompt)) return { kind: "archive" };
  if (/^\/delete$/i.test(prompt)) return { kind: "delete" };
  const shell = prompt.match(/^!(.+)$/s)?.[1].trim();
  if (shell) return { kind: "shell", command: shell };
  const execText = prompt.match(/^\/exec\s+(.+)$/s)?.[1].trim();
  if (execText) return { kind: "exec", commandText: execText, argv: parseArgv(execText) };
  return {
    kind: "text",
    text: prompt,
    inputs: [
      ...(prompt ? [{ type: "text" as const, text: prompt, text_elements: [] }] : []),
      ...images.map(({ url }) => ({ type: "image" as const, url })),
    ],
    metadata: images.map(({ url, name }) => ({ url, name })),
  };
}

function parseArgv(value: string): string[] {
  return (
    value.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^(['"])(.*)\1$/, "$2")) ?? []
  );
}
