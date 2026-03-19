import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
  resolveConfigPath: vi.fn(),
  withFileLock: vi.fn(
    async (_path: string, _options: unknown, fn: () => Promise<unknown>) => await fn(),
  ),
  writeConfigFile: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
  readConfigFileSnapshotForWrite: (...args: unknown[]) =>
    mocks.readConfigFileSnapshotForWrite(...args),
  resolveConfigPath: (...args: unknown[]) => mocks.resolveConfigPath(...args),
  writeConfigFile: (...args: unknown[]) => mocks.writeConfigFile(...args),
}));

vi.mock("../../infra/file-lock.js", () => ({
  withFileLock: mocks.withFileLock,
}));

import { loadValidConfigOrThrow, updateConfig } from "./shared.js";

describe("models/shared", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockClear();
    mocks.readConfigFileSnapshotForWrite.mockClear();
    mocks.resolveConfigPath.mockClear();
    mocks.withFileLock.mockClear();
    mocks.writeConfigFile.mockClear();
    mocks.resolveConfigPath.mockReturnValue("/tmp/openclaw.json");
  });

  it("returns config when snapshot is valid", async () => {
    const cfg = { providers: {} } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: cfg,
    });

    await expect(loadValidConfigOrThrow()).resolves.toBe(cfg);
  });

  it("throws formatted issues when snapshot is invalid", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: false,
      path: "/tmp/openclaw.json",
      issues: [{ path: "providers.openai.apiKey", message: "Required" }],
    });

    await expect(loadValidConfigOrThrow()).rejects.toThrowError(
      "Invalid config at /tmp/openclaw.json\n- providers.openai.apiKey: Required",
    );
  });

  it("updateConfig writes mutated config", async () => {
    const cfg = { update: { channel: "stable" } } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        valid: true,
        path: "/tmp/openclaw.json",
        config: cfg,
      },
      writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
    });
    mocks.writeConfigFile.mockResolvedValue(undefined);

    await updateConfig((current) => ({
      ...current,
      update: { channel: "beta" },
    }));

    expect(mocks.withFileLock).toHaveBeenCalledWith(
      "/tmp/openclaw.json",
      expect.any(Object),
      expect.any(Function),
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { channel: "beta" },
      }),
      { expectedConfigPath: "/tmp/openclaw.json" },
    );
  });
});
