import { create } from "zustand"
import type {
  AnswerRequest,
  AudioInputStreamState,
  AudioSourceSelection,
  DetectedQuestion,
  InterviewAsrDiagnosticEvent,
  InterviewAsrStatusEvent,
  InterviewAssistantState,
  InterviewMode,
  InterviewSession,
  PrimaryProjectState,
  PreparationState,
  QueueCandidateOutcome,
  QuestionCoverageRecord,
  ReverseQuestionPhase,
  ReverseQuestionPhaseStatus,
  RoutingDiagnostic,
  StreamingSessionStatus,
  StreamingTranscriptionSession,
  StatusEvent,
  TranscriptSegment,
} from "@/lib/interview-types"

export interface InterviewStoreState {
  session: InterviewSession
  answerRequests: AnswerRequest[]
  statusEvents: StatusEvent[]
  fullStatusEvents: StatusEvent[]
  resetSession: (now?: number) => void
  setPreparation: (preparation: PreparationState) => void
  setAudioSource: (source: AudioSourceSelection | null) => void
  startSession: (now?: number, streaming?: StreamingTranscriptionSession) => void
  endSession: (now?: number) => void
  setStreamingSession: (session: StreamingTranscriptionSession | null) => void
  updateStreamingStatus: (status: StreamingSessionStatus, now?: number) => void
  updateStreamStatus: (event: InterviewAsrStatusEvent) => void
  upsertProvisionalTranscript: (segment: TranscriptSegment) => void
  commitConfirmedTranscript: (segment: TranscriptSegment) => void
  addTranscriptSegment: (segment: TranscriptSegment) => void
  addDiagnostic: (diagnostic: InterviewAsrDiagnosticEvent) => void
  addDetectedQuestions: (questions: DetectedQuestion[]) => void
  updateQuestion: (id: string, patch: Partial<DetectedQuestion>) => void
  upsertQuestionCoverage: (records: QuestionCoverageRecord[]) => void
  addQueueCandidateOutcome: (outcome: QueueCandidateOutcome) => void
  setPrimaryProjectState: (state: PrimaryProjectState) => void
  addRoutingDiagnostics: (diagnostics: RoutingDiagnostic[]) => void
  setReverseQuestionPhase: (
    patch: Partial<ReverseQuestionPhase> & { state?: ReverseQuestionPhaseStatus },
  ) => void
  setActiveQuestion: (id: string | null) => void
  addAnswerRequest: (request: AnswerRequest) => void
  updateAnswerRequest: (id: string, patch: Partial<AnswerRequest>) => void
  addStatusEvent: (event: StatusEvent) => void
  clearStatusEvents: () => void
  cancelActiveAndPendingQuestions: (now?: number) => void
}

let sessionCounter = 0
let assistantStateCache:
  | {
    session: InterviewSession
    statusEvents: StatusEvent[]
    fullStatusEvents: StatusEvent[]
    value: InterviewAssistantState
  }
  | null = null

export function createInitialInterviewSession(now = Date.now()): InterviewSession {
  sessionCounter += 1
  return {
    id: `interview-${now}-${sessionCounter}`,
    status: "idle",
    preparation: {
      status: "idle",
      startedAt: null,
      completedAt: null,
      conversationId: null,
      error: null,
    },
    audioSource: null,
    mode: null,
    streaming: null,
    audioStreams: [],
    provisionalTranscriptSegments: [],
    diagnostics: [],
    startedAt: null,
    endedAt: null,
    transcriptSegments: [],
    questions: [],
    questionCoverage: [],
    reverseQuestionPhase: {
      state: "inactive",
      startedAt: null,
      triggerSegmentIds: [],
      lastSuppressedAt: null,
      resumeSegmentIds: [],
    },
    primaryProjectState: {
      currentProject: null,
      status: "empty",
      updatedAt: null,
      sourceQuestionId: null,
      reason: null,
    },
    routingDiagnostics: [],
    queueCandidateOutcomes: [],
    activeQuestionId: null,
    lastError: null,
  }
}

