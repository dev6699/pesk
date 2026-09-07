/** @jest-environment node */
/// <reference types="jest" />

import { RendererStatePublisher } from "../../src/app/renderer-state";
import type { CodexState } from "../../src/codex/types";

function codexState(threadId: string): CodexState {
  return {
    threads: {
      selectedId: threadId,
      current: {
        thread: {
          projectId: undefined,
          workingDirectory: "/workspace",
          commandNotice: undefined,
          status: "idle",
          connected: true,
          messages: [],
          collaborationMode: "default",
          pendingApproval: undefined,
          pendingUserInput: undefined,
          queuedSubmissions: [],
          interrupted: false,
        },
        readOnly: false,
        history: { loading: false, hasOlder: false },
      },
      items: [],
      activities: [],
      backgroundWork: { completed: 0, total: 0 },
    },
    connection: { status: "ready", ...{ error: undefined } },
    projects: { items: [] },
    account: {},
  } as CodexState;
}

function fixture() {
  const firstState = codexState("first");
  const getCodexState = jest.fn(() => firstState);
  const codex = { getState: getCodexState };
  const petWindow = {
    isDestroyed: jest.fn(() => false),
    webContents: { send: jest.fn() },
  };
  const chatWindow = {
    isDestroyed: jest.fn(() => false),
    webContents: { send: jest.fn() },
  };
  const webServer = {
    broadcast: jest.fn(),
    broadcastStreamDelta: jest.fn(),
  };
  const publisher = new RendererStatePublisher(
    codex as never,
    () => ({}) as never,
    () => "status.mp3",
    () => ({}) as never,
    () => "default",
    () => petWindow as never,
    () => chatWindow as never,
    webServer as never,
  );
  return { publisher, firstState, getCodexState, petWindow, chatWindow, webServer };
}

describe("RendererStatePublisher", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("uses the latest Codex snapshot for state reads", () => {
    const { publisher, firstState, getCodexState } = fixture();
    const nextState = codexState("next");

    publisher.publishCodex(nextState);

    expect(publisher.getState().codex).toBe(nextState);
    expect(publisher.getState().codex).not.toBe(firstState);
    expect(getCodexState).toHaveBeenCalledTimes(1);
  });

  test("batches Codex updates and publishes the latest snapshot", () => {
    jest.useFakeTimers();
    const { publisher, petWindow, chatWindow, webServer } = fixture();
    const firstUpdate = codexState("update-1");
    const latestUpdate = codexState("update-2");

    publisher.publishCodex(firstUpdate);
    publisher.publishCodex(latestUpdate);
    jest.advanceTimersByTime(16);

    expect(petWindow.webContents.send).toHaveBeenCalledWith(
      "settings-changed",
      expect.objectContaining({ codex: latestUpdate }),
    );
    expect(chatWindow.webContents.send).toHaveBeenCalledWith(
      "settings-changed",
      expect.objectContaining({ codex: latestUpdate }),
    );
    expect(webServer.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ codex: latestUpdate }),
    );
  });

  test("publishes non-Codex updates with the latest Codex snapshot", () => {
    jest.useFakeTimers();
    const { publisher, firstState, petWindow } = fixture();
    const latestState = codexState("latest");
    publisher.publishCodex(latestState);
    publisher.publish();
    jest.advanceTimersByTime(16);

    expect(petWindow.webContents.send).toHaveBeenCalledWith(
      "settings-changed",
      expect.objectContaining({ codex: latestState }),
    );
    expect(petWindow.webContents.send).not.toHaveBeenCalledWith(
      "settings-changed",
      expect.objectContaining({ codex: firstState }),
    );
  });
});
