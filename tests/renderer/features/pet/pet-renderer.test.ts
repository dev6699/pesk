/** @jest-environment jsdom */
/// <reference types="jest" />
/// <reference path="../../../../src/renderer/shared/types.d.ts" />

import { PetRenderer } from "../../../../src/renderer/features/pet/pet-renderer";
import { defaultRendererState } from "../../../../src/renderer/shared/default-settings";

class FakeClassList {
  private readonly values = new Set<string>();
  toggle(name: string, enabled: boolean): void {
    if (enabled) this.values.add(name);
    else this.values.delete(name);
  }
  contains(name: string): boolean {
    return this.values.has(name);
  }
}

class FakeElement {
  classList = new FakeClassList();
  attributes = new Map<string, string>();
  style = {} as Record<string, string>;
  addEventListener(): void {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

function createStatusSound(): HTMLAudioElement {
  return {
    currentTime: 0,
    volume: 0,
    src: "",
    load: jest.fn(),
    pause: jest.fn(),
    play: jest.fn(async () => undefined),
  } as unknown as HTMLAudioElement;
}

function createRenderer(sound = createStatusSound()) {
  return new PetRenderer({
    image: new FakeElement() as never,
    pet: new FakeElement() as never,
    status: new FakeElement() as never,
    statusLabel: { textContent: "" } as unknown as HTMLElement,
    statusSound: sound,
    chatOnly: false,
    state: defaultRendererState(),
  });
}

beforeEach(() => {
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
});

describe("PetRenderer", () => {
  test("does not play automatically when working becomes idle or waiting", () => {
    const sound = createStatusSound();
    const renderer = createRenderer(sound);
    renderer.updateState({
      ...defaultRendererState(),
      codex: { ...defaultRendererState().codex, status: "working" },
      assets: { codexStatusSoundUrl: "file:///tmp/status.mp3" },
    });
    renderer.updateState({
      ...defaultRendererState(),
      codex: { ...defaultRendererState().codex, status: "idle" },
      assets: { codexStatusSoundUrl: "file:///tmp/status.mp3" },
    });
    renderer.updateCodexUpdate(true);
    renderer.updateState({
      ...defaultRendererState(),
      codex: { ...defaultRendererState().codex, status: "waiting" },
      assets: { codexStatusSoundUrl: "file:///tmp/status.mp3" },
    });

    expect(sound.load).toHaveBeenCalledTimes(1);
    expect(sound.play).not.toHaveBeenCalled();
  });

  test("does not play when the window is focused", () => {
    const sound = createStatusSound();
    const renderer = createRenderer(sound);
    renderer.updateFocus(true);
    renderer.updateState({
      ...defaultRendererState(),
      codex: { ...defaultRendererState().codex, status: "working" },
      assets: { codexStatusSoundUrl: "file:///tmp/status.mp3" },
    });
    renderer.updateState({
      ...defaultRendererState(),
      codex: { ...defaultRendererState().codex, status: "idle" },
      assets: { codexStatusSoundUrl: "file:///tmp/status.mp3" },
    });
    renderer.updateCodexUpdate(true);

    expect(sound.play).not.toHaveBeenCalled();
  });

  test("plays an explicit background notification while unfocused", () => {
    const sound = createStatusSound();
    const renderer = createRenderer(sound);
    renderer.playAttentionSound();

    expect(sound.play).toHaveBeenCalledTimes(1);
  });

  test("does not play automatically when the blue indicator activates", () => {
    const sound = createStatusSound();
    const renderer = createRenderer(sound);
    renderer.updateCodexUpdate(true);
    renderer.updateState({
      ...defaultRendererState(),
      codex: {
        ...defaultRendererState().codex,
        pendingApproval: {
          requestId: 1,
          command: "echo hi",
          reason: "Needs approval",
          options: [],
        },
      },
    });

    expect(sound.play).not.toHaveBeenCalled();
  });

  test("does not play the notification when disabled", () => {
    const sound = createStatusSound();
    const renderer = new PetRenderer({
      image: new FakeElement() as never,
      pet: new FakeElement() as never,
      status: new FakeElement() as never,
      statusLabel: { textContent: "" } as unknown as HTMLElement,
      statusSound: sound,
      chatOnly: false,
      state: {
        ...defaultRendererState(),
        settings: { ...defaultRendererState().settings, codexStatusSound: false },
      },
    });
    renderer.updateState({
      ...defaultRendererState(),
      settings: { ...defaultRendererState().settings, codexStatusSound: false },
      codex: { ...defaultRendererState().codex, status: "working" },
    });
    renderer.updateState({
      ...defaultRendererState(),
      settings: { ...defaultRendererState().settings, codexStatusSound: false },
      codex: { ...defaultRendererState().codex, status: "idle" },
    });

    expect(sound.play).not.toHaveBeenCalled();
  });

  test("shows the aggregate active count in the pet status", () => {
    jest.useFakeTimers();
    const now = Date.now();
    jest.setSystemTime(now);
    const statusLabel = { textContent: "" } as unknown as HTMLElement;
    const renderer = new PetRenderer({
      image: new FakeElement() as never,
      pet: new FakeElement() as never,
      status: new FakeElement() as never,
      statusLabel,
      statusSound: createStatusSound(),
      chatOnly: false,
      state: defaultRendererState(),
    });
    renderer.updateState({
      ...defaultRendererState(),
      codex: { ...defaultRendererState().codex, status: "working", workingSince: now - 65000 },
    });

    expect(statusLabel.textContent).toBe("Working · 1m 5s");
    jest.advanceTimersByTime(5000);
    expect(statusLabel.textContent).toBe("Working · 1m 10s");
    renderer.updateState(defaultRendererState());
    expect(statusLabel.textContent).toBe("Idle");
    jest.useRealTimers();
  });

  test("uses one focused class and accessible label for pet focus", () => {
    const pet = new FakeElement();
    const renderer = new PetRenderer({
      image: new FakeElement() as never,
      pet: pet as never,
      status: new FakeElement() as never,
      statusLabel: { textContent: "" } as never,
      statusSound: createStatusSound(),
      chatOnly: false,
      state: defaultRendererState(),
    });
    renderer.updateFocus(true);
    expect(pet.classList.contains("focused")).toBe(true);
    expect(pet.classList.contains("codex-update")).toBe(false);
    expect(pet.attributes.get("aria-label")).toBe("Desktop pet (focused)");
    renderer.updateFocus(false);
    expect(pet.attributes.get("aria-label")).toBe("Desktop pet");
  });

  test("clears Codex update state when focus takes over", () => {
    const pet = new FakeElement();
    const renderer = new PetRenderer({
      image: new FakeElement() as never,
      pet: pet as never,
      status: new FakeElement() as never,
      statusLabel: { textContent: "" } as never,
      statusSound: createStatusSound(),
      chatOnly: false,
      state: defaultRendererState(),
    });
    renderer.updateCodexUpdate(true);
    renderer.updateFocus(true);

    expect(pet.classList.contains("codex-update")).toBe(false);
  });
});
