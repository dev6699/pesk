/// <reference types="jest" />
/// <reference types="node" />
import { CodexModelManager, type ModelRequestInput } from "../../src/codex/model";
import type { JsonRpcResponse, ModelListResponse } from "../../src/codex/protocol";
import type { Model } from "../../src/codex-schema/v2";

type Request = {
  request: ModelRequestInput;
  callback: <TResult>(response: JsonRpcResponse<TResult>) => void;
};

function model(name: string): Model {
  return {
    id: name,
    model: name,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: name,
    description: `${name} description`,
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    supportsPersonality: false,
    multiAgentVersion: "disabled",
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: name === "gpt-first",
  };
}

function manager(selectedThread = "thread-1") {
  const requests: Request[] = [];
  let threadId: string | undefined = selectedThread;
  const publish = jest.fn();
  const setCommandNotice = jest.fn();
  const request = <TResult>(
    request: ModelRequestInput,
    callback: (response: JsonRpcResponse<TResult>) => void,
  ): void => {
    requests.push({ request, callback: callback as Request["callback"] });
  };
  const value = new CodexModelManager({
    request,
    getSelectedThreadId: () => threadId,
    publishRendererState: publish,
    setCommandNotice,
  });
  return {
    value,
    requests,
    publish,
    setCommandNotice,
    setThread: (id?: string) => (threadId = id),
  };
}

function respond<T>(request: Request, result: T): void {
  request.callback({ id: 1, result });
}

test("rejects opening the picker without an active thread", () => {
  const fixture = manager("");
  expect(fixture.value.begin()).toBe(false);
  expect(fixture.setCommandNotice).toHaveBeenCalledWith("No active thread to change model.");
  expect(fixture.publish).toHaveBeenCalled();
});

test("loads every model page before publishing the picker", () => {
  const fixture = manager();
  expect(fixture.value.begin()).toBe(true);
  expect(fixture.requests[0].request).toMatchObject({
    method: "model/list",
    params: { cursor: null, includeHidden: false },
  });
  respond<ModelListResponse>(fixture.requests[0], {
    data: [model("gpt-first")],
    nextCursor: "page-2",
  });
  expect(fixture.requests).toHaveLength(2);
  respond<ModelListResponse>(fixture.requests[1], {
    data: [model("gpt-second")],
    nextCursor: null,
  });
  expect(fixture.value.getPicker()?.models.map((entry) => entry.model)).toEqual([
    "gpt-first",
    "gpt-second",
  ]);
  expect(fixture.publish).toHaveBeenCalled();
});

test("selects a reasoning effort and updates future-turn settings", () => {
  const fixture = manager();
  fixture.value.begin();
  respond<ModelListResponse>(fixture.requests[0], { data: [model("gpt-test")], nextCursor: null });
  fixture.value.select("gpt-test", "");
  expect(fixture.value.getPicker()).toMatchObject({ stage: "effort" });
  fixture.value.select("gpt-test", "medium");
  expect(fixture.requests[1].request).toMatchObject({
    method: "thread/settings/update",
    params: { threadId: "thread-1", model: "gpt-test", effort: "medium" },
  });
  respond(fixture.requests[1], {});
  expect(fixture.value.getPicker()).toBeUndefined();
});

test("rejects invalid model and reasoning selections", () => {
  const fixture = manager();
  fixture.value.select("missing", "medium");
  fixture.value.begin();
  respond<ModelListResponse>(fixture.requests[0], { data: [model("gpt-test")], nextCursor: null });
  fixture.value.select("gpt-test", "unsupported");
  expect(fixture.requests).toHaveLength(1);
  fixture.setThread(undefined);
  fixture.value.select("gpt-test", "");
});

test("ignores responses after cancellation or thread switching", () => {
  const fixture = manager();
  fixture.value.begin();
  fixture.value.cancel();
  respond<ModelListResponse>(fixture.requests[0], { data: [model("stale")], nextCursor: null });
  expect(fixture.value.getPicker()).toBeUndefined();

  fixture.value.begin();
  fixture.setThread("thread-2");
  respond<ModelListResponse>(fixture.requests[1], { data: [model("other")], nextCursor: null });
  expect(fixture.value.getPicker()).toBeUndefined();
});

test("ignores stale settings responses and reports settings errors", () => {
  const fixture = manager();
  fixture.value.begin();
  respond<ModelListResponse>(fixture.requests[0], { data: [model("gpt-test")], nextCursor: null });
  fixture.value.select("gpt-test", "");
  fixture.value.select("gpt-test", "medium");
  fixture.value.cancel();
  respond(fixture.requests[1], {});
  expect(fixture.value.getPicker()).toBeUndefined();

  fixture.value.begin();
  respond<ModelListResponse>(fixture.requests[2], { data: [model("gpt-test")], nextCursor: null });
  fixture.value.select("gpt-test", "");
  fixture.value.select("gpt-test", "medium");
  fixture.requests[3].callback({ id: 3, error: "failed" });
  expect(fixture.setCommandNotice).toHaveBeenCalledWith("Unable to change the model.");
  expect(fixture.value.getPicker()).toBeUndefined();
});

test("reports an empty or failed model response", () => {
  const fixture = manager();
  fixture.value.begin();
  respond<ModelListResponse>(fixture.requests[0], { data: [], nextCursor: null });
  expect(fixture.value.getPicker()).toBeUndefined();
  expect(fixture.setCommandNotice).toHaveBeenCalledWith("Unable to load available models.");

  fixture.value.begin();
  fixture.requests[1].callback({ id: 2, error: "failed" });
  expect(fixture.setCommandNotice).toHaveBeenCalledWith("Unable to load available models.");
});
