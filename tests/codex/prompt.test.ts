/** @jest-environment node */
/// <reference types="jest" />
/// <reference types="node" />

import { parsePrompt } from "../../src/codex/prompt";

describe("parsePrompt", () => {
  test("parses local commands case-insensitively", () => {
    expect(parsePrompt(" /PLAN ", [])).toEqual({ kind: "mode", mode: "plan" });
    expect(parsePrompt("/GOAL define the target", [])).toEqual({
      kind: "goal",
      command: "define the target",
    });
    expect(parsePrompt("/new", [])).toEqual({
      kind: "text",
      text: "/new",
      inputs: [{ type: "text", text: "/new", text_elements: [] }],
      metadata: [],
    });
  });

  test("keeps normal text and images as turn inputs", () => {
    expect(parsePrompt(" inspect this ", [{ url: "image-url", name: "screen.png" }])).toEqual({
      kind: "text",
      text: "inspect this",
      inputs: [
        { type: "text", text: "inspect this", text_elements: [] },
        { type: "image", url: "image-url" },
      ],
      metadata: [{ url: "image-url", name: "screen.png" }],
    });
  });

  test("parses shell and quoted exec commands", () => {
    expect(parsePrompt("!git status", [])).toEqual({ kind: "shell", command: "git status" });
    expect(parsePrompt('/exec bash -lc "printf hello"', [])).toEqual({
      kind: "exec",
      commandText: 'bash -lc "printf hello"',
      argv: ["bash", "-lc", "printf hello"],
    });
  });

  test("rejects a prompt without text or images", () => {
    expect(parsePrompt("   ", [])).toEqual({ kind: "invalid" });
  });
});
