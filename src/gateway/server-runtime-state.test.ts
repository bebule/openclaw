import { describe, expect, it } from "vitest";
import { shouldWarnOnNonLoopbackBind } from "./server-runtime-state.js";

describe("shouldWarnOnNonLoopbackBind", () => {
  it("does not warn for loopback binds", () => {
    expect(shouldWarnOnNonLoopbackBind({ bindHost: "127.0.0.1", env: {} })).toBe(false);
    expect(shouldWarnOnNonLoopbackBind({ bindHost: "::1", env: {} })).toBe(false);
  });

  it("suppresses the warning when Docker publishes the host port on loopback", () => {
    expect(
      shouldWarnOnNonLoopbackBind({
        bindHost: "0.0.0.0",
        env: { OPENCLAW_PUBLISHED_GATEWAY_PORT: "127.0.0.1:18789" },
      }),
    ).toBe(false);
    expect(
      shouldWarnOnNonLoopbackBind({
        bindHost: "0.0.0.0",
        env: { OPENCLAW_PUBLISHED_GATEWAY_PORT: "[::1]:18789" },
      }),
    ).toBe(false);
  });

  it("keeps warning when the published host port is not loopback-only", () => {
    expect(
      shouldWarnOnNonLoopbackBind({
        bindHost: "0.0.0.0",
        env: { OPENCLAW_PUBLISHED_GATEWAY_PORT: "18789" },
      }),
    ).toBe(true);
    expect(
      shouldWarnOnNonLoopbackBind({
        bindHost: "0.0.0.0",
        env: {},
      }),
    ).toBe(true);
  });
});
