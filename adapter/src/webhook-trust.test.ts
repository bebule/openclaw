import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createSmartThingsWebhookVerifier,
  parseSmartThingsSignatureAuthorization,
} from "./webhook-trust.js";

const FIXED_NOW_MS = Date.parse("2026-03-21T12:00:00.000Z");
const KEY_ID = "/pl/useast1/test-smartthings-key";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const { privateKey: invalidPrivateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

function createDigest(rawBody: string): string {
  return `SHA-256=${crypto.createHash("sha256").update(rawBody, "utf8").digest("base64")}`;
}

function buildSigningString(params: {
  date: string;
  digest: string;
  headers: string[];
  host?: string;
  method: string;
  url: string;
}): string {
  const requestUrl = new URL(params.url);
  return params.headers
    .map((headerName) => {
      if (headerName === "(request-target)") {
        return `${headerName}: ${params.method.toLowerCase()} ${requestUrl.pathname}${requestUrl.search}`;
      }
      if (headerName === "digest") {
        return `${headerName}: ${params.digest}`;
      }
      if (headerName === "date") {
        return `${headerName}: ${params.date}`;
      }
      if (headerName === "host") {
        return `${headerName}: ${params.host ?? requestUrl.host}`;
      }
      throw new Error(`Unsupported test header: ${headerName}`);
    })
    .join("\n");
}

function createSignedWebhookRequest(params?: {
  authorizationOverride?: string;
  dateOffsetMs?: number;
  extraHeaders?: Record<string, string>;
  headersList?: string[];
  host?: string;
  method?: string;
  privateKeyOverride?: crypto.KeyObject;
  rawBody?: string;
  url?: string;
}): {
  headers: Record<string, string>;
  method: string;
  rawBody: string;
  url: string;
} {
  const rawBody = params?.rawBody ?? JSON.stringify({ lifecycle: "INSTALL" });
  const method = params?.method ?? "POST";
  const url = params?.url ?? "https://gateway.example.test/webhooks/smartthings";
  const requestUrl = new URL(url);
  const digest = createDigest(rawBody);
  const date = new Date(FIXED_NOW_MS + (params?.dateOffsetMs ?? 0)).toUTCString();
  const headersList = params?.headersList ?? ["(request-target)", "digest", "date"];
  const signingString = buildSigningString({
    date,
    digest,
    headers: headersList,
    host: params?.host ?? requestUrl.host,
    method,
    url,
  });
  const signature = crypto
    .sign(
      "RSA-SHA256",
      Buffer.from(signingString, "utf8"),
      params?.privateKeyOverride ?? privateKey,
    )
    .toString("base64");
  const authorization =
    params?.authorizationOverride ??
    `Signature keyId="${KEY_ID}" headers="${headersList.join(" ")}" algorithm="rsa-sha256" signature="${signature}"`;

  return {
    headers: {
      authorization,
      date,
      digest,
      host: params?.host ?? requestUrl.host,
      ...params?.extraHeaders,
    },
    method,
    rawBody,
    url,
  };
}

function createVerifier() {
  return createSmartThingsWebhookVerifier({
    now: () => FIXED_NOW_MS,
    resolvePublicKey: async () => publicKey,
  });
}

describe("smartthings webhook trust", () => {
  it("parses canonical SmartThings authorization headers", () => {
    const { headers } = createSignedWebhookRequest();
    const parsed = parseSmartThingsSignatureAuthorization(headers.authorization);

    expect(parsed).toMatchObject({
      algorithm: "rsa-sha256",
      headers: ["(request-target)", "digest", "date"],
      keyId: KEY_ID,
    });
    expect(parsed?.signature.length).toBeGreaterThan(10);
  });

  it("rejects malformed or incomplete SmartThings authorization headers", async () => {
    expect(parseSmartThingsSignatureAuthorization("Bearer token")).toBeNull();
    expect(
      parseSmartThingsSignatureAuthorization(`Signature keyId="${KEY_ID}" headers="date"`),
    ).toBeNull();

    const verifier = createVerifier();
    const result = await verifier.verifyWebhook({
      headers: {},
      method: "POST",
      rawBody: "{}",
      url: "https://gateway.example.test/webhooks/smartthings",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Authorization"),
    });
  });

  it("rejects requests when required signed headers are missing", async () => {
    const verifier = createVerifier();
    const request = createSignedWebhookRequest();
    delete request.headers.digest;

    const result = await verifier.verifyWebhook(request);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("digest"),
    });
  });

  it("rejects requests when a referenced signed header value is missing", async () => {
    const verifier = createVerifier();
    const request = createSignedWebhookRequest({
      headersList: ["(request-target)", "digest", "date", "host"],
    });
    delete request.headers.host;

    const result = await verifier.verifyWebhook(request);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("signing string"),
    });
  });

  it("rejects digest mismatches", async () => {
    const verifier = createVerifier();
    const request = createSignedWebhookRequest();
    request.headers.digest = createDigest('{"lifecycle":"UPDATE"}');

    const result = await verifier.verifyWebhook(request);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("digest"),
    });
  });

  it("rejects signature mismatches", async () => {
    const verifier = createVerifier();
    const request = createSignedWebhookRequest({
      privateKeyOverride: invalidPrivateKey,
    });

    const result = await verifier.verifyWebhook(request);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("verification failed"),
    });
  });

  it("rejects stale SmartThings signature dates", async () => {
    const verifier = createVerifier();
    const request = createSignedWebhookRequest({
      dateOffsetMs: -(6 * 60 * 1000),
    });

    const result = await verifier.verifyWebhook(request);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("too old"),
    });
  });

  it("returns a stable verifiedRequestKey for the same authenticated request", async () => {
    const request = createSignedWebhookRequest();
    const first = await createVerifier().verifyWebhook(request);
    const second = await createVerifier().verifyWebhook(request);

    expect(first).toMatchObject({ ok: true, isReplay: false });
    expect(second).toMatchObject({ ok: true, isReplay: false });
    if (!first.ok || !second.ok) {
      throw new Error("expected successful webhook verification");
    }
    expect(first.verifiedRequestKey).toBe(second.verifiedRequestKey);
  });

  it("marks the second identical verified request as replay", async () => {
    const verifier = createVerifier();
    const request = createSignedWebhookRequest();

    const first = await verifier.verifyWebhook(request);
    const second = await verifier.verifyWebhook(request);

    expect(first).toMatchObject({ ok: true, isReplay: false });
    expect(second).toMatchObject({ ok: true, isReplay: true });
    if (!first.ok || !second.ok) {
      throw new Error("expected successful webhook verification");
    }
    expect(first.verifiedRequestKey).toBe(second.verifiedRequestKey);
  });
});
