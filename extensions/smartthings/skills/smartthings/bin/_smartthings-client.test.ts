import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildCommandInvocation,
  normalizeJsonArgs,
  readAdapterConfig,
  SmartThingsCliError,
} from "./_smartthings-client.js";

describe("smartthings helper client", () => {
  it("reads adapter config from environment variables", () => {
    vi.stubEnv("SMARTTHINGS_ADAPTER_URL", "http://127.0.0.1:8787");
    vi.stubEnv("SMARTTHINGS_ADAPTER_TOKEN", "token-123");

    expect(readAdapterConfig()).toEqual({
      adapterToken: "token-123",
      adapterUrl: "http://127.0.0.1:8787/",
      timeoutMs: 10_000,
    });
  });

  it("rejects an invalid adapter URL", () => {
    vi.stubEnv("SMARTTHINGS_ADAPTER_URL", "not-a-url");

    expect(() => readAdapterConfig()).toThrow(SmartThingsCliError);
  });

  it("falls back to plugins.entries.smartthings.config from openclaw.json", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-smartthings-config-"));
    const configPath = path.join(configDir, "openclaw.json");
    await fs.writeFile(
      configPath,
      `{
        plugins: {
          entries: {
            smartthings: {
              config: {
                adapterUrl: "https://gateway.example.test/openclaw",
                adapterToken: "plugin-token",
              },
            },
          },
        },
      }`,
      "utf8",
    );
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);

    try {
      expect(readAdapterConfig()).toEqual({
        adapterToken: "plugin-token",
        adapterUrl: "https://gateway.example.test/openclaw/",
        timeoutMs: 10_000,
      });
    } finally {
      await fs.rm(configDir, { force: true, recursive: true });
    }
  });

  it("falls back to skills.entries.smartthings.env when plugin config is absent", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-smartthings-skill-env-"));
    const configPath = path.join(configDir, "openclaw.json");
    await fs.writeFile(
      configPath,
      `{
        skills: {
          entries: {
            smartthings: {
              env: {
                SMARTTHINGS_ADAPTER_URL: "http://skill-env.example.test:9000",
                SMARTTHINGS_ADAPTER_TOKEN: "skill-token",
              },
            },
          },
        },
      }`,
      "utf8",
    );
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);

    try {
      expect(readAdapterConfig()).toEqual({
        adapterToken: "skill-token",
        adapterUrl: "http://skill-env.example.test:9000/",
        timeoutMs: 10_000,
      });
    } finally {
      await fs.rm(configDir, { force: true, recursive: true });
    }
  });

  it("prefers explicit environment variables over plugin config fallback", async () => {
    const configDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-smartthings-env-priority-"),
    );
    const configPath = path.join(configDir, "openclaw.json");
    await fs.writeFile(
      configPath,
      `{
        plugins: {
          entries: {
            smartthings: {
              config: {
                adapterUrl: "http://plugin-config.example.test:8787",
                adapterToken: "plugin-token",
              },
            },
          },
        },
      }`,
      "utf8",
    );
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("SMARTTHINGS_ADAPTER_URL", "http://env.example.test:8123");
    vi.stubEnv("SMARTTHINGS_ADAPTER_TOKEN", "env-token");

    try {
      expect(readAdapterConfig()).toEqual({
        adapterToken: "env-token",
        adapterUrl: "http://env.example.test:8123/",
        timeoutMs: 10_000,
      });
    } finally {
      await fs.rm(configDir, { force: true, recursive: true });
    }
  });

  it("falls back to OPENCLAW_STATE_DIR/openclaw.json when no explicit config path is set", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-smartthings-state-dir-"));
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(
      configPath,
      `{
        plugins: {
          entries: {
            smartthings: {
              config: {
                adapterUrl: "http://state-dir.example.test:8787",
              },
            },
          },
        },
      }`,
      "utf8",
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    try {
      expect(readAdapterConfig()).toEqual({
        adapterToken: null,
        adapterUrl: "http://state-dir.example.test:8787/",
        timeoutMs: 10_000,
      });
    } finally {
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  it("falls back to OPENCLAW_HOME/.openclaw/openclaw.json when state overrides are unset", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-smartthings-home-dir-"));
    const stateDir = path.join(homeDir, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      `{
        plugins: {
          entries: {
            smartthings: {
              config: {
                adapterUrl: "https://home-dir.example.test/openclaw",
              },
            },
          },
        },
      }`,
      "utf8",
    );
    vi.stubEnv("OPENCLAW_HOME", homeDir);

    try {
      expect(readAdapterConfig()).toEqual({
        adapterToken: null,
        adapterUrl: "https://home-dir.example.test/openclaw/",
        timeoutMs: 10_000,
      });
    } finally {
      await fs.rm(homeDir, { force: true, recursive: true });
    }
  });

  it("ignores malformed config fallback when adapter URL is already provided by env", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-smartthings-bad-config-"));
    const configPath = path.join(configDir, "openclaw.json");
    await fs.writeFile(configPath, "{", "utf8");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("SMARTTHINGS_ADAPTER_URL", "http://env-only.example.test:8787");

    try {
      expect(readAdapterConfig()).toEqual({
        adapterToken: null,
        adapterUrl: "http://env-only.example.test:8787/",
        timeoutMs: 10_000,
      });
    } finally {
      await fs.rm(configDir, { force: true, recursive: true });
    }
  });

  it("parses a simple device command invocation", () => {
    expect(buildCommandInvocation(["tv-1", "switch", "on"])).toEqual({
      capability: "switch",
      command: "on",
      deviceId: "tv-1",
    });
  });

  it("distinguishes command arguments from an explicit component name", () => {
    expect(buildCommandInvocation(["tv-1", "audioVolume", "setVolume", "[15]"])).toEqual({
      arguments: [15],
      capability: "audioVolume",
      command: "setVolume",
      deviceId: "tv-1",
    });

    expect(buildCommandInvocation(["tv-1", "sub", "switch", "on"])).toEqual({
      capability: "switch",
      command: "on",
      component: "sub",
      deviceId: "tv-1",
    });
  });

  it("parses component-scoped commands with JSON arguments", () => {
    expect(
      buildCommandInvocation(["tv-1", "sub", "mediaInputSource", "setInputSource", '["HDMI1"]']),
    ).toEqual({
      arguments: ["HDMI1"],
      capability: "mediaInputSource",
      command: "setInputSource",
      component: "sub",
      deviceId: "tv-1",
    });
  });

  it("raises a CLI error for malformed JSON arguments", () => {
    expect(() => normalizeJsonArgs("{")).toThrow(SmartThingsCliError);
  });
});
