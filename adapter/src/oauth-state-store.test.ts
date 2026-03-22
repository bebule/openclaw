import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileSmartThingsOAuthStateStore,
  resolveInstalledAppStatePath,
} from "./oauth-state-store.js";

const tempDirs: string[] = [];

async function createStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "smartthings-oauth-state-"));
  tempDirs.push(root);
  return {
    env: { SMARTTHINGS_STATE_DIR: root } satisfies NodeJS.ProcessEnv,
    root,
    store: createFileSmartThingsOAuthStateStore({ SMARTTHINGS_STATE_DIR: root }),
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { force: true, recursive: true });
    }
  }
});

describe("SmartThings OAuth state store", () => {
  it("returns null when no state file exists", async () => {
    const runtime = await createStore();

    await expect(runtime.store.readInstalledAppState("app-1")).resolves.toBeNull();
  });

  it("round-trips persisted installed-app state", async () => {
    const runtime = await createStore();

    await runtime.store.writeInstalledAppState({
      authToken: "token-1",
      devices: [{ componentId: "main", deviceId: "tv-1" }],
      installedAppId: "app-1",
      lastLifecycle: "INSTALL",
      refreshToken: "refresh-token-1",
    });

    await expect(runtime.store.readInstalledAppState("app-1")).resolves.toMatchObject({
      authToken: "token-1",
      devices: [{ componentId: "main", deviceId: "tv-1" }],
      installedAppId: "app-1",
      lastLifecycle: "INSTALL",
      refreshToken: "refresh-token-1",
      version: 1,
    });
  });

  it("returns null for malformed JSON", async () => {
    const runtime = await createStore();
    const filePath = resolveInstalledAppStatePath("app-1", runtime.env);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{", "utf8");

    await expect(runtime.store.readInstalledAppState("app-1")).resolves.toBeNull();
  });

  it("overwrites state on update", async () => {
    const runtime = await createStore();

    await runtime.store.writeInstalledAppState({
      authToken: "token-1",
      devices: [{ deviceId: "tv-1" }],
      installedAppId: "app-1",
      lastLifecycle: "INSTALL",
      refreshToken: "refresh-token-1",
    });
    await runtime.store.writeInstalledAppState({
      authToken: "token-2",
      devices: [{ componentId: "main", deviceId: "tv-2" }],
      installedAppId: "app-1",
      lastLifecycle: "UPDATE",
      refreshToken: "refresh-token-2",
    });

    await expect(runtime.store.readInstalledAppState("app-1")).resolves.toMatchObject({
      authToken: "token-2",
      devices: [{ componentId: "main", deviceId: "tv-2" }],
      installedAppId: "app-1",
      lastLifecycle: "UPDATE",
      refreshToken: "refresh-token-2",
    });
  });

  it("keeps reading legacy state files that predate refresh token persistence", async () => {
    const runtime = await createStore();
    const filePath = resolveInstalledAppStatePath("app-1", runtime.env);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      `${JSON.stringify({
        authToken: "token-1",
        devices: [{ deviceId: "tv-1" }],
        installedAppId: "app-1",
        lastLifecycle: "INSTALL",
        updatedAt: "2026-03-21T00:00:00.000Z",
        version: 1,
      })}\n`,
      "utf8",
    );

    await expect(runtime.store.readInstalledAppState("app-1")).resolves.toMatchObject({
      authToken: "token-1",
      devices: [{ deviceId: "tv-1" }],
      installedAppId: "app-1",
      lastLifecycle: "INSTALL",
      version: 1,
    });
  });

  it("deletes persisted state", async () => {
    const runtime = await createStore();

    await runtime.store.writeInstalledAppState({
      authToken: "token-1",
      devices: [{ deviceId: "tv-1" }],
      installedAppId: "app-1",
    });
    await runtime.store.deleteInstalledAppState("app-1");

    await expect(runtime.store.readInstalledAppState("app-1")).resolves.toBeNull();
  });
});
