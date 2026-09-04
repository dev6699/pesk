/** @jest-environment jsdom */

import { CodexHistoryScrollController } from "../../../../src/renderer/features/chat/codex-history-scroll-controller";

function makeController(): {
  controller: CodexHistoryScrollController;
  viewport: HTMLElement;
  content: HTMLElement;
} {
  document.body.innerHTML = '<div id="viewport"><div id="content"></div></div>';
  const viewport = document.querySelector<HTMLElement>("#viewport") as HTMLElement;
  const content = document.querySelector<HTMLElement>("#content") as HTMLElement;
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 800, writable: true },
  });
  viewport.scrollTo = jest.fn();
  viewport.scrollBy = jest.fn();
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof window.requestAnimationFrame;
  return { controller: new CodexHistoryScrollController(viewport, content), viewport, content };
}

test("switches to reading mode for manual scrolling and resumes at the bottom", () => {
  const { controller, viewport } = makeController();
  controller.noteManualScroll();
  viewport.scrollTop = 120;
  controller.handleScroll();
  expect(controller.isFollowing()).toBe(false);

  controller.noteManualScroll();
  viewport.scrollTop = 500;
  controller.handleScroll();
  expect(controller.isFollowing()).toBe(true);
  expect(controller.shouldFollowUpdate()).toBe(true);
});

test("treats the physical bottom as authoritative before a send update", () => {
  const { controller, viewport } = makeController();
  controller.noteManualScroll();
  viewport.scrollTop = 500;

  expect(controller.shouldFollowUpdate()).toBe(true);
  expect(controller.isFollowing()).toBe(true);
});

test("cancels stale bottom work when manual scrolling begins", () => {
  const { controller, viewport } = makeController();
  const frames: FrameRequestCallback[] = [];
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = jest.fn();
  controller.scrollToLatest(false);
  controller.noteManualScroll();
  viewport.scrollTop = 120;
  frames.shift()?.(0);
  expect(viewport.scrollTop).toBe(120);
});

test("restores a reader position without writing a clamped value", () => {
  const { controller, viewport, content } = makeController();
  controller.noteManualScroll();
  viewport.scrollTop = 120;
  controller.handleScroll();
  controller.lockContentExtent(800);
  controller.restoreReaderPosition(120);
  expect(viewport.scrollTop).toBe(120);
  expect(content.style.minHeight).toBe("");
});

test("settles the bottom when a hidden viewport becomes measurable", () => {
  const { controller, viewport } = makeController();
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 0 });
  controller.scrollToLatest(false);
  expect(viewport.scrollTop).toBe(0);

  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 300 });
  controller.handleResize();
  expect(viewport.scrollTop).toBe(500);
});

test("does not release the extent lock from the locked scroll height", () => {
  const { controller, viewport, content } = makeController();
  let naturalScrollHeight = 800;
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () => (content.style.minHeight ? 800 : naturalScrollHeight),
  });
  controller.noteManualScroll();
  viewport.scrollTop = 400;
  controller.handleScroll();
  controller.lockContentExtent(800);
  naturalScrollHeight = 600;

  controller.handleResize();
  expect(content.style.minHeight).toBe("800px");
  expect(viewport.scrollTop).toBe(400);

  naturalScrollHeight = 900;
  controller.handleResize();
  expect(content.style.minHeight).toBe("");
});

test("releases a temporary extent lock after settling the real bottom", () => {
  const { controller, viewport, content } = makeController();
  let naturalScrollHeight = 600;
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () => (content.style.minHeight ? 800 : naturalScrollHeight),
  });
  viewport.scrollTop = 500;
  controller.lockContentExtent(800);

  controller.scrollToLatest(false);

  expect(content.style.minHeight).toBe("");
  expect(viewport.scrollTop).toBe(naturalScrollHeight - viewport.clientHeight);
});
