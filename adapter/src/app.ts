import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL, pathToFileURL } from "node:url";
import {
  createFileSmartThingsOAuthStateStore,
  type SmartThingsOAuthStateStore,
} from "./oauth-state-store.js";
import { handleDeviceRoutes } from "./routes/devices.js";
import { handleWebhookRoutes } from "./routes/webhooks.js";
import { SmartThingsClient } from "./smartthings-client.js";
import {
  createSmartThingsWebhookVerifier,
  type SmartThingsWebhookVerifier,
} from "./webhook-trust.js";

export type AdapterRuntimeConfig = {
  baseUrl: string;
  bindHost: string;
  defaultInstalledAppId: string | null;
  maxBodyBytes: number;
  port: number;
  publicUrl: string | null;
  requestTimeoutMs: number;
  smartAppClientId: string | null;
  smartAppClientSecret: string | null;
  smartAppTokenUrl: string;
};

export type RouteContext = {
  client: SmartThingsClient;
  config: AdapterRuntimeConfig;
  oauthStateStore?: SmartThingsOAuthStateStore;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  webhookTrustVerifier?: SmartThingsWebhookVerifier;
};

export type RouteResult = {
  body?: unknown;
  headers?: Record<string, string>;
  statusCode: number;
};

export class AdapterRequestError extends Error {
  readonly errorCode: string;
  readonly statusCode: number;

  constructor(message: string, statusCode: number, errorCode: string) {
    super(message);
    this.name = "AdapterRequestError";
    this.errorCode = errorCode;
    this.statusCode = statusCode;
  }
}

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_PORT = 8787;

export async function main(): Promise<void> {
  const config = readConfigFromEnv();
  const client = new SmartThingsClient({
    authToken: process.env.SMARTTHINGS_TOKEN,
    baseUrl: config.baseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const server = createAdapterServer({
    client,
    config,
    oauthStateStore: createFileSmartThingsOAuthStateStore(process.env),
    webhookTrustVerifier: createSmartThingsWebhookVerifier({ publicUrl: config.publicUrl }),
  });

  server.listen(config.port, config.bindHost, () => {
    console.log(
      `smartthings-adapter listening on http://${config.bindHost}:${config.port} (public webhook: ${
        config.publicUrl ?? "unset"
      })`,
    );
  });
}

export function json(
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>,
): RouteResult {
  return { body, headers, statusCode };
}

export function createAdapterServer(params: {
  client: SmartThingsClient;
  config: AdapterRuntimeConfig;
  oauthStateStore?: SmartThingsOAuthStateStore;
  webhookTrustVerifier?: SmartThingsWebhookVerifier;
}) {
  const { client, config, oauthStateStore, webhookTrustVerifier } = params;
  return createServer(async (request, response) => {
    const url = buildRequestUrl(request, config.bindHost);
    const context: RouteContext = {
      client,
      config,
      oauthStateStore,
      request,
      response,
      url,
      webhookTrustVerifier,
    };
    const result = await handleAdapterRequest(context);
    writeRouteResult(response, result);
  });
}

export async function handleAdapterRequest(context: RouteContext): Promise<RouteResult> {
  const { client, config, request, url, webhookTrustVerifier } = context;

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      const mode = resolveAdapterMode(config);
      const readiness = buildHealthReadiness(config, client, webhookTrustVerifier);
      return json(200, {
        blockers: buildHealthBlockers(config, client, readiness),
        ok: true,
        mode,
        notes: buildHealthNotes(config, client, mode),
        readiness,
        smartthings: {
          authConfigured: client.hasDefaultToken(),
          baseUrl: config.baseUrl,
          ...(config.defaultInstalledAppId ? { installedAppId: config.defaultInstalledAppId } : {}),
          webhookPath: "/webhooks/smartthings",
        },
      });
    }

    const routes = [handleDeviceRoutes, handleWebhookRoutes];
    for (const route of routes) {
      const result = await route(context);
      if (result !== null) {
        return result;
      }
    }

    return json(404, {
      error: "not_found",
      message: `No route for ${request.method ?? "GET"} ${url.pathname}`,
    });
  } catch (error) {
    if (error instanceof AdapterRequestError) {
      return json(error.statusCode, {
        error: error.errorCode,
        message: error.message,
      });
    }
    return json(500, {
      error: "adapter_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function readJsonBody<T>(
  request: IncomingMessage,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<T> {
  const raw = await readBody(request, maxBytes);
  if (raw.length === 0) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}

export async function readRawBody(
  request: IncomingMessage,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<string> {
  return await readBody(request, maxBytes);
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        reject(
          new AdapterRequestError(
            `Request body exceeded ${maxBytes} bytes`,
            413,
            "payload_too_large",
          ),
        );
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });

    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error) => reject(error));
  });
}

