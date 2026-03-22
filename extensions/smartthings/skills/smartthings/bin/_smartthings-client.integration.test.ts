import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RouteContext } from "../../../../../adapter/src/app.js";
import { handleDeviceRoutes } from "../../../../../adapter/src/routes/devices.js";
import { requestAdapterJson, summarizeDeviceStatus } from "./_smartthings-client.js";

const fixtureRoot = path.resolve("fixtures/samsung-tv");

async function startDeviceRouteServer(client: Partial<RouteContext["client"]>) {
  const server = createServer(async (request, response) => {
    const context = {
      client: client as RouteContext["client"],
      config: {
        baseUrl: "https://api.smartthings.com/v1",
        bindHost: "127.0.0.1",
        defaultInstalledAppId: null,
        maxBodyBytes: 256 * 1024,
        port: 0,
        publicUrl: null,
        requestTimeoutMs: 10_000,
      },
      request,
      response,
      url: new URL(request.url ?? "/", "http://127.0.0.1"),
    } satisfies RouteContext;

    const result = await handleDeviceRoutes(context);
    if (!result) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    response.statusCode = result.statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(result.body ?? {}));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  return {
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    url: `http://127.0.0.1:${(address as AddressInfo).port}`,
  };
}

describe("smartthings helper client integration", () => {
  it("reads device lists over HTTP from the adapter route", async () => {
    const runtime = await startDeviceRouteServer({
      listDevices: async () => [
        {
          deviceId: "tv-1",
          label: "Living Room TV",
          components: [{ id: "main", capabilities: [{ id: "switch" }, { id: "healthCheck" }] }],
          deviceTypeName: "Samsung TV",
        },
      ],
    });
    vi.stubEnv("SMARTTHINGS_ADAPTER_URL", runtime.url);

    try {
      const payload = await requestAdapterJson("GET", "/devices");

      expect(payload).toMatchObject({
        count: 1,
        items: [{ deviceId: "tv-1", isTvCandidate: true, label: "Living Room TV" }],
      });
    } finally {
      await runtime.close();
    }
  });

  it("reads normalized TV state from the adapter route and summarizes it", async () => {
    const statusFixture = JSON.parse(
      await fs.readFile(path.join(fixtureRoot, "sample-status.json"), "utf8"),
    ) as Record<string, unknown>;
    const runtime = await startDeviceRouteServer({
      getDeviceHealth: async () => ({ healthStatus: "ONLINE", state: "ONLINE" }),
      getDeviceStatus: async () => statusFixture,
      listDevices: async () => [
        {
          deviceId: "tv-1",
          label: "Living Room TV",
          components: [{ id: "main", capabilities: [{ id: "switch" }, { id: "healthCheck" }] }],
          deviceTypeName: "Samsung TV",
        },
      ],
    });
    vi.stubEnv("SMARTTHINGS_ADAPTER_URL", runtime.url);

    try {
      const payload = await requestAdapterJson("GET", "/devices/tv-1/status");
      const summary = summarizeDeviceStatus(payload);

      expect(summary).toMatchObject({
        device: { deviceId: "tv-1", label: "Living Room TV" },
        normalized: { state: "on", tvState: "on" },
        normalizedState: "on",
      });
    } finally {
      await runtime.close();
    }
  });
});
