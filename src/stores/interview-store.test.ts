import { beforeEach, describe, expect, it } from "vitest"
import type { AudioSourceSelection, DetectedQuestion, TranscriptSegment } from "@/lib/interview-types"
import {
  deriveQuestionWaitingMs,
  selectInterviewAssistantState,
  selectPendingQuestions,
  useInterviewStore,
} from "./interview-store"

function source(now = 1000): AudioSourceSelection {
  return {
    kind: "microphone",
    label: "Built-in microphone",
    fileName: null,
    selectedAt: now,
  }
}

function segment(id: string, text = "Tell me about yourself"): TranscriptSegment {
  return {
    id,
    sessionId: "session-test",
    streamId: "stream-mic",
    speaker: "interviewer",
    text,
    startMs: 0,
    endMs: 1000,
    confidence: 0.9,
    source: "microphone",
    createdAt: 1100,
  }
}

function question(id: string, queuedAt: number): DetectedQuestion {
  return {
    id,
    sessionId: "session-test",
    text: `Question ${id}?`,
    sourceSegmentIds: ["s1"],
    detectedAt: queuedAt,
    status: "pending",
    queuedAt,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    attentionReason: null,
  }
}

beforeEach(() => {
  useInterviewStore.getState().resetSession(1000)
})

describe("interview store session lifecycle", () => {
  it("keeps live interview data temporary and clears it on reset", () => {
    const store = useInterviewStore.getState()
    store.setPreparation({
      status: "succeeded",
      startedAt: 1000,
      completedAt: 1100,
      conversationId: "conv-1",
      error: null,
    })
    store.setAudioSource(source(1200))
    store.startSession(1300)
    store.addTranscriptSegment(segment("s1"))
    store.addDetectedQuestions([question("q1", 1400)])

    expect(useInterviewStore.getState().session.status).toBe("listening")
    expect(useInterviewStore.getState().session.transcriptSegments).toHaveLength(1)
    expect(useInterviewStore.getState().session.questions).toHaveLength(1)

    store.resetSession(2000)

    const reset = useInterviewStore.getState().session
    expect(reset.status).toBe("idle")
    expect(reset.preparation.status).toBe("idle")
    expect(reset.audioSource).toBeNull()
    expect(reset.transcriptSegments).toEqual([])
    expect(reset.questions).toEqual([])
    expect(useInterviewStore.getState().answerRequests).toEqual([])
  })

  it("keeps an active interview live when answer chat creation stores a conversation", () => {
    const store = useInterviewStore.getState()
    store.startSession(1300)

    store.setPreparation({
      status: "succeeded",
      startedAt: 1400,
      completedAt: 1500,
      conversationId: "conv-answer",
      error: null,
    })

    const state = useInterviewStore.getState().session
    expect(state.status).toBe("listening")
    expect(state.preparation.conversationId).toBe("conv-answer")
  })

  it("selects pending questions in FIFO order", () => {
    const store = useInterviewStore.getState()
    store.addDetectedQuestions([
      question("later", 3000),
      question("earlier", 2000),
    ])

    expect(selectPendingQuestions(useInterviewStore.getState()).map((item) => item.id)).toEqual([
      "earlier",
      "later",
    ])
  })

  it("derives waiting time without persisting it on the question", () => {
    const item = question("q1", 2000)

    expect(deriveQuestionWaitingMs(item, 2750)).toBe(750)
    expect(item).not.toHaveProperty("waitingMs")
  })

  it("clears assistant-only status and answer request state on reset", () => {
    const store = useInterviewStore.getState()
    store.addDetectedQuestions([question("q1", 1000)])
    store.addAnswerRequest({
      id: "answer-1",
      questionId: "q1",
      conversationId: "conv-1",
      submittedPrompt: "prompt",
      assistantMessageContent: null,
      status: "answering",
      submittedAt: 1000,
      completedAt: null,
      canceledAt: null,
      errorCode: null,
      errorMessage: null,
    })
    store.addStatusEvent({
      id: "status-1",
      sessionId: store.session.id,
      kind: "chat",
      message: "Answering",
      level: "info",
      createdAt: 1000,
      details: {},
    })

    store.resetSession(3000)
    const reset = useInterviewStore.getState().session

    expect(useInterviewStore.getState().session.questions).toEqual([])
    expect(useInterviewStore.getState().answerRequests).toEqual([])
    expect(useInterviewStore.getState().statusEvents).toEqual([])
    expect(useInterviewStore.getState().fullStatusEvents).toEqual([])
    expect(reset.questionCoverage).toEqual([])
    expect(reset.queueCandidateOutcomes).toEqual([])
    expect(reset.reverseQuestionPhase.state).toBe("inactive")
    expect(reset.primaryProjectState).toMatchObject({
      currentProject: null,
      status: "empty",
    })
    expect(reset.routingDiagnostics).toEqual([])
  })

  it("stores primary project state and routing diagnostics", () => {
    const store = useInterviewStore.getState()

    store.setPrimaryProjectState({
      currentProject: "搜索质量平台",
      status: "active",
      updatedAt: 2000,
      sourceQuestionId: "q1",
      reason: "project detected",
    })
    store.addRoutingDiagnostics([{
      questionId: "q1",
      questionType: "项目方法方案类",
      projectCategory: "搜索质量平台",
      projectRoutingStatus: "detected",
      answerPromptFamily: "project_method_plan",
      retrievalPolicy: "project_grounded",
      reason: "project detected",
      createdAt: 2000,
    }])

    expect(useInterviewStore.getState().session.primaryProjectState).toMatchObject({
      currentProject: "搜索质量平台",
      status: "active",
    })
    expect(useInterviewStore.getState().session.routingDiagnostics).toHaveLength(1)
  })
})

