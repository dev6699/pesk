/** @jest-environment node */
/// <reference types="jest" />

import { CodexRateLimitManager } from "../../src/codex/rate-limits";
import type { JsonRpcResponse } from "../../src/codex/protocol";

test("guards rate-limit reads and applies the response snapshot", () => {
  const callbacks: Array<(message: JsonRpcResponse<any>) => void> = [];
  const publish = jest.fn();
  const manager = new CodexRateLimitManager({
    request: (_request, callback) => {
      callbacks.push(callback as (message: JsonRpcResponse<any>) => void);
      return true;
    },
    publishRendererState: publish,
  });
  const snapshot = { primary: { usedPercent: 25 } } as never;

  manager.refresh();
  manager.refresh();
  expect(callbacks).toHaveLength(1);
  callbacks[0]({ id: 1, result: { rateLimits: snapshot } });

  expect(manager.getSnapshot()).toBe(snapshot);
  expect(publish).toHaveBeenCalledTimes(1);
});

test("accepts live rate-limit updates", () => {
  const publish = jest.fn();
  const manager = new CodexRateLimitManager({
    request: () => true,
    publishRendererState: publish,
  });
  const snapshot = { secondary: { usedPercent: 50 } } as never;

  manager.handleUpdated(snapshot);

  expect(manager.getSnapshot()).toBe(snapshot);
  expect(publish).toHaveBeenCalledTimes(1);
});

test("clears a rejected read guard and ignores an empty response", () => {
  const callbacks: Array<(message: JsonRpcResponse<unknown>) => void> = [];
  const manager = new CodexRateLimitManager({
    request: (_request, callback) => {
      callbacks.push(callback as (message: JsonRpcResponse<unknown>) => void);
      return true;
    },
    publishRendererState: jest.fn(),
  });

  manager.refresh();
  manager.refresh();
  callbacks[0]({ id: 1 });

  expect(manager.getSnapshot()).toBeUndefined();
});
