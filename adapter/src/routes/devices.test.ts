import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { RouteContext } from "../app.js";
import {
  SmartThingsConfigError,
  SmartThingsHttpError,
  type SmartThingsDeviceStatus,
} from "../smartthings-client.js";
import { handleDeviceRoutes } from "./devices.js";

const fixtureRoot = path.resolve("fixtures/samsung-tv");

function createRequest(method: string): PassThrough {
  const request = new PassThrough();
  const typedRequest = request as unknown as PassThrough & RouteContext["request"];
  typedRequest.method = method;
  typedRequest.headers = { "content-type": "application/json", host: "127.0.0.1:8787" };
  return request;
}

function createContext(params: {
  client: Partial<RouteContext["client"]>;
  pathname: string;
  requestMethod: string;
  search?: string;
  body?: unknown;
}): { context: RouteContext; request: PassThrough } {
  const request = createRequest(params.requestMethod);
  const context = {
    client: params.client as RouteContext["client"],
    config: {
      baseUrl: "https://api.smartthings.com/v1",
      bindHost: "127.0.0.1",
      defaultInstalledAppId: null,
      maxBodyBytes: 256 * 1024,
      port: 8787,
      publicUrl: null,
      requestTimeoutMs: 10_000,
      smartAppClientId: null,
      smartAppClientSecret: null,
      smartAppTokenUrl: "https://api.smartthings.com/oauth/token",
    },
    request: request as unknown as RouteContext["request"],
    response: {} as RouteContext["response"],
    url: new URL(`${params.pathname}${params.search ?? ""}`, "http://127.0.0.1:8787"),
  } satisfies RouteContext;

  return { context, request };
}

function writeJson(request: PassThrough, body: unknown): void {
  request.end(JSON.stringify(body));
}

