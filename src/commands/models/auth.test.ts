import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  clackCancel: vi.fn(),
  clackConfirm: vi.fn(),
  clackIsCancel: vi.fn((value: unknown) => value === Symbol.for("clack:cancel")),
  clackSelect: vi.fn(),
  clackText: vi.fn(),
  resolveOpenClawAgentDir: vi.fn(),
  listAgentIds: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  resolveAgentDir: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentWorkspaceDir: vi.fn(),
  upsertAuthProfileOrThrow: vi.fn(),
  resolvePluginProviders: vi.fn(),
  createClackPrompter: vi.fn(),
  loginOpenAICodexOAuth: vi.fn(),
  writeOAuthCredentials: vi.fn(),
  loadValidConfigOrThrow: vi.fn(),
  updateConfig: vi.fn(),
  logConfigUpdated: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  cancel: mocks.clackCancel,
  confirm: mocks.clackConfirm,
  isCancel: mocks.clackIsCancel,
  select: mocks.clackSelect,
  text: mocks.clackText,
}));

vi.mock("../../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: mocks.resolveOpenClawAgentDir,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: mocks.listAgentIds,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: mocks.resolveDefaultAgentWorkspaceDir,
}));

vi.mock("../auth-profile-write.js", () => ({
  upsertAuthProfileOrThrow: mocks.upsertAuthProfileOrThrow,
}));

vi.mock("../../plugins/providers.js", () => ({
  resolvePluginProviders: mocks.resolvePluginProviders,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("../openai-codex-oauth.js", () => ({
  loginOpenAICodexOAuth: mocks.loginOpenAICodexOAuth,
}));

vi.mock("../onboard-auth.js", async (importActual) => {
  const actual = await importActual<typeof import("../onboard-auth.js")>();
  return {
    ...actual,
    writeOAuthCredentials: mocks.writeOAuthCredentials,
  };
});

vi.mock("./shared.js", async (importActual) => {
  const actual = await importActual<typeof import("./shared.js")>();
  return {
    ...actual,
    loadValidConfigOrThrow: mocks.loadValidConfigOrThrow,
    updateConfig: mocks.updateConfig,
  };
});

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../onboard-helpers.js", () => ({
  openUrl: mocks.openUrl,
}));

const { modelsAuthLoginCommand, modelsAuthPasteTokenCommand } = await import("./auth.js");

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function withInteractiveStdin() {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const hadOwnIsTTY = Object.prototype.hasOwnProperty.call(stdin, "isTTY");
  const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    enumerable: true,
    get: () => true,
  });
  return () => {
    if (previousIsTTYDescriptor) {
      Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
    } else if (!hadOwnIsTTY) {
      delete (stdin as { isTTY?: boolean }).isTTY;
    }
  };
}

