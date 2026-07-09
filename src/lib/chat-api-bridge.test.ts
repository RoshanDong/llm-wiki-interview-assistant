import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const listeners: Record<string, (event: { payload: unknown }) => void> = {}
  return {
    listeners,
    listen: vi.fn(async (event: string, cb: (event: { payload: unknown }) => void) => {
      listeners[event] = cb
      return vi.fn(() => {
        delete listeners[event]
      })
    }),
    invoke: vi.fn(async () => undefined),
    sendStandaloneChatMessageFromStores: vi.fn(async () => ({
      ok: true,
      projectId: "p1",
      conversation: { id: "c1", title: "Question", createdAt: 1, updatedAt: 2, messageCount: 2 },
      userMessage: { id: "u1", role: "user", content: "Question", timestamp: 1, conversationId: "c1" },
      assistantMessage: { id: "a1", role: "assistant", content: "Answer", timestamp: 2, conversationId: "c1" },
      references: [],
      historyLimit: 10,
    })),
  }
})

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("./chat-service", () => ({
  StandaloneChatServiceError: class StandaloneChatServiceError extends Error {
    code: string
    status: number

    constructor(code: string, message: string, status: number) {
      super(message)
      this.code = code
      this.status = status
    }
  },
  sendStandaloneChatMessageFromStores: mocks.sendStandaloneChatMessageFromStores,
  serviceErrorToResponse: (error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code: (error as { code?: string })?.code ?? "chat_failed",
    status: (error as { status?: number })?.status ?? 500,
  }),
}))

import {
  API_CHAT_REQUEST_EVENT,
  API_CHAT_RESPONSE_COMMAND,
  CHAT_API_BRIDGE_TIMEOUT_MS,
  registerChatApiBridge,
  unregisterChatApiBridge,
} from "./chat-api-bridge"

describe("chat API bridge", () => {
  beforeEach(() => {
    unregisterChatApiBridge()
    vi.useRealTimers()
    vi.clearAllMocks()
    for (const key of Object.keys(mocks.listeners)) delete mocks.listeners[key]
  })

  it("correlates request ids and completes successful bridge requests", async () => {
    await registerChatApiBridge()

    await mocks.listeners[API_CHAT_REQUEST_EVENT]({
      payload: {
        requestId: "r1",
        projectId: "current",
        body: { message: "Question" },
      },
    })

    expect(mocks.sendStandaloneChatMessageFromStores).toHaveBeenCalledWith({
      projectId: "current",
      message: "Question",
    })
    expect(mocks.invoke).toHaveBeenCalledWith(API_CHAT_RESPONSE_COMMAND, {
      requestId: "r1",
      response: expect.objectContaining({ ok: true, projectId: "p1" }),
    })
  })

  it("maps service failures to structured bridge responses", async () => {
    mocks.sendStandaloneChatMessageFromStores.mockRejectedValueOnce(new Error("boom"))
    await registerChatApiBridge()

    await mocks.listeners[API_CHAT_REQUEST_EVENT]({
      payload: {
        requestId: "r2",
        projectId: "current",
        body: { message: "Question" },
      },
    })

    expect(mocks.invoke).toHaveBeenCalledWith(API_CHAT_RESPONSE_COMMAND, {
      requestId: "r2",
      response: expect.objectContaining({ ok: false, error: "boom", code: "chat_failed" }),
    })
  })

  it("ignores duplicate request ids without running the chat service twice", async () => {
    await registerChatApiBridge()

    const event = {
      payload: {
        requestId: "r-duplicate",
        projectId: "current",
        body: { message: "Question" },
      },
    }
    await mocks.listeners[API_CHAT_REQUEST_EVENT](event)
    await mocks.listeners[API_CHAT_REQUEST_EVENT](event)

    expect(mocks.sendStandaloneChatMessageFromStores).toHaveBeenCalledTimes(1)
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })

  it("does not turn response delivery failures into a second chat response", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("Unknown or expired chat request"))
    await registerChatApiBridge()

    await mocks.listeners[API_CHAT_REQUEST_EVENT]({
      payload: {
        requestId: "r-delivery-fails",
        projectId: "current",
        body: { message: "Question" },
      },
    })

    expect(mocks.sendStandaloneChatMessageFromStores).toHaveBeenCalledTimes(1)
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })

  it("maps hung service calls to a structured timeout response", async () => {
    vi.useFakeTimers()
    mocks.sendStandaloneChatMessageFromStores.mockImplementationOnce(() => new Promise(() => {}))
    await registerChatApiBridge()

    const pending = mocks.listeners[API_CHAT_REQUEST_EVENT]({
      payload: {
        requestId: "r-timeout",
        projectId: "current",
        body: { message: "Question" },
      },
    })
    await vi.advanceTimersByTimeAsync(CHAT_API_BRIDGE_TIMEOUT_MS + 1)
    await pending

    expect(mocks.invoke).toHaveBeenCalledWith(API_CHAT_RESPONSE_COMMAND, {
      requestId: "r-timeout",
      response: expect.objectContaining({
        ok: false,
        code: "chat_bridge_timeout",
        status: 504,
      }),
    })
  })

  it("ignores malformed events without invoking the response command", async () => {
    await registerChatApiBridge()

    await mocks.listeners[API_CHAT_REQUEST_EVENT]({ payload: { requestId: "", body: {} } })

    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
