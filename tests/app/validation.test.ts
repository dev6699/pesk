/// <reference types="jest" />

import { isRequestId, validAnswers, validImageInputs, validRoots } from "../../src/app/validation";

describe("runtime validation", () => {
  test("accepts string and numeric request IDs only", () => {
    expect(isRequestId("request-1")).toBe(true);
    expect(isRequestId(1)).toBe(true);
    expect(isRequestId(null)).toBe(false);
    expect(isRequestId({})).toBe(false);
  });

  test("filters image inputs to data images with names", () => {
    expect(
      validImageInputs([
        { url: "data:image/png;base64,abc", name: "image.png" },
        { url: "https://example.com/image.png", name: "remote.png" },
        { url: "data:text/plain,hello", name: "text.txt" },
        { url: "data:image/png;base64,missing-name" },
      ]),
    ).toEqual([{ url: "data:image/png;base64,abc", name: "image.png" }]);
  });

  test("returns only string roots and handles non-array input", () => {
    expect(validRoots(["C:\\project", 1, null, "D:\\work"])).toEqual(["C:\\project", "D:\\work"]);
    expect(validRoots(undefined)).toBeUndefined();
  });

  test("normalizes answer values to string arrays", () => {
    expect(validAnswers({ first: ["one", 2], ignored: "value", second: [] })).toEqual({
      first: ["one"],
      second: [],
    });
    expect(validAnswers(null)).toBeUndefined();
  });
});
