import type {
  ConversationPhase,
  InterviewProjectProfile,
  InterviewSession,
  ReverseQuestionPhase,
  StatusEventDetails,
  StatusEventLevel,
  TranscriptSegment,
} from "./interview-types"
import { normalizeQuestionText, type QuestionDetectionResult, type QuestionDetector } from "./interview-question-detector"

export const SEMANTIC_CONTEXT_MAX_SEGMENTS = 14
export const SEMANTIC_CONTEXT_MAX_AGE_MS = 75_000
export const SEMANTIC_CONTEXT_MAX_CHARS = 3_200
export const SEMANTIC_IDLE_DEBOUNCE_MS = 1_000
export const SEMANTIC_MIN_INTERVAL_MS = 2_500
export const SEMANTIC_STABILIZATION_MS = 700
export const SEMANTIC_REFINEMENT_STABILIZATION_MS = 6_000
export const SEMANTIC_MAX_COVERAGE_SUMMARIES = 12
export const SEMANTIC_TIMEOUT_MS = 7_000

export interface RollingTranscriptContext {
  version: number
  segments: TranscriptSegment[]
  latestSegmentId?: string
  latestEndedAt?: number
  latestConfirmedAt?: number
  latestAsrLatencyMs?: number
  builtAt: number
}

export interface SemanticQuestionScheduler {
  onConfirmedTranscriptCommitted: (segment: TranscriptSegment) => void
  stop: (reason?: string) => void
}

export interface SemanticQuestionSchedulerDeps {
  sessionId: string
  questionDetector: QuestionDetector
  getSession: () => InterviewSession
  getExistingQuestionTexts: () => string[]
  getExistingCoverageSummaries?: () => string[]
  getProjectProfiles?: () => readonly InterviewProjectProfile[]
  getReverseQuestionPhase?: () => ReverseQuestionPhase
  isSessionActive: () => boolean
  emitQuestions: (questions: QuestionDetectionResult["questions"], metadata: StableQuestionEmissionMetadata) => void
  handleConversationPhase?: (phase: ConversationPhase, metadata: ConversationPhaseMetadata) => void
  addEvent: (message: string, level?: StatusEventLevel, details?: StatusEventDetails) => void
  now?: () => number
}

export interface StableQuestionEmissionMetadata {
  runId: string
  contextVersion: number
  conversationPhase: ConversationPhase
  latestConfirmedAt?: number
  latestAsrLatencyMs?: number
}

export interface ConversationPhaseMetadata {
  runId: string
  contextVersion: number
  sourceSegmentIds: string[]
}

interface InFlightSemanticRun {
  id: string
  contextVersion: number
  startedAt: number
  latestConfirmedAt?: number
  latestAsrLatencyMs?: number
  segmentCount: number
  controller: AbortController
  timeoutTimer: ReturnType<typeof setTimeout>
}

interface PendingStableQuestions {
  runId: string
  contextVersion: number
  questions: QuestionDetectionResult["questions"]
  segmentCount: number
  latestConfirmedAt?: number
  latestAsrLatencyMs?: number
  runStartedAt: number
  detectorCompletedAt: number
  llmDetectionMs: number
  conversationPhase: ConversationPhase
}

export function createSemanticQuestionScheduler(deps: SemanticQuestionSchedulerDeps): SemanticQuestionScheduler {
  return new DefaultSemanticQuestionScheduler(deps)
}

export function buildRollingTranscriptContext(input: {
  segments: TranscriptSegment[]
  version: number
  builtAt: number
  maxSegments?: number
  maxAgeMs?: number
  maxChars?: number
}): RollingTranscriptContext {
  const maxSegments = input.maxSegments ?? SEMANTIC_CONTEXT_MAX_SEGMENTS
  const maxAgeMs = input.maxAgeMs ?? SEMANTIC_CONTEXT_MAX_AGE_MS
  const maxChars = input.maxChars ?? SEMANTIC_CONTEXT_MAX_CHARS
  let segments = input.segments
    .filter(isConfirmedForSemanticDetection)
    .filter((segment) => segment.text.trim())
    .slice(-maxSegments)

  const latest = segments[segments.length - 1]
  if (latest) {
    const latestEndedAt = segmentSemanticTime(latest)
    segments = segments.filter((segment) => latestEndedAt - segmentSemanticTime(segment) <= maxAgeMs)
  }

  segments = trimSegmentsToMaxChars(segments, maxChars)

  const newest = segments[segments.length - 1]
  return {
    version: input.version,
    segments,
    latestSegmentId: newest?.id,
    latestEndedAt: newest ? segmentSemanticTime(newest) : undefined,
    latestConfirmedAt: newest?.createdAt,
    latestAsrLatencyMs: newest?.asrLatencyMs ?? undefined,
    builtAt: input.builtAt,
  }
}