export const useInterviewStore = create<InterviewStoreState>((set) => ({
  session: createInitialInterviewSession(),
  answerRequests: [],
  statusEvents: [],
  fullStatusEvents: [],

  resetSession: (now = Date.now()) =>
    set({
      session: createInitialInterviewSession(now),
      answerRequests: [],
      statusEvents: [],
      fullStatusEvents: [],
    }),

  setPreparation: (preparation) =>
    set((state) => ({
      session: {
        ...state.session,
        preparation,
        status: preparation.status === "succeeded" && state.session.status === "idle"
          ? "ready"
          : state.session.status,
        lastError: preparation.status === "failed" ? preparation.error : state.session.lastError,
      },
    })),

  setAudioSource: (audioSource) =>
    set((state) => ({
      session: { ...state.session, audioSource },
    })),

  startSession: (now = Date.now(), streaming) =>
    set((state) => ({
      session: {
        ...state.session,
        status: streaming?.status === "connecting" ? "connecting" : "listening",
        mode: streaming?.mode ?? state.session.mode,
        streaming: streaming ?? state.session.streaming,
        audioStreams: streaming?.streams ?? state.session.audioStreams,
        startedAt: state.session.startedAt ?? now,
        endedAt: null,
      },
    })),

  endSession: (now = Date.now()) =>
    set((state) => ({
      session: {
        ...state.session,
        status: "ended",
        endedAt: now,
        activeQuestionId: null,
        streaming: state.session.streaming
          ? { ...state.session.streaming, status: "stopped", stoppedAt: now }
          : state.session.streaming,
        audioStreams: state.session.audioStreams.map((stream) => ({
          ...stream,
          status: stream.status === "failed" ? "failed" : "stopped",
          available: false,
        })),
      },
    })),

  setStreamingSession: (streaming) =>
    set((state) => ({
      session: {
        ...state.session,
        mode: streaming?.mode ?? null,
        streaming,
        audioStreams: streaming?.streams ?? [],
      },
    })),

  updateStreamingStatus: (status, now = Date.now()) =>
    set((state) => ({
      session: {
        ...state.session,
        status: sessionStatusFromStreamingStatus(status, state.session.status),
        streaming: state.session.streaming
          ? {
              ...state.session.streaming,
              status,
              stoppedAt: status === "stopped" || status === "failed" ? now : state.session.streaming.stoppedAt,
            }
          : state.session.streaming,
      },
    })),

  updateStreamStatus: (event) =>
    set((state) => {
      const effectiveEvent = normalizeTerminalStreamEvent(state.session, event)
      const nextStreams = state.session.audioStreams.map((stream) =>
        stream.id === effectiveEvent.streamId
          ? streamStateFromStatusEvent(stream, effectiveEvent)
          : stream
      )
      const streamingStatus = deriveStreamingStatus(nextStreams, state.session.streaming?.mode ?? state.session.mode)
      return {
        session: {
          ...state.session,
          status: sessionStatusFromStreamingStatus(streamingStatus, state.session.status),
          endedAt: streamingStatus === "stopped" ? effectiveEvent.createdAt : state.session.endedAt,
          streaming: state.session.streaming
            ? {
                ...state.session.streaming,
                status: streamingStatus,
                stoppedAt: streamingStatus === "stopped" ? effectiveEvent.createdAt : state.session.streaming.stoppedAt,
                streams: nextStreams,
              }
            : state.session.streaming,
          audioStreams: nextStreams,
          lastError: effectiveEvent.level === "error" ? effectiveEvent.message : state.session.lastError,
        },
      }
    }),

  upsertProvisionalTranscript: (segment) =>
    set((state) => {
      const key = provisionalKey(segment)
      const existingIndex = state.session.provisionalTranscriptSegments.findIndex((item) =>
        provisionalKey(item) === key
      )
      const next = { ...segment, state: "provisional" as const, definite: false }
      const provisionalTranscriptSegments =
        existingIndex >= 0
          ? state.session.provisionalTranscriptSegments.map((item, index) =>
              index === existingIndex ? { ...item, ...next } : item
            )
          : [...state.session.provisionalTranscriptSegments, next]
      return {
        session: {
          ...state.session,
          provisionalTranscriptSegments,
        },
      }
    }),

  commitConfirmedTranscript: (segment) =>
    set((state) => {
      const confirmed = { ...segment, state: "confirmed" as const, definite: segment.definite !== false }
      const duplicate = state.session.transcriptSegments.some((item) =>
        item.id === confirmed.id ||
        (confirmed.providerUtteranceId && item.providerUtteranceId === confirmed.providerUtteranceId)
      )
      const provisionalKeyToRemove = provisionalKey(confirmed)
      return {
        session: {
          ...state.session,
          provisionalTranscriptSegments: state.session.provisionalTranscriptSegments.filter((item) =>
            provisionalKey(item) !== provisionalKeyToRemove &&
            item.id !== confirmed.replacesProvisionalId
          ),
          transcriptSegments: duplicate
            ? state.session.transcriptSegments
            : [...state.session.transcriptSegments, confirmed],
        },
      }
    }),

  addTranscriptSegment: (segment) =>
    set((state) => ({
      session: {
        ...state.session,
        transcriptSegments: [...state.session.transcriptSegments, {
          ...segment,
          state: segment.state ?? "confirmed",
          definite: segment.definite ?? true,
        }],
      },
    })),

  addDiagnostic: (diagnostic) =>
    set((state) => ({
      session: {
        ...state.session,
        diagnostics: [...state.session.diagnostics, diagnostic].slice(-200),
      },
    })),

  addDetectedQuestions: (questions) =>
    set((state) => ({
      session: {
        ...state.session,
        questions: [...state.session.questions, ...questions],
      },
    })),

  updateQuestion: (id, patch) =>
    set((state) => ({
      session: {
        ...state.session,
        questions: state.session.questions.map((question) =>
          question.id === id ? { ...question, ...patch } : question
        ),
      },
    })),

  upsertQuestionCoverage: (records) =>
    set((state) => {
      if (records.length === 0) return state
      const byId = new Map(state.session.questionCoverage.map((record) => [record.coverageId, record]))
      for (const record of records) byId.set(record.coverageId, record)
      return {
        session: {
          ...state.session,
          questionCoverage: Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt),
        },
      }
    }),

  addQueueCandidateOutcome: (outcome) =>
    set((state) => ({
      session: {
        ...state.session,
        queueCandidateOutcomes: [...state.session.queueCandidateOutcomes, outcome],
      },
    })),

  setPrimaryProjectState: (primaryProjectState) =>
    set((state) => ({
      session: {
        ...state.session,
        primaryProjectState,
      },
    })),

  addRoutingDiagnostics: (diagnostics) =>
    set((state) => ({
      session: {
        ...state.session,
        routingDiagnostics: [...state.session.routingDiagnostics, ...diagnostics],
      },
    })),

  setReverseQuestionPhase: (patch) =>
    set((state) => ({
      session: {
        ...state.session,
        reverseQuestionPhase: {
          ...state.session.reverseQuestionPhase,
          ...patch,
        },
      },
    })),

  setActiveQuestion: (activeQuestionId) =>
    set((state) => ({
      session: { ...state.session, activeQuestionId },
    })),

  addAnswerRequest: (request) =>
    set((state) => ({
      answerRequests: [...state.answerRequests, request],
    })),

  updateAnswerRequest: (id, patch) =>
    set((state) => ({
      answerRequests: state.answerRequests.map((request) =>
        request.id === id ? { ...request, ...patch } : request
      ),
    })),

  addStatusEvent: (event) =>
    set((state) => ({
      statusEvents: [...state.statusEvents, event].slice(-200),
      fullStatusEvents: [...state.fullStatusEvents, event],
    })),

  clearStatusEvents: () => set({ statusEvents: [], fullStatusEvents: [] }),

  cancelActiveAndPendingQuestions: (now = Date.now()) =>
    set((state) => ({
      session: {
        ...state.session,
        activeQuestionId: null,
        questions: state.session.questions.map((question) =>
          question.status === "pending" || question.status === "answering" || question.status === "attention"
            ? { ...question, status: "canceled", canceledAt: now }
            : question
        ),
      },
      answerRequests: state.answerRequests.map((request) =>
        request.status === "submitting" || request.status === "answering"
          ? { ...request, status: "canceled", canceledAt: now }
          : request
      ),
    })),
}))

