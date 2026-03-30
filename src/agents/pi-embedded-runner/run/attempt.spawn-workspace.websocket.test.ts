import { describe, expect, it } from "vitest";
import { shouldUseOpenAIWebSocketTransport } from "./attempt.thread-helpers.js";

describe("openai websocket transport selection", () => {
  it("accepts the direct OpenAI responses transport pair", () => {
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
      }),
    ).toBe(true);
  });

  it("accepts the default OpenAI responses base URL", () => {
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai",
        modelApi: "openai-responses",
      }),
    ).toBe(true);
  });

  it("rejects blank OpenAI responses base URLs", () => {
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai",
        modelApi: "openai-responses",
        modelBaseUrl: "",
      }),
    ).toBe(false);
  });

  it("rejects Codex responses transport pairs", () => {
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai-codex",
        modelApi: "openai-codex-responses",
        modelBaseUrl: "https://chatgpt.com/backend-api",
      }),
    ).toBe(false);
  });

  it("rejects proxied OpenAI responses base URLs", () => {
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai",
        modelApi: "openai-responses",
        modelBaseUrl: "https://proxy.example.com/v1",
      }),
    ).toBe(false);
  });

  it("rejects mismatched OpenAI websocket transport pairs", () => {
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai",
        modelApi: "openai-codex-responses",
      }),
    ).toBe(false);
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai-codex",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai-codex",
        modelApi: "openai-codex-responses",
      }),
    ).toBe(false);
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "anthropic",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });
});