class DefaultSemanticQuestionScheduler implements SemanticQuestionScheduler {
  private readonly now: () => number
  private contextVersion = 0
  private runCounter = 0
  private stopped = false
  private dirtyDuringInFlight = false
  private lastRunStartedAt: number | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private minIntervalTimer: ReturnType<typeof setTimeout> | null = null
  private stabilizationTimer: ReturnType<typeof setTimeout> | null = null
  private inFlight: InFlightSemanticRun | null = null
  private pendingStableQuestions: PendingStableQuestions | null = null
  private lastEvaluatedContextKey: string | null = null

  constructor(private readonly deps: SemanticQuestionSchedulerDeps) {
    this.now = deps.now ?? Date.now
  }

  onConfirmedTranscriptCommitted(segment: TranscriptSegment): void {
    if (this.stopped || !isConfirmedForSemanticDetection(segment)) return
    this.contextVersion += 1
    this.cancelPendingStableQuestions()
    if (this.inFlight) this.dirtyDuringInFlight = true
    this.scheduleAfterIdle()
  }

  stop(): void {
    this.stopped = true
    this.clearTimer("idle")
    this.clearTimer("min")
    this.clearTimer("stabilization")
    this.pendingStableQuestions = null
    if (this.inFlight) {
      this.inFlight.controller.abort()
      clearTimeout(this.inFlight.timeoutTimer)
      this.inFlight = null
    }
  }

