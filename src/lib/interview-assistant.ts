import type {
  AudioSourceSelection,
  DetectedQuestion,
  ConversationPhase,
  ChatTurnResult,
  InterviewProjectProfile,
  InterviewStartInput,
  QueueCandidateOutcome,
  QuestionCoverageRecord,
  StatusEvent,
  StatusEventDetails,
  StatusEventKind,
  StatusEventLevel,
  TranscriptSegment,
} from "./interview-types"
import {
  selectPendingQuestions,
  useInterviewStore,
  type InterviewStoreState,
} from "@/stores/interview-store"
import {
  attachStreamingAudioContext,
  createAudioSourceSelection,
  createDefaultAudioAdapters,
  StreamingTranscriptProvider,
  validateAudioCaptureCapabilitiesForSources,
  validateAudioSourceSelection,
  type AudioCaptureCapabilityValidation,
  type AudioAdapterMap,
  type AudioSourceAdapter,
  type TranscriptProvider,
} from "./interview-audio"
import {
  createLlmWikiInterviewGateway,
  type LlmWikiInterviewGateway,
} from "./interview-llm-wiki-gateway"
import {
  LlmQuestionDetector,
  normalizeQuestionText,
  type QuestionDetectionResult,
  type QuestionDetector,
} from "./interview-question-detector"
import {
  canonicalAnswerGoal,
  evaluateQuestionCandidates,
} from "./interview-question-coverage"
import {
  createSemanticQuestionScheduler,
  type ConversationPhaseMetadata,
  type SemanticQuestionScheduler,
  type StableQuestionEmissionMetadata,
} from "./interview-question-scheduler"
import {
  buildRoutedAnswerPrompt,
  DEFAULT_ANSWER_PROMPT,
  type AnswerPromptTemplateTextMap,
} from "./interview-settings"
import { routingFieldsFromQuestion } from "./interview-prompt-routing"

let statusEventCounter = 0

export function createStatusEvent(input: {
  sessionId?: string | null
  kind: StatusEventKind
  message: string
  level?: StatusEventLevel
  details?: StatusEventDetails
  now?: number
}): StatusEvent {
  const createdAt = input.now ?? Date.now()
  statusEventCounter += 1
  return {
    id: `status-${createdAt}-${statusEventCounter}`,
    sessionId: input.sessionId ?? null,
    kind: input.kind,
    message: input.message,
    level: input.level ?? "info",
    createdAt,
    details: input.details ?? {},
  }
}

