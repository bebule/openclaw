import { describe, expect, it, vi } from "vitest";
import { refreshSmartThingsAccessToken } from "./oauth-refresh.js";
import { SmartThingsConfigError, SmartThingsHttpError } from "./smartthings-client.js";

describe("SmartThings OAuth refresh", () => {
  it("posts a refresh_token grant with basic auth and parses the returned token set", async () => {
    const fetchFn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "access-token-2",
            expires_in: 86399,
            refresh_token: "refresh-token-2",
            token_type: "Bearer",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        ),
    );

    await expect(
      refreshSmartThingsAccessToken({
        clientId: "client-id-1",
        clientSecret: "client-secret-1",
        fetchFn,
        refreshToken: "refresh-token-1",
        tokenUrl: "https://api.smartthings.com/oauth/token",
      }),
    ).resolves.toMatchObject({
      authToken: "access-token-2",
      expiresIn: 86399,
      refreshToken: "refresh-token-2",
      tokenType: "Bearer",
    });

    const call = fetchFn.mock.calls[0];
    expect(call?.[0]).toBe("https://api.smartthings.com/oauth/token");
    expect(call?.[1]?.method).toBe("POST");
    expect(new Headers(call?.[1]?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("client-id-1:client-secret-1").toString("base64")}`,
    );
    expect(call?.[1]?.body).toBeInstanceOf(URLSearchParams);
    const body = call?.[1]?.body;
    expect(body instanceof URLSearchParams ? body.get("grant_type") : null).toBe("refresh_token");
    expect(body instanceof URLSearchParams ? body.get("client_id") : null).toBe("client-id-1");
    expect(body instanceof URLSearchParams ? body.get("refresh_token") : null).toBe(
      "refresh-token-1",
    );
  });

  it("reuses the prior refresh token when SmartThings omits a new one", async () => {
    const fetchFn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ access_token: "access-token-2" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );

    await expect(
      refreshSmartThingsAccessToken({
        clientId: "client-id-1",
        clientSecret: "client-secret-1",
        fetchFn,
        refreshToken: "refresh-token-1",
        tokenUrl: "https://api.smartthings.com/oauth/token",
      }),
    ).resolves.toMatchObject({
      authToken: "access-token-2",
      refreshToken: "refresh-token-1",
    });
  });

  it("rejects refresh requests when required refresh configuration is missing", async () => {
    await expect(
      refreshSmartThingsAccessToken({
        clientId: null,
        clientSecret: "client-secret-1",
        refreshToken: "refresh-token-1",
        tokenUrl: "https://api.smartthings.com/oauth/token",
      }),
    ).rejects.toMatchObject({
      errorCode: "smartthings_oauth_refresh_unconfigured",
      name: "SmartThingsConfigError",
    } satisfies Partial<SmartThingsConfigError>);

    await expect(
      refreshSmartThingsAccessToken({
        clientId: "client-id-1",
        clientSecret: "client-secret-1",
        refreshToken: null,
        tokenUrl: "https://api.smartthings.com/oauth/token",
      }),
    ).rejects.toMatchObject({
      errorCode: "smartthings_refresh_token_missing",
      name: "SmartThingsConfigError",
    } satisfies Partial<SmartThingsConfigError>);
  });

  it("surfaces upstream refresh failures as SmartThingsHttpError", async () => {
    const fetchFn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );

    await expect(
      refreshSmartThingsAccessToken({
        clientId: "client-id-1",
        clientSecret: "client-secret-1",
        fetchFn,
        refreshToken: "refresh-token-1",
        tokenUrl: "https://api.smartthings.com/oauth/token",
      }),
    ).rejects.toMatchObject({
      name: "SmartThingsHttpError",
      responseBody: { error: "invalid_grant" },
      statusCode: 400,
    } satisfies Partial<SmartThingsHttpError>);
  });
});
