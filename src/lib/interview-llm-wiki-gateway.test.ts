import { describe, expect, it, vi } from "vitest"
import type { StandaloneChatResponse } from "./chat-service"
import { createLlmWikiInterviewGateway } from "./interview-llm-wiki-gateway"

function response(conversationId: string): StandaloneChatResponse {
  return {
    ok: true,
    projectId: "project-1",
    conversation: {
      id: conversationId,
      title: "Interview",
      createdAt: 1000,
      updatedAt: 2000,
      messageCount: 2,
    },
    userMessage: {
      id: "user-1",
      role: "user",
      content: "prompt",
      timestamp: 1000,
      conversationId,
    },
    assistantMessage: {
      id: "assistant-1",
      role: "assistant",
      content: "generated answer must stay in chat only",
      timestamp: 2000,
      conversationId,
    },
    references: [],
    historyLimit: 10,
    agentSteps: [],
    queryPages: [],
    conversations: [],
    messages: [],
  }
}

describe("LLM Wiki interview gateway", () => {
  it("submits preparation as a fresh chat turn and exposes completion only", async () => {
    const sendChat = vi.fn(async () => response("conv-prep"))
    const gateway = createLlmWikiInterviewGateway({ sendChat })

    const result = await gateway.prepare("prep prompt", new AbortController().signal)

    expect(sendChat).toHaveBeenCalledWith(
      { message: "prep prompt", createConversation: true },
      expect.any(AbortSignal),
    )
    expect(result).toEqual({
      conversationId: "conv-prep",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      assistantMessageContent: "generated answer must stay in chat only",
      completedAt: 2000,
    })
    expect(result).not.toHaveProperty("assistantMessage")
  })

  it("submits answer prompts to the provided conversation", async () => {
    const sendChat = vi.fn(async () => response("conv-prep"))
    const gateway = createLlmWikiInterviewGateway({ sendChat })

    await gateway.submitAnswerPrompt({
      conversationId: "conv-prep",
      questionId: "q1",
      prompt: "answer prompt",
    }, new AbortController().signal)

    expect(sendChat).toHaveBeenCalledWith(
      { message: "answer prompt", conversationId: "conv-prep" },
      expect.any(AbortSignal),
    )
  })

  it("creates an answer conversation when none is available", async () => {
    const sendChat = vi.fn(async () => response("conv-answer"))
    const gateway = createLlmWikiInterviewGateway({ sendChat })

    await gateway.submitAnswerPrompt({
      conversationId: null,
      questionId: "q1",
      prompt: "answer prompt",
    }, new AbortController().signal)

    expect(sendChat).toHaveBeenCalledWith(
      { message: "answer prompt", createConversation: true },
      expect.any(AbortSignal),
    )
  })

  it("passes cancellation through to the chat service", async () => {
    const sendChat = vi.fn(async (_request, signal?: AbortSignal) => {
      if (signal?.aborted) throw new DOMException("Request aborted", "AbortError")
      return response("conv-1")
    })
    const gateway = createLlmWikiInterviewGateway({ sendChat })
    const controller = new AbortController()
    controller.abort()

    await expect(gateway.prepare("prep", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
  })
})