describe("interview store queue selectors", () => {
  it("excludes the active answering item from the pending FIFO queue", () => {
    const store = useInterviewStore.getState()
    store.addDetectedQuestions([
      question("q1", 1000),
      question("q2", 1100),
    ])
    store.updateQuestion("q1", { status: "answering", startedAt: 1200 })
    store.setActiveQuestion("q1")

    expect(selectPendingQuestions(useInterviewStore.getState()).map((item) => item.id)).toEqual(["q2"])
  })
})

describe("interview store question optimization state", () => {
  it("keeps full-session status events while the live panel is capped", () => {
    const store = useInterviewStore.getState()

    for (let index = 0; index < 205; index += 1) {
      store.addStatusEvent({
        id: `status-${index}`,
        sessionId: store.session.id,
        kind: "question",
        message: `event-${index}`,
        level: "info",
        createdAt: 1000 + index,
        details: { runId: `run-${index}` },
      })
    }

    expect(useInterviewStore.getState().statusEvents).toHaveLength(200)
    expect(useInterviewStore.getState().statusEvents[0].id).toBe("status-5")
    expect(useInterviewStore.getState().fullStatusEvents).toHaveLength(205)
    expect(useInterviewStore.getState().fullStatusEvents[0].id).toBe("status-0")
  })

  it("stores reverse phase, coverage records, and candidate outcomes", () => {
    const store = useInterviewStore.getState()
    store.setReverseQuestionPhase({
      state: "active",
      startedAt: 2000,
      triggerSegmentIds: ["seg-reverse"],
    })
    store.upsertQuestionCoverage([{
      coverageId: "q1",
      questionId: "q1",
      answerGoal: "AI测试实践工具与应用",
      canonicalText: "你在AI方面有哪些实践？",
      sourceSegmentIds: ["seg-1"],
      status: "pending",
      lastOutcome: "added",
      createdAt: 2100,
      updatedAt: 2100,
    }])
    store.addQueueCandidateOutcome({
      outcomeId: "outcome-1",
      candidateId: "candidate-1",
      outcome: "suppressed_reverse_question",
      questionId: null,
      questionText: "这个岗位做什么？",
      answerGoal: "岗位工作内容",
      sourceSegmentIds: ["seg-reverse"],
      reason: "candidate reverse question during reverse-question phase",
      createdAt: 2200,
    })

    const state = useInterviewStore.getState().session
    expect(state.reverseQuestionPhase).toMatchObject({
      state: "active",
      startedAt: 2000,
      triggerSegmentIds: ["seg-reverse"],
    })
    expect(state.questionCoverage).toHaveLength(1)
    expect(state.queueCandidateOutcomes[0]).toMatchObject({
      outcome: "suppressed_reverse_question",
      answerGoal: "岗位工作内容",
    })
  })

  it("updates existing coverage records by coverage id", () => {
    const store = useInterviewStore.getState()
    store.upsertQuestionCoverage([{
      coverageId: "q1",
      questionId: "q1",
      answerGoal: "Java接口开发流程",
      canonicalText: "Java 开发一个接口的流程是什么样的？",
      sourceSegmentIds: ["seg-1"],
      status: "pending",
      lastOutcome: "added",
      createdAt: 1000,
      updatedAt: 1000,
    }])
    store.upsertQuestionCoverage([{
      coverageId: "q1",
      questionId: "q1",
      answerGoal: "Java接口开发流程",
      canonicalText: "Java 开发一个接口的流程是什么样的？",
      sourceSegmentIds: ["seg-1"],
      status: "completed",
      lastOutcome: "merged",
      createdAt: 1000,
      updatedAt: 3000,
    }])

    expect(useInterviewStore.getState().session.questionCoverage).toEqual([
      expect.objectContaining({
        coverageId: "q1",
        status: "completed",
        updatedAt: 3000,
      }),
    ])
  })
})

