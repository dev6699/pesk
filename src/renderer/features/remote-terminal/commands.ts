import type { SlashCommand } from "../chat/codex-suggestions-renderer.js";

export const REMOTE_TERMINAL_COMMANDS: SlashCommand[] = [
  { command: "/rterm", description: "Show or hide the Remote Terminal" },
];

export function handleRemoteTerminalCommand(prompt: string): boolean {
  if (!/^\/rterm$/i.test(prompt)) return false;
  document.dispatchEvent(new Event("toggle-rterm"));
  return true;
}
