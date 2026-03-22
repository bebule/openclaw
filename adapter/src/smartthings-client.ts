export type SmartThingsCapabilityRef = {
  id: string;
  version?: number;
};

export type SmartThingsDeviceComponentSummary = {
  id: string;
  label?: string;
  capabilities?: SmartThingsCapabilityRef[];
};

export type SmartThingsDeviceSummary = {
  deviceId: string;
  name?: string;
  label?: string;
  manufacturerName?: string;
  deviceTypeName?: string;
  locationId?: string;
  roomId?: string;
  presentationId?: string;
  components?: SmartThingsDeviceComponentSummary[];
  type?: string;
};

export type SmartThingsAttributeState = {
  data?: unknown;
  timestamp?: string;
  unit?: string;
  value?: unknown;
};

export type SmartThingsDeviceStatus = {
  deviceId?: string;
  components?: Record<string, Record<string, Record<string, SmartThingsAttributeState>>>;
};

export type SmartThingsDeviceHealth = {
  deviceId?: string;
  healthStatus?: string;
  state?: string;
};

export type SmartThingsDeviceCommand = {
  component?: string;
  capability: string;
  command: string;
  arguments?: unknown[];
};

export type SmartThingsDeviceSubscriptionRequest = {
  installedAppId: string;
  authToken: string;
  componentId?: string;
  deviceId: string;
  capability?: string;
  attribute?: string;
  value?: unknown;
  stateChangeOnly?: boolean;
  subscriptionName?: string;
};

export type SmartThingsAuthRetryResult = {
  authToken: string;
};

export type SmartThingsAuthRetryHandler = (params: {
  failedAuthToken: string;
  method: "DELETE" | "GET" | "POST";
  path: string;
}) => Promise<SmartThingsAuthRetryResult>;

export type SmartThingsRequestRetryOptions = {
  onAuthFailureRetry?: SmartThingsAuthRetryHandler;
};

type SmartThingsRequestOptions = {
  authRetryAttempted?: boolean;
  authToken?: string;
  body?: unknown;
  expectJson?: boolean;
  headers?: Record<string, string>;
  method?: "DELETE" | "GET" | "POST";
  onAuthFailureRetry?: SmartThingsAuthRetryHandler;
};

type SmartThingsClientOptions = {
  authToken?: string | null;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
};

export class SmartThingsHttpError extends Error {
  readonly responseBody: unknown;
  readonly statusCode: number;

  constructor(message: string, statusCode: number, responseBody: unknown) {
    super(message);
    this.name = "SmartThingsHttpError";
    this.responseBody = responseBody;
    this.statusCode = statusCode;
  }
}

export class SmartThingsConfigError extends Error {
  readonly errorCode: string;

  constructor(message: string, errorCode = "smartthings_auth_unconfigured") {
    super(message);
    this.name = "SmartThingsConfigError";
    this.errorCode = errorCode;
  }
}