  private scheduleAfterIdle(): void {
    this.clearTimer("idle")
    this.clearTimer("min")
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.startWhenEligible()
    }, SEMANTIC_IDLE_DEBOUNCE_MS)
  }

  private startWhenEligible(): void {
    if (this.stopped || !this.deps.isSessionActive()) return
    if (this.inFlight) return
    const context = this.buildContext()
    if (context.segments.length === 0) return
    const skipReason = this.lowValueSkipReason(context)
    if (skipReason) {
      this.deps.addEvent("Question detection skipped: low-value context", "info", {
        contextVersion: context.version,
        segmentCount: context.segments.length,
        reason: skipReason,
        skippedLowValue: true,
      })
      return
    }

    const waitMs = this.remainingMinIntervalMs()
    if (waitMs > 0) {
      this.clearTimer("min")
      this.minIntervalTimer = setTimeout(() => {
        this.minIntervalTimer = null
        this.startWhenEligible()
      }, waitMs)
      return
    }

    this.startRun(context)
  }

  private startRun(context: RollingTranscriptContext): void {
    const runId = `semantic-detection-${++this.runCounter}`
    const startedAt = this.now()
    const controller = new AbortController()
    this.lastRunStartedAt = startedAt
    this.dirtyDuringInFlight = false
    const timeoutTimer = setTimeout(() => {
      if (!this.inFlight || this.inFlight.id !== runId) return
      controller.abort()
      const timedOutRun = this.inFlight
      this.inFlight = null
      const details = timingDetails(timedOutRun, this.now())
      this.deps.addEvent(`Question detection timed out (${formatTimingSummary(details)})`, "warn", {
        runId,
        contextVersion: context.version,
        ...details,
      })
      this.scheduleLatestIfDirty()
    }, SEMANTIC_TIMEOUT_MS)

    this.inFlight = {
      id: runId,
      contextVersion: context.version,
      startedAt,
      latestConfirmedAt: context.latestConfirmedAt,
      latestAsrLatencyMs: context.latestAsrLatencyMs,
      segmentCount: context.segments.length,
      controller,
      timeoutTimer,
    }
    const details = timingDetails(this.inFlight, startedAt)
    this.deps.addEvent(`Semantic question detection scheduled (${formatTimingSummary(details)})`, "info", {
      runId,
      contextVersion: context.version,
      segmentCount: context.segments.length,
      ...details,
    })
    void this.runDetection(runId, context, controller.signal)
  }

  private async runDetection(
    runId: string,
    context: RollingTranscriptContext,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const result = await this.deps.questionDetector.detect({
        recentSegments: context.segments,
        existingQuestionTexts: this.deps.getExistingQuestionTexts(),
        existingCoverageSummaries: compactCoverageSummaries(this.deps.getExistingCoverageSummaries?.() ?? []),
        primaryProjectState: this.deps.getSession().primaryProjectState,
        projectProfiles: this.deps.getProjectProfiles?.() ?? [],
        reverseQuestionPhaseActive: this.deps.getReverseQuestionPhase?.().state === "active",
        contextVersion: context.version,
      }, signal)
      const completedAt = this.now()
      const completedRun = this.completeRun(runId)
      if (!completedRun) return
      this.lastEvaluatedContextKey = contextKey(context)
      const details = timingDetails(completedRun, completedAt, {
        detectorCompletedAt: completedAt,
      })
      if (result.conversationPhase !== "normal_interview") {
        this.deps.handleConversationPhase?.(result.conversationPhase, {
          runId,
          contextVersion: context.version,
          sourceSegmentIds: context.segments.map((segment) => segment.id),
        })
      }
      if (context.version !== this.contextVersion || result.contextVersion !== context.version) {
        this.deps.addEvent(`Stale question detection result discarded (${formatTimingSummary(details)})`, "info", {
          runId,
          contextVersion: context.version,
          latestContextVersion: this.contextVersion,
          ...details,
        })
        this.scheduleAfterIdle()
        return
      }
      if (!result.turnComplete) {
        this.deps.addEvent(`Question detection skipped: turn incomplete (${formatTimingSummary(details)})`, "info", {
          runId,
          contextVersion: context.version,
          reason: result.turnReason ?? null,
          ...details,
        })
        this.scheduleLatestIfDirty()
        return
      }
      if (result.questions.length === 0) {
        this.deps.addEvent(`Question detection completed: no question (${formatTimingSummary(details)})`, "info", {
          runId,
          contextVersion: context.version,
          ...details,
        })
        this.scheduleLatestIfDirty()
        return
      }
      this.holdStableQuestions(completedRun, completedAt, result.questions, result.conversationPhase)
    } catch (error) {
      const failedAt = this.now()
      const failedRun = this.completeRun(runId)
      if (!failedRun) return
      if (isAbortError(error)) return
      const message = error instanceof Error ? error.message : String(error)
      const details = timingDetails(failedRun, failedAt, {
        detectorCompletedAt: failedAt,
      })
      this.deps.addEvent(`Question detection failed: ${message} (${formatTimingSummary(details)})`, "warn", {
        runId,
        contextVersion: context.version,
        error: message,
        ...details,
      })
      this.scheduleLatestIfDirty()
    }
  }

  private completeRun(runId: string): InFlightSemanticRun | null {
    if (!this.inFlight || this.inFlight.id !== runId) return null
    const run = this.inFlight
    clearTimeout(this.inFlight.timeoutTimer)
    this.inFlight = null
    return run
  }

  private holdStableQuestions(
    run: InFlightSemanticRun,
    detectorCompletedAt: number,
    questions: QuestionDetectionResult["questions"],
    conversationPhase: ConversationPhase,
  ): void {
    this.cancelPendingStableQuestions()
    this.pendingStableQuestions = {
      runId: run.id,
      contextVersion: run.contextVersion,
      questions,
      segmentCount: run.segmentCount,
      latestConfirmedAt: run.latestConfirmedAt,
      latestAsrLatencyMs: run.latestAsrLatencyMs,
      runStartedAt: run.startedAt,
      detectorCompletedAt,
      llmDetectionMs: durationBetween(detectorCompletedAt, run.startedAt) ?? 0,
      conversationPhase,
    }
    const stabilizationMs = questions.some(needsRefinementWindow)
      ? SEMANTIC_REFINEMENT_STABILIZATION_MS
      : SEMANTIC_STABILIZATION_MS
    this.stabilizationTimer = setTimeout(() => {
      this.stabilizationTimer = null
      const pending = this.pendingStableQuestions
      this.pendingStableQuestions = null
      if (!pending || this.stopped || !this.deps.isSessionActive()) return
      if (pending.contextVersion !== this.contextVersion) {
        this.scheduleAfterIdle()
        return
      }
      const questionsToEmit = this.dedupeQuestions(pending.questions)
      if (questionsToEmit.length === 0) return
      const emittedAt = this.now()
      const details = timingDetailsFromPending(pending, emittedAt)
      this.deps.emitQuestions(questionsToEmit, {
        runId: pending.runId,
        contextVersion: pending.contextVersion,
        conversationPhase: pending.conversationPhase,
        latestConfirmedAt: pending.latestConfirmedAt,
        latestAsrLatencyMs: pending.latestAsrLatencyMs,
      })
      this.deps.addEvent(`Stable questions emitted (${formatTimingSummary(details)})`, "info", {
        runId: pending.runId,
        contextVersion: pending.contextVersion,
        conversationPhase: pending.conversationPhase,
        questionCount: questionsToEmit.length,
        ...details,
      })
    }, stabilizationMs)
  }

  private dedupeQuestions(
    questions: QuestionDetectionResult["questions"],
  ): QuestionDetectionResult["questions"] {
    const existing = new Set(this.deps.getExistingQuestionTexts().map(normalizeQuestionText))
    const out: QuestionDetectionResult["questions"] = []
    for (const question of questions) {
      const normalized = normalizeQuestionText(question.text)
      if (!normalized || existing.has(normalized)) continue
      existing.add(normalized)
      out.push(question)
    }
    return out
  }

  private buildContext(): RollingTranscriptContext {
    return buildRollingTranscriptContext({
      segments: this.deps.getSession().transcriptSegments,
      version: this.contextVersion,
      builtAt: this.now(),
    })
  }

  private remainingMinIntervalMs(): number {
    if (this.lastRunStartedAt === null) return 0
    return Math.max(0, SEMANTIC_MIN_INTERVAL_MS - (this.now() - this.lastRunStartedAt))
  }

  private scheduleLatestIfDirty(): void {
    if (!this.dirtyDuringInFlight || this.stopped) return
    this.dirtyDuringInFlight = false
    this.scheduleAfterIdle()
  }

  private lowValueSkipReason(context: RollingTranscriptContext): string | null {
    const key = contextKey(context)
    if (key && key === this.lastEvaluatedContextKey) return "context already evaluated"
    const latest = context.segments[context.segments.length - 1]
    if (!latest) return "empty context"
    const text = latest.text.trim()
    const reversePhase = this.deps.getReverseQuestionPhase?.()
    if (reversePhase?.state === "active" && !hasEvaluationResumeCue(text)) {
      return "reverse-question phase active"
    }
    if (text.length < 6 && !hasQuestionCue(text) && !context.segments.some((segment) =>
      segment.id !== latest.id && hasQuestionCue(segment.text)
    )) {
      return "latest segment too small"
    }
    if (latest.speaker === "interviewee" && !hasQuestionCue(text)) return "candidate answer continuation"
    const coverage = this.deps.getExistingCoverageSummaries?.() ?? []
    if (coverage.some((item) => isCoveredContinuation(text, item))) {
      return "already-covered topic continuation"
    }
    return null
  }

  private cancelPendingStableQuestions(): void {
    this.pendingStableQuestions = null
    this.clearTimer("stabilization")
  }

  private clearTimer(kind: "idle" | "min" | "stabilization"): void {
    const timer = kind === "idle"
      ? this.idleTimer
      : kind === "min"
        ? this.minIntervalTimer
        : this.stabilizationTimer
    if (timer) clearTimeout(timer)
    if (kind === "idle") this.idleTimer = null
    if (kind === "min") this.minIntervalTimer = null
    if (kind === "stabilization") this.stabilizationTimer = null
  }
}

