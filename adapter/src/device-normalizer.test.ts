import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeTvStatus, summarizeDevice } from "./device-normalizer.js";
import type {
  SmartThingsDeviceHealth,
  SmartThingsDeviceStatus,
  SmartThingsDeviceSummary,
} from "./smartthings-client.js";

const fixtureRoot = path.resolve("fixtures/samsung-tv");

async function loadStatusFixture(name: string): Promise<SmartThingsDeviceStatus> {
  const text = await fs.readFile(path.join(fixtureRoot, name), "utf8");
  return JSON.parse(text) as SmartThingsDeviceStatus;
}

function buildDeviceSummary(): SmartThingsDeviceSummary {
  return {
    deviceId: "tv-living-room",
    deviceTypeName: "Samsung TV",
    label: "Living Room TV",
    manufacturerName: "Samsung Electronics",
    components: [
      {
        id: "main",
        capabilities: [
          { id: "healthCheck", version: 1 },
          { id: "switch", version: 1 },
          { id: "audioVolume", version: 1 },
        ],
      },
    ],
  };
}

describe("device normalizer", () => {
  it("summarizes Samsung TVs as TV candidates", () => {
    const summary = summarizeDevice(buildDeviceSummary());

    expect(summary).toMatchObject({
      capabilities: ["audioVolume", "healthCheck", "switch"],
      deviceId: "tv-living-room",
      isTvCandidate: true,
      label: "Living Room TV",
      manufacturerName: "Samsung Electronics",
    });
  });

  it("treats Samsung monitors with TV capabilities as TV candidates", () => {
    const summary = summarizeDevice({
      components: [
        {
          id: "main",
          capabilities: [
            { id: "switch", version: 1 },
            { id: "mediaInputSource", version: 1 },
            { id: "samsungvd.remoteControl", version: 1 },
          ],
        },
      ],
      deviceId: "monitor-1",
      deviceTypeName: "x.com.st.d.monitor",
      label: "Samsung M7 32",
      manufacturerName: "Samsung Electronics",
    });

    expect(summary.isTvCandidate).toBe(true);
  });

  it("does not classify non-TV Samsung appliances as TV candidates", () => {
    const summary = summarizeDevice({
      components: [
        {
          id: "main",
          capabilities: [
            { id: "switch", version: 1 },
            { id: "refresh", version: 1 },
            { id: "remoteControlStatus", version: 1 },
          ],
        },
      ],
      deviceId: "washer-1",
      deviceTypeName: "Samsung OCF Washer",
      label: "세탁기",
      manufacturerName: "Samsung Electronics",
    });

    expect(summary.isTvCandidate).toBe(false);
  });

  it("normalizes an online TV with switch on to on", async () => {
    const status = await loadStatusFixture("sample-status.json");
    const normalized = normalizeTvStatus(buildDeviceSummary(), status, { state: "ONLINE" });

    expect(normalized.state).toBe("on");
    expect(normalized.reasons).toEqual(["health_online", "switch_on"]);
    expect(normalized.capabilitiesSeen).toEqual([
      "health.endpoint.state",
      "healthCheck.DeviceWatch-DeviceStatus",
      "switch.switch",
      "ocf.st",
    ]);
  });

  it("normalizes an online TV with switch off to standby", async () => {
    const status = await loadStatusFixture("standby-status.json");
    const normalized = normalizeTvStatus(buildDeviceSummary(), status, { healthStatus: "ONLINE" });

    expect(normalized.state).toBe("standby");
    expect(normalized.reasons).toEqual(["health_online", "switch_off"]);
  });

  it("normalizes an offline TV to offline even if switch data looks stale", async () => {
    const status = await loadStatusFixture("offline-status.json");
    const normalized = normalizeTvStatus(buildDeviceSummary(), status, { state: "OFFLINE" });

    expect(normalized.state).toBe("offline");
    expect(normalized.reasons).toContain("health_offline");
  });

  it("returns unknown when health is missing", async () => {
    const status = await loadStatusFixture("missing-health-status.json");
    const normalized = normalizeTvStatus(
      buildDeviceSummary(),
      status,
      undefined as unknown as SmartThingsDeviceHealth,
    );

    expect(normalized.state).toBe("unknown");
    expect(normalized.reasons).toEqual(["health_missing"]);
  });
});