describe("device routes", () => {
  it("lists devices and honors the tvOnly filter", async () => {
    const listDevices = vi.fn(async () => [
      {
        deviceId: "tv-1",
        label: "Living Room TV",
        components: [{ id: "main", capabilities: [{ id: "switch" }, { id: "healthCheck" }] }],
        deviceTypeName: "Samsung TV",
      },
      {
        deviceId: "plug-1",
        label: "Desk Lamp",
        components: [{ id: "main", capabilities: [{ id: "switch" }] }],
        deviceTypeName: "Outlet",
      },
    ]);
    const { context } = createContext({
      client: { listDevices },
      pathname: "/devices",
      requestMethod: "GET",
      search: "?tvOnly=true",
    });

    const result = await handleDeviceRoutes(context);

    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        count: 1,
        devices: [{ deviceId: "tv-1", isTvCandidate: true }],
        items: [{ deviceId: "tv-1", isTvCandidate: true }],
      },
    });
  });

  it("returns normalized status and raw payload for a device", async () => {
    const statusFixture = JSON.parse(
      await fs.readFile(path.join(fixtureRoot, "sample-status.json"), "utf8"),
    ) as SmartThingsDeviceStatus;
    const listDevices = vi.fn(async () => [
      {
        deviceId: "tv-1",
        label: "Living Room TV",
        components: [{ id: "main", capabilities: [{ id: "switch" }, { id: "healthCheck" }] }],
        deviceTypeName: "Samsung TV",
      },
    ]);
    const getDeviceStatus = vi.fn(async () => statusFixture);
    const getDeviceHealth = vi.fn(async () => ({ healthStatus: "ONLINE", state: "ONLINE" }));
    const { context } = createContext({
      client: { getDeviceHealth, getDeviceStatus, listDevices },
      pathname: "/devices/tv-1/status",
      requestMethod: "GET",
    });

    const result = await handleDeviceRoutes(context);

    expect(getDeviceStatus).toHaveBeenCalledWith("tv-1");
    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        device: { deviceId: "tv-1", isTvCandidate: true, label: "Living Room TV" },
        normalized: { state: "on", tvState: "on" },
        normalizedState: { source: "adapter", state: "on" },
      },
    });
    expect(result).not.toBeNull();
    if (!result) {
      throw new Error("Expected a route result");
    }
    const body = result.body as { raw: { status: unknown } };
    expect(body.raw.status).toEqual(statusFixture);
  });

  it("maps upstream errors to a 502 contract response", async () => {
    const listDevices = vi.fn(async () => [
      {
        deviceId: "tv-1",
        label: "Living Room TV",
        components: [{ id: "main", capabilities: [{ id: "switch" }, { id: "healthCheck" }] }],
        deviceTypeName: "Samsung TV",
      },
    ]);
    const getDeviceStatus = vi.fn(async () => {
      throw new SmartThingsHttpError("SmartThings request failed with 429", 429, {
        error: "rate_limit",
      });
    });
    const { context } = createContext({
      client: { getDeviceStatus, listDevices },
      pathname: "/devices/tv-1/status",
      requestMethod: "GET",
    });

    const result = await handleDeviceRoutes(context);

    expect(result).toMatchObject({
      statusCode: 502,
      body: {
        error: "smartthings_upstream_error",
        upstreamStatus: 429,
        upstreamBody: { error: "rate_limit" },
      },
    });
  });

  it("returns 503 when the adapter is missing a SmartThings auth token", async () => {
    const listDevices = vi.fn(async () => {
      throw new SmartThingsConfigError("Missing SmartThings auth token");
    });
    const { context } = createContext({
      client: { listDevices },
      pathname: "/devices",
      requestMethod: "GET",
    });

    const result = await handleDeviceRoutes(context);

    expect(result).toMatchObject({
      statusCode: 503,
      body: {
        error: "smartthings_auth_unconfigured",
        message: "Missing SmartThings auth token",
      },
    });
  });

  it("accepts command payloads and defaults missing components to main", async () => {
    const executeDeviceCommands = vi.fn(async () => ({ results: [{ status: "ACCEPTED" }] }));
    const { context, request } = createContext({
      client: { executeDeviceCommands },
      pathname: "/devices/tv-1/commands",
      requestMethod: "POST",
    });

    const resultPromise = handleDeviceRoutes(context);
    writeJson(request, {
      commands: [
        { capability: "switch", command: "on" },
        { capability: "audioVolume", command: "setVolume", arguments: [15], component: "sub" },
      ],
    });

    const result = await resultPromise;

    expect(executeDeviceCommands).toHaveBeenCalledWith("tv-1", [
      { capability: "switch", command: "on", component: "main" },
      { capability: "audioVolume", command: "setVolume", arguments: [15], component: "sub" },
    ]);
    expect(result).toMatchObject({
      statusCode: 202,
      body: {
        accepted: true,
        deviceId: "tv-1",
        results: [{ status: "ACCEPTED" }],
      },
    });
  });

  it("rejects malformed command payloads", async () => {
    const executeDeviceCommands = vi.fn();
    const { context, request } = createContext({
      client: { executeDeviceCommands },
      pathname: "/devices/tv-1/commands",
      requestMethod: "POST",
    });

    const resultPromise = handleDeviceRoutes(context);
    request.end("{");
    const result = await resultPromise;

    expect(result).toMatchObject({
      statusCode: 400,
      body: {
        error: "invalid_json",
      },
    });
  });

  it("rejects mixed-validity command payloads without executing partial commands", async () => {
    const executeDeviceCommands = vi.fn();
    const { context, request } = createContext({
      client: { executeDeviceCommands },
      pathname: "/devices/tv-1/commands",
      requestMethod: "POST",
    });

    const resultPromise = handleDeviceRoutes(context);
    writeJson(request, {
      commands: [{ capability: "switch", command: "on" }, { capability: "switch" }],
    });
    const result = await resultPromise;

    expect(executeDeviceCommands).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      statusCode: 400,
      body: {
        error: "invalid_command_payload",
      },
    });
  });

  it("returns 413 when the command payload exceeds the configured body limit", async () => {
    const executeDeviceCommands = vi.fn();
    const { context, request } = createContext({
      client: { executeDeviceCommands },
      pathname: "/devices/tv-1/commands",
      requestMethod: "POST",
    });
    context.config.maxBodyBytes = 12;

    const resultPromise = handleDeviceRoutes(context);
    writeJson(request, {
      commands: [{ capability: "switch", command: "on" }],
    });
    const result = await resultPromise;

    expect(executeDeviceCommands).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      statusCode: 413,
      body: {
        error: "payload_too_large",
      },
    });
  });
});
