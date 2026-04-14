import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureAuthProfileStore = vi.fn();
const upsertAuthProfile = vi.fn();
const updateConfig = vi.fn();
const applyAuthProfileConfig = vi.fn((cfg) => cfg);
const logConfigUpdated = vi.fn();
const stylePromptTitle = vi.fn((value: string) => value);
const intro = vi.fn();
const note = vi.fn();
const outro = vi.fn();
const spinnerStart = vi.fn();
const spinnerStop = vi.fn();
const spinner = vi.fn(() => ({
  start: spinnerStart,
  stop: spinnerStop,
}));

vi.mock("@clack/prompts", () => ({
  intro,
  note,
  outro,
  spinner,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  ensureAuthProfileStore,
  upsertAuthProfile,
  applyAuthProfileConfig,
}));

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  updateConfig,
  logConfigUpdated,
}));

vi.mock("openclaw/plugin-sdk/cli-runtime", () => ({
  stylePromptTitle,
}));

describe("githubCopilotLoginCommand", () => {
  const originalFetch = globalThis.fetch;
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    ensureAuthProfileStore.mockReset();
    upsertAuthProfile.mockReset();
    updateConfig.mockReset();
    applyAuthProfileConfig.mockReset();
    logConfigUpdated.mockReset();
    stylePromptTitle.mockClear();
    intro.mockClear();
    note.mockClear();
    outro.mockClear();
    spinner.mockClear();
    spinnerStart.mockClear();
    spinnerStop.mockClear();

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });

    ensureAuthProfileStore.mockReturnValue({ profiles: {} });
    updateConfig.mockImplementation(async (mutator) => mutator({}));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          device_code: "device-123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 600,
          interval: 1,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "ghu_token",
          token_type: "bearer",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalIsTTY,
    });
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it("writes github copilot auth to the requested agent dir via plugin-sdk auth helpers", async () => {
    const { githubCopilotLoginCommand } = await import("./login.js");
    const runtime = { log: vi.fn() };

    await githubCopilotLoginCommand(
      { agentDir: "/state/agents/ops/agent", yes: true },
      runtime as never,
    );

    expect(ensureAuthProfileStore).toHaveBeenCalledWith("/state/agents/ops/agent", {
      allowKeychainPrompt: false,
    });
    expect(upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "github-copilot:github",
      credential: {
        type: "token",
        provider: "github-copilot",
        token: "ghu_token",
      },
      agentDir: "/state/agents/ops/agent",
    });
    expect(applyAuthProfileConfig).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        provider: "github-copilot",
        profileId: "github-copilot:github",
        mode: "token",
      }),
    );
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(logConfigUpdated).toHaveBeenCalledWith(runtime);
    expect(runtime.log).toHaveBeenCalledWith(
      "Auth profile: github-copilot:github (github-copilot/token)",
    );
  });

  it("honors an explicit profile id", async () => {
    const { githubCopilotLoginCommand } = await import("./login.js");

    await githubCopilotLoginCommand(
      {
        profileId: "github-copilot:ops",
        agentDir: "/env/agent",
        yes: true,
      },
      { log: vi.fn() } as never,
    );

    expect(ensureAuthProfileStore).toHaveBeenCalledWith("/env/agent", {
      allowKeychainPrompt: false,
    });
    expect(upsertAuthProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "github-copilot:ops",
        agentDir: "/env/agent",
      }),
    );
  });
});
