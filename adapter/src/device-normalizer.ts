import type {
  SmartThingsAttributeState,
  SmartThingsDeviceHealth,
  SmartThingsDeviceStatus,
  SmartThingsDeviceSummary,
} from "./smartthings-client.js";

export type NormalizedTvState = "offline" | "on" | "standby" | "unknown";

export type NormalizedDeviceSummary = {
  capabilities: string[];
  deviceId: string;
  deviceTypeName?: string;
  isTvCandidate: boolean;
  label: string;
  locationId?: string;
  manufacturerName?: string;
  name?: string;
  presentationId?: string;
  roomId?: string;
};

export type TvStateSignal = {
  classification: "offline" | "online" | "power-off" | "power-on" | "unknown";
  source: string;
  timestamp: string | null;
  value: string | null;
};

export type NormalizedTvStatus = {
  capabilities: string[];
  capabilitiesSeen: string[];
  deviceId: string;
  isTvCandidate: boolean;
  observedAt: string | null;
  rawSignals: Record<string, string | null>;
  reasons: string[];
  signals: TvStateSignal[];
  state: NormalizedTvState;
};

const TV_TEXT_HINTS = ["monitor", "screen", "television", "tv"];
const TV_CAPABILITY_HINTS = new Set([
  "custom.launchapp",
  "custom.picturemode",
  "custom.soundmode",
  "custom.tvsearch",
  "mediaInputSource",
  "mediaPlayback",
  "mediaTrackControl",
  "samsungvd.ambient",
  "samsungvd.ambientContent",
  "samsungvd.mediaInputSource",
  "samsungvd.remoteControl",
  "samsungvd.supportsFeatures",
  "tvChannel",
]);

export function summarizeDevice(device: SmartThingsDeviceSummary): NormalizedDeviceSummary {
  const capabilities = listDeviceCapabilities(device);

  return {
    capabilities,
    deviceId: device.deviceId,
    isTvCandidate: isTvCandidate(device, capabilities),
    label: device.label ?? device.name ?? device.deviceId,
    ...(device.deviceTypeName ? { deviceTypeName: device.deviceTypeName } : {}),
    ...(device.locationId ? { locationId: device.locationId } : {}),
    ...(device.manufacturerName ? { manufacturerName: device.manufacturerName } : {}),
    ...(device.name ? { name: device.name } : {}),
    ...(device.presentationId ? { presentationId: device.presentationId } : {}),
    ...(device.roomId ? { roomId: device.roomId } : {}),
  };
}

export function normalizeTvStatus(
  device: SmartThingsDeviceSummary,
  status: SmartThingsDeviceStatus,
  health?: SmartThingsDeviceHealth,
): NormalizedTvStatus {
  const summary = summarizeDevice(device);
  const healthSignals = [
    buildSignal("health.endpoint.state", health?.state ?? health?.healthStatus ?? null),
    buildSignal(
      "healthCheck.DeviceWatch-DeviceStatus",
      stringifyAttribute(status, "healthCheck", "DeviceWatch-DeviceStatus"),
      firstTimestamp(status, "healthCheck", "DeviceWatch-DeviceStatus"),
    ),
    buildSignal(
      "healthCheck.healthStatus",
      stringifyAttribute(status, "healthCheck", "healthStatus"),
      firstTimestamp(status, "healthCheck", "healthStatus"),
    ),
  ].filter((entry): entry is TvStateSignal => entry !== null);
  const switchSignal = buildSignal(
    "switch.switch",
    stringifyAttribute(status, "switch", "switch"),
    firstTimestamp(status, "switch", "switch"),
  );
  const ocfSignal = buildSignal(
    "ocf.st",
    firstStringValue(status, [
      ["ocf", "st"],
      ["ocf", "status"],
      ["ocf", "deviceConnectionState"],
    ]),
    firstTimestamp(status, "ocf", "st") ??
      firstTimestamp(status, "ocf", "status") ??
      firstTimestamp(status, "ocf", "deviceConnectionState"),
  );
  const samsungSignal = buildSignal(
    "samsungvd.deviceState",
    firstStringValue(status, [
      ["samsungvd.deviceState", "deviceState"],
      ["custom.devicePower", "powerState"],
    ]),
    firstTimestamp(status, "samsungvd.deviceState", "deviceState") ??
      firstTimestamp(status, "custom.devicePower", "powerState"),
  );
  const signals = [...healthSignals, switchSignal, ocfSignal, samsungSignal].filter(
    (entry): entry is TvStateSignal => entry !== null,
  );
  const primaryHealthSignal = selectPrimaryHealthSignal(healthSignals);
  const resolution = resolveNormalizedState(primaryHealthSignal, switchSignal);

  return {
    capabilities: summary.capabilities,
    capabilitiesSeen: Array.from(new Set(signals.map((signal) => signal.source))),
    deviceId: summary.deviceId,
    isTvCandidate: summary.isTvCandidate,
    observedAt: latestTimestamp(signals),
    rawSignals: {
      healthEndpointState: health?.state ?? health?.healthStatus ?? null,
      healthStatus: primaryHealthSignal?.value ?? null,
      ocfStatus: ocfSignal?.value ?? null,
      samsungvdDeviceState: samsungSignal?.value ?? null,
      switch: switchSignal?.value ?? null,
    },
    reasons: resolution.reasons,
    signals,
    state: resolution.state,
  };
}