function buildRequestUrl(request: IncomingMessage, fallbackHost: string): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? fallbackHost}`);
}

function readConfigFromEnv(): AdapterRuntimeConfig {
  return {
    baseUrl: process.env.SMARTTHINGS_API_BASE_URL?.trim() || "https://api.smartthings.com/v1",
    bindHost: process.env.SMARTTHINGS_BIND_HOST?.trim() || "127.0.0.1",
    defaultInstalledAppId: process.env.SMARTTHINGS_INSTALLED_APP_ID?.trim() || null,
    maxBodyBytes: parsePositiveInt(process.env.SMARTTHINGS_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES),
    port: parsePositiveInt(process.env.SMARTTHINGS_PORT, DEFAULT_PORT),
    publicUrl: process.env.SMARTTHINGS_PUBLIC_URL?.trim() || null,
    requestTimeoutMs: parsePositiveInt(process.env.SMARTTHINGS_REQUEST_TIMEOUT_MS, 10_000),
    smartAppClientId: process.env.SMARTTHINGS_CLIENT_ID?.trim() || null,
    smartAppClientSecret: process.env.SMARTTHINGS_CLIENT_SECRET?.trim() || null,
    smartAppTokenUrl:
      process.env.SMARTTHINGS_OAUTH_TOKEN_URL?.trim() || "https://api.smartthings.com/oauth/token",
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveAdapterMode(config: AdapterRuntimeConfig): "oauth-smartapp" | "pat-dev" {
  return config.defaultInstalledAppId || config.publicUrl ? "oauth-smartapp" : "pat-dev";
}

function buildHealthNotes(
  config: AdapterRuntimeConfig,
  client: SmartThingsClient,
  mode: "oauth-smartapp" | "pat-dev",
): string[] {
  const notes: string[] = [];
  if (!client.hasDefaultToken()) {
    notes.push(
      "SMARTTHINGS_TOKEN is unset; live SmartThings reads will fail until a token is supplied.",
    );
  }
  if (mode === "oauth-smartapp" && !config.publicUrl) {
    notes.push(
      "SMARTTHINGS_PUBLIC_URL is unset; SmartThings webhook confirmation cannot complete on this adapter.",
    );
  }
  if (!config.smartAppClientId || !config.smartAppClientSecret) {
    notes.push(
      "SMARTTHINGS_CLIENT_ID or SMARTTHINGS_CLIENT_SECRET is unset; OAuth token refresh and subscription repair are unavailable.",
    );
  }
  if (!config.defaultInstalledAppId) {
    notes.push(
      "SMARTTHINGS_INSTALLED_APP_ID is unset; OAuth subscription bootstrap requires an installed app context.",
    );
  }
  return notes;
}

function buildHealthReadiness(
  config: AdapterRuntimeConfig,
  client: SmartThingsClient,
  webhookTrustVerifier: SmartThingsWebhookVerifier | undefined,
): {
  installedAppContextReady: boolean;
  oauthDryRunReady: boolean;
  oauthRefreshReady: boolean;
  oauthWebhookReady: boolean;
  patReady: boolean;
  webhookVerificationReady: boolean;
} {
  const patReady = client.hasDefaultToken();
  const oauthWebhookReady = Boolean(config.publicUrl);
  const oauthRefreshReady = Boolean(config.smartAppClientId && config.smartAppClientSecret);
  const installedAppContextReady = Boolean(config.defaultInstalledAppId);
  const webhookVerificationReady = Boolean(webhookTrustVerifier);

  return {
    installedAppContextReady,
    oauthDryRunReady:
      oauthWebhookReady &&
      oauthRefreshReady &&
      installedAppContextReady &&
      webhookVerificationReady,
    oauthRefreshReady,
    oauthWebhookReady,
    patReady,
    webhookVerificationReady,
  };
}

function buildHealthBlockers(
  config: AdapterRuntimeConfig,
  client: SmartThingsClient,
  readiness: ReturnType<typeof buildHealthReadiness>,
): string[] {
  const blockers: string[] = [];
  if (!client.hasDefaultToken()) {
    blockers.push("missing SMARTTHINGS_TOKEN for PAT reads and commands");
  }
  if (!readiness.oauthWebhookReady) {
    blockers.push("missing SMARTTHINGS_PUBLIC_URL for SmartApp webhook confirmation");
  }
  if (!readiness.oauthRefreshReady) {
    blockers.push(
      "missing SMARTTHINGS_CLIENT_ID or SMARTTHINGS_CLIENT_SECRET for OAuth refresh repair",
    );
  }
  if (!readiness.installedAppContextReady) {
    blockers.push("missing SMARTTHINGS_INSTALLED_APP_ID for OAuth subscription bootstrap");
  }
  if (!readiness.webhookVerificationReady) {
    blockers.push("missing SmartThings webhook signature verifier");
  }
  if (readiness.oauthRefreshReady && !config.smartAppTokenUrl.trim().startsWith("https://")) {
    blockers.push("SMARTTHINGS_OAUTH_TOKEN_URL must be https for production refresh traffic");
  }
  return blockers;
}

function writeRouteResult(response: ServerResponse, result: RouteResult): void {
  response.statusCode = result.statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  for (const [key, value] of Object.entries(result.headers ?? {})) {
    response.setHeader(key, value);
  }
  response.end(JSON.stringify(result.body ?? {}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