function isConfirmedForSemanticDetection(segment: TranscriptSegment): boolean {
  return (segment.state ?? "confirmed") === "confirmed" && segment.definite !== false
}

function segmentSemanticTime(segment: TranscriptSegment): number {
  return Number.isFinite(segment.endMs) ? segment.endMs : segment.createdAt
}

function trimSegmentsToMaxChars(
  segments: TranscriptSegment[],
  maxChars: number,
): TranscriptSegment[] {
  let selected = [...segments]
  while (selected.length > 1 && totalTextChars(selected) > maxChars) {
    selected = selected.slice(1)
  }
  if (selected.length === 1 && selected[0].text.length > maxChars) {
    const only = selected[0]
    selected = [{
      ...only,
      text: only.text.slice(-maxChars),
    }]
  }
  return selected
}

function totalTextChars(segments: TranscriptSegment[]): number {
  return segments.reduce((total, segment) => total + segment.text.length, 0)
}

function timingDetails(
  run: InFlightSemanticRun,
  now: number,
  extra: { detectorCompletedAt?: number } = {},
): StatusEventDetails {
  return compactDetails({
    segmentCount: run.segmentCount,
    asrLatencyMs: run.latestAsrLatencyMs,
    confirmedToRunMs: durationBetween(run.startedAt, run.latestConfirmedAt),
    llmDetectionMs: extra.detectorCompletedAt === undefined
      ? undefined
      : durationBetween(extra.detectorCompletedAt, run.startedAt),
    runElapsedMs: durationBetween(now, run.startedAt),
    confirmedToNowMs: durationBetween(now, run.latestConfirmedAt),
  })
}

