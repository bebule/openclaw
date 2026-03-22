#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";

const DEFAULT_ADAPTER_URL = "http://127.0.0.1:8787";
const LEGACY_CONFIG_FILENAMES = ["openclaw.json", "clawdbot.json", "moldbot.json", "moltbot.json"];
const LEGACY_STATE_DIRNAMES = [".openclaw", ".clawdbot", ".moldbot", ".moltbot"];
const REQUEST_TIMEOUT_MS = 10_000;
const SKILL_KEY = "smartthings";

export class SmartThingsCliError extends Error {
  constructor(message) {
    super(message);
    this.name = "SmartThingsCliError";
  }
}

export function readAdapterConfig() {
  const envUrl = trimToNull(process.env.SMARTTHINGS_ADAPTER_URL);
  const envToken = trimToNull(process.env.SMARTTHINGS_ADAPTER_TOKEN);
  const resolvedConfig = loadSmartThingsConfigFallback({ strict: !envUrl });
  const rawUrl =
    envUrl ??
    trimToNull(resolvedConfig?.pluginConfig?.adapterUrl) ??
    trimToNull(resolvedConfig?.skillEnv?.SMARTTHINGS_ADAPTER_URL) ??
    DEFAULT_ADAPTER_URL;
  if (!rawUrl) {
    throw new SmartThingsCliError(
      "SmartThings adapter URL is empty. Set SMARTTHINGS_ADAPTER_URL or plugins.entries.smartthings.config.adapterUrl.",
    );
  }

  let adapterUrl;
  try {
    adapterUrl = normalizeBaseUrl(new URL(rawUrl).toString());
  } catch {
    throw new SmartThingsCliError(
      `Invalid SmartThings adapter URL: ${rawUrl}. Use SMARTTHINGS_ADAPTER_URL or plugins.entries.smartthings.config.adapterUrl with an absolute URL such as http://127.0.0.1:8787.`,
    );
  }

  return {
    adapterToken:
      envToken ??
      trimToNull(resolvedConfig?.pluginConfig?.adapterToken) ??
      trimToNull(resolvedConfig?.skillEnv?.SMARTTHINGS_ADAPTER_TOKEN) ??
      null,
    adapterUrl,
    timeoutMs: REQUEST_TIMEOUT_MS,
  };
}

