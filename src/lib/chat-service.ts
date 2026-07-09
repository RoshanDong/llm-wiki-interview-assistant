import { buildChatAgentMessages, type ChatAgentEvent, type ChatAgentResult, type ChatAgentStep } from "@/lib/chat-agent"
import { isReasoningOnlyResponseError, streamChat, type ChatMessage as LLMMessage } from "@/lib/llm-client"
import { loadChatPreferences, saveChatHistory, type ChatPreferences } from "@/lib/persist"
import { chatMessagesToLLM, type Conversation, type DisplayMessage, type MessageImage, type MessageReference } from "@/stores/chat-store"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore, type LlmConfig, type SearchApiConfig } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

export interface StandaloneChatRequest {
  message: string
  conversationId?: string
  createConversation?: boolean
  images?: MessageImage[]
  options?: Partial<StandaloneChatPreferences>
}

export interface StandaloneChatPreferences extends ChatPreferences {
  maxHistoryMessages: number
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export interface StandaloneChatResponse {
  ok: true
  projectId: string
  conversation: ConversationSummary
  userMessage: DisplayMessage
  assistantMessage: DisplayMessage
  references: MessageReference[]
  historyLimit: number
  agentSteps?: ChatAgentStep[]
  queryPages?: { title: string; path: string }[]
  conversations: Conversation[]
  messages: DisplayMessage[]
}

export interface StandaloneChatErrorResponse {
  ok: false
  error: string
  code: string
  status: number
}

interface StandaloneChatDeps {
  buildChatAgentMessages?: typeof buildChatAgentMessages
  streamChat?: typeof streamChat
  saveChatHistory?: typeof saveChatHistory
}

export interface SendStandaloneChatMessageArgs {
  project: WikiProject | null
  llmConfig: LlmConfig
  searchApiConfig: SearchApiConfig
  dataVersion: number
  conversations: Conversation[]
  messages: DisplayMessage[]
  request: StandaloneChatRequest
  preferences: StandaloneChatPreferences
  signal?: AbortSignal
  deps?: StandaloneChatDeps
  onEvent?: (event: ChatAgentEvent) => void
  onToken?: (token: string) => void
  onReasoningToken?: (token: string) => void
  onUserMessage?: (message: DisplayMessage, conversations: Conversation[], messages: DisplayMessage[]) => void
  onComplete?: (response: StandaloneChatResponse) => void
}

export class StandaloneChatServiceError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status = 500) {
    super(message)
    this.name = "StandaloneChatServiceError"
    this.code = code
    this.status = status
  }
}

let serviceMessageCounter = 0

function nextMessageId(): string {
  serviceMessageCounter += 1
  return `api_msg_${Date.now()}_${serviceMessageCounter}`
}

function nextConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function conversationSummary(
  conversation: Conversation,
  messages: DisplayMessage[],
): ConversationSummary {
  return {
    ...conversation,
    messageCount: messages.filter((message) => message.conversationId === conversation.id).length,
  }
}

export function collectRecentRetrievalHistory(messages: DisplayMessage[]): MessageReference[] {
  const refs: MessageReference[] = []
  const seen = new Set<string>()
  for (const msg of [...messages].reverse()) {
    if (msg.role !== "assistant" || !msg.references) continue
    for (const ref of msg.references) {
      const key = `${ref.kind ?? "wiki"}:${ref.url ?? ref.path}`.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      refs.push(ref)
      if (refs.length >= 10) return refs
    }
  }
  return refs
}