export class SmartThingsClient {
  private readonly authToken: string | null;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: SmartThingsClientOptions = {}) {
    this.authToken = options.authToken?.trim() || null;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.requestTimeoutMs = Math.max(1000, options.requestTimeoutMs ?? 10_000);
  }

  hasDefaultToken(): boolean {
    return this.authToken !== null;
  }

  async listDevices(
    authToken?: string,
    retryOptions?: SmartThingsRequestRetryOptions,
  ): Promise<SmartThingsDeviceSummary[]> {
    const payload = await this.requestJson<{ items?: SmartThingsDeviceSummary[] }>("/devices", {
      authToken,
      method: "GET",
      ...retryOptions,
    });
    return Array.isArray(payload.items) ? payload.items : [];
  }

  async getDeviceStatus(
    deviceId: string,
    authToken?: string,
    retryOptions?: SmartThingsRequestRetryOptions,
  ): Promise<SmartThingsDeviceStatus> {
    return await this.requestJson<SmartThingsDeviceStatus>(
      `/devices/${encodeURIComponent(deviceId)}/status`,
      {
        authToken,
        method: "GET",
        ...retryOptions,
      },
    );
  }

  async getDeviceHealth(
    deviceId: string,
    authToken?: string,
    retryOptions?: SmartThingsRequestRetryOptions,
  ): Promise<SmartThingsDeviceHealth> {
    return await this.requestJson<SmartThingsDeviceHealth>(
      `/devices/${encodeURIComponent(deviceId)}/health`,
      {
        authToken,
        method: "GET",
        ...retryOptions,
      },
    );
  }

  async executeDeviceCommands(
    deviceId: string,
    commands: SmartThingsDeviceCommand[],
    authToken?: string,
    retryOptions?: SmartThingsRequestRetryOptions,
  ): Promise<unknown> {
    return await this.requestJson(`/devices/${encodeURIComponent(deviceId)}/commands`, {
      authToken,
      body: { commands },
      method: "POST",
      ...retryOptions,
    });
  }

  async deleteInstalledAppSubscriptions(
    installedAppId: string,
    authToken: string,
    retryOptions?: SmartThingsRequestRetryOptions,
  ): Promise<void> {
    await this.requestJson(`/installedapps/${encodeURIComponent(installedAppId)}/subscriptions`, {
      authToken,
      expectJson: false,
      method: "DELETE",
      ...retryOptions,
    });
  }

  async createDeviceSubscription(
    request: SmartThingsDeviceSubscriptionRequest,
    retryOptions?: SmartThingsRequestRetryOptions,
  ): Promise<Record<string, unknown>> {
    const body = {
      sourceType: "DEVICE",
      device: {
        attribute: request.attribute ?? "*",
        capability: request.capability ?? "*",
        componentId: request.componentId ?? "main",
        deviceId: request.deviceId,
        ...(request.stateChangeOnly === undefined
          ? {}
          : { stateChangeOnly: request.stateChangeOnly }),
        ...(request.subscriptionName ? { subscriptionName: request.subscriptionName } : {}),
        ...(request.value === undefined ? {} : { value: request.value }),
      },
    };

    return await this.requestJson<Record<string, unknown>>(
      `/installedapps/${encodeURIComponent(request.installedAppId)}/subscriptions`,
      {
        authToken: request.authToken,
        body,
        method: "POST",
        ...retryOptions,
      },
    );
  }

  async confirmWebhookTarget(confirmationUrl: string): Promise<void> {
    const response = await this.fetchWithTimeout(confirmationUrl, {
      method: "GET",
    });
    if (!response.ok) {
      const responseBody = await safeReadResponse(response);
      throw new SmartThingsHttpError(
        "SmartThings confirmation URL request failed",
        response.status,
        responseBody,
      );
    }
  }

  private async requestJson<T = unknown>(
    path: string,
    options: SmartThingsRequestOptions,
  ): Promise<T> {
    const url =
      path.startsWith("http://") || path.startsWith("https://") ? path : `${this.baseUrl}${path}`;
    const headers = new Headers(options.headers);
    const token = resolveAuthToken(options.authToken, this.authToken, path);
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }

    const response = await this.fetchWithTimeout(url, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method: options.method ?? "GET",
    });

    const responseBody = response.ok ? undefined : await safeReadResponse(response);

    if (
      !response.ok &&
      (response.status === 401 || response.status === 403) &&
      token &&
      options.onAuthFailureRetry &&
      !options.authRetryAttempted
    ) {
      const refreshed = await options.onAuthFailureRetry({
        failedAuthToken: token,
        method: options.method ?? "GET",
        path,
      });
      return await this.requestJson(path, {
        ...options,
        authRetryAttempted: true,
        authToken: refreshed.authToken,
      });
    }

    if (!response.ok) {
      throw new SmartThingsHttpError(
        `SmartThings request failed with ${response.status}`,
        response.status,
        responseBody ?? null,
      );
    }

    if (options.expectJson === false || response.status === 204) {
      return undefined as T;
    }

    return (await safeReadResponse(response)) as T;
  }

  private async fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(input, {
        ...init,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw toTransportError(error);
    }
  }
}

function normalizeBaseUrl(value: string | undefined): string {
  const normalized = value?.trim() || "https://api.smartthings.com/v1";
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function resolveAuthToken(
  requestedToken: string | undefined,
  defaultToken: string | null,
  path: string,
): string | null {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return null;
  }
  const token = requestedToken?.trim() || defaultToken;
  if (!token) {
    throw new SmartThingsConfigError("Missing SmartThings auth token");
  }
  return token;
}

async function safeReadResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }
  const text = await response.text();
  return text.length > 0 ? text : null;
}

function toTransportError(error: unknown): SmartThingsHttpError {
  if (error instanceof SmartThingsHttpError) {
    return error;
  }

  if (isAbortTimeoutError(error)) {
    return new SmartThingsHttpError("SmartThings request timed out", 504, {
      error: "timeout",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return new SmartThingsHttpError("SmartThings request could not reach the upstream API", 502, {
    error: "transport_error",
    message: error instanceof Error ? error.message : String(error),
  });
}

function isAbortTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || error.name === "TimeoutError";
}