export async function requestAdapterJson(method, path, body) {
  const config = readAdapterConfig();
  const url = new URL(normalizePath(path), config.adapterUrl);
  const headers = {
    accept: "application/json",
  };

  if (config.adapterToken) {
    headers.authorization = `Bearer ${config.adapterToken}`;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  let response;
  try {
    response = await fetch(url, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
      method,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw new SmartThingsCliError(
      `Unable to reach SmartThings adapter at ${config.adapterUrl}: ${describeError(error)}\nCheck SMARTTHINGS_ADAPTER_URL, plugins.entries.smartthings.config.adapterUrl, or whether the adapter process is running.`,
    );
  }

  const responseBody = await readResponseBody(response);
  if (!response.ok) {
    const bodyText = formatResponseBody(responseBody);
    throw new SmartThingsCliError(
      `SmartThings adapter returned ${response.status} for ${method} ${url.pathname}${url.search ? url.search : ""}${bodyText ? `: ${bodyText}` : ""}`,
    );
  }

  return responseBody;
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value ?? null, null, 2)}\n`);
}

export function printUsage(message, usageLines) {
  if (message) {
    console.error(message);
  }
  for (const line of usageLines) {
    console.error(line);
  }
}

export function normalizeJsonArgs(rawValue) {
  if (!rawValue) {
    return { hasValue: false, value: undefined };
  }

  const trimmed = rawValue.trim();
  if (!trimmed) {
    return { hasValue: false, value: undefined };
  }

  try {
    return { hasValue: true, value: JSON.parse(trimmed) };
  } catch (error) {
    throw new SmartThingsCliError(`Invalid JSON arguments: ${trimmed}\n${describeError(error)}`);
  }
}

export function buildCommandInvocation(argv) {
  if (argv.length < 2) {
    throw new SmartThingsCliError(
      "Missing command arguments. Expected either <deviceId> <capability> <command> [argumentsJson] or <deviceId> <component> <capability> <command> [argumentsJson].",
    );
  }

  const [deviceId, ...rest] = argv;
  if (rest.length === 2) {
    return {
      capability: rest[0],
      command: rest[1],
      deviceId,
    };
  }

  if (rest.length === 3) {
    const candidate = normalizeJsonArgsMaybe(rest[2]);
    if (candidate.hasValue) {
      return {
        arguments: candidate.value,
        capability: rest[0],
        command: rest[1],
        deviceId,
      };
    }

    return {
      capability: rest[1],
      command: rest[2],
      component: rest[0],
      deviceId,
    };
  }

  if (rest.length >= 4) {
    const tail = rest.slice(3).join(" ").trim();
    const candidate = normalizeJsonArgs(tail);
    return {
      arguments: candidate.value,
      capability: rest[1],
      command: rest[2],
      component: rest[0],
      deviceId,
    };
  }

  throw new SmartThingsCliError(
    "Missing command arguments. Expected either <deviceId> <capability> <command> [argumentsJson] or <deviceId> <component> <capability> <command> [argumentsJson].",
  );
}

export function summarizeDeviceStatus(response) {
  const normalizedState = response?.normalizedState?.state ?? "unknown";
  return {
    device: response?.device ?? null,
    normalized: response?.normalized ?? null,
    normalizedState,
    raw: response?.raw ?? null,
  };
}

function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function trimToNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizePath(value) {
  return value.startsWith("/") ? value.slice(1) : value;
}

async function readResponseBody(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!text) {
    return null;
  }

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  const trimmed = text.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }

  return text;
}

function normalizeJsonArgsMaybe(rawValue) {
  if (!rawValue) {
    return { hasValue: false, value: undefined };
  }

  const trimmed = rawValue.trim();
  if (!trimmed) {
    return { hasValue: false, value: undefined };
  }

  try {
    return { hasValue: true, value: JSON.parse(trimmed) };
  } catch {
    return { hasValue: false, value: undefined };
  }
}

function formatResponseBody(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return JSON.stringify(value);
}

function describeError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function loadSmartThingsConfigFallback(options = {}) {
  if (
    trimToNull(process.env.SMARTTHINGS_ADAPTER_URL) &&
    trimToNull(process.env.SMARTTHINGS_ADAPTER_TOKEN)
  ) {
    return null;
  }

  const configPath = resolveOpenClawConfigPath();
  if (!configPath || !fs.existsSync(configPath)) {
    return null;
  }

  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (!options.strict) {
      return null;
    }
    throw new SmartThingsCliError(
      `Unable to read OpenClaw config at ${configPath}: ${describeError(error)}`,
    );
  }

  let parsed;
  try {
    parsed = JSON5.parse(raw);
  } catch (error) {
    if (!options.strict) {
      return null;
    }
    throw new SmartThingsCliError(
      `Unable to parse OpenClaw config at ${configPath}: ${describeError(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const root = parsed;
  return {
    pluginConfig: readPluginConfig(root),
    skillEnv: readSkillEnv(root),
  };
}

function readPluginConfig(config) {
  const pluginEntry = config?.plugins?.entries?.[SKILL_KEY];
  if (!pluginEntry || typeof pluginEntry !== "object" || Array.isArray(pluginEntry)) {
    return null;
  }
  const pluginConfig = pluginEntry.config;
  if (!pluginConfig || typeof pluginConfig !== "object" || Array.isArray(pluginConfig)) {
    return null;
  }
  return pluginConfig;
}

function readSkillEnv(config) {
  const skillEntry = config?.skills?.entries?.[SKILL_KEY];
  if (!skillEntry || typeof skillEntry !== "object" || Array.isArray(skillEntry)) {
    return null;
  }
  const skillEnv = skillEntry.env;
  if (!skillEnv || typeof skillEnv !== "object" || Array.isArray(skillEnv)) {
    return null;
  }
  return skillEnv;
}

function resolveOpenClawConfigPath() {
  const explicitConfigPath =
    trimToNull(process.env.OPENCLAW_CONFIG_PATH) ?? trimToNull(process.env.CLAWDBOT_CONFIG_PATH);
  if (explicitConfigPath) {
    return resolveUserPath(explicitConfigPath);
  }

  const stateOverride =
    trimToNull(process.env.OPENCLAW_STATE_DIR) ?? trimToNull(process.env.CLAWDBOT_STATE_DIR);
  if (stateOverride) {
    return resolveFirstExistingConfigPath(
      LEGACY_CONFIG_FILENAMES.map((filename) =>
        path.join(resolveUserPath(stateOverride), filename),
      ),
    );
  }

  const homeDir = resolveHomeDir();
  return resolveFirstExistingConfigPath(
    LEGACY_STATE_DIRNAMES.flatMap((dirname) =>
      LEGACY_CONFIG_FILENAMES.map((filename) => path.join(homeDir, dirname, filename)),
    ),
  );
}

function resolveFirstExistingConfigPath(candidates) {
  const existing = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (existing) {
    return existing;
  }
  return candidates[0] ?? null;
}

function resolveHomeDir() {
  const configuredHome = trimToNull(process.env.OPENCLAW_HOME) ?? trimToNull(process.env.HOME);
  if (configuredHome) {
    return resolvePathWithHome(configuredHome, os.homedir());
  }
  return os.homedir();
}

function resolveUserPath(value) {
  return resolvePathWithHome(value, resolveHomeDir());
}

function resolvePathWithHome(value, homeDir) {
  if (value.startsWith("~/")) {
    return path.resolve(homeDir, value.slice(2));
  }
  if (value === "~") {
    return homeDir;
  }
  return path.resolve(value);
}