export async function sendStandaloneChatMessage(
  args: SendStandaloneChatMessageArgs,
): Promise<StandaloneChatResponse> {
  const text = args.request.message.trim()
  if (!text) {
    throw new StandaloneChatServiceError("empty_message", "Chat message cannot be empty.", 400)
  }
  if (!args.project) {
    throw new StandaloneChatServiceError("project_not_available", "No current LLM Wiki project is open.", 404)
  }

  const now = Date.now()
  const existingConversation = args.request.conversationId
    ? args.conversations.find((conversation) => conversation.id === args.request.conversationId)
    : null
  if (args.request.conversationId && !existingConversation) {
    throw new StandaloneChatServiceError(
      "conversation_not_found",
      `Conversation not found: ${args.request.conversationId}`,
      404,
    )
  }

  const conversation = existingConversation ?? {
    id: nextConversationId(),
    title: text.slice(0, 50),
    createdAt: now,
    updatedAt: now,
  }
  const conversationId = conversation.id
  const userMessage: DisplayMessage = {
    id: nextMessageId(),
    role: "user",
    content: text,
    timestamp: now,
    conversationId,
    ...(args.request.images && args.request.images.length > 0 ? { images: args.request.images } : {}),
  }
  const nextConversations = upsertConversation(args.conversations, {
    ...conversation,
    updatedAt: now,
    title: shouldUseFirstMessageAsTitle(conversation, args.messages)
      ? text.slice(0, 50)
      : conversation.title,
  })
  const messagesWithUser = [...args.messages, userMessage]
  args.onUserMessage?.(userMessage, nextConversations, messagesWithUser)

  const historyLimit = clampHistoryLimit(args.request.options?.maxHistoryMessages ?? args.preferences.maxHistoryMessages)
  const activeMessages = messagesWithUser
    .filter((message) => message.conversationId === conversationId)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-historyLimit)
  const historyMessages = chatMessagesToLLM(activeMessages)
  const retrievalHistory = collectRecentRetrievalHistory(activeMessages)
  const options = {
    useWebSearch: args.request.options?.useWebSearch ?? args.preferences.useWebSearch,
    useAnyTxtSearch: args.request.options?.useAnyTxtSearch ?? args.preferences.useAnyTxtSearch,
    mode: args.request.options?.agentMode ?? args.preferences.agentMode,
  }

  const deps = {
    buildChatAgentMessages: args.deps?.buildChatAgentMessages ?? buildChatAgentMessages,
    streamChat: args.deps?.streamChat ?? streamChat,
    saveChatHistory: args.deps?.saveChatHistory ?? saveChatHistory,
  }

  try {
    const agentResult = await deps.buildChatAgentMessages({
      project: { name: args.project.name, path: args.project.path },
      llmConfig: args.llmConfig,
      searchApiConfig: args.searchApiConfig,
      text,
      historyMessages,
      retrievalHistory,
      dataVersion: args.dataVersion,
      options,
      signal: args.signal,
      onEvent: args.onEvent,
    })
    throwIfAborted(args.signal)
    const content = await streamFinalAnswer({
      llmConfig: args.llmConfig,
      agentResult,
      streamChatImpl: deps.streamChat,
      signal: args.signal,
      onToken: args.onToken,
      onReasoningToken: args.onReasoningToken,
    })
    throwIfAborted(args.signal)
    const assistantMessage: DisplayMessage = {
      id: nextMessageId(),
      role: "assistant",
      content,
      timestamp: Date.now(),
      conversationId,
      references: agentResult.references,
      agentSteps: agentResult.steps,
    }
    const finalMessages = [...messagesWithUser, assistantMessage]
    const finalConversations = upsertConversation(nextConversations, {
      ...conversation,
      title: nextConversations.find((item) => item.id === conversationId)?.title ?? conversation.title,
      updatedAt: assistantMessage.timestamp,
    })

    await deps.saveChatHistory(args.project.path, finalConversations, finalMessages)

    const response: StandaloneChatResponse = {
      ok: true,
      projectId: args.project.id,
      conversation: conversationSummary(
        finalConversations.find((item) => item.id === conversationId) ?? conversation,
        finalMessages,
      ),
      userMessage,
      assistantMessage,
      references: agentResult.references,
      historyLimit,
      agentSteps: agentResult.steps,
      queryPages: agentResult.queryPages,
      conversations: finalConversations,
      messages: finalMessages,
    }
    args.onComplete?.(response)
    return response
  } catch (error) {
    if (error instanceof StandaloneChatServiceError) throw error
    if (isAbortLikeError(error)) throw error
    throw new StandaloneChatServiceError(
      "chat_failed",
      error instanceof Error ? error.message : String(error),
      500,
    )
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw new DOMException("Request aborted", "AbortError")
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true
  if (!(error instanceof Error)) return false
  return error.name === "AbortError" || /abort|cancel/i.test(error.message)
}

