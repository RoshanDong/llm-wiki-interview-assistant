import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { InterviewSession, StatusEventDetails, StatusEventLevel, TranscriptSegment } from "./interview-types"
import type { QuestionDetectionInput, QuestionDetectionResult, QuestionDetector } from "./interview-question-detector"
import {
  buildRollingTranscriptContext,
  createSemanticQuestionScheduler,
  SEMANTIC_CONTEXT_MAX_SEGMENTS,
  SEMANTIC_CONTEXT_MAX_CHARS,
  SEMANTIC_IDLE_DEBOUNCE_MS,
  SEMANTIC_MIN_INTERVAL_MS,
  SEMANTIC_REFINEMENT_STABILIZATION_MS,
  SEMANTIC_STABILIZATION_MS,
  SEMANTIC_TIMEOUT_MS,
} from "./interview-question-scheduler"

function segment(
  id: string,
  text = `Question ${id}?`,
  overrides: Partial<TranscriptSegment> = {},
): TranscriptSegment {
  return {
    id,
    sessionId: "session-1",
    streamId: "stream-1",
    speaker: "interviewer",
    text,
    startMs: 0,
    endMs: Number(id.replace(/\D/g, "")) * 1000,
    confidence: 0.9,
    source: "system",
    state: "confirmed",
    definite: true,
    createdAt: 1000,
    ...overrides,
  }
}

function sessionWith(segments: TranscriptSegment[]): InterviewSession {
  return {
    id: "session-1",
    status: "listening",
    transcriptSegments: segments,
    questions: [],
  } as unknown as InterviewSession
}

