import { SmartThingsConfigError, SmartThingsHttpError } from "./smartthings-client.js";

export type SmartThingsTokenRefreshResult = {
  authToken: string;
  expiresIn?: number;
  refreshToken: string;
  tokenType?: string;
};

export async function refreshSmartThingsAccessToken(params: {
  clientId: string | null;
  clientSecret: string | null;
  fetchFn?: typeof fetch;
  refreshToken: string | null | undefined;
  requestTimeoutMs?: number;
  tokenUrl: string;
}): Promise<SmartThingsTokenRefreshResult> {
  const clientId = params.clientId?.trim() || null;
  const clientSecret = params.clientSecret?.trim() || null;
  const refreshToken = params.refreshToken?.trim() || null;
  if (!clientId || !clientSecret) {
    throw new SmartThingsConfigError(
      "SmartThings OAuth refresh requires SMARTTHINGS_CLIENT_ID and SMARTTHINGS_CLIENT_SECRET.",
      "smartthings_oauth_refresh_unconfigured",
    );
  }
  if (!refreshToken) {
    throw new SmartThingsConfigError(
      "SmartThings OAuth refresh requires a persisted refresh token.",
      "smartthings_refresh_token_missing",
    );
  }

  const fetchFn = params.fetchFn ?? globalThis.fetch;
  const requestTimeoutMs = Math.max(1000, params.requestTimeoutMs ?? 10_000);
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const response = await fetchFn(params.tokenUrl, {
    body,
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  const payload = await safeReadJson(response);
  if (!response.ok) {
    throw new SmartThingsHttpError(
      `SmartThings token refresh failed with ${response.status}`,
      response.status,
      payload,
    );
  }

  const authToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  const nextRefreshToken =
    typeof payload.refresh_token === "string" && payload.refresh_token.trim().length > 0
      ? payload.refresh_token.trim()
      : refreshToken;
  if (!authToken) {
    throw new SmartThingsHttpError("SmartThings token refresh response omitted access_token", 502, {
      payload,
    });
  }

  return {
    authToken,
    ...(Number.isFinite(payload.expires_in) ? { expiresIn: Number(payload.expires_in) } : {}),
    refreshToken: nextRefreshToken,
    ...(typeof payload.token_type === "string" && payload.token_type.trim().length > 0
      ? { tokenType: payload.token_type.trim() }
      : {}),
  };
}

async function safeReadJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}