export async function sendStandaloneChatMessageFromStores(
  request: StandaloneChatRequest & { projectId?: string },
  signal?: AbortSignal,
): Promise<StandaloneChatResponse> {
  const wiki = useWikiStore.getState()
  const chat = useChatStore.getState()
  const project = wiki.project
  if (!projectMatches(project, request.projectId ?? "current")) {
    throw new StandaloneChatServiceError("project_not_available", `Project is not open: ${request.projectId}`, 404)
  }
  const persistedPreferences = project ? await loadChatPreferences(project.path) : null
  const preferences: StandaloneChatPreferences = {
    useWebSearch: chat.useWebSearch ?? persistedPreferences?.useWebSearch ?? false,
    useAnyTxtSearch: chat.useAnyTxtSearch ?? persistedPreferences?.useAnyTxtSearch ?? false,
    agentMode: chat.agentMode ?? persistedPreferences?.agentMode ?? "standard",
    maxHistoryMessages: chat.maxHistoryMessages,
  }
  const response = await sendStandaloneChatMessage({
    project,
    llmConfig: wiki.llmConfig,
    searchApiConfig: wiki.searchApiConfig,
    dataVersion: wiki.dataVersion,
    conversations: chat.conversations,
    messages: chat.messages,
    request,
    preferences,
    signal,
  })
  useChatStore.setState({
    conversations: response.conversations,
    messages: response.messages,
    activeConversationId: response.conversation.id,
    isStreaming: false,
    streamingContent: "",
  })
  return response
}

export function serviceErrorToResponse(error: unknown): StandaloneChatErrorResponse {
  if (error instanceof StandaloneChatServiceError) {
    return {
      ok: false,
      error: error.message,
      code: error.code,
      status: error.status,
    }
  }
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code: "chat_failed",
    status: 500,
  }
}

function upsertConversation(conversations: Conversation[], conversation: Conversation): Conversation[] {
  const exists = conversations.some((item) => item.id === conversation.id)
  if (!exists) return [conversation, ...conversations]
  return conversations.map((item) => item.id === conversation.id ? conversation : item)
}

function shouldUseFirstMessageAsTitle(conversation: Conversation, messages: DisplayMessage[]): boolean {
  if (messages.some((message) => message.conversationId === conversation.id && message.role === "user")) {
    return false
  }
  return conversation.title === "New Conversation" || conversation.title === "新对话" || conversation.title.trim() === ""
}

function clampHistoryLimit(value: number): number {
  if (!Number.isFinite(value)) return 10
  return Math.min(100, Math.max(1, Math.floor(value)))
}

async function streamFinalAnswer(args: {
  llmConfig: LlmConfig
  agentResult: ChatAgentResult
  streamChatImpl: typeof streamChat
  signal?: AbortSignal
  onToken?: (token: string) => void
  onReasoningToken?: (token: string) => void
}): Promise<string> {
  let accumulated = ""
  let thinkingOpen = false

  const appendToken = (token: string) => {
    accumulated += token
    args.onToken?.(token)
  }
  const appendReasoning = (token: string) => {
    if (!token) return
    if (!thinkingOpen) {
      thinkingOpen = true
      appendToken("<think>")
    }
    appendToken(token)
    args.onReasoningToken?.(token)
  }
  const closeReasoning = () => {
    if (!thinkingOpen) return
    thinkingOpen = false
    appendToken("</think>")
  }
  const run = async (reasoningOff: boolean) => {
    let streamError: Error | null = null
    await args.streamChatImpl(
      args.llmConfig,
      args.agentResult.messages as LLMMessage[],
      {
        onToken: (token) => {
          closeReasoning()
          appendToken(token)
        },
        onReasoningToken: (token) => {
          if (!reasoningOff) appendReasoning(token)
        },
        onDone: () => {},
        onError: (error) => {
          streamError = error
        },
      },
      args.signal,
      reasoningOff ? { reasoning: { mode: "off" } } : undefined,
    )
    if (streamError) throw streamError
  }

  try {
    await run(false)
  } catch (error) {
    if (!isReasoningOnlyResponseError(error)) throw error
    accumulated = ""
    thinkingOpen = false
    await run(true)
  }
  closeReasoning()
  return accumulated
}

function projectMatches(project: WikiProject | null, requested: string): boolean {
  if (!project) return false
  if (!requested || requested.toLowerCase() === "current") return true
  return project.id === requested || normalizePath(project.path) === normalizePath(decodeURIComponent(requested))
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}