export function selectPendingQuestions(state: InterviewStoreState): DetectedQuestion[] {
  return state.session.questions
    .filter((question) => question.status === "pending")
    .slice()
    .sort((a, b) => a.queuedAt - b.queuedAt)
}

function streamStateFromStatusEvent(
  stream: AudioInputStreamState,
  event: InterviewAsrStatusEvent,
): AudioInputStreamState {
  const status = streamStatusFromAsrStatus(event.status)
  return {
    ...stream,
    status,
    available: status !== "failed" && status !== "stopped",
    retryAttempt: event.retryAttempt ?? (event.status === "recovered" ? 0 : stream.retryAttempt),
    lastErrorCode: event.errorCode ?? (event.level === "error" ? "asr_error" : stream.lastErrorCode),
    lastErrorMessage: event.level === "error" || event.level === "warn"
      ? event.message
      : event.status === "recovered"
      ? null
      : stream.lastErrorMessage,
    lastServiceLogId: event.serviceLogId ?? stream.lastServiceLogId,
  }
}

function normalizeTerminalStreamEvent(
  session: InterviewSession,
  event: InterviewAsrStatusEvent,
): InterviewAsrStatusEvent {
  if (
    session.mode === "debug" &&
    event.status === "failed" &&
    session.audioStreams.length === 1 &&
    session.transcriptSegments.length > 0
  ) {
    return {
      ...event,
      status: "stopped",
      level: "info",
      message: "Debug file ASR stream stopped after confirmed transcript output.",
      errorCode: undefined,
    }
  }
  return event
}

