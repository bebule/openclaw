export class SmartThingsCliError extends Error {
  constructor(message: string);
}

export function readAdapterConfig(): {
  adapterToken: string | null;
  adapterUrl: string;
  timeoutMs: number;
};

export function requestAdapterJson(method: string, path: string, body?: unknown): Promise<unknown>;

export function printJson(value: unknown): void;

export function printUsage(message: string | undefined, usageLines: string[]): void;

export function normalizeJsonArgs(rawValue: string | undefined): {
  hasValue: boolean;
  value: unknown;
};

export function buildCommandInvocation(argv: string[]): {
  arguments?: unknown;
  capability: string;
  command: string;
  component?: string;
  deviceId: string;
};

export function summarizeDeviceStatus(response: unknown): {
  device: unknown;
  normalized: unknown;
  normalizedState: unknown;
  raw: unknown;
};
