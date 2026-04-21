import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createReasoningFinalAnswerMessage,
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession", () => {
  it("keeps assistantTexts to the final answer when block replies are disabled", () => {
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run",
      reasoningMode: "on",
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Final " });
    emitAssistantTextDelta({ emit, delta: "answer" });
    emitAssistantTextEnd({ emit });

    const assistantMessage = createReasoningFinalAnswerMessage();

    emit({ type: "message_end", message: assistantMessage });

    expect(subscription.assistantTexts).toEqual(["Final answer"]);
  });

  it("ignores commentary turns and keeps only the final answer", () => {
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run",
      reasoningMode: "on",
    });

    const commentaryMessage = {
      role: "assistant",
      phase: "commentary",
      content: [{ type: "text", text: "Draft commentary" }],
    } as AssistantMessage;

    emit({ type: "message_start", message: { role: "assistant", phase: "commentary" } });
    emit({
      type: "message_update",
      message: { role: "assistant", phase: "commentary" },
      assistantMessageEvent: { type: "text_delta", delta: "Draft commentary" },
    });
    emit({
      type: "message_update",
      message: { role: "assistant", phase: "commentary" },
      assistantMessageEvent: { type: "text_end", content: "Draft commentary" },
    });
    emit({ type: "message_end", message: commentaryMessage });

    expect(subscription.assistantTexts).toEqual([]);

    emit({ type: "message_start", message: { role: "assistant", phase: "final_answer" } });
    emitAssistantTextDelta({ emit, delta: "Final " });
    emitAssistantTextDelta({ emit, delta: "answer" });
    emitAssistantTextEnd({ emit });

    const assistantMessage = {
      ...createReasoningFinalAnswerMessage(),
      phase: "final_answer",
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });

    expect(subscription.assistantTexts).toEqual(["Final answer"]);
  });

  it("records commentary turn usage without keeping commentary text", () => {
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run",
      reasoningMode: "on",
    });

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        phase: "commentary",
        content: [{ type: "text", text: "Draft commentary" }],
        usage: { input: 11, output: 7, total: 18 },
      } as AssistantMessage,
    });

    expect(subscription.assistantTexts).toEqual([]);
    expect(subscription.getUsageTotals()).toEqual({
      input: 11,
      output: 7,
      total: 18,
    });
  });
  it("suppresses partial replies when reasoning is enabled and block replies are disabled", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run",
      reasoningMode: "on",
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Draft " });
    emitAssistantTextDelta({ emit, delta: "reply" });

    expect(onPartialReply).not.toHaveBeenCalled();

    const assistantMessage = createReasoningFinalAnswerMessage();

    emit({ type: "message_end", message: assistantMessage });
    emitAssistantTextEnd({ emit, content: "Draft reply" });

    expect(onPartialReply).not.toHaveBeenCalled();
    expect(subscription.assistantTexts).toEqual(["Final answer"]);
  });
});