function streamStatusFromAsrStatus(status: InterviewAsrStatusEvent["status"]): AudioInputStreamState["status"] {
  if (status === "connecting") return "connecting"
  if (status === "listening" || status === "recovered") return "streaming"
  if (status === "retrying") return "retrying"
  if (status === "degraded") return "degraded"
  if (status === "failed") return "failed"
  return "stopped"
}

function deriveStreamingStatus(
  streams: AudioInputStreamState[],
  mode: InterviewMode | null,
): StreamingSessionStatus {
  if (streams.length === 0) return "idle"
  if (streams.every((stream) => stream.status === "stopped")) return "stopped"
  if (streams.every((stream) => stream.status === "failed" || stream.status === "stopped")) {
    return "failed"
  }
  if (streams.some((stream) => stream.status === "retrying")) return "retrying"
  if (streams.some((stream) => stream.status === "failed" || stream.status === "degraded")) {
    return mode === "production" ? "degraded" : "failed"
  }
  if (streams.some((stream) => stream.status === "connecting")) return "connecting"
  return "listening"
}

function sessionStatusFromStreamingStatus(
  status: StreamingSessionStatus,
  fallback: InterviewSession["status"],
): InterviewSession["status"] {
  if (status === "idle") return fallback
  if (status === "finalizing") return fallback === "ended" ? "ended" : "ending"
  if (status === "stopped") return "ended"
  return status
}

function provisionalKey(segment: TranscriptSegment): string {
  return segment.revisionOf ||
    segment.providerUtteranceId ||
    `${segment.streamId ?? segment.source}:${segment.startMs}:${segment.endMs}`
}

export function deriveQuestionWaitingMs(question: DetectedQuestion, now = Date.now()): number {
  const end = question.completedAt ?? question.canceledAt ?? now
  return Math.max(0, end - question.queuedAt)
}

export function selectInterviewAssistantState(state: InterviewStoreState): InterviewAssistantState {
  const session = state.session
  if (
    assistantStateCache &&
    assistantStateCache.session === session &&
    assistantStateCache.statusEvents === state.statusEvents &&
    assistantStateCache.fullStatusEvents === state.fullStatusEvents
  ) {
    return assistantStateCache.value
  }
  const startInterviewEnabled =
    session.status !== "listening" &&
    session.status !== "connecting" &&
    session.status !== "retrying" &&
    session.status !== "ending" &&
    session.status !== "ended"
  const value: InterviewAssistantState = {
    preparationStatus: session.preparation.status,
    sessionStatus: session.status,
    selectedAudioSource: session.audioSource,
    mode: session.mode,
    streamingStatus: session.streaming?.status ?? null,
    audioStreams: session.audioStreams,
    provisionalTranscriptSegments: session.provisionalTranscriptSegments,
    diagnostics: session.diagnostics,
    transcriptSegments: session.transcriptSegments,
    questions: session.questions,
    activeQuestionId: session.activeQuestionId,
    queueLength: selectPendingQuestions(state).length,
    statusEvents: state.statusEvents,
    fullStatusEvents: state.fullStatusEvents,
    startInterviewEnabled,
    endInterviewEnabled:
      session.status === "ready" ||
      session.status === "connecting" ||
      session.status === "listening" ||
      session.status === "degraded" ||
      session.status === "retrying",
  }
  assistantStateCache = {
    session,
    statusEvents: state.statusEvents,
    fullStatusEvents: state.fullStatusEvents,
    value,
  }
  return value
}
