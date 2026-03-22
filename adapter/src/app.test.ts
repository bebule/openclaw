import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { handleAdapterRequest, type RouteContext } from "./app.js";

function createRequest(method: string): PassThrough {
  const request = new PassThrough();
  const typedRequest = request as unknown as PassThrough & RouteContext["request"];
  typedRequest.method = method;
  typedRequest.headers = { host: "127.0.0.1:8787" };
  return request;
}

function createContext(params?: {
  authConfigured?: boolean;
  defaultInstalledAppId?: string | null;
  hasWebhookTrustVerifier?: boolean;
  smartAppClientId?: string | null;
  smartAppClientSecret?: string | null;
  smartAppTokenUrl?: string;
  pathname?: string;
  publicUrl?: string | null;
}) {
  const request = createRequest("GET");
  const context = {
    client: {
      hasDefaultToken: () => params?.authConfigured ?? false,
    } as RouteContext["client"],
    config: {
      baseUrl: "https://api.smartthings.com/v1",
      bindHost: "127.0.0.1",
      defaultInstalledAppId: params?.defaultInstalledAppId ?? null,
      maxBodyBytes: 256 * 1024,
      port: 8787,
      publicUrl: params?.publicUrl ?? null,
      requestTimeoutMs: 10_000,
      smartAppClientId: params?.smartAppClientId ?? null,
      smartAppClientSecret: params?.smartAppClientSecret ?? null,
      smartAppTokenUrl: params?.smartAppTokenUrl ?? "https://api.smartthings.com/oauth/token",
    },
    request: request as unknown as RouteContext["request"],
    response: {} as RouteContext["response"],
    url: new URL(params?.pathname ?? "/health", "http://127.0.0.1:8787"),
    ...(params?.hasWebhookTrustVerifier === false
      ? {}
      : {
          webhookTrustVerifier: {
            verifyWebhook: async () => ({
              isReplay: false,
              ok: true as const,
              verifiedRequestKey: "verified-request",
            }),
          },
        }),
  } satisfies RouteContext;

  return context;
}

describe("adapter app", () => {
  it("reports PAT development health when no webhook settings are configured", async () => {
    const result = await handleAdapterRequest(createContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        ok: true,
        mode: "pat-dev",
        readiness: {
          oauthDryRunReady: false,
          oauthRefreshReady: false,
          oauthWebhookReady: false,
          patReady: false,
          webhookVerificationReady: true,
        },
        smartthings: {
          authConfigured: false,
          baseUrl: "https://api.smartthings.com/v1",
          webhookPath: "/webhooks/smartthings",
        },
      },
    });
    expect(result.body).toMatchObject({
      blockers: expect.arrayContaining([
        expect.stringContaining("SMARTTHINGS_TOKEN"),
        expect.stringContaining("SMARTTHINGS_PUBLIC_URL"),
      ]),
      notes: expect.arrayContaining([expect.stringContaining("SMARTTHINGS_TOKEN is unset")]),
    });
  });

  it("reports OAuth dry-run readiness when webhook, refresh, and installed-app config are present", async () => {
    const result = await handleAdapterRequest(
      createContext({
        authConfigured: true,
        defaultInstalledAppId: "app-123",
        publicUrl: "https://gateway.example.test/webhooks/smartthings",
        smartAppClientId: "client-id-1",
        smartAppClientSecret: "client-secret-1",
      }),
    );

    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        ok: true,
        mode: "oauth-smartapp",
        readiness: {
          installedAppContextReady: true,
          oauthDryRunReady: true,
          oauthRefreshReady: true,
          oauthWebhookReady: true,
          patReady: true,
          webhookVerificationReady: true,
        },
        smartthings: {
          authConfigured: true,
          installedAppId: "app-123",
          webhookPath: "/webhooks/smartthings",
        },
        blockers: [],
        notes: [],
      },
    });
  });

  it("warns when OAuth mode is inferred without a public webhook URL", async () => {
    const result = await handleAdapterRequest(
      createContext({
        defaultInstalledAppId: "app-123",
      }),
    );

    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        mode: "oauth-smartapp",
      },
    });
    expect(result.body).toMatchObject({
      blockers: expect.arrayContaining([
        expect.stringContaining("SMARTTHINGS_PUBLIC_URL"),
        expect.stringContaining("SMARTTHINGS_CLIENT_ID"),
      ]),
      notes: expect.arrayContaining([
        expect.stringContaining("SMARTTHINGS_TOKEN is unset"),
        expect.stringContaining("SMARTTHINGS_PUBLIC_URL is unset"),
      ]),
    });
  });

  it("flags missing webhook verifier as a dry-run blocker", async () => {
    const result = await handleAdapterRequest(
      createContext({
        authConfigured: true,
        defaultInstalledAppId: "app-123",
        hasWebhookTrustVerifier: false,
        publicUrl: "https://gateway.example.test/webhooks/smartthings",
        smartAppClientId: "client-id-1",
        smartAppClientSecret: "client-secret-1",
      }),
    );

    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        readiness: {
          oauthDryRunReady: false,
          webhookVerificationReady: false,
        },
      },
    });
    expect(result.body).toMatchObject({
      blockers: expect.arrayContaining([expect.stringContaining("webhook signature verifier")]),
    });
  });
});
