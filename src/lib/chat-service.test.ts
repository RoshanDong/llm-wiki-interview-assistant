import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatAgentResult } from "./chat-agent"
import type { LlmConfig, SearchApiConfig } from "@/stores/wiki-store"
import type { Conversation, DisplayMessage } from "@/stores/chat-store"
import {
  StandaloneChatServiceError,
  collectRecentRetrievalHistory,
  conversationSummary,
  sendStandaloneChatMessage,
} from "./chat-service"

const llmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "https://example.com/v1",
  maxContextSize: 128_000,
}

const searchApiConfig: SearchApiConfig = {
  provider: "none",
  apiKey: "",
}

const agentResult: ChatAgentResult = {
  messages: [{ role: "user", content: "final prompt" }],
  references: [{ title: "Attention", path: "/proj/wiki/attention.md", kind: "wiki" }],
  queryPages: [{ title: "Attention", path: "/proj/wiki/attention.md" }],
  plan: [],
  steps: [{ id: "s1", type: "tool_result", tool: "wiki_search", count: 1, status: "success" }],
}

function baseArgs(overrides: Partial<Parameters<typeof sendStandaloneChatMessage>[0]> = {}) {
  return {
    project: { id: "p1", name: "Project", path: "/proj" },
    llmConfig,
    searchApiConfig,
    dataVersion: 7,
    conversations: [] as Conversation[],
    messages: [] as DisplayMessage[],
    request: { message: "What is attention?" },
    preferences: {
      useWebSearch: false,
      useAnyTxtSearch: false,
      agentMode: "standard" as const,
      maxHistoryMessages: 10,
    },
    deps: {
      buildChatAgentMessages: vi.fn(async () => agentResult),
      streamChat: vi.fn(async (_cfg, _messages, callbacks) => {
        callbacks.onToken("Grounded answer")
        callbacks.onDone()
      }),
      saveChatHistory: vi.fn(async () => undefined),
    },
    ...overrides,
  }
}

