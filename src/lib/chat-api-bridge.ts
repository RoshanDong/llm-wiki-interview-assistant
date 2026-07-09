import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import {
  StandaloneChatServiceError,
  sendStandaloneChatMessageFromStores,
  serviceErrorToResponse,
  type StandaloneChatRequest,
  type StandaloneChatResponse,
} from "./chat-service"

export const API_CHAT_REQUEST_EVENT = "llm-wiki://api-chat-request"
export const API_CHAT_RESPONSE_COMMAND = "api_server_complete_chat_request"
export const CHAT_API_BRIDGE_TIMEOUT_MS = 115_000
const MAX_HANDLED_REQUEST_IDS = 100

interface ApiChatBridgePayload {
  requestId?: unknown
  projectId?: unknown
  body?: unknown
}

type ApiChatBridgeResponse =
  | Omit<StandaloneChatResponse, "conversations" | "messages" | "queryPages">
  | ReturnType<typeof serviceErrorToResponse>

let unregister: (() => void) | null = null
const handledRequestIds = ((globalThis as unknown as {
  __llmWikiChatBridgeHandledRequestIds?: Set<string>
}).__llmWikiChatBridgeHandledRequestIds ??= new Set<string>())

export async function registerChatApiBridge(): Promise<() => void> {
  if (unregister) return unregister
  unregister = await listen(API_CHAT_REQUEST_EVENT, async (event) => {
    const payload = event.payload as ApiChatBridgePayload
    if (!isValidPayload(payload)) {
      console.warn("[chat-api-bridge] ignoring malformed chat request", payload)
      return
    }

    if (!rememberRequestId(payload.requestId)) {
      console.warn("[chat-api-bridge] ignoring duplicate chat request", {
        requestId: payload.requestId,
        projectId: payload.projectId,
      })
      return
    }

    const request = normalizeRequest(payload.projectId, payload.body)
    console.info("[chat-api-bridge] chat request started", {
      requestId: payload.requestId,
      projectId: payload.projectId,
    })
    let bridgeResponse: ApiChatBridgeResponse
    try {
      const response = await withTimeout(sendStandaloneChatMessageFromStores(request))
      const {
        conversations: _conversations,
        messages: _messages,
        queryPages: _queryPages,
        ...apiResponse
      } = response
      console.info("[chat-api-bridge] chat request completed", {
        requestId: payload.requestId,
        conversationId: response.conversation.id,
      })
      bridgeResponse = apiResponse
    } catch (error) {
      bridgeResponse = serviceErrorToResponse(error)
      console.warn("[chat-api-bridge] chat request failed", {
        requestId: payload.requestId,
        code: bridgeResponse.code,
        error: bridgeResponse.error,
      })
    }
    await sendBridgeResponse(payload.requestId, bridgeResponse)
  })
  return unregister
}

function rememberRequestId(requestId: string): boolean {
  if (handledRequestIds.has(requestId)) return false
  handledRequestIds.add(requestId)
  if (handledRequestIds.size > MAX_HANDLED_REQUEST_IDS) {
    const oldest = handledRequestIds.values().next().value
    if (oldest) handledRequestIds.delete(oldest)
  }
  return true
}

async function sendBridgeResponse(
  requestId: string,
  response: ApiChatBridgeResponse,
): Promise<void> {
  try {
    await invoke(API_CHAT_RESPONSE_COMMAND, { requestId, response })
  } catch (error) {
    console.warn("[chat-api-bridge] failed to deliver chat response", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function withTimeout(promise: Promise<StandaloneChatResponse>): Promise<StandaloneChatResponse> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new StandaloneChatServiceError(
            "chat_bridge_timeout",
            "Timed out waiting for the chat service.",
            504,
          ))
        }, CHAT_API_BRIDGE_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

export function unregisterChatApiBridge(): void {
  unregister?.()
  unregister = null
}

function isValidPayload(payload: ApiChatBridgePayload): payload is {
  requestId: string
  projectId: string
  body: Record<string, unknown>
} {
  return (
    typeof payload?.requestId === "string" &&
    payload.requestId.trim().length > 0 &&
    typeof payload.projectId === "string" &&
    payload.projectId.trim().length > 0 &&
    typeof payload.body === "object" &&
    payload.body !== null
  )
}

function normalizeRequest(projectId: string, body: Record<string, unknown>): StandaloneChatRequest & { projectId: string } {
  return {
    projectId,
    message: typeof body.message === "string" ? body.message : "",
    conversationId: typeof body.conversationId === "string" ? body.conversationId : undefined,
    createConversation: typeof body.createConversation === "boolean" ? body.createConversation : undefined,
    options: typeof body.options === "object" && body.options !== null
      ? body.options as StandaloneChatRequest["options"]
      : undefined,
  }
}
