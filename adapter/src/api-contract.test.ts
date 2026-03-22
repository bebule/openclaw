import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type OpenApiMediaType = {
  schema?: OpenApiSchema;
};

type OpenApiResponse = {
  content?: Record<string, OpenApiMediaType>;
};

type OpenApiOperation = {
  requestBody?: {
    content?: Record<string, OpenApiMediaType>;
  };
  responses?: Record<string, OpenApiResponse>;
};

type OpenApiSchema = {
  enum?: string[];
  items?: OpenApiSchema;
  minItems?: number;
  oneOf?: OpenApiSchema[];
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  type?: string;
};

type OpenApiDocument = {
  components?: {
    schemas?: Record<string, OpenApiSchema>;
  };
  paths?: Record<string, Record<string, OpenApiOperation>>;
};

async function loadContract(): Promise<OpenApiDocument> {
  const raw = await readFile(path.resolve("docs/api-contract.yaml"), "utf8");
  return parse(raw) as OpenApiDocument;
}

describe("SmartThings API contract", () => {
  it("defines the expected SmartThings adapter routes", async () => {
    const contract = await loadContract();
    const paths = contract.paths ?? {};

    expect(paths["/health"]?.get).toBeDefined();
    expect(paths["/devices"]?.get).toBeDefined();
    expect(paths["/devices/{deviceId}/status"]?.get).toBeDefined();
    expect(paths["/devices/{deviceId}/commands"]?.post).toBeDefined();
    expect(paths["/subscriptions/bootstrap"]?.post).toBeDefined();
    expect(paths["/webhooks/smartthings"]?.post).toBeDefined();
  });

  it("keeps the health contract anchored to the HealthResponse schema", async () => {
    const contract = await loadContract();
    const healthResponseSchemaRef =
      contract.paths?.["/health"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema;
    const healthResponse = contract.components?.schemas?.HealthResponse;
    const healthReadiness = contract.components?.schemas?.HealthReadiness;

    expect(healthResponseSchemaRef).toMatchObject({ $ref: "#/components/schemas/HealthResponse" });
    expect(healthResponse?.required).toEqual([
      "ok",
      "mode",
      "smartthings",
      "readiness",
      "blockers",
    ]);
    expect(healthReadiness?.required).toEqual([
      "patReady",
      "oauthWebhookReady",
      "oauthRefreshReady",
      "installedAppContextReady",
      "webhookVerificationReady",
      "oauthDryRunReady",
    ]);
    expect(healthResponse?.properties?.readiness).toMatchObject({
      $ref: "#/components/schemas/HealthReadiness",
    });
    expect(healthResponse?.properties?.blockers?.type).toBe("array");
  });

  it("keeps normalized TV state enums limited to the four documented values", async () => {
    const contract = await loadContract();
    const normalizedState = contract.components?.schemas?.NormalizedDeviceState;
    const normalizedAlias = contract.components?.schemas?.NormalizedStateAlias;

    expect(normalizedState?.properties?.state?.enum).toEqual([
      "offline",
      "standby",
      "on",
      "unknown",
    ]);
    expect(normalizedState?.properties?.tvState?.enum).toEqual([
      "offline",
      "standby",
      "on",
      "unknown",
    ]);
    expect(normalizedAlias?.properties?.state?.enum).toEqual([
      "offline",
      "standby",
      "on",
      "unknown",
    ]);
  });

  it("requires the documented device status and command request structure", async () => {
    const contract = await loadContract();
    const deviceStatusResponse = contract.components?.schemas?.DeviceStatusResponse;
    const commandRequest = contract.components?.schemas?.CommandDeviceRequest;

    expect(deviceStatusResponse?.required).toEqual([
      "device",
      "normalized",
      "normalizedState",
      "raw",
    ]);
    expect(commandRequest?.required).toEqual(["commands"]);
    expect(commandRequest?.properties?.commands?.type).toBe("array");
    expect(commandRequest?.properties?.commands?.minItems).toBe(1);
  });

  it("documents bootstrap configuration failures as ErrorResponse", async () => {
    const contract = await loadContract();
    const bootstrap503 =
      contract.paths?.["/subscriptions/bootstrap"]?.post?.responses?.["503"]?.content?.[
        "application/json"
      ]?.schema;

    expect(bootstrap503).toMatchObject({
      $ref: "#/components/schemas/ErrorResponse",
    });
  });

  it("keeps webhook success responses modeled as the documented oneOf shapes", async () => {
    const contract = await loadContract();
    const webhookSuccessSchema =
      contract.paths?.["/webhooks/smartthings"]?.post?.responses?.["200"]?.content?.[
        "application/json"
      ]?.schema;

    expect(webhookSuccessSchema?.oneOf).toHaveLength(3);
    expect(webhookSuccessSchema?.oneOf).toEqual([
      { $ref: "#/components/schemas/WebhookAckResponse" },
      { $ref: "#/components/schemas/WebhookConfirmationResponse" },
      { $ref: "#/components/schemas/WebhookConfigurationResponse" },
    ]);
  });

  it("documents webhook signature and media-type errors plus replay acknowledgements", async () => {
    const contract = await loadContract();
    const webhookOperation = contract.paths?.["/webhooks/smartthings"]?.post;
    const webhookAck = contract.components?.schemas?.WebhookAckResponse;

    expect(
      webhookOperation?.responses?.["401"]?.content?.["application/json"]?.schema,
    ).toMatchObject({
      $ref: "#/components/schemas/ErrorResponse",
    });
    expect(
      webhookOperation?.responses?.["415"]?.content?.["application/json"]?.schema,
    ).toMatchObject({
      $ref: "#/components/schemas/ErrorResponse",
    });
    expect(webhookAck?.properties?.replayed?.type).toBe("boolean");
  });
});
