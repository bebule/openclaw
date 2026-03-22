import crypto, { KeyObject, X509Certificate } from "node:crypto";

type HttpHeaderMap = Record<string, string | string[] | undefined>;

const DEFAULT_KEY_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const DEFAULT_REPLAY_CACHE_MAX_ENTRIES = 10_000;
const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const REQUIRED_SIGNED_HEADERS = ["(request-target)", "digest", "date"] as const;

type ReplayCache = {
  calls: number;
  seenUntil: Map<string, number>;
};

export type ParsedSmartThingsSignature = {
  algorithm: string | null;
  headers: string[];
  keyId: string;
  signature: string;
};

export type SmartThingsWebhookContext = {
  headers: HttpHeaderMap;
  method: string;
  rawBody: string;
  remoteAddress?: string;
  url: string;
};

export type SmartThingsWebhookVerificationResult =
  | {
      isReplay: boolean;
      ok: true;
      verifiedRequestKey: string;
    }
  | {
      ok: false;
      reason: string;
    };

export type SmartThingsWebhookVerifier = {
  verifyWebhook: (
    context: SmartThingsWebhookContext,
  ) => Promise<SmartThingsWebhookVerificationResult>;
};

export type ResolveSmartThingsPublicKey = (params: {
  keyId: string;
  url: string;
}) => Promise<KeyObject | string>;

export type CreateSmartThingsWebhookVerifierOptions = {
  keyCacheTtlMs?: number;
  maxSignatureAgeMs?: number;
  now?: () => number;
  publicUrl?: string | null;
  replayCacheMaxEntries?: number;
  replayWindowMs?: number;
  resolvePublicKey?: ResolveSmartThingsPublicKey;
};

type CachedPublicKey = {
  expiresAt: number;
  key: KeyObject;
};

export function createSmartThingsWebhookVerifier(
  options: CreateSmartThingsWebhookVerifierOptions = {},
): SmartThingsWebhookVerifier {
  const keyCache = new Map<string, CachedPublicKey>();
  const now = options.now ?? (() => Date.now());
  const replayCache: ReplayCache = {
    calls: 0,
    seenUntil: new Map<string, number>(),
  };
  const keyCacheTtlMs = Math.max(1_000, options.keyCacheTtlMs ?? DEFAULT_KEY_CACHE_TTL_MS);
  const maxSignatureAgeMs = Math.max(
    1_000,
    options.maxSignatureAgeMs ?? DEFAULT_MAX_SIGNATURE_AGE_MS,
  );
  const replayCacheMaxEntries = Math.max(
    1,
    options.replayCacheMaxEntries ?? DEFAULT_REPLAY_CACHE_MAX_ENTRIES,
  );
  const replayWindowMs = Math.max(1_000, options.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS);
  const resolvePublicKey = options.resolvePublicKey ?? fetchSmartThingsPublicKey;

  async function getCachedPublicKey(keyId: string): Promise<KeyObject> {
    const cacheHit = keyCache.get(keyId);
    const nowMs = now();
    if (cacheHit && cacheHit.expiresAt > nowMs) {
      return cacheHit.key;
    }

    const url = resolveSmartThingsKeyUrl(keyId);
    const resolved = await resolvePublicKey({ keyId, url });
    const key = coercePublicKey(resolved);
    keyCache.set(keyId, {
      expiresAt: nowMs + keyCacheTtlMs,
      key,
    });
    pruneKeyCache(keyCache, nowMs);
    return key;
  }

  return {
    verifyWebhook: async (context) => {
      const authorization = getHeader(context.headers, "authorization");
      const parsed = parseSmartThingsSignatureAuthorization(authorization);
      if (!parsed) {
        return {
          ok: false,
          reason: "Missing or invalid SmartThings Authorization signature header.",
        };
      }

      if (parsed.algorithm?.toLowerCase() !== "rsa-sha256") {
        return {
          ok: false,
          reason: `Unsupported SmartThings signature algorithm: ${parsed.algorithm ?? "missing"}`,
        };
      }

      const missingRequiredHeaders = REQUIRED_SIGNED_HEADERS.filter(
        (headerName) => !parsed.headers.includes(headerName),
      );
      if (missingRequiredHeaders.length > 0) {
        return {
          ok: false,
          reason: `Missing required SmartThings signed headers: ${missingRequiredHeaders.join(", ")}`,
        };
      }

      const digestHeader = getHeader(context.headers, "digest");
      if (!digestHeader) {
        return { ok: false, reason: "Missing SmartThings digest header." };
      }
      if (!verifySmartThingsDigest(digestHeader, context.rawBody)) {
        return { ok: false, reason: "SmartThings digest header did not match the request body." };
      }

      const dateHeader = getHeader(context.headers, "date");
      if (!dateHeader) {
        return { ok: false, reason: "Missing SmartThings date header." };
      }
      if (!isRecentHttpDate(dateHeader, now(), maxSignatureAgeMs)) {
        return { ok: false, reason: "SmartThings webhook signature is too old or invalid." };
      }

      const signingString = buildSmartThingsSigningString(
        context,
        parsed.headers,
        options.publicUrl,
      );
      if (!signingString) {
        return {
          ok: false,
          reason: "Unable to reconstruct the SmartThings signing string from request headers.",
        };
      }

      let publicKey: KeyObject;
      try {
        publicKey = await getCachedPublicKey(parsed.keyId);
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }

      const verified = crypto.verify(
        "RSA-SHA256",
        Buffer.from(signingString, "utf8"),
        publicKey,
        Buffer.from(parsed.signature, "base64"),
      );
      if (!verified) {
        return { ok: false, reason: "SmartThings webhook signature verification failed." };
      }

      const verifiedRequestKey = sha256Hex(
        `${parsed.keyId}\n${parsed.signature}\n${parsed.headers.join(" ")}\n${signingString}`,
      );
      const isReplay = markReplay(replayCache, verifiedRequestKey, now(), {
        maxEntries: replayCacheMaxEntries,
        ttlMs: replayWindowMs,
      });
      return { isReplay, ok: true, verifiedRequestKey };
    },
  };
}

