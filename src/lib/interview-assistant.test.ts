import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useInterviewStore } from "@/stores/interview-store"
import { createAudioSourceSelection } from "./interview-audio"
import { DEFAULT_ANSWER_PROMPT } from "./interview-settings"
import {
  createDeferred,
  createFakeAudioSourceAdapter,
  createFakeInterviewGateway,
  createFakeQuestionDetector,
  createFakeTranscriptProvider,
  genericInterviewProjectProfiles,
} from "./interview-test-fakes"
import { createInterviewAssistant, createProductionInterviewStartInput } from "./interview-assistant"
import { HeuristicQuestionDetector } from "./interview-question-detector"
import {
  SEMANTIC_IDLE_DEBOUNCE_MS,
  SEMANTIC_STABILIZATION_MS,
} from "./interview-question-scheduler"
import type { AudioSourceSelection } from "./interview-types"

beforeEach(() => {
  useInterviewStore.getState().resetSession(1000)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }
}

async function advanceSemanticDetectionTimers(): Promise<void> {
  await flushMicrotasks()
  await vi.advanceTimersByTimeAsync(SEMANTIC_IDLE_DEBOUNCE_MS)
  await flushMicrotasks()
  await vi.advanceTimersByTimeAsync(SEMANTIC_STABILIZATION_MS)
  await flushMicrotasks()
}

function debugFileSource(now = 2100): AudioSourceSelection & { kind: "file" } {
  return createAudioSourceSelection(
    "file",
    "Debug file",
    now,
    undefined,
    "/tmp/interview.wav",
  ) as AudioSourceSelection & { kind: "file" }
}

function stubLiveAudioCaptureAvailable() {
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(),
      getDisplayMedia: vi.fn(),
    },
  })
  vi.stubGlobal("AudioContext", class FakeAudioContext {})
}

describe("interview assistant preparation", () => {
  it("starts listening without a preparation step", async () => {
    stubLiveAudioCaptureAvailable()
    const assistant = createInterviewAssistant({
      gateway: createFakeInterviewGateway({ preparationConversationId: "conv-ready" }),
      audioAdapters: {
        system: createFakeAudioSourceAdapter("system"),
        microphone: createFakeAudioSourceAdapter("microphone"),
      },
      transcriptProvider: createFakeTranscriptProvider([]),
      now: () => 2000,
    })
    const startInput = createProductionInterviewStartInput(2100)

    expect(useInterviewStore.getState().session.preparation).toMatchObject({
      status: "idle",
      conversationId: null,
      error: null,
    })

    await expect(assistant.start(startInput)).resolves.toBeUndefined()
    expect(useInterviewStore.getState().session.status).toBe("connecting")
  })

  it("blocks production start before session creation when live capture is unavailable", async () => {
    vi.stubGlobal("navigator", {})
    vi.stubGlobal("AudioContext", class FakeAudioContext {})
    const assistant = createInterviewAssistant({
      gateway: createFakeInterviewGateway(),
      now: () => 2000,
    })

    await expect(assistant.start(createProductionInterviewStartInput(2100))).rejects.toThrow(
      "Live audio capture is not available in this runtime.",
    )

    const state = useInterviewStore.getState()
    expect(state.session.status).toBe("idle")
    expect(state.session.streaming).toBeNull()
    expect(state.statusEvents[0]).toMatchObject({
      kind: "audio",
      level: "error",
      details: {
        audioCaptureCapabilityCheck: true,
        microphoneAvailable: false,
        systemAvailable: false,
      },
    })
  })

  it("keeps explicit preparation failures recoverable", async () => {
    const assistant = createInterviewAssistant({
      gateway: createFakeInterviewGateway({
        prepare: async () => {
          throw new Error("LLM Wiki unavailable")
        },
      }),
      now: () => 2000,
    })

    await expect(assistant.prepare("prepare")).rejects.toThrow("LLM Wiki unavailable")

    const state = useInterviewStore.getState().session
    expect(state.preparation.status).toBe("failed")
    expect(state.preparation.error).toBe("LLM Wiki unavailable")
    expect(state.status).toBe("idle")
  })
})