function timingDetailsFromPending(
  pending: PendingStableQuestions,
  emittedAt: number,
): StatusEventDetails {
  return compactDetails({
    segmentCount: pending.segmentCount,
    asrLatencyMs: pending.latestAsrLatencyMs,
    confirmedToRunMs: durationBetween(pending.runStartedAt, pending.latestConfirmedAt),
    llmDetectionMs: pending.llmDetectionMs,
    stabilizationWaitMs: durationBetween(emittedAt, pending.detectorCompletedAt),
    runToEmitMs: durationBetween(emittedAt, pending.runStartedAt),
    confirmedToEmitMs: durationBetween(emittedAt, pending.latestConfirmedAt),
  })
}

function durationBetween(later: number, earlier?: number): number | undefined {
  if (earlier === undefined || !Number.isFinite(later) || !Number.isFinite(earlier)) return undefined
  return Math.max(0, Math.round(later - earlier))
}

function compactDetails(details: StatusEventDetails): StatusEventDetails {
  const compacted: StatusEventDetails = {}
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined) compacted[key] = value
  }
  return compacted
}

function formatTimingSummary(details: StatusEventDetails): string {
  const parts: string[] = []
  if (typeof details.asrLatencyMs === "number") parts.push(`asr ${details.asrLatencyMs}ms`)
  if (typeof details.confirmedToRunMs === "number") parts.push(`wait ${details.confirmedToRunMs}ms`)
  if (typeof details.llmDetectionMs === "number") parts.push(`llm ${details.llmDetectionMs}ms`)
  if (typeof details.stabilizationWaitMs === "number") parts.push(`stable ${details.stabilizationWaitMs}ms`)
  if (typeof details.confirmedToEmitMs === "number") parts.push(`total ${details.confirmedToEmitMs}ms`)
  if (parts.length === 0 && typeof details.runElapsedMs === "number") parts.push(`elapsed ${details.runElapsedMs}ms`)
  return parts.join(", ")
}

function contextKey(context: RollingTranscriptContext): string {
  return context.segments.map((segment) => `${segment.id}:${normalizeQuestionText(segment.text)}`).join("|")
}

function hasQuestionCue(text: string): boolean {
  return /[?？]|(什么|为什么|如何|怎么|怎样|哪|谁|讲讲|说说|介绍|说明|测试|开发|架构|算法|AI|流程)/i.test(text)
}

function hasEvaluationResumeCue(text: string): boolean {
  return /(继续|接着|再).{0,8}(问|看|聊).{0,8}(技术|项目|测试|开发|算法|架构)|(我们|我).{0,6}(再|继续|接着).{0,8}(问你|看下|聊下)|恢复.{0,6}(面试|评估|考察)/i.test(text)
}

function isCoveredContinuation(text: string, coverageSummary: string): boolean {
  const normalizedText = normalizeQuestionText(text).replace(/\s+/g, "")
  const normalizedCoverage = normalizeQuestionText(coverageSummary).replace(/\s+/g, "")
  if (!normalizedText || !normalizedCoverage || normalizedText.length < 10) return false
  return normalizedCoverage.includes(normalizedText) || normalizedText.includes(normalizedCoverage)
}

function compactCoverageSummaries(summaries: string[]): string[] {
  return summaries
    .slice(-SEMANTIC_MAX_COVERAGE_SUMMARIES)
    .map((summary) => summary.replace(/\s+/g, " ").trim().slice(0, 120))
    .filter(Boolean)
}

function needsRefinementWindow(question: QuestionDetectionResult["questions"][number]): boolean {
  const text = `${question.text} ${question.answerGoal ?? ""}`
  if (question.clarificationState === "candidate_clarifying") return true
  if (question.sourceSegmentIds.length >= 3) return false
  return /(具体一点|什么样|什么项|这个算法|这个项目|相关项目|大概.*项目流程|前面这个算法|怎么测.*这个|这个.*怎么测)/i.test(text)
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true
  if (!(error instanceof Error)) return false
  return error.name === "AbortError" || /abort|cancel/i.test(error.message)
}