function detectionResult(
  input: QuestionDetectionInput,
  questions: QuestionDetectionResult["questions"] = [],
): QuestionDetectionResult {
  return {
    contextVersion: input.contextVersion,
    turnComplete: true,
    conversationPhase: "normal_interview",
    questions,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("rolling semantic transcript context", () => {
  it("keeps confirmed context within segment, age, and character limits", () => {
    const manySegments = Array.from({ length: 30 }, (_, index) =>
      segment(`seg-${index + 1}`, `Question ${index + 1}?`, { endMs: (index + 1) * 1000 })
    )

    const byCount = buildRollingTranscriptContext({
      segments: manySegments,
      version: 1,
      builtAt: 1000,
    })
    expect(byCount.segments).toHaveLength(SEMANTIC_CONTEXT_MAX_SEGMENTS)
    expect(byCount.segments[0].id).toBe(`seg-${30 - SEMANTIC_CONTEXT_MAX_SEGMENTS + 1}`)

    const byAge = buildRollingTranscriptContext({
      segments: [
        segment("old", "old question", { endMs: 1_000 }),
        segment("recent", "recent question", { endMs: 30_000 }),
        segment("latest", "latest question", { endMs: 100_000 }),
      ],
      version: 2,
      builtAt: 1000,
    })
    expect(byAge.segments.map((item) => item.id)).toEqual(["recent", "latest"])

    const byChars = buildRollingTranscriptContext({
      segments: [
        segment("long-1", "a".repeat(SEMANTIC_CONTEXT_MAX_CHARS)),
        segment("long-2", "b".repeat(100)),
      ],
      version: 3,
      builtAt: 1000,
    })
    expect(byChars.segments.map((item) => item.id)).toEqual(["long-2"])
  })
})

describe("semantic question scheduler timing", () => {
  it("waits for idle and stabilization before emitting questions", async () => {
    const segments = [segment("seg-1")]
    const emitted: QuestionDetectionResult["questions"][] = []
    const detector: QuestionDetector = {
      detect: vi.fn(async (input) => detectionResult(input, [{
        text: "How do you test ASR models?",
        sourceSegmentIds: ["seg-1"],
      }])),
    }
    const scheduler = createSemanticQuestionScheduler({
      sessionId: "session-1",
      questionDetector: detector,
      getSession: () => sessionWith(segments),
      getExistingQuestionTexts: () => [],
      isSessionActive: () => true,
      emitQuestions: (questions) => emitted.push(questions),
      addEvent: () => {},
      now: () => Date.now(),
    })

    scheduler.onConfirmedTranscriptCommitted(segments[0])
    await vi.advanceTimersByTimeAsync(SEMANTIC_IDLE_DEBOUNCE_MS - 1)
    expect(detector.detect).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(detector.detect).toHaveBeenCalledTimes(1)
    expect(emitted).toEqual([])

    await vi.advanceTimersByTimeAsync(SEMANTIC_STABILIZATION_MS)
    expect(emitted[0]).toEqual([expect.objectContaining({
      text: "How do you test ASR models?",
    })])
  })

  it("emits timing metrics for the semantic detection lifecycle", async () => {
    vi.setSystemTime(10_000)
    const segments = [segment("seg-1", "How do you test ASR models?", {
      asrLatencyMs: 420,
      createdAt: 10_000,
    })]
    const events: Array<{ message: string; level?: StatusEventLevel; details?: StatusEventDetails }> = []
    const detector: QuestionDetector = {
      detect: vi.fn(async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 250))
        return detectionResult(input, [{
          text: "How do you test ASR models?",
          sourceSegmentIds: ["seg-1"],
        }])
      }),
    }
    const scheduler = createSemanticQuestionScheduler({
      sessionId: "session-1",
      questionDetector: detector,
      getSession: () => sessionWith(segments),
      getExistingQuestionTexts: () => [],
      isSessionActive: () => true,
      emitQuestions: () => {},
      addEvent: (message, level, details) => events.push({ message, level, details }),
      now: () => Date.now(),
    })

    scheduler.onConfirmedTranscriptCommitted(segments[0])
    await vi.advanceTimersByTimeAsync(SEMANTIC_IDLE_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(SEMANTIC_STABILIZATION_MS)

    const emitted = events.find((event) => event.message.startsWith("Stable questions emitted"))
    expect(emitted?.message).toContain("asr 420ms")
    expect(emitted?.message).toContain("wait 1000ms")
    expect(emitted?.message).toContain("llm 250ms")
    expect(emitted?.message).toContain("stable 700ms")
    expect(emitted?.message).toContain("total 1950ms")
    expect(emitted?.details).toMatchObject({
      asrLatencyMs: 420,
      confirmedToRunMs: 1000,
      llmDetectionMs: 250,
      stabilizationWaitMs: 700,
      runToEmitMs: 950,
      confirmedToEmitMs: 1950,
    })
  })

  it("enforces minimum interval between semantic detection starts", async () => {
    const segments = [segment("seg-1")]
    const detector: QuestionDetector = {
      detect: vi.fn(async (input) => detectionResult(input)),
    }
    const scheduler = createSemanticQuestionScheduler({
      sessionId: "session-1",
      questionDetector: detector,
      getSession: () => sessionWith(segments),
      getExistingQuestionTexts: () => [],
      isSessionActive: () => true,
      emitQuestions: () => {},
      addEvent: () => {},
      now: () => Date.now(),
    })

    scheduler.onConfirmedTranscriptCommitted(segments[0])
    await vi.advanceTimersByTimeAsync(SEMANTIC_IDLE_DEBOUNCE_MS)
    expect(detector.detect).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(200)
    segments.push(segment("seg-2", "Follow-up?", { endMs: 2_000 }))
    scheduler.onConfirmedTranscriptCommitted(segments[1])

    await vi.advanceTimersByTimeAsync(SEMANTIC_IDLE_DEBOUNCE_MS)
    expect(detector.detect).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SEMANTIC_MIN_INTERVAL_MS - SEMANTIC_IDLE_DEBOUNCE_MS - 200)
    expect(detector.detect).toHaveBeenCalledTimes(2)
  })

  it("skips low-value candidate answer continuations but still runs for technical questions", async () => {
    const segments = [segment("seg-answer", "主要负责会议字幕模块", {
      speaker: "interviewee",
    })]
    const events: Array<{ message: string; details?: StatusEventDetails }> = []
    const detector: QuestionDetector = {
      detect: vi.fn(async (input) => detectionResult(input)),
    }
    const scheduler = createSemanticQuestionScheduler({
      sessionId: "session-1",
      questionDetector: detector,
      getSession: () => sessionWith(segments),
      getExistingQuestionTexts: () => [],
      isSessionActive: () => true,
      emitQuestions: () => {},
      addEvent: (message, _level, details) => events.push({ message, details }),
      now: () => Date.now(),
    })

    scheduler.onConfirmedTranscriptCommitted(segments[0])
    await vi.advanceTimersByTimeAsync(SEMANTIC_IDLE_DEBOUNCE_MS)
    expect(detector.detect).not.toHaveBeenCalled()
    expect(events[0]).toMatchObject({
      message: "Question detection skipped: low-value context",
      details: expect.objectContaining({ reason: "candidate answer continuation" }),
    })

    segments.push(segment("seg-tech", "你们语音转文本算法模型是怎么测试的？", {
      speaker: "unknown",
      endMs: 2_000,
    }))
    scheduler.onConfirmedTranscriptCommitted(segments[1])
    await vi.advanceTimersByTimeAsync(SEMANTIC_IDLE_DEBOUNCE_MS)
    expect(detector.detect).toHaveBeenCalledTimes(1)
  })

  it("uses a longer refinement window for vague candidates", async () => {
    const segments = [segment("seg-vague", "前面这个算法是怎么测试的？")]
    const emitted: QuestionDetectionResult["questions"][] = []
    const detector: QuestionDetector = {
      detect: vi.fn(async (input) => detectionResult(input, [{
        text: "前面这个算法是怎么测试的？",
        answerGoal: "算法测试方法",
        sourceSegmentIds: ["seg-vague"],
      }])),
    }
    const scheduler = createSemanticQuestionScheduler({
      sessionId: "session-1",
      questionDetector: detector,
      getSession: () => sessionWith(segments),
      getExistingQuestionTexts: () => [],
      isSessionActive: () => true,
      emitQuestions: (questions) => emitted.push(questions),
      addEvent: () => {},
      now: () => Date.now(),
    })

    scheduler.onConfirmedTranscriptCommitted(segments[0])
    await vi.advanceTimersByTimeAsync(SEMANTIC_IDLE_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(SEMANTIC_STABILIZATION_MS)
    expect(emitted).toEqual([])

    await vi.advanceTimersByTimeAsync(SEMANTIC_REFINEMENT_STABILIZATION_MS - SEMANTIC_STABILIZATION_MS)
    expect(emitted[0]).toEqual([expect.objectContaining({
      text: "前面这个算法是怎么测试的？",
    })])
  })

  it("skips reverse-question phase even when the candidate asks about AI or business", async () => {
    const segments = [segment("seg-reverse", "这个AI测试开发岗位和业务有什么关系？", {
      speaker: "interviewee",
    })]
    const events: Array<{ message: string; details?: StatusEventDetails }> = []
    const detector: QuestionDetector = {
      detect: vi.fn(async (input) => detectionResult(input)),
    }
    const scheduler = createSemanticQuestionScheduler({
      sessionId: "session-1",
      questionDetector: detector,
      getSession: () => ({
        ...sessionWith(segments),
        reverseQuestionPhase: {
          state: "active",
          startedAt: 1000,
          triggerSegmentIds: ["seg-trigger"],
          lastSuppressedAt: null,
          resumeSegmentIds: [],
        },
      }),
      getExistingQuestionTexts: () => [],
      getReverseQuestionPhase: () => ({
        state: "active",
        startedAt: 1000,
        triggerSegmentIds: ["seg-trigger"],
        lastSuppressedAt: null,
        resumeSegmentIds: [],
      }),
      isSessionActive: () => true,
      emitQuestions: () => {},
      addEvent: (message, _level, details) => events.push({ message, details }),
      now: () => Date.now(),
    })

    scheduler.onConfirmedTranscriptCommitted(segments[0])
    await vi.advanceTimersByTimeAsync(SEMANTIC_IDLE_DEBOUNCE_MS)

    expect(detector.detect).not.toHaveBeenCalled()
    expect(events[0]).toMatchObject({
      message: "Question detection skipped: low-value context",
      details: expect.objectContaining({ reason: "reverse-question phase active" }),
    })
  })

  it("allows semantic detection after an explicit resumed-evaluation cue", async () => {
    const segments = [segment("seg-resume", "我们继续问一个技术问题，你这个算法怎么评测？")]
    const detector: QuestionDetector = {
      detect: vi.fn(async (input) => detectionResult(input)),
    }
    const scheduler = createSemanticQuestionScheduler({
      sessionId: "session-1",
      questionDetector: detector,
      getSession: () => ({
        ...sessionWith(segments),
        reverseQuestionPhase: {
          state: "active",
          startedAt: 1000,
          triggerSegmentIds: ["seg-trigger"],
          lastSuppressedAt: null,
          resumeSegmentIds: [],
        },
      }),
      getExistingQuestionTexts: () => [],
      getReverseQuestionPhase: () => ({
        state: "active",
        startedAt: 1000,
        triggerSegmentIds: ["seg-trigger"],
        lastSuppressedAt: null,
        resumeSegmentIds: [],
      }),
      isSessionActive: () => true,
      emitQuestions: () => {},
      addEvent: () => {},
      now: () => Date.now(),
    })

    scheduler.onConfirmedTranscriptCommitted(segments[0])
    await vi.advanceTimersByTimeAsync(SEMANTIC_IDLE_DEBOUNCE_MS)

    expect(detector.detect).toHaveBeenCalledTimes(1)
  })
})

