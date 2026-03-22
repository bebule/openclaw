import type { RouteContext, RouteResult } from "../app.js";
import { AdapterRequestError, json, readJsonBody } from "../app.js";
import { normalizeTvStatus, summarizeDevice } from "../device-normalizer.js";
import type { SmartThingsDeviceCommand, SmartThingsHttpError } from "../smartthings-client.js";
import { SmartThingsConfigError } from "../smartthings-client.js";

export async function handleDeviceRoutes(context: RouteContext): Promise<RouteResult | null> {
  const segments = splitPath(context.url.pathname);
  if (segments.length === 1 && segments[0] === "devices") {
    if (context.request.method !== "GET") {
      return json(405, { error: "method_not_allowed" });
    }
    return await handleListDevices(context);
  }

  if (segments.length === 3 && segments[0] === "devices" && segments[2] === "status") {
    if (context.request.method !== "GET") {
      return json(405, { error: "method_not_allowed" });
    }
    return await handleGetDeviceStatus(context, segments[1]);
  }

  if (segments.length === 3 && segments[0] === "devices" && segments[2] === "commands") {
    if (context.request.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }
    return await handleSendCommands(context, segments[1]);
  }

  return null;
}

async function handleListDevices(context: RouteContext): Promise<RouteResult> {
  try {
    const devices = await context.client.listDevices();
    const tvOnly = context.url.searchParams.get("tvOnly") === "true";
    const summaries = devices.map((device) => summarizeDevice(device));
    const filtered = tvOnly ? summaries.filter((device) => device.isTvCandidate) : summaries;
    return json(200, {
      count: filtered.length,
      devices: filtered,
      items: filtered,
    });
  } catch (error) {
    return smartThingsErrorToResponse(error);
  }
}

async function handleGetDeviceStatus(
  context: RouteContext,
  deviceId: string,
): Promise<RouteResult> {
  try {
    const devices = await context.client.listDevices();
    const device = devices.find((entry) => entry.deviceId === deviceId);
    if (!device) {
      return json(404, { error: "device_not_found", deviceId });
    }

    const status = await context.client.getDeviceStatus(deviceId);
    let health = null;
    try {
      health = await context.client.getDeviceHealth(deviceId);
    } catch (error) {
      const candidate = error as SmartThingsHttpError;
      if (candidate?.name !== "SmartThingsHttpError" || candidate.statusCode !== 404) {
        throw error;
      }
    }

    const normalized = normalizeTvStatus(device, status, health ?? undefined);

    return json(200, {
      device: summarizeDevice(device),
      normalized: {
        capabilitiesSeen: normalized.capabilitiesSeen,
        kind: "tv",
        observedAt: normalized.observedAt,
        reasons: normalized.reasons,
        state: normalized.state,
        tvState: normalized.state,
      },
      normalizedState: {
        details: {
          capabilitiesSeen: normalized.capabilitiesSeen,
          observedAt: normalized.observedAt,
          rawSignals: normalized.rawSignals,
          reasons: normalized.reasons,
          signals: normalized.signals,
        },
        source: "adapter",
        state: normalized.state,
      },
      raw: {
        ...(health ? { health } : {}),
        status,
      },
    });
  } catch (error) {
    return smartThingsErrorToResponse(error);
  }
}

async function handleSendCommands(context: RouteContext, deviceId: string): Promise<RouteResult> {
  try {
    const payload = await readJsonBody<unknown>(context.request, context.config.maxBodyBytes);
    const commands = parseCommands(payload);
    if (commands.length === 0) {
      return json(400, {
        error: "invalid_command_payload",
        message: "Request body must provide at least one SmartThings command.",
      });
    }

    const result = await context.client.executeDeviceCommands(deviceId, commands);
    const results =
      result &&
      typeof result === "object" &&
      Array.isArray((result as { results?: unknown[] }).results)
        ? (result as { results: unknown[] }).results
        : [];

    return json(202, {
      accepted: true,
      commands,
      deviceId,
      results,
      upstream: result ?? null,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json(400, { error: "invalid_json", message: error.message });
    }
    return smartThingsErrorToResponse(error);
  }
}

function parseCommands(payload: unknown): SmartThingsDeviceCommand[] {
  const rawCommands = Array.isArray(payload)
    ? payload
    : payload !== null &&
        typeof payload === "object" &&
        Array.isArray((payload as { commands?: unknown[] }).commands)
      ? (payload as { commands: unknown[] }).commands
      : [];

  return rawCommands.map((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      throw new AdapterRequestError(
        `Command at index ${index} must be an object.`,
        400,
        "invalid_command_payload",
      );
    }
    const candidate = entry as Partial<SmartThingsDeviceCommand>;
    if (typeof candidate.capability !== "string" || typeof candidate.command !== "string") {
      throw new AdapterRequestError(
        `Command at index ${index} must include string capability and command fields.`,
        400,
        "invalid_command_payload",
      );
    }
    return {
      arguments: Array.isArray(candidate.arguments) ? candidate.arguments : undefined,
      capability: candidate.capability,
      command: candidate.command,
      component: typeof candidate.component === "string" ? candidate.component : "main",
    };
  });
}

function splitPath(pathname: string): string[] {
  return pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

function smartThingsErrorToResponse(error: unknown): RouteResult {
  if (error instanceof AdapterRequestError) {
    return json(error.statusCode, {
      error: error.errorCode,
      message: error.message,
    });
  }

  if (error instanceof SmartThingsConfigError) {
    return json(503, {
      error: error.errorCode,
      message: error.message,
    });
  }

  const candidate = error as SmartThingsHttpError;
  if (candidate?.name === "SmartThingsHttpError") {
    const statusCode =
      candidate.statusCode === 400
        ? 400
        : candidate.statusCode === 404
          ? 404
          : candidate.statusCode === 504
            ? 504
            : 502;

    return json(statusCode, {
      error: statusCode === 404 ? "device_not_found" : "smartthings_upstream_error",
      message: candidate.message,
      upstreamBody: candidate.responseBody ?? null,
      upstreamStatus: candidate.statusCode,
    });
  }
  return json(500, {
    error: "adapter_error",
    message: error instanceof Error ? error.message : String(error),
  });
}
