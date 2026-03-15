import { describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools", () => {
  it("registers the KIS quote tool", () => {
    const tool = createOpenClawTools().find((candidate) => candidate.name === "kis_quote");
    expect(tool).toBeDefined();
  });
});
