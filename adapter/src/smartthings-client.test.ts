import { describe, expect, it, vi } from "vitest";
import {
  SmartThingsClient,
  SmartThingsConfigError,
  SmartThingsHttpError,
} from "./smartthings-client.js";

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function createAuthErrorResponse(status = 401): Response {
  return createJsonResponse({ error: "auth_failed" }, status);
}

describe("SmartThingsClient", () => {
  it("lists devices with the configured base URL and bearer token", async () => {
    const fetchFn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => createJsonResponse({ items: [{ deviceId: "tv-1" }] }),
    );
    const client = new SmartThingsClient({
      authToken: "token-123",
      baseUrl: "https://api.example/v1",
      fetchFn,
    });

    await expect(client.listDevices()).resolves.toEqual([{ deviceId: "tv-1" }]);
    expect(fetchFn).toHaveBeenCalledOnce();

    const call = fetchFn.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) {
      throw new Error("Expected fetch to be called");
    }
    const [url, init] = call;
    expect(url).toBe("https://api.example/v1/devices");
    expect(init).toMatchObject({ method: "GET" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-123");
  });

  it("serializes device commands with the expected payload", async () => {
    const fetchFn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => createJsonResponse({ results: [{ status: "ACCEPTED" }] }),
    );
    const client = new SmartThingsClient({
      authToken: "token-123",
      baseUrl: "https://api.example/v1",
      fetchFn,
    });

    await expect(
      client.executeDeviceCommands("tv-1", [
        { capability: "switch", command: "on", component: "main" },
        { capability: "audioVolume", command: "setVolume", arguments: [15] },
      ]),
    ).resolves.toEqual({ results: [{ status: "ACCEPTED" }] });

    const call = fetchFn.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) {
      throw new Error("Expected fetch to be called");
    }
    const [, init] = call;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(
      JSON.stringify({
        commands: [
          { capability: "switch", command: "on", component: "main" },
          { capability: "audioVolume", command: "setVolume", arguments: [15] },
        ],
      }),
    );
  });

  it("creates subscriptions under the installed app endpoint", async () => {
    const fetchFn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => createJsonResponse({ subscriptionId: "sub-1" }, 201),
    );
    const client = new SmartThingsClient({
      authToken: "token-123",
      baseUrl: "https://api.example/v1",
      fetchFn,
    });

    await expect(
      client.createDeviceSubscription({
        authToken: "token-override",
        attribute: "switch",
        capability: "switch",
        componentId: "main",
        deviceId: "tv-1",
        installedAppId: "app-1",
        stateChangeOnly: true,
        subscriptionName: "openclaw-tv-1",
        value: "*",
      }),
    ).resolves.toEqual({ subscriptionId: "sub-1" });

    const call = fetchFn.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) {
      throw new Error("Expected fetch to be called");
    }
    const [url, init] = call;
    expect(url).toBe("https://api.example/v1/installedapps/app-1/subscriptions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-override");
    expect(init?.body).toBe(
      JSON.stringify({
        sourceType: "DEVICE",
        device: {
          attribute: "switch",
          capability: "switch",
          componentId: "main",
          deviceId: "tv-1",
          stateChangeOnly: true,
          subscriptionName: "openclaw-tv-1",
          value: "*",
        },
      }),
    );
  });

  it("retries once with a refreshed token after a 401 auth failure", async () => {
    const fetchFn = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(createAuthErrorResponse(401))
      .mockResolvedValueOnce(createJsonResponse({ items: [{ deviceId: "tv-1" }] }));
    const onAuthFailureRetry = vi.fn(async () => ({ authToken: "token-refreshed" }));
    const client = new SmartThingsClient({
      authToken: "token-expired",
      baseUrl: "https://api.example/v1",
      fetchFn,
    });

    await expect(client.listDevices(undefined, { onAuthFailureRetry })).resolves.toEqual([
      { deviceId: "tv-1" },
    ]);

    expect(onAuthFailureRetry).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer token-expired",
    );
    expect(new Headers(fetchFn.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer token-refreshed",
    );
  });

  it("retries installed-app subscription writes with a refreshed token after a 403", async () => {
    const fetchFn = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(createAuthErrorResponse(403))
      .mockResolvedValueOnce(createJsonResponse({ subscriptionId: "sub-1" }, 201));
    const onAuthFailureRetry = vi.fn(async () => ({ authToken: "token-refreshed" }));
    const client = new SmartThingsClient({
      authToken: "token-default",
      baseUrl: "https://api.example/v1",
      fetchFn,
    });

    await expect(
      client.createDeviceSubscription(
        {
          authToken: "token-expired",
          deviceId: "tv-1",
          installedAppId: "app-1",
        },
        { onAuthFailureRetry },
      ),
    ).resolves.toEqual({ subscriptionId: "sub-1" });

    expect(onAuthFailureRetry).toHaveBeenCalledWith({
      failedAuthToken: "token-expired",
      method: "POST",
      path: "/installedapps/app-1/subscriptions",
    });
    expect(new Headers(fetchFn.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer token-refreshed",
    );
  });

  it("does not attempt token refresh for non-auth upstream failures", async () => {
    const fetchFn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => createJsonResponse({ error: "rate_limit" }, 429),
    );
    const onAuthFailureRetry = vi.fn(async () => ({ authToken: "token-refreshed" }));
    const client = new SmartThingsClient({
      authToken: "token-expired",
      baseUrl: "https://api.example/v1",
      fetchFn,
    });

    await expect(client.listDevices(undefined, { onAuthFailureRetry })).rejects.toMatchObject({
      name: "SmartThingsHttpError",
      statusCode: 429,
    } satisfies Partial<SmartThingsHttpError>);
    expect(onAuthFailureRetry).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("surfaces refresh failures without retrying indefinitely", async () => {
    const fetchFn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => createAuthErrorResponse(401),
    );
    const onAuthFailureRetry = vi.fn(async () => {
      throw new SmartThingsConfigError("refresh unavailable", "smartthings_refresh_unavailable");
    });
    const client = new SmartThingsClient({
      authToken: "token-expired",
      baseUrl: "https://api.example/v1",
      fetchFn,
    });

    await expect(client.listDevices(undefined, { onAuthFailureRetry })).rejects.toMatchObject({
      errorCode: "smartthings_refresh_unavailable",
      name: "SmartThingsConfigError",
    } satisfies Partial<SmartThingsConfigError>);
    expect(onAuthFailureRetry).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("raises a SmartThingsHttpError for non-2xx responses", async () => {
    const fetchFn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ error: "rate_limit" }), {
          headers: { "content-type": "application/json" },
          status: 429,
        }),
    );
    const client = new SmartThingsClient({
      authToken: "token-123",
      baseUrl: "https://api.example/v1",
      fetchFn,
    });

    await expect(client.getDeviceStatus("tv-1")).rejects.toMatchObject({
      name: "SmartThingsHttpError",
      responseBody: { error: "rate_limit" },
      statusCode: 429,
    } satisfies Partial<SmartThingsHttpError>);
  });

  it("maps transport failures into a SmartThingsHttpError", async () => {
    const fetchFn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => {
        throw new Error("socket hang up");
      },
    );
    const client = new SmartThingsClient({
      authToken: "token-123",
      baseUrl: "https://api.example/v1",
      fetchFn,
    });

    await expect(client.getDeviceStatus("tv-1")).rejects.toMatchObject({
      name: "SmartThingsHttpError",
      responseBody: {
        error: "transport_error",
        message: "socket hang up",
      },
      statusCode: 502,
    } satisfies Partial<SmartThingsHttpError>);
  });

  it("maps timeout aborts into a gateway timeout SmartThingsHttpError", async () => {
    const fetchFn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => {
        throw new DOMException("The operation timed out", "TimeoutError");
      },
    );
    const client = new SmartThingsClient({
      authToken: "token-123",
      baseUrl: "https://api.example/v1",
      fetchFn,
    });

    await expect(client.getDeviceStatus("tv-1")).rejects.toMatchObject({
      name: "SmartThingsHttpError",
      responseBody: {
        error: "timeout",
      },
      statusCode: 504,
    } satisfies Partial<SmartThingsHttpError>);
  });

  it("raises a SmartThingsConfigError when no auth token is configured", async () => {
    const fetchFn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
    const client = new SmartThingsClient({
      baseUrl: "https://api.example/v1",
      fetchFn,
    });

    await expect(client.listDevices()).rejects.toMatchObject({
      errorCode: "smartthings_auth_unconfigured",
      name: "SmartThingsConfigError",
    } satisfies Partial<SmartThingsConfigError>);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
