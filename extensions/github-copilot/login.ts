import { intro, note, outro, spinner } from "@clack/prompts";
import { resolveAgentDir, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import { stylePromptTitle } from "openclaw/plugin-sdk/cli-runtime";
import { logConfigUpdated, updateConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  applyAuthProfileConfig,
  ensureAuthProfileStore,
} from "openclaw/plugin-sdk/provider-auth";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { resolveOpenClawAgentDir } from "../../src/agents/agent-paths.js";
import { upsertAuthProfileOrThrow } from "../../src/commands/auth-profile-write.js";
import {
  loadValidConfigOrThrow,
  resolveKnownAgentId,
} from "../../src/commands/models/shared.js";
import { normalizeAgentId } from "../../src/routing/session-key.js";

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

type DeviceTokenResponse =
  | {
      access_token: string;
      token_type: string;
      scope?: string;
    }
  | {
      error: string;
      error_description?: string;
      error_uri?: string;
    };

function parseJsonResponse<T>(value: unknown): T {
  if (!value || typeof value !== "object") {
    throw new Error("Unexpected response from GitHub");
  }
  return value as T;
}

async function requestDeviceCode(params: { scope: string }): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: params.scope,
  });

  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`GitHub device code failed: HTTP ${res.status}`);
  }

  const json = parseJsonResponse<DeviceCodeResponse>(await res.json());
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error("GitHub device code response missing fields");
  }
  return json;
}

async function pollForAccessToken(params: {
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
}): Promise<string> {
  const bodyBase = new URLSearchParams({
    client_id: CLIENT_ID,
    device_code: params.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  while (Date.now() < params.expiresAt) {
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: bodyBase,
    });

    if (!res.ok) {
      throw new Error(`GitHub device token failed: HTTP ${res.status}`);
    }

    const json = parseJsonResponse<DeviceTokenResponse>(await res.json());
    if ("access_token" in json && typeof json.access_token === "string") {
      return json.access_token;
    }

    const err = "error" in json ? json.error : "unknown";
    if (err === "authorization_pending") {
      await new Promise((r) => setTimeout(r, params.intervalMs));
      continue;
    }
    if (err === "slow_down") {
      await new Promise((r) => setTimeout(r, params.intervalMs + 2000));
      continue;
    }
    if (err === "expired_token") {
      throw new Error("GitHub device code expired; run login again");
    }
    if (err === "access_denied") {
      throw new Error("GitHub login cancelled");
    }
    throw new Error(`GitHub device flow error: ${err}`);
  }

  throw new Error("GitHub device code expired; run login again");
}

function resolveDockerHelperTargetAgentId(): string | undefined {
  const raw = process.env.OPENCLAW_DOCKER_AUTH_AGENT_ID?.trim();
  return raw ? normalizeAgentId(raw) : undefined;
}

async function resolveGithubCopilotAuthAgentDir(rawAgentId?: string): Promise<string> {
  const cfg = await loadValidConfigOrThrow();
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const explicitAgentId = resolveKnownAgentId({
    cfg,
    rawAgentId,
  });
  const agentId = explicitAgentId ?? defaultAgentId;
  const dockerHelperAgentId = resolveDockerHelperTargetAgentId();
  if (dockerHelperAgentId === agentId) {
    return resolveOpenClawAgentDir();
  }

  return resolveAgentDir(cfg, agentId);
}

async function resolveGithubCopilotStoreDir(opts: {
  agent?: string;
  agentDir?: string;
}): Promise<string> {
  const explicitAgentDir = opts.agentDir?.trim();
  if (explicitAgentDir) {
    return explicitAgentDir;
  }
  return await resolveGithubCopilotAuthAgentDir(opts.agent);
}

export async function githubCopilotLoginCommand(
  opts: { profileId?: string; yes?: boolean; agent?: string; agentDir?: string },
  runtime: RuntimeEnv,
) {
  if (!process.stdin.isTTY) {
    throw new Error("github-copilot login requires an interactive TTY.");
  }

  intro(stylePromptTitle("GitHub Copilot login"));

  const profileId = opts.profileId?.trim() || "github-copilot:github";
  const agentDir = await resolveGithubCopilotStoreDir(opts);
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });

  if (store.profiles[profileId] && !opts.yes) {
    note(
      `Auth profile already exists: ${profileId}\nRe-running will overwrite it.`,
      stylePromptTitle("Existing credentials"),
    );
  }

  const spin = spinner();
  spin.start("Requesting device code from GitHub...");
  const device = await requestDeviceCode({ scope: "read:user" });
  spin.stop("Device code ready");

  note(
    [`Visit: ${device.verification_uri}`, `Code: ${device.user_code}`].join("\n"),
    stylePromptTitle("Authorize"),
  );

  const expiresAt = Date.now() + device.expires_in * 1000;
  const intervalMs = Math.max(1000, device.interval * 1000);

  const polling = spinner();
  polling.start("Waiting for GitHub authorization...");
  const accessToken = await pollForAccessToken({
    deviceCode: device.device_code,
    intervalMs,
    expiresAt,
  });
  polling.stop("GitHub access token acquired");

  await upsertAuthProfileOrThrow({
    profileId,
    credential: {
      type: "token",
      provider: "github-copilot",
      token: accessToken,
      // GitHub device flow token doesn't reliably include expiry here.
      // Leave expires unset; we'll exchange into Copilot token plus expiry later.
    },
    agentDir,
  });

  await updateConfig((cfg) =>
    applyAuthProfileConfig(cfg, {
      provider: "github-copilot",
      profileId,
      mode: "token",
    }),
  );

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (github-copilot/token)`);

  outro("Done");
}
