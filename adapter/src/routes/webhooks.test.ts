import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouteContext } from "../app.js";
import type { SmartThingsOAuthStateStore } from "../oauth-state-store.js";
import type { SmartThingsDeviceSubscriptionRequest } from "../smartthings-client.js";
import { handleWebhookRoutes } from "./webhooks.js";

type TestRequest = PassThrough & RouteContext["request"];

function createRequest(method: string): TestRequest {
  const request = new PassThrough();
  const typedRequest = request as unknown as TestRequest;
  typedRequest.method = method;
  typedRequest.headers = {
    "content-type": "application/json",
    host: "127.0.0.1:8787",
    "x-forwarded-proto": "https",
  };
  typedRequest.socket = { remoteAddress: "127.0.0.1" } as RouteContext["request"]["socket"];
  return typedRequest;
}

function createContext(params: {
  client: Partial<RouteContext["client"]>;
  defaultInstalledAppId?: string | null;
  oauthStateStore?: SmartThingsOAuthStateStore;
  pathname: string;
  publicUrl?: string | null;
  requestMethod: string;
  webhookTrustVerifier?: Exclude<RouteContext["webhookTrustVerifier"], undefined>;
}): { context: RouteContext; request: TestRequest } {
  const request = createRequest(params.requestMethod);
  const context = {
    client: params.client as RouteContext["client"],
    config: {
      baseUrl: "https://api.smartthings.com/v1",
      bindHost: "127.0.0.1",
      defaultInstalledAppId: params.defaultInstalledAppId ?? null,
      maxBodyBytes: 256 * 1024,
      port: 8787,
      publicUrl: params.publicUrl ?? null,
      requestTimeoutMs: 10_000,
      smartAppClientId: null,
      smartAppClientSecret: null,
      smartAppTokenUrl: "https://api.smartthings.com/oauth/token",
    },
    oauthStateStore: params.oauthStateStore,
    request: request as unknown as RouteContext["request"],
    response: {} as RouteContext["response"],
    url: new URL(params.pathname, "http://127.0.0.1:8787"),
    webhookTrustVerifier: params.webhookTrustVerifier ?? createAllowAllWebhookTrustVerifier(),
  } satisfies RouteContext;
  return { context, request };
}

function writeJson(request: PassThrough, body: unknown): void {
  request.end(JSON.stringify(body));
}

function createMemoryStore() {
  const state = new Map<string, unknown>();
  const store: SmartThingsOAuthStateStore = {
    async deleteInstalledAppState(installedAppId) {
      state.delete(installedAppId);
    },
    async readInstalledAppState(installedAppId) {
      return (
        (state.get(installedAppId) as Awaited<
          ReturnType<SmartThingsOAuthStateStore["readInstalledAppState"]>
        >) ?? null
      );
    },
    async writeInstalledAppState(payload) {
      state.set(payload.installedAppId, {
        ...payload,
        updatedAt: payload.updatedAt ?? "2026-03-21T00:00:00.000Z",
        version: 1,
      });
    },
  };
  return { state, store };
}

function createAllowAllWebhookTrustVerifier(): Exclude<
  RouteContext["webhookTrustVerifier"],
  undefined
