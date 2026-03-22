import type { RouteContext, RouteResult } from "../app.js";
import { AdapterRequestError, json, readJsonBody, readRawBody } from "../app.js";
import { refreshSmartThingsAccessToken } from "../oauth-refresh.js";
import type { PersistedSmartThingsDeviceSelection } from "../oauth-state-store.js";
import type {
  SmartThingsAuthRetryResult,
  SmartThingsDeviceSubscriptionRequest,
  SmartThingsHttpError,
} from "../smartthings-client.js";
import { SmartThingsConfigError } from "../smartthings-client.js";

type BootstrapBody = {
  authToken?: string;
  callbackPath?: string;
  devices?: Array<
    | string
    | {
        attribute?: string;
        capability?: string;
        componentId?: string;
        deviceId: string;
        stateChangeOnly?: boolean;
        subscriptionName?: string;
        value?: unknown;
      }
  >;
  installedAppId?: string;
  mode?: "oauth-smartapp" | "pat-dev";
  publicBaseUrl?: string;
  replaceExisting?: boolean;
};

type SmartAppLifecycleRequest = {
  confirmationData?: {
    appId?: string;
    confirmationUrl?: string;
  };
  configurationData?: {
    pageId?: string;
    phase?: string;
  };
  installData?: SmartAppInstallOrUpdateData;
  lifecycle?: string;
  pingData?: {
    challenge?: string;
  };
  uninstallData?: SmartAppInstallOrUpdateData;
  updateData?: SmartAppInstallOrUpdateData;
};

type SmartAppInstallOrUpdateData = {
  authToken?: string;
  refreshToken?: string;
  installedApp?: {
    config?: Record<
      string,
      Array<{
        deviceConfig?: {
          componentId?: string;
          deviceId?: string;
        };
      }>
    >;
    installedAppId?: string;
  };
};

const CONFIG_PAGE_ID = "tv-devices";
const CONFIG_SETTING_ID = "tvDevices";

export async function handleWebhookRoutes(context: RouteContext): Promise<RouteResult | null> {
  const pathname = context.url.pathname;
  if (pathname === "/subscriptions/bootstrap") {
    if (context.request.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }
    return await handleBootstrapSubscriptions(context);
  }

  if (pathname === "/webhooks/smartthings") {
    if (context.request.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }
    return await handleSmartThingsWebhook(context);
  }

  return null;
}