export function parseSmartThingsSignatureAuthorization(
  value: string | undefined,
): ParsedSmartThingsSignature | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("Signature ")) {
    return null;
  }

  const attributes = new Map<string, string>();
  const pattern = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g;
  const source = trimmed.slice("Signature ".length);
  let match: RegExpExecArray | null = pattern.exec(source);
  while (match) {
    attributes.set(match[1], match[2]);
    match = pattern.exec(source);
  }

  const keyId = attributes.get("keyId")?.trim();
  const headersValue = attributes.get("headers")?.trim();
  const signature = attributes.get("signature")?.trim();
  if (!keyId || !headersValue || !signature) {
    return null;
  }

  const headers = headersValue
    .split(/\s+/u)
    .map((headerName) => headerName.trim().toLowerCase())
    .filter(Boolean);
  if (headers.length === 0) {
    return null;
  }

  return {
    algorithm: attributes.get("algorithm")?.trim().toLowerCase() ?? null,
    headers,
    keyId,
    signature,
  };
}

export function buildSmartThingsSigningString(
  context: SmartThingsWebhookContext,
  signedHeaders: string[],
  publicUrl: string | null | undefined,
): string | null {
  const lines: string[] = [];
  for (const headerName of signedHeaders) {
    const value = resolveSignedHeaderValue(context, headerName, publicUrl);
    if (value == null) {
      return null;
    }
    lines.push(`${headerName}: ${value}`);
  }
  return lines.join("\n");
}

export function verifySmartThingsDigest(digestHeader: string, rawBody: string): boolean {
  const expectedDigest = createSmartThingsDigestHeader(rawBody).split("=", 2)[1];
  const candidates = digestHeader
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    const [algorithm, value] = candidate.split("=", 2);
    if (algorithm?.trim().toLowerCase() !== "sha-256") {
      continue;
    }
    if (!value) {
      continue;
    }
    const actualBuffer = Buffer.from(value.trim());
    const expectedBuffer = Buffer.from(expectedDigest);
    if (
      actualBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      return true;
    }
  }
  return false;
}

export function createSmartThingsDigestHeader(rawBody: string): string {
  return `SHA-256=${crypto.createHash("sha256").update(rawBody, "utf8").digest("base64")}`;
}