describe("standalone chat service", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it("rejects blank messages with a structured service error", async () => {
    await expect(sendStandaloneChatMessage(baseArgs({ request: { message: "  " } }))).rejects.toMatchObject({
      code: "empty_message",
      status: 400,
    })
  })

  it("rejects a missing conversation id", async () => {
    await expect(
      sendStandaloneChatMessage(baseArgs({ request: { message: "hello", conversationId: "missing" } })),
    ).rejects.toMatchObject({
      code: "conversation_not_found",
      status: 404,
    })
  })

  it("summarizes conversations with derived message counts", () => {
    const conv: Conversation = { id: "c1", title: "Topic", createdAt: 1, updatedAt: 2 }
    expect(conversationSummary(conv, [
      { id: "m1", role: "user", content: "hi", timestamp: 1, conversationId: "c1" },
      { id: "m2", role: "assistant", content: "hello", timestamp: 2, conversationId: "c1" },
      { id: "m3", role: "user", content: "other", timestamp: 3, conversationId: "c2" },
    ])).toEqual({ id: "c1", title: "Topic", createdAt: 1, updatedAt: 2, messageCount: 2 })
  })

  it("builds chat-agent messages, streams a final answer, returns references, and saves the turn", async () => {
    const args = baseArgs()
    const result = await sendStandaloneChatMessage(args)

    expect(args.deps.buildChatAgentMessages).toHaveBeenCalledWith(expect.objectContaining({
      text: "What is attention?",
      historyMessages: [{ role: "user", content: "What is attention?" }],
      dataVersion: 7,
      options: { useWebSearch: false, useAnyTxtSearch: false, mode: "standard" },
    }))
    expect(args.deps.streamChat).toHaveBeenCalledWith(
      llmConfig,
      agentResult.messages,
      expect.any(Object),
      undefined,
      undefined,
    )
    expect(result.ok).toBe(true)
    expect(result.conversation.id).toBeTruthy()
    expect(result.userMessage.content).toBe("What is attention?")
    expect(result.assistantMessage.content).toBe("Grounded answer")
    expect(result.references).toEqual(agentResult.references)
    expect(result.agentSteps).toEqual(agentResult.steps)
    expect(args.deps.saveChatHistory).toHaveBeenCalledWith(
      "/proj",
      result.conversations,
      result.messages,
    )
  })

  it("can mirror the app chat UI by appending the user message, streaming tokens, and finalizing references through callbacks", async () => {
    const uiState = {
      conversations: [] as Conversation[],
      messages: [] as DisplayMessage[],
      streamingContent: "",
    }
    const args = baseArgs({
      onUserMessage: (_message, conversations, messages) => {
        uiState.conversations = conversations
        uiState.messages = messages
      },
      onToken: (token) => {
        uiState.streamingContent += token
      },
      onComplete: (response) => {
        uiState.conversations = response.conversations
        uiState.messages = response.messages
        uiState.streamingContent = ""
      },
    })

    const result = await sendStandaloneChatMessage(args)

    expect(uiState.conversations).toEqual(result.conversations)
    expect(uiState.messages).toEqual(result.messages)
    expect(uiState.messages).toMatchObject([
      { role: "user", content: "What is attention?", conversationId: result.conversation.id },
      {
        role: "assistant",
        content: "Grounded answer",
        conversationId: result.conversation.id,
        references: agentResult.references,
        agentSteps: agentResult.steps,
      },
    ])
    expect(uiState.streamingContent).toBe("")
  })

  it("limits prompt history while preserving the new user message", async () => {
    const messages: DisplayMessage[] = [
      { id: "m1", role: "user", content: "one", timestamp: 1, conversationId: "c1" },
      { id: "m2", role: "assistant", content: "two", timestamp: 2, conversationId: "c1" },
      { id: "m3", role: "user", content: "three", timestamp: 3, conversationId: "c1" },
    ]
    const args = baseArgs({
      conversations: [{ id: "c1", title: "Existing", createdAt: 1, updatedAt: 3 }],
      messages,
      request: { message: "four", conversationId: "c1" },
      preferences: {
        useWebSearch: false,
        useAnyTxtSearch: false,
        agentMode: "fast",
        maxHistoryMessages: 2,
      },
    })

    await sendStandaloneChatMessage(args)

    expect(args.deps.buildChatAgentMessages).toHaveBeenCalledWith(expect.objectContaining({
      historyMessages: [
        { role: "user", content: "three" },
        { role: "user", content: "four" },
      ],
      options: { useWebSearch: false, useAnyTxtSearch: false, mode: "fast" },
    }))
  })

  it("maps model errors to structured service errors", async () => {
    const args = baseArgs({
      deps: {
        buildChatAgentMessages: vi.fn(async () => agentResult),
        streamChat: vi.fn(async (_cfg, _messages, callbacks) => {
          callbacks.onError(new Error("model offline"))
        }),
        saveChatHistory: vi.fn(async () => undefined),
      },
    })

    await expect(sendStandaloneChatMessage(args)).rejects.toBeInstanceOf(StandaloneChatServiceError)
    await expect(sendStandaloneChatMessage(args)).rejects.toMatchObject({
      code: "chat_failed",
      status: 500,
    })
  })

  it("collects recent retrieval references without duplicates", () => {
    const refs = collectRecentRetrievalHistory([
      {
        id: "a1",
        role: "assistant",
        content: "a",
        timestamp: 1,
        conversationId: "c1",
        references: [{ title: "A", path: "/wiki/a.md", kind: "wiki" }],
      },
      {
        id: "a2",
        role: "assistant",
        content: "b",
        timestamp: 2,
        conversationId: "c1",
        references: [
          { title: "A again", path: "/wiki/a.md", kind: "wiki" },
          { title: "B", path: "/wiki/b.md", kind: "wiki" },
        ],
      },
    ])

    expect(refs).toEqual([
      { title: "A again", path: "/wiki/a.md", kind: "wiki" },
      { title: "B", path: "/wiki/b.md", kind: "wiki" },
    ])
  })
})