async function handleBootstrapSubscriptions(context: RouteContext): Promise<RouteResult> {
  try {
    const body = await readJsonBody<BootstrapBody>(context.request, context.config.maxBodyBytes);
    const mode = resolveBootstrapMode(body.mode, context.config);
    const webhookUrl = resolveWebhookUrl(context, body.publicBaseUrl, body.callbackPath);

    if (mode === "pat-dev") {
      return json(200, {
        mode,
        notes: [
          "PAT mode supports direct polling and commands, but subscription bootstrap is intentionally a no-op.",
        ],
        subscriptionState: "noop",
        webhookUrl,
      });
    }

    const installedAppId = body.installedAppId?.trim() || context.config.defaultInstalledAppId;
    const persistedState = installedAppId
      ? await context.oauthStateStore?.readInstalledAppState(installedAppId)
      : null;
    const authToken = body.authToken?.trim() || persistedState?.authToken;
    if (!installedAppId || !authToken) {
      return json(200, {
        mode,
        notes: [
          "Provide installedAppId plus authToken from SmartApp INSTALL or UPDATE before bootstrapping subscriptions.",
          "Persist INSTALL and UPDATE tokens for each installedApp.",
          "Refresh OAuth-In SmartApp tokens before subscription writes.",
        ],
        subscriptionState: "pending-confirmation",
        webhookUrl,
      });
    }

    const authState = {
      authToken,
      devices: body.devices ?? persistedState?.devices ?? [],
      installedAppId,
      lastLifecycle: persistedState?.lastLifecycle,
      refreshToken: persistedState?.refreshToken,
    };
    const requests = buildBootstrapRequests(
      authState.installedAppId,
      authState.authToken,
      authState.devices,
    );
    if (requests.length === 0) {
      return json(400, {
        error: "missing_devices",
        message: "At least one deviceId is required to create subscriptions.",
      });
    }
    const retryOptions = createInstalledAppRetryOptions(context, authState);

    if (body.replaceExisting) {
      await context.client.deleteInstalledAppSubscriptions(
        authState.installedAppId,
        authState.authToken,
        retryOptions,
      );
    }

    const created = [];
    for (const request of requests) {
      created.push(
        await context.client.createDeviceSubscription(
          { ...request, authToken: authState.authToken },
          retryOptions,
        ),
      );
    }

    return json(200, {
      createdCount: created.length,
      installedAppId,
      mode,
      notes: [`Created ${created.length} SmartThings device subscriptions.`],
      status: "ok",
      subscriptionState: "active",
      subscriptions: created,
      webhookUrl,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json(400, { error: "invalid_json", message: error.message });
    }
    return smartThingsErrorToResponse(error);
  }
}

async function handleSmartThingsWebhook(context: RouteContext): Promise<RouteResult> {
  try {
    if (!isJsonContentType(context.request.headers["content-type"])) {
      return json(415, {
        error: "unsupported_media_type",
        message: "SmartThings webhooks must use application/json content type.",
      });
    }

    const rawBody = await readRawBody(context.request, context.config.maxBodyBytes);
    const verification = await context.webhookTrustVerifier?.verifyWebhook({
      headers: context.request.headers,
      method: context.request.method ?? "POST",
      rawBody,
      remoteAddress: context.request.socket.remoteAddress ?? undefined,
      url: context.url.toString(),
    });
    if (!verification?.ok) {
      return json(401, {
        error: "unauthorized_webhook",
        message: verification?.reason ?? "Missing SmartThings webhook verifier.",
      });
    }
    if (!verification.verifiedRequestKey) {
      return json(401, {
        error: "unauthorized_webhook",
        message: "Verified webhook request is missing a stable request identity.",
      });
    }

    const payload =
      rawBody.length === 0
        ? ({} as SmartAppLifecycleRequest)
        : (JSON.parse(rawBody) as SmartAppLifecycleRequest);

    switch (payload.lifecycle) {
      case "CONFIRMATION":
        return await handleConfirmation(context, payload);
      case "PING":
        return json(200, {
          acknowledged: true,
          lifecycle: "PING",
          pingData: {
            challenge: payload.pingData?.challenge ?? "",
          },
        });
      case "CONFIGURATION":
        return json(200, buildConfigurationResponse(payload.configurationData?.phase));
      case "INSTALL":
        if (verification.isReplay) {
          return acknowledgedReplay(payload.lifecycle);
        }
        await persistLifecycleState(context, payload.installData, "INSTALL");
        await bootstrapLifecycleSubscriptions(context, payload.installData, false);
        return json(200, { acknowledged: true, lifecycle: "INSTALL" });
      case "UPDATE":
        if (verification.isReplay) {
          return acknowledgedReplay(payload.lifecycle);
        }
        await persistLifecycleState(context, payload.updateData, "UPDATE");
        await bootstrapLifecycleSubscriptions(context, payload.updateData, true);
        return json(200, { acknowledged: true, lifecycle: "UPDATE" });
      case "EVENT":
      case "OAUTH_CALLBACK":
        // TODO: Forward SmartThings lifecycle payloads into OpenClaw session or automation hooks.
        return json(200, { acknowledged: true, lifecycle: payload.lifecycle });
      case "UNINSTALL":
        if (verification.isReplay) {
          return acknowledgedReplay(payload.lifecycle);
        }
        await deleteLifecycleState(context, payload.uninstallData);
        return json(200, { acknowledged: true, lifecycle: payload.lifecycle });
      default:
        return json(202, {
          acknowledged: false,
          lifecycle: payload.lifecycle ?? null,
          status: "ignored",
        });
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json(400, { error: "invalid_json", message: error.message });
    }
    return smartThingsErrorToResponse(error);
  }
}

function acknowledgedReplay(lifecycle: string | undefined): RouteResult {
  return json(200, {
    acknowledged: true,
    lifecycle: lifecycle ?? null,
    replayed: true,
  });
}

async function handleConfirmation(
  context: RouteContext,
  payload: SmartAppLifecycleRequest,
): Promise<RouteResult> {
  const confirmationUrl = payload.confirmationData?.confirmationUrl;
  if (confirmationUrl) {
    await context.client.confirmWebhookTarget(confirmationUrl);
  }

  return json(200, {
    targetUrl: buildWebhookUrl(context),
  });
}

async function bootstrapLifecycleSubscriptions(
  context: RouteContext,
  data: SmartAppInstallOrUpdateData | undefined,
  replaceExisting: boolean,
): Promise<void> {
  const installedAppId = data?.installedApp?.installedAppId?.trim();
  const authToken = data?.authToken?.trim();
  if (!installedAppId || !authToken) {
    return;
  }

  const authState = {
    authToken,
    devices: extractConfiguredDeviceSelections(data),
    installedAppId,
    lastLifecycle: undefined as "INSTALL" | "UPDATE" | undefined,
    refreshToken: data?.refreshToken?.trim() || null,
  };
  const persistedState = context.oauthStateStore
    ? await context.oauthStateStore.readInstalledAppState(installedAppId)
    : null;
  if (persistedState?.refreshToken) {
    authState.refreshToken = persistedState.refreshToken;
    authState.lastLifecycle = persistedState.lastLifecycle;
  }

  const requests = buildBootstrapRequests(
    authState.installedAppId,
    authState.authToken,
    authState.devices,
  );
  if (requests.length === 0) {
    return;
  }
  const retryOptions = createInstalledAppRetryOptions(context, authState);

  if (replaceExisting) {
    await context.client.deleteInstalledAppSubscriptions(
      authState.installedAppId,
      authState.authToken,
      retryOptions,
    );
  }

  for (const request of requests) {
    await context.client.createDeviceSubscription(
      { ...request, authToken: authState.authToken },
      retryOptions,
    );
  }
}

async function persistLifecycleState(
  context: RouteContext,
  data: SmartAppInstallOrUpdateData | undefined,
  lifecycle: "INSTALL" | "UPDATE",
): Promise<void> {
  const installedAppId = data?.installedApp?.installedAppId?.trim();
  const authToken = data?.authToken?.trim();
  if (!installedAppId || !authToken || !context.oauthStateStore) {
    return;
  }

  await context.oauthStateStore.writeInstalledAppState({
    authToken,
    devices: extractConfiguredDeviceSelections(data),
    installedAppId,
    lastLifecycle: lifecycle,
    refreshToken: data?.refreshToken?.trim() || undefined,
  });
}

async function deleteLifecycleState(
  context: RouteContext,
  data: SmartAppInstallOrUpdateData | undefined,
): Promise<void> {
  const installedAppId = data?.installedApp?.installedAppId?.trim();
  if (!installedAppId || !context.oauthStateStore) {
    return;
  }
  await context.oauthStateStore.deleteInstalledAppState(installedAppId);
}

function buildBootstrapRequests(
  installedAppId: string,
  authToken: string,
  devices: BootstrapBody["devices"],
): SmartThingsDeviceSubscriptionRequest[] {
  return (devices ?? []).map((entry, index) => {
    if (typeof entry === "string" && entry.trim().length > 0) {
      return {
        authToken,
        deviceId: entry.trim(),
        installedAppId,
        stateChangeOnly: true,
        subscriptionName: `openclaw-tv-${index + 1}`,
      };
    }

    if (
      entry &&
      typeof entry === "object" &&
      typeof entry.deviceId === "string" &&
      entry.deviceId.trim().length > 0
    ) {
      return {
        attribute: entry.attribute,
        authToken,
        capability: entry.capability,
        componentId: entry.componentId,
        deviceId: entry.deviceId.trim(),
        installedAppId,
        stateChangeOnly: entry.stateChangeOnly ?? true,
        subscriptionName: entry.subscriptionName ?? `openclaw-tv-${index + 1}`,
        value: entry.value,
      };
    }

    throw new AdapterRequestError(
      `Device subscription at index ${index} must provide a deviceId.`,
      400,
      "invalid_subscription_payload",
    );
  });
}

function createInstalledAppRetryOptions(
  context: RouteContext,
  state: {
    authToken: string;
    devices: BootstrapBody["devices"] | PersistedSmartThingsDeviceSelection[];
    installedAppId: string;
    lastLifecycle?: "INSTALL" | "UPDATE";
    refreshToken?: string | null;
  },
): {
  onAuthFailureRetry: (params: {
    failedAuthToken: string;
    method: "DELETE" | "GET" | "POST";
    path: string;
  }) => Promise<SmartThingsAuthRetryResult>;
} {
  return {
    onAuthFailureRetry: async () => {
      const refreshed = await refreshSmartThingsAccessToken({
        clientId: context.config.smartAppClientId,
        clientSecret: context.config.smartAppClientSecret,
        refreshToken: state.refreshToken,
        requestTimeoutMs: context.config.requestTimeoutMs,
        tokenUrl: context.config.smartAppTokenUrl,
      });
      state.authToken = refreshed.authToken;
      state.refreshToken = refreshed.refreshToken;

      if (context.oauthStateStore) {
        await context.oauthStateStore.writeInstalledAppState({
          authToken: refreshed.authToken,
          devices: normalizePersistedDeviceSelections(state.devices),
          installedAppId: state.installedAppId,
          ...(state.lastLifecycle ? { lastLifecycle: state.lastLifecycle } : {}),
          refreshToken: refreshed.refreshToken,
        });
      }

      return { authToken: refreshed.authToken };
    },
  };
}

function extractConfiguredDeviceSelections(
  data: SmartAppInstallOrUpdateData | undefined,
): PersistedSmartThingsDeviceSelection[] {
  return (
    data?.installedApp?.config?.[CONFIG_SETTING_ID]
      ?.map((entry) => entry.deviceConfig)
      .filter(
        (entry): entry is { componentId?: string; deviceId: string } =>
          typeof entry?.deviceId === "string" && entry.deviceId.length > 0,
      )
      .map((entry, index) => ({
        attribute: "switch",
        capability: "switch",
        componentId: entry.componentId ?? "main",
        deviceId: entry.deviceId,
        stateChangeOnly: true,
        subscriptionName: `openclaw-tv-${index + 1}`,
        value: "*",
      })) ?? []
  );
}

function normalizePersistedDeviceSelections(
  devices: BootstrapBody["devices"] | PersistedSmartThingsDeviceSelection[],
): PersistedSmartThingsDeviceSelection[] {
  return (devices ?? []).reduce<PersistedSmartThingsDeviceSelection[]>((out, entry) => {
    if (typeof entry === "string") {
      const deviceId = entry.trim();
      if (deviceId) {
        out.push({ deviceId });
      }
      return out;
    }
    if (!entry || typeof entry !== "object" || typeof entry.deviceId !== "string") {
      return out;
    }
    out.push({
      attribute: entry.attribute,
      capability: entry.capability,
      componentId: entry.componentId,
      deviceId: entry.deviceId,
      stateChangeOnly: entry.stateChangeOnly,
      subscriptionName: entry.subscriptionName,
      value: entry.value,
    });
    return out;
  }, []);
}

function buildConfigurationResponse(phase: string | undefined): Record<string, unknown> {
  if (phase === "INITIALIZE") {
    return {
      configurationData: {
        initialize: {
          description: "Expose Samsung TV state and commands through the OpenClaw adapter.",
          firstPageId: CONFIG_PAGE_ID,
          id: "openclaw-smartthings-adapter",
          name: "OpenClaw SmartThings Adapter",
          permissions: ["r:devices:*", "x:devices:*"],
        },
      },
    };
  }

  return {
    configurationData: {
      page: {
        complete: true,
        name: "Select Samsung TVs",
        nextPageId: null,
        pageId: CONFIG_PAGE_ID,
        previousPageId: null,
        sections: [
          {
            name: "TV devices",
            settings: [
              {
                capabilities: ["switch"],
                description: "Pick one or more Samsung TVs to expose to OpenClaw.",
                id: CONFIG_SETTING_ID,
                multiple: true,
                name: "Samsung TVs",
                permissions: ["r", "x"],
                required: true,
                type: "DEVICE",
              },
            ],
          },
        ],
      },
    },
  };
}

function buildWebhookUrl(context: RouteContext): string {
  if (context.config.publicUrl) {
    return context.config.publicUrl;
  }
  const forwardedProto = context.request.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto?.split(",")[0]?.trim() || "http";
  const host = context.request.headers.host ?? `${context.config.bindHost}:${context.config.port}`;
  return `${protocol}://${host}/webhooks/smartthings`;
}

function resolveBootstrapMode(
  requestedMode: BootstrapBody["mode"],
  config: RouteContext["config"],
): "oauth-smartapp" | "pat-dev" {
  if (requestedMode) {
    return requestedMode;
  }
  return config.defaultInstalledAppId || config.publicUrl ? "oauth-smartapp" : "pat-dev";
}

function resolveWebhookUrl(
  context: RouteContext,
  publicBaseUrl: string | undefined,
  callbackPath: string | undefined,
): string {
  if (publicBaseUrl?.trim()) {
    const normalizedPath = normalizeCallbackPath(callbackPath);
    return new URL(normalizedPath, ensureTrailingSlash(publicBaseUrl.trim())).toString();
  }
  return buildWebhookUrl(context);
}

function normalizeCallbackPath(callbackPath: string | undefined): string {
  const normalizedPath = callbackPath?.trim();
  if (!normalizedPath) {
    return "webhooks/smartthings";
  }
  if (
    normalizedPath.startsWith("http://") ||
    normalizedPath.startsWith("https://") ||
    normalizedPath.startsWith("/")
  ) {
    return normalizedPath;
  }
  return normalizedPath.replace(/^\.?\//u, "");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) {
    return false;
  }
  const mediaType = first.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

function smartThingsErrorToResponse(error: unknown): RouteResult {
  if (error instanceof AdapterRequestError) {
    return json(error.statusCode, {
      error: error.errorCode,
      message: error.message,
    });
  }

  if (error instanceof SmartThingsConfigError) {
    return json(503, {
      error: error.errorCode,
      message: error.message,
    });
  }

  const candidate = error as SmartThingsHttpError;
  if (candidate?.name === "SmartThingsHttpError") {
    const statusCode =
      candidate.statusCode === 400
        ? 400
        : candidate.statusCode === 404
          ? 404
          : candidate.statusCode === 504
            ? 504
            : 502;

    return json(statusCode, {
      error: "smartthings_upstream_error",
      message: candidate.message,
      upstreamBody: candidate.responseBody ?? null,
      upstreamStatus: candidate.statusCode,
    });
  }
  return json(500, {
    error: "adapter_error",
    message: error instanceof Error ? error.message : String(error),
  });
}