> {
  return {
    verifyWebhook: async () => ({
      isReplay: false,
      ok: true,
      verifiedRequestKey: "verified-smartthings-request",
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("webhook routes", () => {
  it("treats PAT bootstrap as a no-op", async () => {
    const { context, request } = createContext({
      client: {},
      pathname: "/subscriptions/bootstrap",
      requestMethod: "POST",
    });

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, { mode: "pat-dev" });
    const result = await resultPromise;

    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        mode: "pat-dev",
        subscriptionState: "noop",
        webhookUrl: "https://127.0.0.1:8787/webhooks/smartthings",
      },
    });
  });

  it("returns pending confirmation until SmartApp credentials are supplied", async () => {
    const { context, request } = createContext({
      client: {},
      pathname: "/subscriptions/bootstrap",
      requestMethod: "POST",
    });

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, { mode: "oauth-smartapp" });
    const result = await resultPromise;

    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        mode: "oauth-smartapp",
        subscriptionState: "pending-confirmation",
      },
    });
  });

  it("creates subscriptions when bootstrap receives installed app credentials", async () => {
    const deleteInstalledAppSubscriptions = vi.fn(async () => undefined);
    const createDeviceSubscription = vi.fn(
      async (request: SmartThingsDeviceSubscriptionRequest) => request as Record<string, unknown>,
    );
    const { context, request } = createContext({
      client: { createDeviceSubscription, deleteInstalledAppSubscriptions },
      pathname: "/subscriptions/bootstrap",
      requestMethod: "POST",
    });

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, {
      authToken: "auth-1",
      devices: [
        "tv-1",
        {
          attribute: "switch",
          capability: "switch",
          componentId: "main",
          deviceId: "tv-2",
          stateChangeOnly: true,
          subscriptionName: "custom-tv-2",
          value: "on",
        },
      ],
      installedAppId: "app-1",
      mode: "oauth-smartapp",
      replaceExisting: true,
    });

    const result = await resultPromise;

    expect(deleteInstalledAppSubscriptions).toHaveBeenCalledWith(
      "app-1",
      "auth-1",
      expect.objectContaining({
        onAuthFailureRetry: expect.any(Function),
      }),
    );
    expect(createDeviceSubscription).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        createdCount: 2,
        installedAppId: "app-1",
        mode: "oauth-smartapp",
        subscriptionState: "active",
      },
    });
  });

  it("falls back to persisted OAuth state during bootstrap when body credentials are omitted", async () => {
    const { store } = createMemoryStore();
    await store.writeInstalledAppState({
      authToken: "persisted-token",
      devices: [{ componentId: "main", deviceId: "tv-1" }],
      installedAppId: "app-1",
      lastLifecycle: "INSTALL",
    });
    const createDeviceSubscription = vi.fn(
      async (request: SmartThingsDeviceSubscriptionRequest) => request as Record<string, unknown>,
    );
    const { context, request } = createContext({
      client: { createDeviceSubscription },
      defaultInstalledAppId: "app-1",
      oauthStateStore: store,
      pathname: "/subscriptions/bootstrap",
      requestMethod: "POST",
    });

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, { mode: "oauth-smartapp" });
    const result = await resultPromise;

    expect(createDeviceSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        authToken: "persisted-token",
        deviceId: "tv-1",
        installedAppId: "app-1",
      }),
      expect.objectContaining({
        onAuthFailureRetry: expect.any(Function),
      }),
    );
    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        installedAppId: "app-1",
        subscriptionState: "active",
      },
    });
  });

  it("refreshes an expired persisted token during bootstrap subscription repair", async () => {
    const { state, store } = createMemoryStore();
    await store.writeInstalledAppState({
      authToken: "expired-token",
      devices: [{ componentId: "main", deviceId: "tv-1" }],
      installedAppId: "app-1",
      lastLifecycle: "UPDATE",
      refreshToken: "refresh-token-1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "fresh-token",
              refresh_token: "refresh-token-2",
              token_type: "Bearer",
            }),
            {
              headers: { "content-type": "application/json" },
              status: 200,
            },
          ),
      ),
    );

    const deleteInstalledAppSubscriptions = vi.fn(
      async (
        _installedAppId: string,
        authToken: string,
        retryOptions?: { onAuthFailureRetry?: () => Promise<{ authToken: string }> },
      ) => {
        if (authToken === "expired-token") {
          await retryOptions?.onAuthFailureRetry?.();
        }
      },
    );
    const createDeviceSubscription = vi.fn(
      async (request: SmartThingsDeviceSubscriptionRequest) => ({ authToken: request.authToken }),
    );
    const { context, request } = createContext({
      client: { createDeviceSubscription, deleteInstalledAppSubscriptions },
      defaultInstalledAppId: "app-1",
      oauthStateStore: store,
      pathname: "/subscriptions/bootstrap",
      requestMethod: "POST",
    });
    context.config.smartAppClientId = "client-id-1";
    context.config.smartAppClientSecret = "client-secret-1";

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, {
      mode: "oauth-smartapp",
      replaceExisting: true,
    });
    const result = await resultPromise;

    expect(deleteInstalledAppSubscriptions).toHaveBeenCalledWith(
      "app-1",
      "expired-token",
      expect.objectContaining({
        onAuthFailureRetry: expect.any(Function),
      }),
    );
    expect(createDeviceSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        authToken: "fresh-token",
        deviceId: "tv-1",
        installedAppId: "app-1",
      }),
      expect.objectContaining({
        onAuthFailureRetry: expect.any(Function),
      }),
    );
    expect(state.get("app-1")).toMatchObject({
      authToken: "fresh-token",
      installedAppId: "app-1",
      refreshToken: "refresh-token-2",
    });
    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        installedAppId: "app-1",
        subscriptionState: "active",
      },
    });
  });

  it("returns 503 when bootstrap repair needs refresh but no refresh token is persisted", async () => {
    const { store } = createMemoryStore();
    await store.writeInstalledAppState({
      authToken: "expired-token",
      devices: [{ componentId: "main", deviceId: "tv-1" }],
      installedAppId: "app-1",
      lastLifecycle: "UPDATE",
    });
    const deleteInstalledAppSubscriptions = vi.fn(
      async (
        _installedAppId: string,
        _authToken: string,
        retryOptions?: { onAuthFailureRetry?: () => Promise<{ authToken: string }> },
      ) => {
        await retryOptions?.onAuthFailureRetry?.();
      },
    );
    const createDeviceSubscription = vi.fn(
      async (request: SmartThingsDeviceSubscriptionRequest) => ({ authToken: request.authToken }),
    );
    const { context, request } = createContext({
      client: { createDeviceSubscription, deleteInstalledAppSubscriptions },
      defaultInstalledAppId: "app-1",
      oauthStateStore: store,
      pathname: "/subscriptions/bootstrap",
      requestMethod: "POST",
    });
    context.config.smartAppClientId = "client-id-1";
    context.config.smartAppClientSecret = "client-secret-1";

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, {
      mode: "oauth-smartapp",
      replaceExisting: true,
    });
    const result = await resultPromise;

    expect(createDeviceSubscription).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      statusCode: 503,
      body: {
        error: "smartthings_refresh_token_missing",
      },
    });
  });

  it("rejects invalid bootstrap device entries before creating subscriptions", async () => {
    const deleteInstalledAppSubscriptions = vi.fn(async () => undefined);
    const createDeviceSubscription = vi.fn();
    const { context, request } = createContext({
      client: { createDeviceSubscription, deleteInstalledAppSubscriptions },
      pathname: "/subscriptions/bootstrap",
      requestMethod: "POST",
    });

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, {
      authToken: "auth-1",
      devices: ["tv-1", { capability: "switch" }],
      installedAppId: "app-1",
      mode: "oauth-smartapp",
      replaceExisting: true,
    });
    const result = await resultPromise;

    expect(deleteInstalledAppSubscriptions).not.toHaveBeenCalled();
    expect(createDeviceSubscription).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      statusCode: 400,
      body: {
        error: "invalid_subscription_payload",
      },
    });
  });

  it("preserves a public base URL path prefix when resolving the webhook callback", async () => {
    const { context, request } = createContext({
      client: {},
      pathname: "/subscriptions/bootstrap",
      requestMethod: "POST",
    });

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, {
      mode: "pat-dev",
      publicBaseUrl: "https://gateway.example.test/openclaw/",
    });
    const result = await resultPromise;

    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        webhookUrl: "https://gateway.example.test/openclaw/webhooks/smartthings",
      },
    });
  });

  it("returns configuration metadata for SmartThings lifecycle initialization", async () => {
    const { context, request } = createContext({
      client: {},
      pathname: "/webhooks/smartthings",
      publicUrl: "https://webhook.example.test/webhooks/smartthings",
      requestMethod: "POST",
    });

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, {
      configurationData: { phase: "INITIALIZE" },
      lifecycle: "CONFIGURATION",
    });
    const result = await resultPromise;

    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        configurationData: {
          initialize: {
            firstPageId: "tv-devices",
            id: "openclaw-smartthings-adapter",
            name: "OpenClaw SmartThings Adapter",
          },
        },
      },
    });
  });

  it("returns 415 for SmartThings webhook posts without json content type", async () => {
    const verifyWebhook = vi.fn(async () => ({
      isReplay: false,
      ok: true as const,
      verifiedRequestKey: "verified-smartthings-request",
    }));
    const { context, request } = createContext({
      client: {},
      pathname: "/webhooks/smartthings",
      requestMethod: "POST",
      webhookTrustVerifier: { verifyWebhook },
    });
    request.headers["content-type"] = "text/plain";

    const resultPromise = handleWebhookRoutes(context);
    request.end("{}");
    const result = await resultPromise;

    expect(verifyWebhook).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      statusCode: 415,
      body: {
        error: "unsupported_media_type",
      },
    });
  });

  it("rejects missing webhook auth before SmartThings side effects", async () => {
    const confirmWebhookTarget = vi.fn(async () => undefined);
    const { state, store } = createMemoryStore();
    const verifyWebhook = vi.fn(async () => ({
      ok: false as const,
      reason: "missing authorization header",
    }));
    const { context, request } = createContext({
      client: { confirmWebhookTarget },
      oauthStateStore: store,
      pathname: "/webhooks/smartthings",
      requestMethod: "POST",
      webhookTrustVerifier: { verifyWebhook },
    });

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, {
      confirmationData: { confirmationUrl: "https://smartthings.example/confirm" },
      lifecycle: "CONFIRMATION",
    });
    const result = await resultPromise;

    expect(confirmWebhookTarget).not.toHaveBeenCalled();
    expect(state.size).toBe(0);
    expect(result).toMatchObject({
      statusCode: 401,
      body: {
        error: "unauthorized_webhook",
      },
    });
  });

  it("rejects verified webhook responses without a stable request identity", async () => {
    const confirmWebhookTarget = vi.fn(async () => undefined);
    const verifyWebhook = vi.fn(async () => ({
      isReplay: false,
      ok: true as const,
      verifiedRequestKey: "",
    }));
    const { context, request } = createContext({
      client: { confirmWebhookTarget },
      pathname: "/webhooks/smartthings",
      requestMethod: "POST",
      webhookTrustVerifier: { verifyWebhook },
    });

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, {
      confirmationData: { confirmationUrl: "https://smartthings.example/confirm" },
      lifecycle: "CONFIRMATION",
    });
    const result = await resultPromise;

    expect(confirmWebhookTarget).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      statusCode: 401,
      body: {
        error: "unauthorized_webhook",
      },
    });
  });

  it("persists INSTALL lifecycle state before bootstrapping subscriptions", async () => {
    const { state, store } = createMemoryStore();
    const createDeviceSubscription = vi.fn(async () => ({ subscriptionId: "sub-1" }));
    const { context, request } = createContext({
      client: { createDeviceSubscription },
      oauthStateStore: store,
      pathname: "/webhooks/smartthings",
      requestMethod: "POST",
    });

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, {
      installData: {
        authToken: "install-token",
        refreshToken: "refresh-token-1",
        installedApp: {
          config: {
            tvDevices: [{ deviceConfig: { componentId: "main", deviceId: "tv-1" } }],
          },
          installedAppId: "app-1",
        },
      },
      lifecycle: "INSTALL",
    });
    const result = await resultPromise;

    expect(state.get("app-1")).toMatchObject({
      authToken: "install-token",
      devices: [{ componentId: "main", deviceId: "tv-1" }],
      installedAppId: "app-1",
      lastLifecycle: "INSTALL",
      refreshToken: "refresh-token-1",
    });
    expect(createDeviceSubscription).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      statusCode: 200,
      body: { acknowledged: true, lifecycle: "INSTALL" },
    });
  });

  it("acknowledges replayed INSTALL lifecycle delivery without mutating state", async () => {
    const { state, store } = createMemoryStore();
    const createDeviceSubscription = vi.fn(async () => ({ subscriptionId: "sub-1" }));
    const verifyWebhook = vi.fn(async () => ({
      isReplay: true,
      ok: true as const,
      verifiedRequestKey: "verified-smartthings-request",
    }));
    const { context, request } = createContext({
      client: { createDeviceSubscription },
      oauthStateStore: store,
      pathname: "/webhooks/smartthings",
      requestMethod: "POST",
      webhookTrustVerifier: { verifyWebhook },
    });

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, {
      installData: {
        authToken: "install-token",
        installedApp: {
          config: {
            tvDevices: [{ deviceConfig: { componentId: "main", deviceId: "tv-1" } }],
          },
          installedAppId: "app-1",
        },
      },
      lifecycle: "INSTALL",
    });
    const result = await resultPromise;

    expect(state.size).toBe(0);
    expect(createDeviceSubscription).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      statusCode: 200,
      body: { acknowledged: true, lifecycle: "INSTALL", replayed: true },
    });
  });

  it("updates persisted lifecycle state on UPDATE", async () => {
    const { state, store } = createMemoryStore();
    await store.writeInstalledAppState({
      authToken: "old-token",
      devices: [{ componentId: "main", deviceId: "tv-1" }],
      installedAppId: "app-1",
      lastLifecycle: "INSTALL",
      refreshToken: "refresh-token-old",
    });
    const deleteInstalledAppSubscriptions = vi.fn(async () => undefined);
    const createDeviceSubscription = vi.fn(async () => ({ subscriptionId: "sub-2" }));
    const { context, request } = createContext({
      client: { createDeviceSubscription, deleteInstalledAppSubscriptions },
      oauthStateStore: store,
      pathname: "/webhooks/smartthings",
      requestMethod: "POST",
    });

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, {
      lifecycle: "UPDATE",
      updateData: {
        authToken: "new-token",
        refreshToken: "refresh-token-new",
        installedApp: {
          config: {
            tvDevices: [{ deviceConfig: { componentId: "secondary", deviceId: "tv-2" } }],
          },
          installedAppId: "app-1",
        },
      },
    });
    const result = await resultPromise;

    expect(deleteInstalledAppSubscriptions).toHaveBeenCalledWith(
      "app-1",
      "new-token",
      expect.objectContaining({
        onAuthFailureRetry: expect.any(Function),
      }),
    );
    expect(state.get("app-1")).toMatchObject({
      authToken: "new-token",
      devices: [{ componentId: "secondary", deviceId: "tv-2" }],
      installedAppId: "app-1",
      lastLifecycle: "UPDATE",
      refreshToken: "refresh-token-new",
    });
    expect(result).toMatchObject({
      statusCode: 200,
      body: { acknowledged: true, lifecycle: "UPDATE" },
    });
  });

  it("acknowledges replayed UPDATE lifecycle delivery without replacing subscriptions", async () => {
    const { state, store } = createMemoryStore();
    await store.writeInstalledAppState({
      authToken: "old-token",
      devices: [{ componentId: "main", deviceId: "tv-1" }],
      installedAppId: "app-1",
      lastLifecycle: "INSTALL",
      refreshToken: "refresh-token-old",
    });
    const deleteInstalledAppSubscriptions = vi.fn(async () => undefined);
    const createDeviceSubscription = vi.fn(async () => ({ subscriptionId: "sub-2" }));
    const verifyWebhook = vi.fn(async () => ({
      isReplay: true,
      ok: true as const,
      verifiedRequestKey: "verified-smartthings-request",
    }));
    const { context, request } = createContext({
      client: { createDeviceSubscription, deleteInstalledAppSubscriptions },
      oauthStateStore: store,
      pathname: "/webhooks/smartthings",
      requestMethod: "POST",
      webhookTrustVerifier: { verifyWebhook },
    });

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, {
      lifecycle: "UPDATE",
      updateData: {
        authToken: "new-token",
        refreshToken: "refresh-token-new",
        installedApp: {
          config: {
            tvDevices: [{ deviceConfig: { componentId: "secondary", deviceId: "tv-2" } }],
          },
          installedAppId: "app-1",
        },
      },
    });
    const result = await resultPromise;

    expect(deleteInstalledAppSubscriptions).not.toHaveBeenCalled();
    expect(createDeviceSubscription).not.toHaveBeenCalled();
    expect(state.get("app-1")).toMatchObject({
      authToken: "old-token",
      installedAppId: "app-1",
      lastLifecycle: "INSTALL",
      refreshToken: "refresh-token-old",
    });
    expect(result).toMatchObject({
      statusCode: 200,
      body: { acknowledged: true, lifecycle: "UPDATE", replayed: true },
    });
  });

  it("deletes persisted lifecycle state on UNINSTALL when installed app context is supplied", async () => {
    const { state, store } = createMemoryStore();
    await store.writeInstalledAppState({
      authToken: "token-1",
      devices: [{ deviceId: "tv-1" }],
      installedAppId: "app-1",
    });
    const { context, request } = createContext({
      client: {},
      oauthStateStore: store,
      pathname: "/webhooks/smartthings",
      requestMethod: "POST",
    });

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, {
      lifecycle: "UNINSTALL",
      uninstallData: {
        installedApp: {
          installedAppId: "app-1",
        },
      },
    });
    const result = await resultPromise;

    expect(state.has("app-1")).toBe(false);
    expect(result).toMatchObject({
      statusCode: 200,
      body: { acknowledged: true, lifecycle: "UNINSTALL" },
    });
  });

  it("confirms SmartThings webhook targets", async () => {
    const confirmWebhookTarget = vi.fn(async () => undefined);
    const { context, request } = createContext({
      client: { confirmWebhookTarget },
      pathname: "/webhooks/smartthings",
      publicUrl: "https://webhook.example.test/webhooks/smartthings",
      requestMethod: "POST",
    });

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, {
      confirmationData: { confirmationUrl: "https://smartthings.example/confirm" },
      lifecycle: "CONFIRMATION",
    });
    const result = await resultPromise;

    expect(confirmWebhookTarget).toHaveBeenCalledWith("https://smartthings.example/confirm");
    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        targetUrl: "https://webhook.example.test/webhooks/smartthings",
      },
    });
  });

  it("returns 413 when the webhook payload exceeds the configured body limit", async () => {
    const confirmWebhookTarget = vi.fn(async () => undefined);
    const { context, request } = createContext({
      client: { confirmWebhookTarget },
      pathname: "/webhooks/smartthings",
      requestMethod: "POST",
    });
    context.config.maxBodyBytes = 16;

    const resultPromise = handleWebhookRoutes(context);
    writeJson(request, {
      confirmationData: { confirmationUrl: "https://smartthings.example/confirm" },
      lifecycle: "CONFIRMATION",
    });
    const result = await resultPromise;

    expect(confirmWebhookTarget).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      statusCode: 413,
      body: {
        error: "payload_too_large",
      },
    });
  });
});