describe("interview store streaming transcript state", () => {
  it("upserts provisional transcript updates and commits confirmed segments once", () => {
    const store = useInterviewStore.getState()
    store.upsertProvisionalTranscript({
      ...segment("prov-1", "Can you"),
      state: "provisional",
      definite: false,
      providerUtteranceId: "utt-1",
    })
    store.upsertProvisionalTranscript({
      ...segment("prov-2", "Can you introduce yourself?"),
      state: "provisional",
      definite: false,
      providerUtteranceId: "utt-1",
    })

    expect(useInterviewStore.getState().session.provisionalTranscriptSegments).toHaveLength(1)
    expect(useInterviewStore.getState().session.provisionalTranscriptSegments[0].text).toBe(
      "Can you introduce yourself?",
    )
    expect(useInterviewStore.getState().session.transcriptSegments).toEqual([])

    store.commitConfirmedTranscript({
      ...segment("confirmed-1", "Can you introduce yourself?"),
      state: "confirmed",
      definite: true,
      providerUtteranceId: "utt-1",
    })
    store.commitConfirmedTranscript({
      ...segment("confirmed-duplicate", "Can you introduce yourself?"),
      state: "confirmed",
      definite: true,
      providerUtteranceId: "utt-1",
    })

    expect(useInterviewStore.getState().session.provisionalTranscriptSegments).toEqual([])
    expect(useInterviewStore.getState().session.transcriptSegments).toHaveLength(1)
  })

  it("derives degraded, retrying, recovered, failed, and stopped stream state", () => {
    const store = useInterviewStore.getState()
    store.startSession(1200, {
      id: "asr-session",
      interviewSessionId: store.session.id,
      mode: "production",
      status: "connecting",
      startedAt: 1200,
      stoppedAt: null,
      streams: [
        {
          id: "stream-system",
          kind: "system",
          label: "System audio",
          status: "streaming",
          available: true,
          retryAttempt: 0,
          lastErrorCode: null,
          lastErrorMessage: null,
          lastServiceLogId: null,
          selectedAt: 1200,
          fileName: null,
        },
        {
          id: "stream-mic",
          kind: "microphone",
          label: "Microphone",
          status: "streaming",
          available: true,
          retryAttempt: 0,
          lastErrorCode: null,
          lastErrorMessage: null,
          lastServiceLogId: null,
          selectedAt: 1200,
          fileName: null,
        },
      ],
    })

    store.updateStreamStatus({
      sessionId: store.session.id,
      streamId: "stream-mic",
      source: "microphone",
      status: "retrying",
      level: "warn",
      message: "retrying",
      retryAttempt: 1,
      createdAt: 1300,
    })
    expect(useInterviewStore.getState().session.status).toBe("retrying")

    store.updateStreamStatus({
      sessionId: store.session.id,
      streamId: "stream-mic",
      source: "microphone",
      status: "failed",
      level: "error",
      message: "failed",
      errorCode: "network",
      createdAt: 1400,
    })
    expect(useInterviewStore.getState().session.status).toBe("degraded")

    store.updateStreamStatus({
      sessionId: store.session.id,
      streamId: "stream-mic",
      source: "microphone",
      status: "recovered",
      level: "info",
      message: "recovered",
      createdAt: 1500,
    })
    expect(useInterviewStore.getState().session.status).toBe("listening")
  })

  it("marks the session ended when all streams stop naturally", () => {
    const store = useInterviewStore.getState()
    store.startSession(1200, {
      id: "asr-session",
      interviewSessionId: store.session.id,
      mode: "debug",
      status: "connecting",
      startedAt: 1200,
      stoppedAt: null,
      streams: [{
        id: "stream-file",
        kind: "file",
        label: "Debug file",
        status: "streaming",
        available: true,
        retryAttempt: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastServiceLogId: null,
        selectedAt: 1200,
        fileName: "interview.wav",
      }],
    })

    store.updateStreamStatus({
      sessionId: store.session.id,
      streamId: "stream-file",
      source: "file",
      status: "stopped",
      level: "info",
      message: "ASR stream stopped",
      createdAt: 3000,
    })

    expect(useInterviewStore.getState().session).toMatchObject({
      status: "ended",
      endedAt: 3000,
      streaming: expect.objectContaining({
        status: "stopped",
        stoppedAt: 3000,
      }),
    })
  })

  it("treats a debug-file terminal failure after confirmed transcript as stopped", () => {
    const store = useInterviewStore.getState()
    store.startSession(1200, {
      id: "asr-session",
      interviewSessionId: store.session.id,
      mode: "debug",
      status: "connecting",
      startedAt: 1200,
      stoppedAt: null,
      streams: [{
        id: "stream-file",
        kind: "file",
        label: "Debug file",
        status: "streaming",
        available: true,
        retryAttempt: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastServiceLogId: null,
        selectedAt: 1200,
        fileName: "interview.wav",
      }],
    })
    store.commitConfirmedTranscript(segment("seg-confirmed", "ASR service deployment?"))

    store.updateStreamStatus({
      sessionId: store.session.id,
      streamId: "stream-file",
      source: "file",
      status: "failed",
      level: "error",
      message: "ASR stream interrupted after source ended",
      errorCode: "stream_interrupted",
      createdAt: 3000,
    })

    expect(useInterviewStore.getState().session).toMatchObject({
      status: "ended",
      endedAt: 3000,
      lastError: null,
      audioStreams: [expect.objectContaining({
        status: "stopped",
        lastErrorMessage: null,
      })],
    })
  })
})

describe("interview assistant selector", () => {
  it("returns a stable object reference while the selected store snapshot is unchanged", () => {
    const state = useInterviewStore.getState()

    expect(selectInterviewAssistantState(state)).toBe(selectInterviewAssistantState(state))
  })

  it("returns a fresh assistant state when the session snapshot changes", () => {
    const before = selectInterviewAssistantState(useInterviewStore.getState())

    useInterviewStore.getState().setAudioSource(source(1200))

    expect(selectInterviewAssistantState(useInterviewStore.getState())).not.toBe(before)
  })

  it("requires resetting the ended session before Start Interview is enabled again", () => {
    const store = useInterviewStore.getState()

    store.startSession(1200)
    store.endSession(2000)

    expect(selectInterviewAssistantState(useInterviewStore.getState())).toMatchObject({
      sessionStatus: "ended",
      startInterviewEnabled: false,
      endInterviewEnabled: false,
    })

    store.resetSession(3000)

    expect(selectInterviewAssistantState(useInterviewStore.getState())).toMatchObject({
      sessionStatus: "idle",
      startInterviewEnabled: true,
      endInterviewEnabled: false,
    })
  })
})
