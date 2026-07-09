import type { LlmWikiInterviewGateway } from "./interview-llm-wiki-gateway"
import type { AudioChunk, AudioSourceAdapter, TranscriptProvider } from "./interview-audio"
import type { QuestionDetectionInput, QuestionDetectionResult, QuestionDetector } from "./interview-question-detector"
import type {
  AudioSourceKind,
  AudioSourceSelection,
  ChatTurnResult,
  DetectedQuestion,
  InterviewAsrDiagnosticEvent,
  InterviewAsrStatusEvent,
  InterviewProjectCategory,
  InterviewProjectProfile,
  InterviewQuestionType,
  TranscriptSegment,
} from "./interview-types"

export function createFakeStreamingAudioChunk(options: {
  sessionId?: string
  streamId?: string
  source?: AudioSourceKind
  sequence?: number
  textBytes?: Uint8Array
} = {}): AudioChunk {
  const pcm16 = options.textBytes ?? new Uint8Array([1, 0, 2, 0])
  return {
    id: `chunk-${options.sequence ?? 1}`,
    sessionId: options.sessionId ?? "session-1",
    streamId: options.streamId ?? "stream-1",
    source: options.source ?? "microphone",
    blob: null,
    bytes: pcm16,
    pcm16,
    sequence: options.sequence ?? 1,
    sampleRate: 16000,
    channelCount: 1,
    durationMs: 100,
    isFinal: true,
    mimeType: "audio/pcm",
    createdAt: 1000,
  }
}

export function createFakeTranscriptSegment(
  overrides: Partial<TranscriptSegment> = {},
): TranscriptSegment {
  return {
    id: "seg-1",
    sessionId: "session-1",
    streamId: "stream-1",
    speaker: "interviewer",
    text: "Can you introduce one project?",
    startMs: 0,
    endMs: 1000,
    confidence: 0.9,
    source: "system",
    state: "confirmed",
    definite: true,
    createdAt: 1100,
    ...overrides,
  }
}

export function createFakeDetectedQuestion(
  overrides: Partial<DetectedQuestion> = {},
): DetectedQuestion {
  return {
    id: "question-1",
    sessionId: "session-1",
    text: "请介绍一下你的项目经历？",
    answerGoal: "项目经历介绍",
    topic: "项目经历",
    intent: "项目经验",
    entities: [],
    coverageAliases: [],
    sourceSegmentIds: ["seg-1"],
    clarificationState: "none",
    detectedAt: 1400,
    updatedAt: 1400,
    status: "pending",
    queuedAt: 1400,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    attentionReason: null,
    ...overrides,
  }
}

export function createFakeAsrStatusEvent(
  overrides: Partial<InterviewAsrStatusEvent> = {},
): InterviewAsrStatusEvent {
  return {
    sessionId: "session-1",
    streamId: "stream-1",
    source: "microphone",
    status: "listening",
    level: "info",
    message: "listening",
    createdAt: 1200,
    ...overrides,
  }
}

export function createFakeAsrDiagnosticEvent(
  overrides: Partial<InterviewAsrDiagnosticEvent> = {},
): InterviewAsrDiagnosticEvent {
  return {
    sessionId: "session-1",
    streamId: "stream-1",
    source: "microphone",
    level: "warn",
    category: "retry",
    message: "retrying",
    createdAt: 1300,
    ...overrides,
  }
}

export function createFakeAudioSourceAdapter(
  kind: AudioSourceKind,
  chunks: AudioChunk[] = [],
): AudioSourceAdapter {
  return {
    kind,
    async *start(_source: AudioSourceSelection, signal: AbortSignal) {
      for (const chunk of chunks) {
        if (signal.aborted) throw new DOMException("Request aborted", "AbortError")
        yield chunk
      }
    },
    async stop() {},
  }
}

export function createFakeTranscriptProvider(
  segments: TranscriptSegment[] = [],
): TranscriptProvider {
  return {
    async *transcribe(_chunks: AsyncIterable<AudioChunk>, signal: AbortSignal) {
      for (const segment of segments) {
        if (signal.aborted) throw new DOMException("Request aborted", "AbortError")
        yield segment
      }
    },
  }
}

type FakeQuestionDetectionResult = Pick<QuestionDetectionResult, "questions"> & Partial<QuestionDetectionResult>

export function createFakeQuestionDetector(
  result: FakeQuestionDetectionResult | ((segments: TranscriptSegment[], input: QuestionDetectionInput) => FakeQuestionDetectionResult | Promise<FakeQuestionDetectionResult>),
): QuestionDetector {
  return {
    async detect(input, signal) {
      if (signal.aborted) throw new DOMException("Request aborted", "AbortError")
      const output = typeof result === "function" ? await result(input.recentSegments, input) : result
      return {
        contextVersion: input.contextVersion,
        turnComplete: output.turnComplete ?? true,
        turnReason: output.turnReason,
        conversationPhase: output.conversationPhase ?? "normal_interview",
        questions: output.questions,
      }
    },
  }
}