export function logStatusEvent(
  event: StatusEvent,
  logger: Pick<Console, "info" | "warn" | "error"> = console,
): void {
  const payload = {
    id: event.id,
    sessionId: event.sessionId,
    kind: event.kind,
    details: event.details,
  }
  if (event.level === "error") {
    logger.error(`[interview] ${event.message}`, payload)
  } else if (event.level === "warn") {
    logger.warn(`[interview] ${event.message}`, payload)
  } else {
    logger.info(`[interview] ${event.message}`, payload)
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true
  if (!(error instanceof Error)) return false
  return error.name === "AbortError" || /abort|cancel/i.test(error.message)
}

export function interviewErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export interface InterviewCoordinator {
  prepare: (prompt: string) => Promise<ChatTurnResult>
  start: (input: InterviewStartInput | AudioSourceSelection) => Promise<void>
  end: () => Promise<void>
  retryQuestion: (questionId: string) => Promise<void>
  skipQuestion: (questionId: string) => void
  markQuestionComplete: (questionId: string) => void
}

interface InterviewAssistantDeps {
  store?: typeof useInterviewStore
  gateway?: LlmWikiInterviewGateway
  audioAdapters?: AudioAdapterMap
  transcriptProvider?: TranscriptProvider
  questionDetector?: QuestionDetector
  answerPromptTemplate?: () => string
  answerPromptTemplates?: () => Partial<AnswerPromptTemplateTextMap>
  projectProfiles?: () => readonly InterviewProjectProfile[]
  now?: () => number
}

let detectedQuestionCounter = 0
let answerRequestCounter = 0

export function createInterviewAssistant(deps: InterviewAssistantDeps = {}): InterviewCoordinator {
  const store = deps.store ?? useInterviewStore
  const gateway = deps.gateway ?? createLlmWikiInterviewGateway()
  const audioAdapters = { ...createDefaultAudioAdapters(), ...deps.audioAdapters }
  const transcriptProvider = deps.transcriptProvider ?? new StreamingTranscriptProvider({
    onStatus: (event) => store.getState().updateStreamStatus(event),
    onDiagnostic: (event) => store.getState().addDiagnostic(event),
  })
  const questionDetector = deps.questionDetector ?? new LlmQuestionDetector()
  const answerPromptTemplate = deps.answerPromptTemplate ?? (() => DEFAULT_ANSWER_PROMPT)
  const answerPromptTemplates = deps.answerPromptTemplates ?? (() => ({}))
  const projectProfiles = deps.projectProfiles ?? (() => [])
  const now = deps.now ?? Date.now
  let preparationAbortController: AbortController | null = null
  let listeningAbortController: AbortController | null = null
  let activeAudioAdapters: AudioSourceAdapter[] = []
  let activeAnswerAbortController: AbortController | null = null
  let questionScheduler: SemanticQuestionScheduler | null = null
  let queueProcessing = false

  const addEvent = (
    kind: StatusEventKind,
    message: string,
    level: StatusEventLevel = "info",
    details: StatusEventDetails = {},
  ) => {
    const sessionId = store.getState().session.id
    const event = createStatusEvent({ sessionId, kind, message, level, details, now: now() })
    store.getState().addStatusEvent(event)
    logStatusEvent(event)
  }

  const processQueue = async () => {
    if (queueProcessing) return
    queueProcessing = true
    try {
      while (true) {
        const state = store.getState()
        if (state.session.activeQuestionId) return
        const next = selectPendingQuestions(state)[0]
        if (!next) return
        const conversationId = state.session.preparation.conversationId
        const startedAt = now()
        const submittedPrompt = buildRoutedAnswerPrompt(next, answerPromptTemplate(), answerPromptTemplates())
        const requestId = `answer-${startedAt}-${++answerRequestCounter}`
        store.getState().setActiveQuestion(next.id)
        store.getState().updateQuestion(next.id, { status: "answering", startedAt })
        updateCoverageStatusForQuestion(store, next.id, "answering", "merged", startedAt)
        store.getState().addAnswerRequest({
          id: requestId,
          questionId: next.id,
          conversationId,
          submittedPrompt,
          assistantMessageContent: null,
          status: "answering",
          submittedAt: startedAt,
          completedAt: null,
          canceledAt: null,
          errorCode: null,
          errorMessage: null,
          questionType: next.questionType,
          projectCategory: next.projectCategory,
          projectRoutingStatus: next.projectRoutingStatus,
          projectRoutingReason: next.projectRoutingReason,
          answerPromptFamily: next.answerPromptFamily,
          retrievalPolicy: next.retrievalPolicy,
        })
        addEvent("chat", "Answer prompt submitted", "info", { questionId: next.id })
        addEvent("queue", "Question submitted for answer", "info", {
          questionId: next.id,
          queueWaitMs: Math.max(0, startedAt - next.queuedAt),
        })
        activeAnswerAbortController = new AbortController()
        try {
          const result = await gateway.submitAnswerPrompt({
            conversationId,
            questionId: next.id,
            prompt: submittedPrompt,
          }, activeAnswerAbortController.signal)
          if (!conversationId) {
            store.getState().setPreparation({
              status: "succeeded",
              startedAt: startedAt,
              completedAt: result.completedAt,
              conversationId: result.conversationId,
              error: null,
            })
          }
          store.getState().updateAnswerRequest(requestId, {
            status: "completed",
            conversationId: result.conversationId,
            assistantMessageContent: result.assistantMessageContent ?? null,
            completedAt: result.completedAt,
          })
          store.getState().updateQuestion(next.id, {
            status: "completed",
            completedAt: result.completedAt,
          })
          updateCoverageStatusForQuestion(store, next.id, "completed", "merged", result.completedAt)
          store.getState().setActiveQuestion(null)
          addEvent("chat", "Answer prompt completed", "info", {
            questionId: next.id,
            answerDurationMs: Math.max(0, result.completedAt - startedAt),
          })
        } catch (error) {
          const canceled = isAbortError(error)
          const message = interviewErrorMessage(error)
          store.getState().updateAnswerRequest(requestId, {
            status: canceled ? "canceled" : "failed",
            canceledAt: canceled ? now() : null,
            errorCode: canceled ? "canceled" : "answer_failed",
            errorMessage: canceled ? null : message,
          })
          store.getState().updateQuestion(next.id, canceled
            ? { status: "canceled", canceledAt: now() }
            : { status: "attention", attentionReason: message })
          updateCoverageStatusForQuestion(
            store,
            next.id,
            canceled ? "canceled" : "attention",
            "skipped_duplicate",
            now(),
          )
          store.getState().setActiveQuestion(null)
          addEvent("chat", canceled ? "Answer prompt canceled" : "Answer prompt failed", canceled ? "warn" : "error", {
            questionId: next.id,
            error: canceled ? null : message,
          })
        } finally {
          activeAnswerAbortController = null
        }
      }
    } finally {
      queueProcessing = false
    }
  }

  return {
    async prepare(prompt) {
      const trimmed = prompt.trim()
      if (!trimmed) throw new Error("Preparation prompt cannot be empty.")
      preparationAbortController?.abort()
      preparationAbortController = new AbortController()
      const startedAt = now()
      store.getState().setPreparation({
        status: "running",
        startedAt,
        completedAt: null,
        conversationId: null,
        error: null,
      })
      addEvent("preparation", "Preparation started", "info")
      try {
        const result = await gateway.prepare(trimmed, preparationAbortController.signal)
        store.getState().setPreparation({
          status: "succeeded",
          startedAt,
          completedAt: result.completedAt,
          conversationId: result.conversationId,
          error: null,
        })
        addEvent("preparation", "Preparation completed", "info", {
          conversationId: result.conversationId,
        })
        return result
      } catch (error) {
        if (isAbortError(error)) throw error
        const message = interviewErrorMessage(error)
        store.getState().setPreparation({
          status: "failed",
          startedAt,
          completedAt: now(),
          conversationId: null,
          error: message,
        })
        addEvent("preparation", "Preparation failed", "error", { error: message })
        throw error
      }
    },

    async start(input) {
      const startInput = normalizeInterviewStartInput(input)
      const streamSources = sourcesForStartInput(startInput)
      const captureValidation = validateAudioCaptureCapabilitiesForSources(streamSources)
      if (captureValidation.requiredSources.length > 0) {
        addEvent(
          "audio",
          captureValidation.ok
            ? "Audio capture capability check passed"
            : `Audio capture capability check failed: ${captureValidation.error}`,
          captureValidation.ok ? "info" : "error",
          audioCaptureCapabilityDetails(captureValidation),
        )
      }
      if (!captureValidation.ok) throw new Error(captureValidation.error ?? "Live audio capture is not available.")
      for (const source of streamSources) {
        const validation = validateAudioSourceSelection(source)
        if (!validation.ok) throw new Error(validation.error)
        if (!audioAdapters[source.kind]) throw new Error(`Audio source is not available: ${source.kind}`)
      }
      const sessionId = store.getState().session.id
      const startedAt = now()
      const streams = streamSources.map((source) => ({
        id: streamIdFor(sessionId, source.kind),
        kind: source.kind,
        label: source.label,
        status: "connecting" as const,
        available: true,
        retryAttempt: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastServiceLogId: null,
        selectedAt: source.selectedAt,
        fileName: source.fileName,
      }))
      store.getState().setAudioSource(startInput.mode === "debug" ? startInput.file : null)
      store.getState().startSession(startedAt, {
        id: `asr-${sessionId}-${startedAt}`,
        interviewSessionId: sessionId,
        mode: startInput.mode,
        status: "connecting",
        startedAt,
        stoppedAt: null,
        streams,
      })
      addEvent("session", "Interview started", "info", { mode: startInput.mode })
      listeningAbortController?.abort()
      questionScheduler?.stop("new interview started")
      listeningAbortController = new AbortController()
      questionScheduler = createSemanticQuestionScheduler({
        sessionId,
        questionDetector,
        getSession: () => store.getState().session,
        getExistingQuestionTexts: () => store.getState().session.questions.map((question) => question.text),
        getExistingCoverageSummaries: () => coverageSummaries(store.getState().session.questionCoverage),
        getProjectProfiles: projectProfiles,
        getReverseQuestionPhase: () => store.getState().session.reverseQuestionPhase,
        isSessionActive: () => allowsTranscriptIngestion(store.getState().session.status),
        handleConversationPhase: (phase, metadata) => {
          applyConversationPhase(store, phase, metadata, now, addEvent)
        },
        emitQuestions: (candidates, metadata) => {
          const questions = createDetectedQuestions(candidates, store.getState().session.id, now)
          if (questions.length === 0) return
          const result = mergeDetectedQuestions(store, questions, metadata, now, projectProfiles())
          for (const question of result.added) {
            addEvent("question", "Question detected", "info", {
              questionId: question.id,
              answerGoal: question.answerGoal ?? question.text,
              candidateOutcome: "added",
              runId: metadata.runId,
            })
          }
          for (const outcome of result.outcomes.filter((item) => item.outcome !== "added")) {
            addEvent("question", `Question candidate ${outcome.outcome}`, "info", outcomeDetails(outcome))
          }
          void processQueue()
        },
        addEvent: (message, level = "info", details = {}) => {
          addEvent("question", message, level, details)
        },
        now,
      })
      activeAudioAdapters = streamSources
        .map((source) => audioAdapters[source.kind])
        .filter((adapter): adapter is AudioSourceAdapter => Boolean(adapter))
      for (const source of streamSources) {
        const adapter = audioAdapters[source.kind]
        if (!adapter) continue
        void runTranscriptLoop({
          source,
          streamId: streamIdFor(sessionId, source.kind),
          adapter,
          transcriptProvider,
          questionScheduler,
          store,
          signal: listeningAbortController.signal,
          addEvent,
          now,
        })
      }
    },

    async end() {
      questionScheduler?.stop("interview ended")
      questionScheduler = null
      listeningAbortController?.abort()
      activeAnswerAbortController?.abort()
      await Promise.all(activeAudioAdapters.map((adapter) => adapter.stop().catch(() => undefined)))
      activeAudioAdapters = []
      store.getState().cancelActiveAndPendingQuestions(now())
      store.getState().endSession(now())
      addEvent("session", "Interview ended", "info")
    },

    async retryQuestion(questionId) {
      const question = store.getState().session.questions.find((item) => item.id === questionId)
      if (question?.status !== "attention") return
      store.getState().updateQuestion(questionId, {
        status: "pending",
        attentionReason: null,
        queuedAt: now(),
        startedAt: null,
      })
      updateCoverageStatusForQuestion(store, questionId, "pending", "merged", now())
      addEvent("queue", "Question returned to queue", "info", { questionId })
      void processQueue()
    },

    skipQuestion(questionId) {
      store.getState().updateQuestion(questionId, {
        status: "canceled",
        canceledAt: now(),
        attentionReason: "Skipped by user",
      })
      updateCoverageStatusForQuestion(store, questionId, "skipped", "skipped_duplicate", now())
      addEvent("queue", "Question skipped", "warn", { questionId })
    },

    markQuestionComplete(questionId) {
      store.getState().updateQuestion(questionId, {
        status: "completed",
        completedAt: now(),
        attentionReason: null,
      })
      updateCoverageStatusForQuestion(store, questionId, "completed", "merged", now())
      if (store.getState().session.activeQuestionId === questionId) {
        store.getState().setActiveQuestion(null)
      }
      if (selectPendingQuestions(store.getState()).length === 0) {
        addEvent("queue", "Question marked complete", "info", { questionId })
      }
    },
  }
}

function normalizeInterviewStartInput(
  input: InterviewStartInput | AudioSourceSelection,
): InterviewStartInput {
  if ("mode" in input) return input
  if (input.kind === "file") {
    return { mode: "debug", file: input as AudioSourceSelection & { kind: "file" } }
  }
  throw new Error("Production interview requires both system audio and microphone streams.")
}

export function createProductionInterviewStartInput(now = Date.now()): InterviewStartInput {
  return {
    mode: "production",
    system: createAudioSourceSelection("system", "System audio", now) as AudioSourceSelection & { kind: "system" },
    microphone: createAudioSourceSelection("microphone", "Microphone", now) as AudioSourceSelection & { kind: "microphone" },
  }
}

function sourcesForStartInput(input: InterviewStartInput): AudioSourceSelection[] {
  return input.mode === "production" ? [input.system, input.microphone] : [input.file]
}

function audioCaptureCapabilityDetails(
  validation: AudioCaptureCapabilityValidation,
): StatusEventDetails {
  return {
    audioCaptureCapabilityCheck: true,
    requiredAudioSources: validation.requiredSources.join(","),
    microphoneAvailable: validation.report.microphone.available,
    microphoneReason: validation.report.microphone.reason ?? undefined,
    systemAvailable: validation.report.system.available,
    systemReason: validation.report.system.reason ?? undefined,
  }
}

function streamIdFor(sessionId: string, kind: AudioSourceSelection["kind"]): string {
  return `${sessionId}-${kind}`
}

function mergeDetectedQuestions(
  store: typeof useInterviewStore,
  questions: DetectedQuestion[],
  metadata: StableQuestionEmissionMetadata,
  now: () => number,
  projectProfiles: readonly InterviewProjectProfile[] = [],
): { added: DetectedQuestion[]; refinedQuestionIds: string[]; outcomes: QueueCandidateOutcome[] } {
  const state = store.getState()
  const evaluated = evaluateQuestionCandidates({
    sessionId: state.session.id,
    candidates: questions,
    existingQuestions: state.session.questions,
    coverageRecords: state.session.questionCoverage,
    reverseQuestionPhase: state.session.reverseQuestionPhase,
    primaryProjectState: state.session.primaryProjectState,
    projectProfiles,
    conversationPhase: metadata.conversationPhase,
    runId: metadata.runId,
    now: now(),
  })
  if (evaluated.reversePhaseUpdate) {
    store.getState().setReverseQuestionPhase(evaluated.reversePhaseUpdate)
  }
  for (const update of evaluated.questionUpdates) {
    store.getState().updateQuestion(update.questionId, update.patch)
  }
  for (const outcome of evaluated.outcomes) {
    store.getState().addQueueCandidateOutcome(outcome)
  }
  if (evaluated.coverageRecords.length > 0) {
    store.getState().upsertQuestionCoverage(evaluated.coverageRecords)
  }
  store.getState().setPrimaryProjectState(evaluated.primaryProjectState)
  if (evaluated.routingDiagnostics.length > 0) {
    store.getState().addRoutingDiagnostics(evaluated.routingDiagnostics)
  }
  if (evaluated.added.length > 0) store.getState().addDetectedQuestions(evaluated.added)
  return {
    added: evaluated.added,
    refinedQuestionIds: evaluated.questionUpdates.map((update) => update.questionId),
    outcomes: evaluated.outcomes,
  }
}

function applyConversationPhase(
  store: typeof useInterviewStore,
  phase: ConversationPhase,
  metadata: ConversationPhaseMetadata,
  now: () => number,
  addEvent: (
    kind: StatusEventKind,
    message: string,
    level?: StatusEventLevel,
    details?: StatusEventDetails,
  ) => void,
): void {
  if (phase === "reverse_question") {
    const current = store.getState().session.reverseQuestionPhase
    store.getState().setReverseQuestionPhase({
      state: "active",
      startedAt: current.startedAt ?? now(),
      triggerSegmentIds: Array.from(new Set([...current.triggerSegmentIds, ...metadata.sourceSegmentIds])),
    })
    addEvent("question", "Reverse-question phase detected", "info", {
      runId: metadata.runId,
      contextVersion: metadata.contextVersion,
    })
    return
  }
  if (phase === "resumed_evaluation") {
    const current = store.getState().session.reverseQuestionPhase
    store.getState().setReverseQuestionPhase({
      state: "resumed_evaluation",
      resumeSegmentIds: Array.from(new Set([...current.resumeSegmentIds, ...metadata.sourceSegmentIds])),
    })
    addEvent("question", "Interviewer evaluation resumed", "info", {
      runId: metadata.runId,
      contextVersion: metadata.contextVersion,
    })
  }
}

function coverageSummaries(records: QuestionCoverageRecord[]): string[] {
  return records.map((record) => {
    const semantic = [record.topic, record.intent].filter(Boolean).join("/")
    return semantic
      ? `${record.answerGoal} (${semantic}): ${record.canonicalText}`
      : `${record.answerGoal}: ${record.canonicalText}`
  })
}

function outcomeDetails(outcome: QueueCandidateOutcome): StatusEventDetails {
  return {
    candidateOutcome: outcome.outcome,
    candidateId: outcome.candidateId,
    questionId: outcome.questionId,
    answerGoal: outcome.answerGoal,
    topic: outcome.topic,
    intent: outcome.intent,
    reason: outcome.reason,
    runId: outcome.runId,
  }
}

function updateCoverageStatusForQuestion(
  store: typeof useInterviewStore,
  questionId: string,
  status: QuestionCoverageRecord["status"],
  lastOutcome: QuestionCoverageRecord["lastOutcome"],
  updatedAt: number,
): void {
  const state = store.getState()
  const question = state.session.questions.find((item) => item.id === questionId)
  if (!question) return
  const existing = state.session.questionCoverage.find((record) => record.questionId === questionId)
  store.getState().upsertQuestionCoverage([{
    coverageId: existing?.coverageId ?? questionId,
    questionId,
    answerGoal: canonicalAnswerGoal(question),
    topic: question.topic,
    intent: question.intent,
    entities: question.entities,
    canonicalText: question.text,
    sourceSegmentIds: question.sourceSegmentIds,
    status,
    lastOutcome,
    createdAt: existing?.createdAt ?? question.detectedAt,
    updatedAt,
    ...routingFieldsFromQuestion(question),
  }])
}

function createDetectedQuestions(
  candidates: QuestionDetectionResult["questions"],
  sessionId: string,
  now: () => number,
): DetectedQuestion[] {
  return candidates.map((question) => {
    const detectedAt = now()
    return {
      id: `question-${detectedAt}-${++detectedQuestionCounter}`,
      sessionId,
      text: question.text.trim(),
      answerGoal: question.answerGoal?.trim() || question.text.trim(),
      topic: question.topic?.trim() || undefined,
      intent: question.intent?.trim() || undefined,
      entities: question.entities?.map((item) => item.trim()).filter(Boolean),
      coverageAliases: [
        normalizeQuestionText(question.text),
        normalizeQuestionText(question.answerGoal ?? question.text),
      ],
      sourceSegmentIds: question.sourceSegmentIds,
      detectedAt,
      updatedAt: detectedAt,
      clarificationState: question.clarificationState ?? "none",
      refinementOfSegmentId: question.refinementOfSegmentId,
      questionType: question.questionType,
      projectCategory: question.projectCategory,
      projectRoutingReason: question.routingReason?.trim() || undefined,
      status: "pending" as const,
      queuedAt: detectedAt,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      attentionReason: null,
    }
  }).filter((question) => question.text)
}

async function runTranscriptLoop(args: {
  source: AudioSourceSelection
  streamId: string
  adapter: AudioSourceAdapter
  transcriptProvider: TranscriptProvider
  questionScheduler: SemanticQuestionScheduler
  store: typeof useInterviewStore
  signal: AbortSignal
  now: () => number
  addEvent: (
    kind: StatusEventKind,
    message: string,
    level?: StatusEventLevel,
    details?: StatusEventDetails,
  ) => void
}): Promise<void> {
  try {
    const sessionId = args.store.getState().session.id
    const chunks = attachStreamingAudioContext(args.adapter.start(args.source, args.signal), {
      sessionId,
      streamId: args.streamId,
    })
    for await (const segment of args.transcriptProvider.transcribe(chunks, args.signal)) {
      if (args.signal.aborted || !allowsTranscriptIngestion(args.store.getState().session.status)) break
      if (segment.state === "provisional" || segment.definite === false) {
        args.store.getState().upsertProvisionalTranscript(segment)
        args.addEvent("asr", "Provisional transcript updated", "info", {
          segmentId: segment.id,
          source: segment.source,
        })
        continue
      }
      const confirmed = withAsrLatency(
        ensureConfirmedSegment(segment),
        args.store.getState(),
      )
      args.store.getState().commitConfirmedTranscript(confirmed)
      args.addEvent("asr", "Transcript segment received", "info", {
        segmentId: confirmed.id,
        speaker: confirmed.speaker,
        source: confirmed.source,
      })
      args.questionScheduler.onConfirmedTranscriptCommitted(confirmed)
    }
  } catch (error) {
    if (isAbortError(error)) return
    const message = interviewErrorMessage(error)
    args.store.getState().updateStreamStatus({
      sessionId: args.store.getState().session.id,
      streamId: args.streamId,
      source: args.source.kind,
      status: "failed",
      level: "error",
      message,
      errorCode: "asr_stream_failed",
      createdAt: args.now(),
    })
    args.addEvent("asr", `Transcript provider failed: ${message}`, "error", { error: message })
  }
}

function ensureConfirmedSegment(segment: TranscriptSegment): TranscriptSegment {
  return {
    ...segment,
    state: "confirmed",
    definite: true,
  }
}

function withAsrLatency(
  segment: TranscriptSegment,
  state: InterviewStoreState,
): TranscriptSegment {
  const startedAt = state.session.streaming?.startedAt ?? state.session.startedAt
  if (!startedAt || !Number.isFinite(segment.createdAt) || !Number.isFinite(segment.endMs)) {
    return { ...segment, asrLatencyMs: null }
  }
  if (state.session.mode === "debug" || state.session.streaming?.mode === "debug") {
    const segmentDurationMs = Number.isFinite(segment.endMs) && Number.isFinite(segment.startMs)
      ? Math.max(0, Math.round(segment.endMs - segment.startMs))
      : undefined
    return {
      ...segment,
      audioStartMs: segment.startMs,
      audioEndMs: segment.endMs,
      segmentDurationMs,
      recognitionProcessingMs: Math.max(0, Math.round(segment.createdAt - startedAt)),
      asrLatencyMs: null,
    }
  }
  return {
    ...segment,
    audioStartMs: segment.startMs,
    audioEndMs: segment.endMs,
    segmentDurationMs: Math.max(0, Math.round(segment.endMs - segment.startMs)),
    asrLatencyMs: Math.max(0, Math.round(segment.createdAt - startedAt - segment.endMs)),
  }
}

function allowsTranscriptIngestion(status: InterviewStoreState["session"]["status"]): boolean {
  return status === "connecting" ||
    status === "listening" ||
    status === "degraded" ||
    status === "retrying"
}