describe("semantic question scheduler freshness", () => {
  it("keeps one in-flight run and rechecks latest context after stale result returns", async () => {
    const segments = [segment("seg-1")]
    const emitted: QuestionDetectionResult["questions"][] = []
    const resolvers: Array<(value: QuestionDetectionResult) => void> = []
    const inputs: QuestionDetectionInput[] = []
    const detector: QuestionDetector = {
      detect: vi.fn((input) => {
        inputs.push(input)
        return new Promise<QuestionDetectionResult>((resolve) => resolvers.push(resolve))
      }),
    }
    const scheduler = createSemanticQuestionScheduler({
      sessionId: "session-1",
      questionDetector: detector,
      getSession: () => sessionWith(segments),
      getExistingQuestionTexts: () => [],
      isSessionActive: () => true,
      emitQuestions: (questions) => emitted.push(questions),
      addEvent: () => {},
      now: () => Date.now(),
    })

    scheduler.onConfirmedTranscriptCommitted(segments[0])
    await vi.advanceTimersByTimeAsync(SEMANTIC_IDLE_DEBOUNCE_MS)
    expect(detector.detect).toHaveBeenCalledTimes(1)

    segments.push(segment("seg-2", "Clarified final question?", { endMs: 2_000 }))
    scheduler.onConfirmedTranscriptCommitted(segments[1])
    resolvers[0](detectionResult(inputs[0], [{
      text: "Old question?",
      sourceSegmentIds: ["seg-1"],
    }]))
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(SEMANTIC_STABILIZATION_MS)
    expect(emitted).toEqual([])

    await vi.advanceTimersByTimeAsync(SEMANTIC_MIN_INTERVAL_MS)
    expect(detector.detect).toHaveBeenCalledTimes(2)
    expect(inputs[1].recentSegments.map((item) => item.id)).toEqual(["seg-1", "seg-2"])

    resolvers[1](detectionResult(inputs[1], [{
      text: "Clarified final question?",
      sourceSegmentIds: ["seg-1", "seg-2"],
    }]))
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(SEMANTIC_STABILIZATION_MS)
    expect(emitted[0][0].text).toBe("Clarified final question?")
  })

  it("aborts timed-out detection and emits a recoverable diagnostic", async () => {
    const segments = [segment("seg-1")]
    const events: Array<{ message: string; level?: StatusEventLevel; details?: StatusEventDetails }> = []
    let aborted = false
    const detector: QuestionDetector = {
      detect: vi.fn((_input, signal) => new Promise<QuestionDetectionResult>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true
          reject(new DOMException("Request aborted", "AbortError"))
        })
      })),
    }
    const scheduler = createSemanticQuestionScheduler({
      sessionId: "session-1",
      questionDetector: detector,
      getSession: () => sessionWith(segments),
      getExistingQuestionTexts: () => [],
      isSessionActive: () => true,
      emitQuestions: () => {},
      addEvent: (message, level, details) => events.push({ message, level, details }),
      now: () => Date.now(),
    })

    scheduler.onConfirmedTranscriptCommitted(segments[0])
    await vi.advanceTimersByTimeAsync(SEMANTIC_IDLE_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(SEMANTIC_TIMEOUT_MS)

    expect(aborted).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("Question detection timed out"),
      level: "warn",
    }))
  })

  it("stops waiting and running scheduler work", async () => {
    const segments = [segment("seg-1")]
    const detector: QuestionDetector = {
      detect: vi.fn(async (input) => detectionResult(input)),
    }
    const scheduler = createSemanticQuestionScheduler({
      sessionId: "session-1",
      questionDetector: detector,
      getSession: () => sessionWith(segments),
      getExistingQuestionTexts: () => [],
      isSessionActive: () => true,
      emitQuestions: () => {},
      addEvent: () => {},
      now: () => Date.now(),
    })

    scheduler.onConfirmedTranscriptCommitted(segments[0])
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(SEMANTIC_IDLE_DEBOUNCE_MS + SEMANTIC_TIMEOUT_MS)

    expect(detector.detect).not.toHaveBeenCalled()
  })
})
