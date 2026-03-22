import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;

export type PersistedSmartThingsDeviceSelection = {
  attribute?: string;
  capability?: string;
  componentId?: string;
  deviceId: string;
  stateChangeOnly?: boolean;
  subscriptionName?: string;
  value?: unknown;
};

export type PersistedSmartThingsInstalledAppState = {
  authToken: string;
  devices: PersistedSmartThingsDeviceSelection[];
  installedAppId: string;
  lastLifecycle?: "INSTALL" | "UPDATE";
  refreshToken?: string;
  updatedAt: string;
  version: 1;
};

export type SmartThingsOAuthStateStore = {
  deleteInstalledAppState(installedAppId: string): Promise<void>;
  readInstalledAppState(
    installedAppId: string,
  ): Promise<PersistedSmartThingsInstalledAppState | null>;
  writeInstalledAppState(
    state: Omit<PersistedSmartThingsInstalledAppState, "updatedAt" | "version"> & {
      updatedAt?: string;
    },
  ): Promise<void>;
};

export function createFileSmartThingsOAuthStateStore(
  env: NodeJS.ProcessEnv = process.env,
): SmartThingsOAuthStateStore {
  return {
    async deleteInstalledAppState(installedAppId) {
      const filePath = resolveInstalledAppStatePath(installedAppId, env);
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") {
          throw error;
        }
      }
    },
    async readInstalledAppState(installedAppId) {
      const filePath = resolveInstalledAppStatePath(installedAppId, env);
      try {
        const raw = await fs.readFile(filePath, "utf8");
        return safeParseInstalledAppState(raw);
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") {
          return null;
        }
        return null;
      }
    },
    async writeInstalledAppState(state) {
      const filePath = resolveInstalledAppStatePath(state.installedAppId, env);
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const tempPath = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
      const payload: PersistedSmartThingsInstalledAppState = {
        authToken: state.authToken,
        devices: state.devices,
        installedAppId: state.installedAppId,
        ...(state.lastLifecycle ? { lastLifecycle: state.lastLifecycle } : {}),
        ...(state.refreshToken ? { refreshToken: state.refreshToken } : {}),
        updatedAt: state.updatedAt ?? new Date().toISOString(),
        version: STORE_VERSION,
      };
      await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8" });
      await fs.chmod(tempPath, 0o600);
      await fs.rename(tempPath, filePath);
    },
  };
}

export function resolveInstalledAppStatePath(
  installedAppId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    resolveSmartThingsStateDir(env),
    `installed-app-${sanitizeInstalledAppId(installedAppId)}.json`,
  );
}

function resolveSmartThingsStateDir(env: NodeJS.ProcessEnv): string {
  const override = env.SMARTTHINGS_STATE_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.resolve(process.cwd(), ".smartthings-state");
}

function sanitizeInstalledAppId(installedAppId: string): string {
  return installedAppId.trim().replace(/[^a-z0-9._-]+/gi, "_");
}

function safeParseInstalledAppState(raw: string): PersistedSmartThingsInstalledAppState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSmartThingsInstalledAppState>;
    if (parsed?.version !== STORE_VERSION) {
      return null;
    }
    if (typeof parsed.installedAppId !== "string" || typeof parsed.authToken !== "string") {
      return null;
    }
    return {
      authToken: parsed.authToken,
      devices: Array.isArray(parsed.devices)
        ? parsed.devices.filter(isPersistedDeviceSelection)
        : [],
      installedAppId: parsed.installedAppId,
      ...(parsed.lastLifecycle === "INSTALL" || parsed.lastLifecycle === "UPDATE"
        ? { lastLifecycle: parsed.lastLifecycle }
        : {}),
      ...(typeof parsed.refreshToken === "string" && parsed.refreshToken.length > 0
        ? { refreshToken: parsed.refreshToken }
        : {}),
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      version: STORE_VERSION,
    };
  } catch {
    return null;
  }
}

function isPersistedDeviceSelection(value: unknown): value is PersistedSmartThingsDeviceSelection {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { deviceId?: unknown }).deviceId === "string"
  );
}
