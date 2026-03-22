import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureAuthProfileStore = vi.fn();
const resolveAgentDir = vi.fn();
const resolveDefaultAgentId = vi.fn();
const resolveOpenClawAgentDir = vi.fn();
const upsertAuthProfileOrThrow = vi.fn();
const loadValidConfigOrThrow = vi.fn();
const resolveKnownAgentId = vi.fn();
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

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentDir,
  resolveDefaultAgentId,
}));

vi.mock("../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir,
}));

vi.mock("../commands/auth-profile-write.js", () => ({
  upsertAuthProfileOrThrow,
}));

vi.mock("../commands/models/shared.js", () => ({
  loadValidConfigOrThrow,
  resolveKnownAgentId,
  updateConfig,
}));

vi.mock("../commands/onboard-auth.js", () => ({
  applyAuthProfileConfig,
}));

vi.mock("../config/logging.js", () => ({
  logConfigUpdated,
}));

vi.mock("../terminal/prompt-style.js", () => ({
  stylePromptTitle,
}));

describe("githubCopilotLoginCommand", () => {
  const originalFetch = globalThis.fetch;
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    ensureAuthProfileStore.mockReset();
    resolveAgentDir.mockReset();
    resolveDefaultAgentId.mockReset();
    resolveOpenClawAgentDir.mockReset();
    upsertAuthProfileOrThrow.mockReset();
    loadValidConfigOrThrow.mockReset();
    resolveKnownAgentId.mockReset();
    updateConfig.mockReset();
    applyAuthProfileConfig.mockClear();
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
    loadValidConfigOrThrow.mockResolvedValue({
      agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
    });
    resolveDefaultAgentId.mockReturnValue("main");
    resolveKnownAgentId.mockImplementation(({ rawAgentId }) => rawAgentId?.trim() || undefined);
    resolveAgentDir.mockImplementation((_cfg, agentId: string) => `/state/agents/${agentId}/agent`);
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

  it("writes github copilot auth to the requested agent via the locked auth-profile path", async () => {
    const { githubCopilotLoginCommand } = await import("./github-copilot-auth.js");
    const runtime = { log: vi.fn() };

    await githubCopilotLoginCommand({ agent: "ops", yes: true }, runtime as never);

    expect(resolveKnownAgentId).toHaveBeenCalledWith(
      expect.objectContaining({ rawAgentId: "ops" }),
    );
    expect(ensureAuthProfileStore).toHaveBeenCalledWith("/state/agents/ops/agent", {
      allowKeychainPrompt: false,
    });
    expect(upsertAuthProfileOrThrow).toHaveBeenCalledWith({
      profileId: "github-copilot:github",
      credential: {
        type: "token",
        provider: "github-copilot",
        token: "ghu_token",
      },
      agentDir: "/state/agents/ops/agent",
    });
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(logConfigUpdated).toHaveBeenCalledWith(runtime);
    expect(runtime.log).toHaveBeenCalledWith(
      "Auth profile: github-copilot:github (github-copilot/token)",
    );
  });

  it("keeps env agent-dir overrides for the default agent when no explicit agent is given", async () => {
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    process.env.OPENCLAW_AGENT_DIR = "/env/agent";
    resolveOpenClawAgentDir.mockReturnValue("/env/agent");

    try {
      const { githubCopilotLoginCommand } = await import("./github-copilot-auth.js");
      await githubCopilotLoginCommand({ yes: true }, { log: vi.fn() } as never);
    } finally {
      process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
    }

    expect(ensureAuthProfileStore).toHaveBeenCalledWith("/env/agent", {
      allowKeychainPrompt: false,
    });
    expect(upsertAuthProfileOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: "/env/agent" }),
    );
  });
});