describe("interview assistant transcript ingestion", () => {
  it("streams transcript segments with speaker labels after start", async () => {
    const source = debugFileSource()
    const assistant = createInterviewAssistant({
      gateway: createFakeInterviewGateway({ preparationConversationId: "conv-ready" }),
      audioAdapters: {
        file: createFakeAudioSourceAdapter("file"),
      },
      transcriptProvider: createFakeTranscriptProvider([{
        id: "seg-1",
        sessionId: useInterviewStore.getState().session.id,
        speaker: "interviewer",
        text: "Can you introduce yourself?",
        startMs: 0,
        endMs: 1200,
        confidence: 0.91,
        source: "file",
        createdAt: 2200,
      }]),
      questionDetector: createFakeQuestionDetector({ questions: [] }),
      now: () => 2200,
    })

    await assistant.prepare("prepare")
    await assistant.start({ mode: "debug", file: source })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useInterviewStore.getState().session.transcriptSegments).toEqual([
      expect.objectContaining({
        speaker: "interviewer",
        text: "Can you introduce yourself?",
      }),
    ])
  })

  it("does not run question detection for provisional-only transcript updates", async () => {
    const source = debugFileSource()
    const assistant = createInterviewAssistant({
      gateway: createFakeInterviewGateway({ preparationConversationId: "conv-ready" }),
      audioAdapters: {
        file: createFakeAudioSourceAdapter("file"),
      },
      transcriptProvider: createFakeTranscriptProvider([{
        id: "prov-question",
        sessionId: useInterviewStore.getState().session.id,
        speaker: "interviewer",
        text: "Can you introduce",
        startMs: 0,
        endMs: 800,
        confidence: 0.7,
        source: "file",
        state: "provisional",
        definite: false,
        providerUtteranceId: "utt-1",
        createdAt: 2200,
      }]),
      questionDetector: createFakeQuestionDetector({
        questions: [{ text: "Can you introduce?", sourceSegmentIds: ["prov-question"] }],
      }),
      now: () => 2400,
    })

    await assistant.prepare("prepare")
    await assistant.start({ mode: "debug", file: source })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useInterviewStore.getState().session.transcriptSegments).toEqual([])
    expect(useInterviewStore.getState().session.provisionalTranscriptSegments).toHaveLength(1)
    expect(useInterviewStore.getState().session.questions).toEqual([])
  })

  it("does not report impossible ASR latency for debug-file replay segments", async () => {
    const source = debugFileSource()
    const assistant = createInterviewAssistant({
      gateway: createFakeInterviewGateway({ preparationConversationId: "conv-ready" }),
      audioAdapters: {
        file: createFakeAudioSourceAdapter("file"),
      },
      transcriptProvider: createFakeTranscriptProvider([{
        id: "debug-latency",
        sessionId: useInterviewStore.getState().session.id,
        speaker: "interviewer",
        text: "调试音频里的问题？",
        startMs: 2_000_000,
        endMs: 2_001_500,
        confidence: 0.91,
        source: "file",
        state: "confirmed",
        definite: true,
        createdAt: 2600,
      }]),
      questionDetector: createFakeQuestionDetector({ questions: [] }),
      now: () => 2400,
    })

    await assistant.prepare("prepare")
    await assistant.start({ mode: "debug", file: source })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useInterviewStore.getState().session.transcriptSegments[0]).toMatchObject({
      asrLatencyMs: null,
      audioStartMs: 2_000_000,
      audioEndMs: 2_001_500,
      segmentDurationMs: 1500,
      recognitionProcessingMs: 200,
    })
  })

  it("keeps ASR transcript alive when semantic question detection fails", async () => {
    vi.useFakeTimers()
    const source = debugFileSource()
    const assistant = createInterviewAssistant({
      gateway: createFakeInterviewGateway({ preparationConversationId: "conv-ready" }),
      audioAdapters: {
        file: createFakeAudioSourceAdapter("file"),
      },
      transcriptProvider: createFakeTranscriptProvider([{
        id: "seg-question-detector-error",
        sessionId: useInterviewStore.getState().session.id,
        speaker: "unknown",
        text: "就整个你的产研的一个项目流程是怎样的？",
        startMs: 0,
        endMs: 1200,
        confidence: 0.91,
        source: "file",
        state: "confirmed",
        definite: true,
        createdAt: 2200,
      }]),
      questionDetector: {
        async detect() {
          throw new Error("semantic detector unavailable")
        },
      },
      now: () => 2400,
    })

    await assistant.prepare("prepare")
    await assistant.start({ mode: "debug", file: source })
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(SEMANTIC_IDLE_DEBOUNCE_MS)
    await flushMicrotasks()

    const state = useInterviewStore.getState()
    expect(state.session.transcriptSegments).toEqual([
      expect.objectContaining({
        id: "seg-question-detector-error",
        text: "就整个你的产研的一个项目流程是怎样的？",
      }),
    ])
    expect(state.session.questions).toEqual([])
    expect(state.session.status).not.toBe("failed")
    expect(state.statusEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "question",
        level: "warn",
        message: expect.stringContaining("Question detection failed: semantic detector unavailable"),
      }),
    ]))
  })

  it("detects interviewer questions and submits an answer prompt without copying answer content", async () => {
    vi.useFakeTimers()
    const submittedPrompts: string[] = []
    const submittedConversationIds: Array<string | null | undefined> = []
    const source = debugFileSource()
    const questionText = "How did you improve retrieval quality?"
    const assistant = createInterviewAssistant({
      gateway: createFakeInterviewGateway({
        submitAnswerPrompt: async (input) => {
          submittedPrompts.push(input.prompt)
          submittedConversationIds.push(input.conversationId)
          return {
            conversationId: "conv-auto",
            userMessageId: "user-answer",
            assistantMessageId: "assistant-answer",
            assistantMessageContent: "Generated answer content for export.",
            completedAt: 2600,
          }
        },
      }),
      audioAdapters: {
        file: createFakeAudioSourceAdapter("file"),
      },
      transcriptProvider: createFakeTranscriptProvider([{
        id: "seg-question",
        sessionId: useInterviewStore.getState().session.id,
        speaker: "interviewer",
        text: questionText,
        startMs: 0,
        endMs: 1200,
        confidence: 0.91,
        source: "file",
        createdAt: 2200,
      }]),
      questionDetector: createFakeQuestionDetector({
        questions: [{ text: questionText, sourceSegmentIds: ["seg-question"] }],
      }),
      answerPromptTemplate: () => DEFAULT_ANSWER_PROMPT,
      now: () => 2400,
    })

    await assistant.start({ mode: "debug", file: source })
    await advanceSemanticDetectionTimers()

    expect(submittedConversationIds[0]).toBeNull()
    expect(submittedPrompts[0]).toContain(questionText)
    expect(submittedPrompts[0]).toContain("200-300 字")
    expect(submittedPrompts[0]).toContain("知识库缺少相关内容时")
    expect(useInterviewStore.getState().session.questions[0]).toMatchObject({
      text: questionText,
      status: "completed",
    })
    expect(useInterviewStore.getState().session.preparation).toMatchObject({
      status: "succeeded",
      conversationId: "conv-auto",
      error: null,
    })
    expect(useInterviewStore.getState().session.status).toBe("connecting")
    expect(useInterviewStore.getState().answerRequests[0]).toMatchObject({
      conversationId: "conv-auto",
      assistantMessageContent: "Generated answer content for export.",
    })
    expect(JSON.stringify(useInterviewStore.getState().session.questions)).not.toContain("assistant-answer")
  })

  it("submits routed prompt families and records answer routing metadata", async () => {
    vi.useFakeTimers()
    const submittedPrompts: string[] = []
    const source = debugFileSource()
    const assistant = createInterviewAssistant({
      gateway: createFakeInterviewGateway({
        preparationConversationId: "conv-ready",
        submitAnswerPrompt: async (input) => {
          submittedPrompts.push(input.prompt)
          return {
            conversationId: input.conversationId ?? "conv-answer",
            userMessageId: "user-code",
            assistantMessageId: "assistant-code",
            completedAt: 2600,
          }
        },
      }),
      audioAdapters: { file: createFakeAudioSourceAdapter("file") },
      transcriptProvider: createFakeTranscriptProvider([{
        id: "seg-code",
        sessionId: useInterviewStore.getState().session.id,
        speaker: "interviewer",
        text: "手撕代码：写一个函数反转链表，并分析复杂度。",
        startMs: 0,
        endMs: 1200,
        confidence: 0.91,
        source: "file",
        createdAt: 2200,
      }]),
      questionDetector: createFakeQuestionDetector({
        questions: [{
          text: "手撕代码：写一个函数反转链表，并分析复杂度。",
          sourceSegmentIds: ["seg-code"],
          questionType: "手撕代码类",
        }],
      }),
      answerPromptTemplates: () => ({
        coding: "CUSTOM CODING：（提问内容）",
      }),
      now: () => 2400,
    })

    await assistant.prepare("prepare")
    await assistant.start({ mode: "debug", file: source })
    await advanceSemanticDetectionTimers()

    expect(submittedPrompts[0]).toBe("CUSTOM CODING：手撕代码：写一个函数反转链表，并分析复杂度。")
    expect(submittedPrompts[0]).not.toContain("Answer prompt family")
    expect(useInterviewStore.getState().answerRequests[0]).toMatchObject({
      questionType: "手撕代码类",
      answerPromptFamily: "coding",
      retrievalPolicy: "direct_no_project_grounding",
    })
  })

  it("inherits project context for follow-up prompts and clears it for coding prompts", async () => {
    vi.useFakeTimers()
    const submittedPrompts: string[] = []
    const source = debugFileSource()
    const assistant = createInterviewAssistant({
      gateway: createFakeInterviewGateway({
        preparationConversationId: "conv-ready",
        submitAnswerPrompt: async (input) => {
          submittedPrompts.push(input.prompt)
          return {
            conversationId: input.conversationId ?? "conv-answer",
            userMessageId: `user-${submittedPrompts.length}`,
            assistantMessageId: `assistant-${submittedPrompts.length}`,
            completedAt: 2600 + submittedPrompts.length,
          }
        },
      }),
      audioAdapters: { file: createFakeAudioSourceAdapter("file") },
      transcriptProvider: createFakeTranscriptProvider([{
        id: "seg-routing",
        sessionId: useInterviewStore.getState().session.id,
        speaker: "interviewer",
        text: "搜索质量平台怎么做？那这个指标怎么算？最后手撕代码反转链表。",
        startMs: 0,
        endMs: 1200,
        confidence: 0.91,
        source: "file",
        createdAt: 2200,
      }]),
      questionDetector: createFakeQuestionDetector({
        questions: [
          {
            text: "搜索质量平台你是怎么做的？",
            sourceSegmentIds: ["seg-routing"],
          },
          {
            text: "那这个指标怎么算？",
            sourceSegmentIds: ["seg-routing"],
          },
          {
            text: "手撕代码：写一个函数反转链表，并分析复杂度。",
            sourceSegmentIds: ["seg-routing"],
          },
        ],
      }),
      projectProfiles: () => genericInterviewProjectProfiles,
      now: () => 2400,
    })

    await assistant.prepare("prepare")
    await assistant.start({ mode: "debug", file: source })
    await advanceSemanticDetectionTimers()

    expect(submittedPrompts).toHaveLength(3)
    expect(submittedPrompts[0]).toContain("在「搜索质量平台」项目中")
    expect(submittedPrompts[1]).toContain("在「搜索质量平台」项目中")
    expect(submittedPrompts[1]).not.toContain("项目路由状态")
    expect(submittedPrompts[2]).toContain("请回答编程题：手撕代码")
    expect(submittedPrompts[2]).not.toContain("项目：搜索质量平台")
  })

  it("refines an active question when candidate clarification is confirmed", async () => {
    vi.useFakeTimers()
    const answer = createDeferred<{ conversationId: string; userMessageId: string; assistantMessageId: string; completedAt: number }>()
    const source = debugFileSource()
    const assistant = createInterviewAssistant({
      gateway: createFakeInterviewGateway({
        preparationConversationId: "conv-ready",
        submitAnswerPrompt: async () => answer.promise,
      }),
      audioAdapters: {
        file: createFakeAudioSourceAdapter("file"),
      },
      transcriptProvider: createFakeTranscriptProvider([
        {
          id: "seg-initial",
          sessionId: useInterviewStore.getState().session.id,
          speaker: "interviewer",
          text: "Can you discuss reliability?",
          startMs: 0,
          endMs: 1000,
          confidence: 0.9,
          source: "system",
          state: "confirmed",
          definite: true,
          createdAt: 2200,
        },
        {
          id: "seg-clarify",
          sessionId: useInterviewStore.getState().session.id,
          speaker: "interviewee",
          text: "Do you mean cache reliability plan?",
          startMs: 1100,
          endMs: 1800,
          confidence: 0.9,
          source: "microphone",
          state: "confirmed",
          definite: true,
          createdAt: 2300,
        },
        {
          id: "seg-confirm",
          sessionId: useInterviewStore.getState().session.id,
          speaker: "interviewer",
          text: "Yes.",
          startMs: 1900,
          endMs: 2200,
          confidence: 0.9,
          source: "system",
          state: "confirmed",
          definite: true,
          createdAt: 2400,
        },
      ]),
      questionDetector: new HeuristicQuestionDetector(),
      now: () => 2500,
    })

    await assistant.prepare("prepare")
    await assistant.start({ mode: "debug", file: source })
    await advanceSemanticDetectionTimers()

    expect(useInterviewStore.getState().session.questions).toHaveLength(1)
    expect(useInterviewStore.getState().session.questions[0]).toMatchObject({
      text: "cache reliability plan",
      clarificationState: "confirmed",
      sourceSegmentIds: ["seg-initial", "seg-clarify", "seg-confirm"],
    })
  })

  it("queues one canonical question for duplicate candidates with the same answer goal", async () => {
    vi.useFakeTimers()
    const source = debugFileSource()
    const assistant = createInterviewAssistant({
      gateway: createFakeInterviewGateway({ preparationConversationId: "conv-ready" }),
      audioAdapters: { file: createFakeAudioSourceAdapter("file") },
      transcriptProvider: createFakeTranscriptProvider([{
        id: "seg-ai",
        sessionId: useInterviewStore.getState().session.id,
        speaker: "unknown",
        text: "AI 这一块能讲讲你的实践情况吗？用过哪些工具？",
        startMs: 0,
        endMs: 1200,
        confidence: 0.9,
        source: "file",
        state: "confirmed",
        definite: true,
        createdAt: 2200,
      }]),
      questionDetector: createFakeQuestionDetector({
        questions: [
          {
            text: "AI 这一块能讲讲你的了解或实践情况吗？",
            answerGoal: "AI测试实践工具与应用",
            sourceSegmentIds: ["seg-ai"],
          },
          {
            text: "你在AI方面有哪些实践？用过哪些AI工具？AI在测试中有什么应用？",
            answerGoal: "AI测试实践工具与应用",
            sourceSegmentIds: ["seg-ai"],
          },
        ],
      }),
      now: () => 2400,
    })

    await assistant.prepare("prepare")
    await assistant.start({ mode: "debug", file: source })
    await advanceSemanticDetectionTimers()

    const state = useInterviewStore.getState()
    expect(state.session.questions).toHaveLength(1)
    expect(state.session.questions[0]).toMatchObject({
      answerGoal: "AI测试实践工具与应用",
    })
    expect(state.session.queueCandidateOutcomes.map((item) => item.outcome)).toEqual([
      "added",
      "refined_pending",
    ])
  })

  it("suppresses candidate reverse questions after the reverse-question phase starts", async () => {
    vi.useFakeTimers()
    const source = debugFileSource()
    const assistant = createInterviewAssistant({
      gateway: createFakeInterviewGateway({ preparationConversationId: "conv-ready" }),
      audioAdapters: { file: createFakeAudioSourceAdapter("file") },
      transcriptProvider: createFakeTranscriptProvider([{
        id: "seg-reverse",
        sessionId: useInterviewStore.getState().session.id,
        speaker: "unknown",
        text: "你有什么想问我或者想了解的吗？这个AI测试开发岗位的具体工作内容是什么？",
        startMs: 0,
        endMs: 1200,
        confidence: 0.9,
        source: "file",
        state: "confirmed",
        definite: true,
        createdAt: 2200,
      }]),
      questionDetector: createFakeQuestionDetector({
        conversationPhase: "reverse_question",
        questions: [{
          text: "这个AI测试开发岗位的具体工作内容是什么？",
          answerGoal: "AI测试开发岗位工作内容",
          sourceSegmentIds: ["seg-reverse"],
        }],
      }),
      now: () => 2400,
    })

    await assistant.prepare("prepare")
    await assistant.start({ mode: "debug", file: source })
    await advanceSemanticDetectionTimers()

    const state = useInterviewStore.getState()
    expect(state.session.questions).toEqual([])
    expect(state.session.reverseQuestionPhase.state).toBe("active")
    expect(state.session.queueCandidateOutcomes[0]).toMatchObject({
      outcome: "suppressed_reverse_question",
      answerGoal: "AI测试开发岗位工作内容",
    })
  })
})

