import {
  sendStandaloneChatMessageFromStores,
  type StandaloneChatRequest,
  type StandaloneChatResponse,
} from "./chat-service"
import type { ChatTurnResult } from "./interview-types"

export interface SubmitAnswerPromptInput {
  conversationId?: string | null
  questionId: string
  prompt: string
}

export interface LlmWikiInterviewGateway {
  prepare: (prompt: string, signal?: AbortSignal) => Promise<ChatTurnResult>
  submitAnswerPrompt: (
    input: SubmitAnswerPromptInput,
    signal?: AbortSignal,
  ) => Promise<ChatTurnResult>
}

export type SendInterviewChat = (
  request: StandaloneChatRequest,
  signal?: AbortSignal,
) => Promise<StandaloneChatResponse>

interface GatewayDeps {
  sendChat?: SendInterviewChat
}

export function createLlmWikiInterviewGateway(
  deps: GatewayDeps = {},
): LlmWikiInterviewGateway {
  const sendChat = deps.sendChat ?? sendStandaloneChatMessageFromStores
  return {
    async prepare(prompt, signal) {
      const response = await sendChat({ message: prompt, createConversation: true }, signal)
      return toChatTurnResult(response)
    },
    async submitAnswerPrompt(input, signal) {
      const response = await sendChat({
        message: input.prompt,
        ...(input.conversationId ? { conversationId: input.conversationId } : { createConversation: true }),
      }, signal)
      return toChatTurnResult(response)
    },
  }
}

export function toChatTurnResult(response: StandaloneChatResponse): ChatTurnResult {
  return {
    conversationId: response.conversation.id,
    userMessageId: response.userMessage.id,
    assistantMessageId: response.assistantMessage.id,
    assistantMessageContent: response.assistantMessage.content,
    completedAt: response.assistantMessage.timestamp,
  }
}