export function resolveSmartThingsKeyUrl(keyId: string): string {
  const trimmed = keyId.trim();
  if (!trimmed) {
    throw new Error("Missing SmartThings keyId.");
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" || parsed.hostname !== "key.smartthings.com") {
      throw new Error(`Unsupported SmartThings key host: ${parsed.origin}`);
    }
    return parsed.toString();
  }

  const normalizedPath = trimmed.replace(/^\/+/u, "");
  const resolvedPath = normalizedPath.startsWith("key/") ? normalizedPath : `key/${normalizedPath}`;
  return new URL(resolvedPath, "https://key.smartthings.com/").toString();
}

function resolveSignedHeaderValue(
  context: SmartThingsWebhookContext,
  headerName: string,
  publicUrl: string | null | undefined,
): string | null {
  if (headerName === "(request-target)") {
    return buildRequestTarget(context.method, context.url);
  }
  if (headerName === "host") {
    return resolveSignedHostHeader(context.headers, publicUrl);
  }
  const value = getHeader(context.headers, headerName);
  return value?.trim() || null;
}

function buildRequestTarget(method: string, url: string): string {
  const parsed = new URL(url);
  const path = `${parsed.pathname}${parsed.search}`;
  return `${method.toLowerCase()} ${path || "/"}`;
}

function resolveSignedHostHeader(
  headers: HttpHeaderMap,
  publicUrl: string | null | undefined,
): string | null {
  const hostHeader = getHeader(headers, "host")?.trim();
  if (!publicUrl) {
    return hostHeader || null;
  }

  const expectedHost = new URL(publicUrl).host;
  const forwardedHeaders = ["x-forwarded-host", "x-original-host", "ngrok-forwarded-host"];
  const normalizedExpectedHost = normalizeHost(expectedHost);
  if (hostHeader && normalizeHost(hostHeader) === normalizedExpectedHost) {
    return expectedHost;
  }

  for (const headerName of forwardedHeaders) {
    const forwardedHost = getHeader(headers, headerName)?.trim();
    if (forwardedHost && normalizeHost(forwardedHost) === normalizedExpectedHost) {
      return expectedHost;
    }
  }

  return hostHeader || null;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

export function getHeader(headers: HttpHeaderMap, name: string): string | undefined {
  const target = name.toLowerCase();
  const direct = headers[target];
  const value =
    direct ?? Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function isRecentHttpDate(value: string, nowMs: number, maxAgeMs: number): boolean {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return Math.abs(nowMs - parsed) <= maxAgeMs;
}

async function fetchSmartThingsPublicKey(params: { keyId: string; url: string }): Promise<string> {
  const response = await fetch(params.url, {
    headers: {
      accept: "application/x-pem-file, application/pem-certificate-chain, text/plain",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Unable to fetch SmartThings public key for ${params.keyId}: HTTP ${response.status}`,
    );
  }
  return await response.text();
}

function coercePublicKey(value: KeyObject | string): KeyObject {
  if (value instanceof KeyObject) {
    return value;
  }
  if (value.includes("BEGIN CERTIFICATE")) {
    return new X509Certificate(value).publicKey;
  }
  return crypto.createPublicKey(value);
}

function markReplay(
  cache: ReplayCache,
  replayKey: string,
  nowMs: number,
  options: { maxEntries: number; ttlMs: number },
): boolean {
  cache.calls += 1;
  if (cache.calls % 64 === 0) {
    pruneReplayCache(cache, nowMs, options.maxEntries);
  }

  const existing = cache.seenUntil.get(replayKey);
  if (existing && existing > nowMs) {
    return true;
  }

  cache.seenUntil.set(replayKey, nowMs + options.ttlMs);
  pruneReplayCache(cache, nowMs, options.maxEntries);
  return false;
}

function pruneReplayCache(cache: ReplayCache, nowMs: number, maxEntries: number): void {
  for (const [key, expiresAt] of cache.seenUntil) {
    if (expiresAt <= nowMs) {
      cache.seenUntil.delete(key);
    }
  }
  while (cache.seenUntil.size > maxEntries) {
    const oldestKey = cache.seenUntil.keys().next().value;
    if (!oldestKey) {
      break;
    }
    cache.seenUntil.delete(oldestKey);
  }
}

function pruneKeyCache(cache: Map<string, CachedPublicKey>, nowMs: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= nowMs) {
      cache.delete(key);
    }
  }
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}