function restoreEnv(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("modelsAuthLoginCommand", () => {
  let restoreStdin: (() => void) | null = null;
  let currentConfig: OpenClawConfig;
  let lastUpdatedConfig: OpenClawConfig | null;

  beforeEach(() => {
    vi.clearAllMocks();
    restoreStdin = withInteractiveStdin();
    currentConfig = {};
    lastUpdatedConfig = null;
    mocks.clackCancel.mockReset();
    mocks.clackConfirm.mockReset();
    mocks.clackIsCancel.mockImplementation(
      (value: unknown) => value === Symbol.for("clack:cancel"),
    );
    mocks.clackSelect.mockReset();
    mocks.clackText.mockReset();
    mocks.resolveOpenClawAgentDir.mockReset();
    mocks.listAgentIds.mockReset();
    mocks.upsertAuthProfileOrThrow.mockReset();

    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.resolveOpenClawAgentDir.mockReturnValue("/tmp/openclaw/agents/main");
    mocks.resolveAgentDir.mockReturnValue("/tmp/openclaw/agents/main");
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.resolveDefaultAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.loadValidConfigOrThrow.mockImplementation(async () => currentConfig);
    mocks.updateConfig.mockImplementation(
      async (mutator: (cfg: OpenClawConfig) => OpenClawConfig) => {
        lastUpdatedConfig = mutator(currentConfig);
        currentConfig = lastUpdatedConfig;
        return lastUpdatedConfig;
      },
    );
    mocks.createClackPrompter.mockReturnValue({
      note: vi.fn(async () => {}),
      select: vi.fn(),
    });
    mocks.loginOpenAICodexOAuth.mockResolvedValue({
      type: "oauth",
      provider: "openai-codex",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      email: "user@example.com",
    });
    mocks.writeOAuthCredentials.mockResolvedValue("openai-codex:user@example.com");
    mocks.resolvePluginProviders.mockReturnValue([]);
  });

  afterEach(() => {
    restoreStdin?.();
    restoreStdin = null;
  });

  it("supports built-in openai-codex login without provider plugins", async () => {
    const runtime = createRuntime();

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);

    expect(mocks.loginOpenAICodexOAuth).toHaveBeenCalledOnce();
    expect(mocks.writeOAuthCredentials).toHaveBeenCalledWith(
      "openai-codex",
      expect.any(Object),
      "/tmp/openclaw/agents/main",
      { syncSiblingAgents: true },
    );
    expect(mocks.resolvePluginProviders).not.toHaveBeenCalled();
    expect(lastUpdatedConfig?.auth?.profiles?.["openai-codex:user@example.com"]).toMatchObject({
      provider: "openai-codex",
      mode: "oauth",
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "Auth profile: openai-codex:user@example.com (openai-codex/oauth)",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Default model available: openai-codex/gpt-5.4 (use --set-default to apply)",
    );
  });

  it("ignores ambient env agent-dir redirects without docker helper targeting", async () => {
    const runtime = createRuntime();
    mocks.resolveDefaultAgentId.mockReturnValue("ops");
    mocks.listAgentIds.mockReturnValue(["ops"]);
    mocks.resolveOpenClawAgentDir.mockReturnValue("/env/agents/ops");
    mocks.resolveAgentDir.mockImplementation(
      (_cfg: OpenClawConfig, agentId: string) => `/config/agents/${agentId}`,
    );

    const previous = {
      OPENCLAW_AGENT_DIR: process.env.OPENCLAW_AGENT_DIR,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      OPENCLAW_DOCKER_AUTH_AGENT_ID: process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID,
    };
    process.env.OPENCLAW_AGENT_DIR = "/env/agents/ops";
    process.env.PI_CODING_AGENT_DIR = "/env/agents/ops";
    delete process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID;
    try {
      await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);
    } finally {
      restoreEnv(previous);
    }

    expect(mocks.writeOAuthCredentials).toHaveBeenCalledWith(
      "openai-codex",
      expect.any(Object),
      "/config/agents/ops",
      { syncSiblingAgents: true },
    );
  });

  it("uses docker helper agent-dir redirects for the implicit default agent", async () => {
    const runtime = createRuntime();
    mocks.resolveDefaultAgentId.mockReturnValue("ops");
    mocks.listAgentIds.mockReturnValue(["ops"]);
    mocks.resolveOpenClawAgentDir.mockReturnValue("/env/agents/ops");
    mocks.resolveAgentDir.mockImplementation(
      (_cfg: OpenClawConfig, agentId: string) => `/config/agents/${agentId}`,
    );

    const previous = {
      OPENCLAW_AGENT_DIR: process.env.OPENCLAW_AGENT_DIR,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      OPENCLAW_DOCKER_AUTH_AGENT_ID: process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID,
    };
    process.env.OPENCLAW_AGENT_DIR = "/env/agents/ops";
    process.env.PI_CODING_AGENT_DIR = "/env/agents/ops";
    process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID = "ops";
    try {
      await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);
    } finally {
      restoreEnv(previous);
    }

    expect(mocks.writeOAuthCredentials).toHaveBeenCalledWith(
      "openai-codex",
      expect.any(Object),
      "/env/agents/ops",
      { syncSiblingAgents: true },
    );
  });

  it("lets explicit --agent override ambient env agent-dir redirects", async () => {
    const runtime = createRuntime();
    mocks.resolveDefaultAgentId.mockReturnValue("ops");
    mocks.listAgentIds.mockReturnValue(["ops"]);
    mocks.resolveOpenClawAgentDir.mockReturnValue("/env/agents/ops");
    mocks.resolveAgentDir.mockImplementation(
      (_cfg: OpenClawConfig, agentId: string) => `/config/agents/${agentId}`,
    );

    const previous = {
      OPENCLAW_AGENT_DIR: process.env.OPENCLAW_AGENT_DIR,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      OPENCLAW_DOCKER_AUTH_AGENT_ID: process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID,
    };
    process.env.OPENCLAW_AGENT_DIR = "/env/agents/ops";
    process.env.PI_CODING_AGENT_DIR = "/env/agents/ops";
    delete process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID;
    try {
      await modelsAuthLoginCommand({ provider: "openai-codex", agent: "ops" }, runtime);
    } finally {
      restoreEnv(previous);
    }

    expect(mocks.writeOAuthCredentials).toHaveBeenCalledWith(
      "openai-codex",
      expect.any(Object),
      "/config/agents/ops",
      { syncSiblingAgents: true },
    );
  });

  it("applies openai-codex default model when --set-default is used", async () => {
    const runtime = createRuntime();

    await modelsAuthLoginCommand({ provider: "openai-codex", setDefault: true }, runtime);

    expect(lastUpdatedConfig?.agents?.defaults?.model).toEqual({
      primary: "openai-codex/gpt-5.4",
    });
    expect(runtime.log).toHaveBeenCalledWith("Default model set to openai-codex/gpt-5.4");
  });

  it("keeps existing plugin error behavior for non built-in providers", async () => {
    const runtime = createRuntime();

    await expect(modelsAuthLoginCommand({ provider: "anthropic" }, runtime)).rejects.toThrow(
      "No provider plugins found.",
    );
  });

  it("does not persist a cancelled manual token entry", async () => {
    const runtime = createRuntime();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${String(code ?? "")}`);
    }) as typeof process.exit);
    try {
      const cancelSymbol = Symbol.for("clack:cancel");
      mocks.clackText.mockResolvedValue(cancelSymbol);
      mocks.clackIsCancel.mockImplementation((value: unknown) => value === cancelSymbol);

      await expect(modelsAuthPasteTokenCommand({ provider: "openai" }, runtime)).rejects.toThrow(
        "exit:0",
      );

      expect(mocks.upsertAuthProfileOrThrow).not.toHaveBeenCalled();
      expect(mocks.updateConfig).not.toHaveBeenCalled();
      expect(mocks.logConfigUpdated).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("uses docker helper overrides for a non-default agent target", async () => {
    const runtime = createRuntime();
    const note = vi.fn(async () => {});
    const select = vi.fn().mockResolvedValue("oauth");
    const providerRun = vi.fn().mockResolvedValue({
      profiles: [
        {
          profileId: "example:user@example.com",
          credential: {
            type: "oauth",
            provider: "example",
            email: "user@example.com",
            access: "token",
          },
        },
      ],
      defaultModel: "example/model",
    });
    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.resolveOpenClawAgentDir.mockReturnValue("/docker/agents/ops/agent");
    mocks.resolveAgentDir.mockImplementation(
      (_cfg: OpenClawConfig, agentId: string) => `/config/agents/${agentId}`,
    );
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/config/workspaces/ops");
    mocks.createClackPrompter.mockReturnValue({ note, select });
    mocks.resolvePluginProviders.mockReturnValue([
      {
        id: "example",
        label: "Example",
        auth: [{ id: "oauth", label: "OAuth", run: providerRun }],
      },
    ]);

    const previous = {
      OPENCLAW_DOCKER_AUTH_AGENT_ID: process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID,
      OPENCLAW_WORKSPACE_DIR: process.env.OPENCLAW_WORKSPACE_DIR,
    };
    process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID = "ops";
    process.env.OPENCLAW_WORKSPACE_DIR = "/docker/workspace";
    try {
      await modelsAuthLoginCommand({ provider: "example", agent: "ops" }, runtime);
    } finally {
      if (previous.OPENCLAW_DOCKER_AUTH_AGENT_ID === undefined) {
        delete process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID;
      } else {
        process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID = previous.OPENCLAW_DOCKER_AUTH_AGENT_ID;
      }
      if (previous.OPENCLAW_WORKSPACE_DIR === undefined) {
        delete process.env.OPENCLAW_WORKSPACE_DIR;
      } else {
        process.env.OPENCLAW_WORKSPACE_DIR = previous.OPENCLAW_WORKSPACE_DIR;
      }
    }

    expect(mocks.resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/docker/workspace",
      }),
    );
    expect(providerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/docker/agents/ops/agent",
        workspaceDir: "/docker/workspace",
      }),
    );
    expect(mocks.upsertAuthProfileOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/docker/agents/ops/agent",
      }),
    );
  });

  it("falls back to the non-default agent workspace when no docker workspace override is set", async () => {
    const runtime = createRuntime();
    const note = vi.fn(async () => {});
    const select = vi.fn().mockResolvedValue("oauth");
    const providerRun = vi.fn().mockResolvedValue({
      profiles: [
        {
          profileId: "example:user@example.com",
          credential: {
            type: "oauth",
            provider: "example",
            email: "user@example.com",
            access: "token",
          },
        },
      ],
      defaultModel: "example/model",
    });
    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.resolveOpenClawAgentDir.mockReturnValue("/docker/agents/ops/agent");
    mocks.resolveAgentDir.mockImplementation(
      (_cfg: OpenClawConfig, agentId: string) => `/config/agents/${agentId}`,
    );
    mocks.resolveAgentWorkspaceDir.mockImplementation(
      (_cfg: OpenClawConfig, agentId: string) => `/config/workspaces/${agentId}`,
    );
    mocks.createClackPrompter.mockReturnValue({ note, select });
    mocks.resolvePluginProviders.mockReturnValue([
      {
        id: "example",
        label: "Example",
        auth: [{ id: "oauth", label: "OAuth", run: providerRun }],
      },
    ]);

    const previous = {
      OPENCLAW_DOCKER_AUTH_AGENT_ID: process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID,
      OPENCLAW_WORKSPACE_DIR: process.env.OPENCLAW_WORKSPACE_DIR,
    };
    process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID = "ops";
    delete process.env.OPENCLAW_WORKSPACE_DIR;
    try {
      await modelsAuthLoginCommand({ provider: "example", agent: "ops" }, runtime);
    } finally {
      if (previous.OPENCLAW_DOCKER_AUTH_AGENT_ID === undefined) {
        delete process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID;
      } else {
        process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID = previous.OPENCLAW_DOCKER_AUTH_AGENT_ID;
      }
      if (previous.OPENCLAW_WORKSPACE_DIR === undefined) {
        delete process.env.OPENCLAW_WORKSPACE_DIR;
      } else {
        process.env.OPENCLAW_WORKSPACE_DIR = previous.OPENCLAW_WORKSPACE_DIR;
      }
    }

    expect(mocks.resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/config/workspaces/ops",
      }),
    );
    expect(providerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/docker/agents/ops/agent",
        workspaceDir: "/config/workspaces/ops",
      }),
    );
  });

  it("lets explicit --agent override default-agent env redirects", async () => {
    const runtime = createRuntime();
    const note = vi.fn(async () => {});
    const select = vi.fn().mockResolvedValue("oauth");
    const providerRun = vi.fn().mockResolvedValue({
      profiles: [
        {
          profileId: "example:user@example.com",
          credential: {
            type: "oauth",
            provider: "example",
            email: "user@example.com",
            access: "token",
          },
        },
      ],
      defaultModel: "example/model",
    });
    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.resolveOpenClawAgentDir.mockReturnValue("/env/agents/main/agent");
    mocks.resolveAgentDir.mockImplementation(
      (_cfg: OpenClawConfig, agentId: string) => `/config/agents/${agentId}`,
    );
    mocks.resolveAgentWorkspaceDir.mockImplementation(
      (_cfg: OpenClawConfig, agentId: string) => `/config/workspaces/${agentId}`,
    );
    mocks.createClackPrompter.mockReturnValue({ note, select });
    mocks.resolvePluginProviders.mockReturnValue([
      {
        id: "example",
        label: "Example",
        auth: [{ id: "oauth", label: "OAuth", run: providerRun }],
      },
    ]);

    const previous = {
      OPENCLAW_AGENT_DIR: process.env.OPENCLAW_AGENT_DIR,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      OPENCLAW_DOCKER_AUTH_AGENT_ID: process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID,
    };
    process.env.OPENCLAW_AGENT_DIR = "/env/agents/main/agent";
    process.env.PI_CODING_AGENT_DIR = "/env/agents/main/agent";
    delete process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID;
    try {
      await modelsAuthLoginCommand({ provider: "example", agent: "main" }, runtime);
    } finally {
      if (previous.OPENCLAW_AGENT_DIR === undefined) {
        delete process.env.OPENCLAW_AGENT_DIR;
      } else {
        process.env.OPENCLAW_AGENT_DIR = previous.OPENCLAW_AGENT_DIR;
      }
      if (previous.PI_CODING_AGENT_DIR === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previous.PI_CODING_AGENT_DIR;
      }
      if (previous.OPENCLAW_DOCKER_AUTH_AGENT_ID === undefined) {
        delete process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID;
      } else {
        process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID = previous.OPENCLAW_DOCKER_AUTH_AGENT_ID;
      }
    }

    expect(mocks.resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/config/workspaces/main",
      }),
    );
    expect(providerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/config/agents/main",
        workspaceDir: "/config/workspaces/main",
      }),
    );
    expect(mocks.upsertAuthProfileOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/config/agents/main",
      }),
    );
  });
});

describe("docker-host-model-auth.sh", () => {
  it("defaults to the configured default agent and its workspace path", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-docker-auth-"));
    const stateDir = path.join(tempDir, "state");
    const binDir = path.join(tempDir, "bin");
    const capturePath = path.join(tempDir, "capture.json");
    const invocationsPath = path.join(tempDir, "invocations.jsonl");
    const fakePnpmPath = path.join(binDir, "pnpm");
    await fs.mkdir(path.join(stateDir, "agents", "ops", "agent"), { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      fakePnpmPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.INVOCATIONS_PATH, JSON.stringify(args) + "\\n");
if (args[0] === "openclaw" && args[1] === "agents" && args[2] === "list" && args[3] === "--json") {
  process.stdout.write(JSON.stringify([{ id: "ops", isDefault: true }]));
  process.exit(0);
}
fs.writeFileSync(
  process.env.CAPTURE_PATH,
  JSON.stringify(
    {
      args,
      agentId: process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID,
      workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR,
      agentDir: process.env.OPENCLAW_AGENT_DIR,
      piAgentDir: process.env.PI_CODING_AGENT_DIR,
      configPath: process.env.OPENCLAW_CONFIG_PATH,
    },
    null,
    2,
  ),
);
`,
      "utf8",
    );
    await fs.chmod(fakePnpmPath, 0o755);

    const result = spawnSync(
      "bash",
      ["scripts/docker-host-model-auth.sh", "login", "--provider", "openai-codex"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_CONFIG_DIR: stateDir,
          CAPTURE_PATH: capturePath,
          INVOCATIONS_PATH: invocationsPath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(await fs.readFile(capturePath, "utf8"))).toEqual({
      args: ["openclaw", "models", "auth", "--agent", "ops", "login", "--provider", "openai-codex"],
      agentId: "ops",
      workspaceDir: path.join(stateDir, "workspace-ops"),
      agentDir: path.join(stateDir, "agents", "ops", "agent"),
      piAgentDir: path.join(stateDir, "agents", "ops", "agent"),
      configPath: path.join(stateDir, "openclaw.json"),
    });
    expect((await fs.readFile(invocationsPath, "utf8")).trim().split("\n")).toHaveLength(2);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("overrides ambient agent-dir env vars to keep helper writes inside OPENCLAW_CONFIG_DIR", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-docker-auth-"));
    const stateDir = path.join(tempDir, "state");
    const binDir = path.join(tempDir, "bin");
    const capturePath = path.join(tempDir, "capture.json");
    const fakePnpmPath = path.join(binDir, "pnpm");
    await fs.mkdir(path.join(stateDir, "agents", "ops", "agent"), { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      fakePnpmPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "openclaw" && args[1] === "agents" && args[2] === "list" && args[3] === "--json") {
  process.stdout.write(JSON.stringify([{ id: "ops", isDefault: true }]));
  process.exit(0);
}
fs.writeFileSync(
  process.env.CAPTURE_PATH,
  JSON.stringify(
    {
      agentDir: process.env.OPENCLAW_AGENT_DIR,
      piAgentDir: process.env.PI_CODING_AGENT_DIR,
    },
    null,
    2,
  ),
);
`,
      "utf8",
    );
    await fs.chmod(fakePnpmPath, 0o755);

    const result = spawnSync("bash", ["scripts/docker-host-model-auth.sh", "login"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_CONFIG_DIR: stateDir,
        OPENCLAW_AGENT_DIR: "/outside/openclaw-agent",
        PI_CODING_AGENT_DIR: "/outside/pi-agent",
        CAPTURE_PATH: capturePath,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(await fs.readFile(capturePath, "utf8"))).toEqual({
      agentDir: path.join(stateDir, "agents", "ops", "agent"),
      piAgentDir: path.join(stateDir, "agents", "ops", "agent"),
    });

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("falls back to main when default-agent lookup fails", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-docker-auth-"));
    const stateDir = path.join(tempDir, "state");
    const binDir = path.join(tempDir, "bin");
    const capturePath = path.join(tempDir, "capture.json");
    const invocationsPath = path.join(tempDir, "invocations.jsonl");
    const fakePnpmPath = path.join(binDir, "pnpm");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      fakePnpmPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.INVOCATIONS_PATH, JSON.stringify(args) + "\\n");
if (args[0] === "openclaw" && args[1] === "agents" && args[2] === "list" && args[3] === "--json") {
  process.exit(23);
}
fs.writeFileSync(
  process.env.CAPTURE_PATH,
  JSON.stringify(
    {
      args,
      agentId: process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID,
      workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR,
      agentDir: process.env.OPENCLAW_AGENT_DIR,
      piAgentDir: process.env.PI_CODING_AGENT_DIR,
      configPath: process.env.OPENCLAW_CONFIG_PATH,
    },
    null,
    2,
  ),
);
`,
      "utf8",
    );
    await fs.chmod(fakePnpmPath, 0o755);

    const result = spawnSync(
      "bash",
      ["scripts/docker-host-model-auth.sh", "login", "--provider", "openai-codex"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_CONFIG_DIR: stateDir,
          CAPTURE_PATH: capturePath,
          INVOCATIONS_PATH: invocationsPath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(await fs.readFile(capturePath, "utf8"))).toEqual({
      args: [
        "openclaw",
        "models",
        "auth",
        "--agent",
        "main",
        "login",
        "--provider",
        "openai-codex",
      ],
      agentId: "main",
      workspaceDir: path.join(stateDir, "workspace"),
      agentDir: path.join(stateDir, "agents", "main", "agent"),
      piAgentDir: path.join(stateDir, "agents", "main", "agent"),
      configPath: path.join(stateDir, "openclaw.json"),
    });
    expect((await fs.readFile(invocationsPath, "utf8")).trim().split("\n")).toHaveLength(2);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("preserves explicit docker auth agent and workspace overrides", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-docker-auth-"));
    const stateDir = path.join(tempDir, "state");
    const binDir = path.join(tempDir, "bin");
    const capturePath = path.join(tempDir, "capture.json");
    const invocationsPath = path.join(tempDir, "invocations.jsonl");
    const fakePnpmPath = path.join(binDir, "pnpm");
    await fs.mkdir(path.join(stateDir, "agents", "custom", "agent"), { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      fakePnpmPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.INVOCATIONS_PATH, JSON.stringify(args) + "\\n");
if (args[0] === "openclaw" && args[1] === "agents" && args[2] === "list" && args[3] === "--json") {
  process.stdout.write(JSON.stringify([{ id: "ops", isDefault: true }]));
  process.exit(0);
}
fs.writeFileSync(
  process.env.CAPTURE_PATH,
  JSON.stringify(
    {
      args,
      agentId: process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID,
      workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR,
      agentDir: process.env.OPENCLAW_AGENT_DIR,
      piAgentDir: process.env.PI_CODING_AGENT_DIR,
      configPath: process.env.OPENCLAW_CONFIG_PATH,
    },
    null,
    2,
  ),
);
`,
      "utf8",
    );
    await fs.chmod(fakePnpmPath, 0o755);

    const result = spawnSync("bash", ["scripts/docker-host-model-auth.sh", "login"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_CONFIG_DIR: stateDir,
        OPENCLAW_DOCKER_AUTH_AGENT_ID: "custom",
        OPENCLAW_WORKSPACE_DIR: "/custom/workspace",
        CAPTURE_PATH: capturePath,
        INVOCATIONS_PATH: invocationsPath,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(await fs.readFile(capturePath, "utf8"))).toEqual({
      args: ["openclaw", "models", "auth", "--agent", "custom", "login"],
      agentId: "custom",
      workspaceDir: "/custom/workspace",
      agentDir: path.join(stateDir, "agents", "custom", "agent"),
      piAgentDir: path.join(stateDir, "agents", "custom", "agent"),
      configPath: path.join(stateDir, "openclaw.json"),
    });
    expect((await fs.readFile(invocationsPath, "utf8")).trim().split("\n")).toHaveLength(1);

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