export function listDeviceCapabilities(device: SmartThingsDeviceSummary): string[] {
  const values = new Set<string>();
  for (const component of device.components ?? []) {
    for (const capability of component.capabilities ?? []) {
      if (capability.id) {
        values.add(capability.id);
      }
    }
  }
  return Array.from(values).toSorted();
}

function isTvCandidate(device: SmartThingsDeviceSummary, capabilities: string[]): boolean {
  const textHaystack = [device.deviceTypeName, device.label, device.name]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
  return (
    TV_TEXT_HINTS.some((hint) => textHaystack.includes(hint)) ||
    capabilities.some((capability) => TV_CAPABILITY_HINTS.has(capability))
  );
}

function selectPrimaryHealthSignal(signals: TvStateSignal[]): TvStateSignal | null {
  return (
    signals.find(
      (signal) =>
        signal.source === "health.endpoint.state" &&
        (signal.classification === "offline" || signal.classification === "online"),
    ) ??
    signals.find(
      (signal) => signal.classification === "offline" || signal.classification === "online",
    ) ??
    signals[0] ??
    null
  );
}

function resolveNormalizedState(
  healthSignal: TvStateSignal | null,
  switchSignal: TvStateSignal | null,
): { reasons: string[]; state: NormalizedTvState } {
  if (healthSignal?.classification === "offline") {
    return {
      reasons: [
        "health_offline",
        ...(switchSignal?.classification === "power-on" ? ["switch_conflicts_with_health"] : []),
      ],
      state: "offline",
    };
  }

  if (healthSignal?.classification === "online" && switchSignal?.classification === "power-on") {
    return { reasons: ["health_online", "switch_on"], state: "on" };
  }

  if (healthSignal?.classification === "online" && switchSignal?.classification === "power-off") {
    return { reasons: ["health_online", "switch_off"], state: "standby" };
  }

  if (healthSignal?.classification === "online") {
    return { reasons: ["health_online", "switch_missing_or_unknown"], state: "unknown" };
  }

  if (healthSignal === null) {
    return { reasons: ["health_missing"], state: "unknown" };
  }

  return { reasons: ["insufficient_primary_signals"], state: "unknown" };
}

function buildSignal(
  source: string,
  value: string | null,
  timestamp: string | null = null,
): TvStateSignal | null {
  if (value === null) {
    return null;
  }
  const normalized = value.toLowerCase();
  if (matches(normalized, ["disconnected", "inactive", "offline", "unavailable"])) {
    return { classification: "offline", source, timestamp, value };
  }
  if (matches(normalized, ["connected", "ok", "online"])) {
    return { classification: "online", source, timestamp, value };
  }
  if (matches(normalized, ["active", "on", "playing", "ready"])) {
    return { classification: "power-on", source, timestamp, value };
  }
  if (matches(normalized, ["off", "sleep", "standby"])) {
    return { classification: "power-off", source, timestamp, value };
  }
  return { classification: "unknown", source, timestamp, value };
}

function stringifyAttribute(
  status: SmartThingsDeviceStatus,
  capability: string,
  attribute: string,
): string | null {
  return stringifyStateValue(status.components?.main?.[capability]?.[attribute]);
}

function firstTimestamp(
  status: SmartThingsDeviceStatus,
  capability: string,
  attribute: string,
): string | null {
  return status.components?.main?.[capability]?.[attribute]?.timestamp ?? null;
}

function firstStringValue(
  status: SmartThingsDeviceStatus,
  candidates: Array<[capability: string, attribute: string]>,
): string | null {
  for (const [capability, attribute] of candidates) {
    const state = status.components?.main?.[capability]?.[attribute];
    const value = stringifyStateValue(state);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function stringifyStateValue(state: SmartThingsAttributeState | undefined): string | null {
  const value = state?.value;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  return null;
}

function matches(value: string, candidates: string[]): boolean {
  return candidates.includes(value);
}

function latestTimestamp(signals: TvStateSignal[]): string | null {
  return signals.reduce<string | null>((latest, signal) => {
    if (!signal.timestamp) {
      return latest;
    }
    if (!latest || signal.timestamp > latest) {
      return signal.timestamp;
    }
    return latest;
  }, null);
}
