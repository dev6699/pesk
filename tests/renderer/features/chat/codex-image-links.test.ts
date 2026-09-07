/** @jest-environment jsdom */
/// <reference types="jest" />
/// <reference path="../../../../src/renderer/shared/types.d.ts" />

import { makeMarkdownLinksOpenable } from "../../../../src/renderer/features/chat/codex-image-links";

test("opens remote Markdown links through the external URL bridge", () => {
  const openExternalUrl = jest.fn(async () => undefined);
  window.peskApi = { openExternalUrl } as unknown as Window["peskApi"];
  const container = document.createElement("div");
  container.innerHTML = `
    <a href="https://example.com">remote</a>
    <a href="mailto:test@example.com">mail</a>
    <a href="#section">section</a>
  `;

  makeMarkdownLinksOpenable(container);
  container.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')?.click();

  expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");
  expect(container.querySelector('a[href^="mailto:"]')).not.toBeNull();
  expect(container.querySelector('a[href^="#"]')).not.toBeNull();
});