describe("interview assistant answer queue", () => {
  it("keeps one active answer request and advances FIFO after completion", async () => {
    vi.useFakeTimers()
    const answerOne = createDeferred<{ conversationId: string; userMessageId: string; assistantMessageId: string; completedAt: number }>()
    const answerTwo = createDeferred<{ conversationId: string; userMessageId: string; assistantMessageId: string; completedAt: number }>()
    const submitted: string[] = []
    const source = debugFileSource()
    const assistant = createInterviewAssistant({
      gateway: createFakeInterviewGateway({
        preparationConversationId: "conv-ready",
        submitAnswerPrompt: async (input) => {
          submitted.push(input.questionId)
          return submitted.length === 1 ? answerOne.promise : answerTwo.promise
        },
      }),
      audioAdapters: { file: createFakeAudioSourceAdapter("file") },
      transcriptProvider: createFakeTranscriptProvider([{
        id: "seg-queue",
        sessionId: useInterviewStore.getState().session.id,
        speaker: "interviewer",
        text: "Two questions",
        startMs: 0,
        endMs: 1000,
        confidence: 0.9,
        source: "file",
        createdAt: 2200,
      }]),
      questionDetector: createFakeQuestionDetector({
        questions: [
          { text: "First question?", sourceSegmentIds: ["seg-queue"] },
          { text: "Second question?", sourceSegmentIds: ["seg-queue"] },
        ],
      }),
      now: () => 2400,
    })

    await assistant.prepare("prepare")
    await assistant.start({ mode: "debug", file: source })
    await advanceSemanticDetectionTimers()

    expect(useInterviewStore.getState().session.questions.map((item) => item.status)).toEqual([
      "answering",
      "pending",
    ])

    answerOne.resolve({
      conversationId: "conv-ready",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      completedAt: 3000,
    })
    await flushMicrotasks()

    expect(useInterviewStore.getState().session.questions.map((item) => item.status)).toEqual([
      "completed",
      "answering",
    ])

    answerTwo.resolve({
      conversationId: "conv-ready",
      userMessageId: "user-2",
      assistantMessageId: "assistant-2",
      completedAt: 4000,
    })
    await flushMicrotasks()

    expect(useInterviewStore.getState().session.questions.map((item) => item.status)).toEqual([
      "completed",
      "completed",
    ])
  })

  it("moves failed answers to attention and supports retry, skip, and manual complete", async () => {
    vi.useFakeTimers()
    let attempts = 0
    const source = debugFileSource()
    const assistant = createInterviewAssistant({
      gateway: createFakeInterviewGateway({
        preparationConversationId: "conv-ready",
        submitAnswerPrompt: async (input) => {
          attempts += 1
          if (attempts === 1) throw new Error("gateway timeout")
          return {
            conversationId: input.conversationId ?? "conv-answer",
            userMessageId: "user-retry",
            assistantMessageId: "assistant-retry",
            completedAt: 3000,
          }
        },
      }),
      audioAdapters: { file: createFakeAudioSourceAdapter("file") },
      transcriptProvider: createFakeTranscriptProvider([{
        id: "seg-attention",
        sessionId: useInterviewStore.getState().session.id,
        speaker: "interviewer",
        text: "Question",
        startMs: 0,
        endMs: 1000,
        confidence: 0.9,
        source: "file",
        createdAt: 2200,
      }]),
      questionDetector: createFakeQuestionDetector({
        questions: [{ text: "Stuck question?", sourceSegmentIds: ["seg-attention"] }],
      }),
      now: () => 2400,
    })

    await assistant.prepare("prepare")
    await assistant.start({ mode: "debug", file: source })
    await advanceSemanticDetectionTimers()

    const questionId = useInterviewStore.getState().session.questions[0].id
    expect(useInterviewStore.getState().session.questions[0].status).toBe("attention")

    await assistant.retryQuestion(questionId)
    await flushMicrotasks()
    expect(useInterviewStore.getState().session.questions[0].status).toBe("completed")
    expect(useInterviewStore.getState().session.questionCoverage[0]).toMatchObject({
      questionId,
      status: "completed",
    })

    useInterviewStore.getState().updateQuestion(questionId, { status: "attention" })
    assistant.skipQuestion(questionId)
    expect(useInterviewStore.getState().session.questions[0].status).toBe("canceled")
    expect(useInterviewStore.getState().session.questionCoverage[0]).toMatchObject({
      questionId,
      status: "skipped",
    })

    useInterviewStore.getState().updateQuestion(questionId, { status: "attention", canceledAt: null })
    assistant.markQuestionComplete(questionId)
    expect(useInterviewStore.getState().session.questions[0].status).toBe("completed")
    expect(useInterviewStore.getState().session.questionCoverage[0]).toMatchObject({
      questionId,
      status: "completed",
    })
  })

  it("cancels active and pending questions when the interview ends", async () => {
    vi.useFakeTimers()
    const answer = createDeferred<{ conversationId: string; userMessageId: string; assistantMessageId: string; completedAt: number }>()
    const source = debugFileSource()
    const assistant = createInterviewAssistant({
      gateway: createFakeInterviewGateway({
        preparationConversationId: "conv-ready",
        submitAnswerPrompt: async () => answer.promise,
      }),
      audioAdapters: { file: createFakeAudioSourceAdapter("file") },
      transcriptProvider: createFakeTranscriptProvider([{
        id: "seg-cancel",
        sessionId: useInterviewStore.getState().session.id,
        speaker: "interviewer",
        text: "Cancel questions",
        startMs: 0,
        endMs: 1000,
        confidence: 0.9,
        source: "file",
        createdAt: 2200,
      }]),
      questionDetector: createFakeQuestionDetector({
        questions: [
          { text: "Active question?", sourceSegmentIds: ["seg-cancel"] },
          { text: "Pending question?", sourceSegmentIds: ["seg-cancel"] },
        ],
      }),
      now: () => 2400,
    })

    await assistant.prepare("prepare")
    await assistant.start({ mode: "debug", file: source })
    await advanceSemanticDetectionTimers()
    await assistant.end()

    expect(useInterviewStore.getState().session.questions.map((item) => item.status)).toEqual([
      "canceled",
      "canceled",
    ])
    expect(useInterviewStore.getState().session.status).toBe("ended")
  })
})