export const questionOptimizationTranscriptFixtures = {
  aiPracticeDialogue: [
    createFakeTranscriptSegment({
      id: "seg-ai-1",
      speaker: "unknown",
      source: "file",
      text: "AI 这一块能讲讲你的了解和实践情况吗？",
    }),
    createFakeTranscriptSegment({
      id: "seg-ai-2",
      speaker: "unknown",
      source: "file",
      text: "用过哪些工具？AI 在测试中的应用有什么了解？",
      startMs: 1000,
      endMs: 2200,
    }),
  ],
  reverseQuestionTail: [
    createFakeTranscriptSegment({
      id: "seg-reverse-1",
      speaker: "unknown",
      source: "file",
      text: "你有什么想问我或者想了解的吗？",
    }),
    createFakeTranscriptSegment({
      id: "seg-reverse-2",
      speaker: "unknown",
      source: "file",
      text: "这个 AI 测试开发岗位的具体工作内容是什么？",
      startMs: 1000,
      endMs: 2200,
    }),
  ],
}

export const questionOptimizationCandidateFixtures = {
  aiPractice: {
    text: "你在AI方面有哪些实践？用过哪些AI工具？AI在测试中有什么应用？",
    answerGoal: "AI测试实践工具与应用",
    sourceSegmentIds: ["seg-ai-1", "seg-ai-2"],
    confidence: 0.9,
  },
  aiPracticeDuplicate: {
    text: "你对AI在测试中的应用有什么了解或实践？用过哪些AI工具？",
    answerGoal: "AI测试实践工具与应用",
    sourceSegmentIds: ["seg-ai-2"],
    confidence: 0.88,
  },
  reverseRoleQuestion: {
    text: "这个AI测试开发岗位的具体工作内容是什么？",
    answerGoal: "AI测试开发岗位工作内容",
    sourceSegmentIds: ["seg-reverse-1", "seg-reverse-2"],
    confidence: 0.86,
  },
}

export const interviewPromptRoutingFixtures: Array<{
  text: string
  expectedType: InterviewQuestionType
  expectedProject?: InterviewProjectCategory
}> = [
  {
    text: "搜索质量平台这个项目你整体负责了什么？",
    expectedType: "项目经历概览类",
    expectedProject: "搜索质量平台",
  },
  {
    text: "支付风控测试平台你们是怎么设计和落地的？",
    expectedType: "项目方法方案类",
    expectedProject: "支付风控测试平台",
  },
  {
    text: "推荐评估系统里准确率指标怎么算，阈值怎么定？",
    expectedType: "项目细节深挖类",
    expectedProject: "推荐评估系统",
  },
  {
    text: "RAG 和传统搜索有什么区别？",
    expectedType: "知识八股类",
  },
  {
    text: "手撕代码：给一个数组，写代码找最长连续子序列并分析复杂度。",
    expectedType: "手撕代码类",
  },
]

export const genericInterviewProjectProfiles: InterviewProjectProfile[] = [
  {
    id: "project-search-quality",
    name: "搜索质量平台",
    aliases: ["搜索质量", "检索质量"],
    strongTerms: ["召回率", "排序质量", "搜索链路"],
    weakTerms: ["搜索", "检索", "重排"],
    technicalTerms: ["bm25", "rerank", "embedding"],
    negativeTerms: ["支付", "风控", "推荐"],
    strongCombos: [["搜索", "召回率"], ["检索质量", "重排"]],
    enabled: true,
    updatedAt: 1000,
  },
  {
    id: "project-payment-risk",
    name: "支付风控测试平台",
    aliases: ["风控平台", "支付风控"],
    strongTerms: ["风控规则", "交易拦截", "风险策略"],
    weakTerms: ["支付", "规则引擎", "灰度"],
    technicalTerms: ["规则引擎", "回放", "拦截率"],
    negativeTerms: ["搜索", "推荐"],
    strongCombos: [["支付", "风控"], ["交易", "拦截"]],
    enabled: true,
    updatedAt: 1000,
  },
  {
    id: "project-recommendation-eval",
    name: "推荐评估系统",
    aliases: ["推荐评估", "推荐质量"],
    strongTerms: ["推荐链路", "离线评估", "点击率"],
    weakTerms: ["推荐", "评估", "排序"],
    technicalTerms: ["auc", "precision", "recall"],
    negativeTerms: ["支付", "搜索"],
    strongCombos: [["推荐", "评估"], ["点击率", "召回率"]],
    enabled: true,
    updatedAt: 1000,
  },
]

export function createFakeInterviewGateway(options: {
  preparationConversationId?: string
  answerConversationId?: string
  prepare?: (prompt: string, signal?: AbortSignal) => Promise<ChatTurnResult>
  submitAnswerPrompt?: LlmWikiInterviewGateway["submitAnswerPrompt"]
} = {}): LlmWikiInterviewGateway {
  return {
    async prepare(prompt, signal) {
      if (options.prepare) return options.prepare(prompt, signal)
      if (signal?.aborted) throw new DOMException("Request aborted", "AbortError")
      return chatTurn(options.preparationConversationId ?? "conv-prep", 1000)
    },
    async submitAnswerPrompt(input, signal) {
      if (options.submitAnswerPrompt) return options.submitAnswerPrompt(input, signal)
      if (signal?.aborted) throw new DOMException("Request aborted", "AbortError")
      return chatTurn(options.answerConversationId ?? input.conversationId ?? "conv-answer", 2000)
    },
  }
}

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function chatTurn(conversationId: string, completedAt: number): ChatTurnResult {
  return {
    conversationId,
    userMessageId: `user-${completedAt}`,
    assistantMessageId: `assistant-${completedAt}`,
    completedAt,
  }
}
