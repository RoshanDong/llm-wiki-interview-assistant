import type {
  DetectedQuestion,
  QueueCandidateOutcome,
  QuestionCoverageRecord,
  ReverseQuestionPhase,
  QueueCandidateOutcomeType,
  ConversationPhase,
  InterviewProjectProfile,
  PrimaryProjectState,
  RoutingDiagnostic,
} from "./interview-types"
import { canonicalizeAnswerGoalText, normalizeQuestionText } from "./interview-question-detector"
import {
  createEmptyPrimaryProjectState,
  routeInterviewQuestion,
  routingFieldsFromQuestion,
} from "./interview-prompt-routing"

export interface QuestionCoverageEvaluationInput {
  sessionId: string
  candidates: DetectedQuestion[]
  existingQuestions: DetectedQuestion[]
  coverageRecords: QuestionCoverageRecord[]
  reverseQuestionPhase: ReverseQuestionPhase
  primaryProjectState?: PrimaryProjectState
  projectProfiles?: readonly InterviewProjectProfile[]
  conversationPhase?: ConversationPhase
  runId?: string
  now: number
}

export interface QuestionUpdate {
  questionId: string
  patch: Partial<DetectedQuestion>
}

export interface ReversePhaseUpdate {
  state: ReverseQuestionPhase["state"]
  startedAt?: number | null
  triggerSegmentIds?: string[]
  lastSuppressedAt?: number | null
  resumeSegmentIds?: string[]
}

export interface QuestionCoverageEvaluationResult {
  added: DetectedQuestion[]
  questionUpdates: QuestionUpdate[]
  coverageRecords: QuestionCoverageRecord[]
  outcomes: QueueCandidateOutcome[]
  reversePhaseUpdate: ReversePhaseUpdate | null
  primaryProjectState: PrimaryProjectState
  routingDiagnostics: RoutingDiagnostic[]
}

interface ExistingMatch {
  question: DetectedQuestion | null
  coverage: QuestionCoverageRecord | null
}

export function evaluateQuestionCandidates(
  input: QuestionCoverageEvaluationInput,
): QuestionCoverageEvaluationResult {
  const result: QuestionCoverageEvaluationResult = {
    added: [],
    questionUpdates: [],
    coverageRecords: [],
    outcomes: [],
    reversePhaseUpdate: phaseUpdateFor(input),
    primaryProjectState: input.primaryProjectState ?? createEmptyPrimaryProjectState(),
    routingDiagnostics: [],
  }
  const workingQuestions = [...input.existingQuestions]
  const workingCoverage = [...input.coverageRecords]
  const reverseActive = isReversePhaseActive(input.reverseQuestionPhase, input.conversationPhase)
  let primaryProjectState = input.primaryProjectState ?? createEmptyPrimaryProjectState()

  for (const candidate of input.candidates) {
    const answerGoal = canonicalAnswerGoal(candidate)
    if (!answerGoal) {
      result.outcomes.push(createOutcome(input, candidate, "ignored_not_actionable", null, answerGoal, "empty candidate"))
      continue
    }

    if (reverseActive && looksLikeReverseQuestion(candidate)) {
      result.outcomes.push(createOutcome(
        input,
        candidate,
        "suppressed_reverse_question",
        null,
        answerGoal,
        "candidate reverse question during reverse-question phase",
      ))
      result.coverageRecords.push(createCoverageRecord(input, candidate, null, answerGoal, "suppressed_reverse_question", "suppressed"))
      result.reversePhaseUpdate = mergeReversePhaseUpdate(result.reversePhaseUpdate, {
        state: "active",
        lastSuppressedAt: input.now,
      })
      continue
    }

    const match = findExistingMatch(candidate, workingQuestions, workingCoverage)
    if (match.question) {
      const status = match.question.status
      if (status === "pending") {
        if (isClearerCandidate(candidate, match.question)) {
          const patch = refinedQuestionPatch(candidate, match.question, input.now)
          const routed = routeInterviewQuestion({
            question: { ...match.question, ...patch },
            primaryProjectState,
            projectProfiles: input.projectProfiles,
            now: input.now,
            runId: input.runId,
          })
          Object.assign(patch, routed.fields)
          primaryProjectState = routed.primaryProjectState
          result.primaryProjectState = primaryProjectState
          result.routingDiagnostics.push(routed.diagnostic)
          result.questionUpdates.push({ questionId: match.question.id, patch })
          Object.assign(match.question, patch)
          result.outcomes.push(createOutcome(
            input,
            candidate,
            "refined_pending",
            match.question.id,
            answerGoal,
            "clearer pending duplicate refined existing question",
          ))
          result.coverageRecords.push(createCoverageRecord(input, match.question, match.question.id, answerGoal, "refined_pending"))
        } else {
          result.outcomes.push(createOutcome(
            input,
            candidate,
            "merged",
            match.question.id,
            answerGoal,
            "same answer goal already pending",
          ))
          result.coverageRecords.push(createCoverageRecord(input, match.question, match.question.id, answerGoal, "merged"))
        }
      } else {
        result.outcomes.push(createOutcome(
          input,
          candidate,
          "skipped_duplicate",
          match.question.id,
          answerGoal,
          `same answer goal already ${status}`,
        ))
        result.coverageRecords.push(createCoverageRecord(input, match.question, match.question.id, answerGoal, "skipped_duplicate"))
      }
      continue
    }

    if (match.coverage) {
      result.outcomes.push(createOutcome(
        input,
        candidate,
        "skipped_duplicate",
        match.coverage.questionId,
        answerGoal,
        `same answer goal already handled as ${match.coverage.status}`,
      ))
      result.coverageRecords.push({
        ...match.coverage,
        sourceSegmentIds: mergeIds(match.coverage.sourceSegmentIds, candidate.sourceSegmentIds),
        lastOutcome: "skipped_duplicate",
        updatedAt: input.now,
      })
      continue
    }

    const accepted = {
      ...candidate,
      answerGoal,
      coverageAliases: mergeIds(candidate.coverageAliases ?? [], [normalizeCoverageKey(answerGoal), normalizeQuestionText(candidate.text)]),
    }
    const routed = routeInterviewQuestion({
      question: accepted,
      primaryProjectState,
      projectProfiles: input.projectProfiles,
      now: input.now,
      runId: input.runId,
    })
    Object.assign(accepted, routed.fields)
    primaryProjectState = routed.primaryProjectState
    result.primaryProjectState = primaryProjectState
    result.routingDiagnostics.push(routed.diagnostic)
    result.added.push(accepted)
    workingQuestions.push(accepted)
    const coverage = createCoverageRecord(input, accepted, accepted.id, answerGoal, "added")
    result.coverageRecords.push(coverage)
    workingCoverage.push(coverage)
    result.outcomes.push(createOutcome(input, accepted, "added", accepted.id, answerGoal, "new answer goal accepted"))
  }

  return result
}

export function canonicalAnswerGoal(question: Pick<DetectedQuestion, "answerGoal" | "text">): string {
  return canonicalizeAnswerGoalText(question.answerGoal?.trim() || question.text.trim(), question.text).slice(0, 120)
}

export function normalizeCoverageKey(text: string): string {
  return normalizeQuestionText(stripLowInformationText(text))
    .replace(/\s+/g, "")
    .replace(/[，。！？、；：“”‘’（）【】]/g, "")
}

export function hasSameAnswerGoal(
  candidate: Pick<DetectedQuestion, "text" | "answerGoal" | "topic" | "intent" | "coverageAliases">,
  existing: Pick<DetectedQuestion, "text" | "answerGoal" | "topic" | "intent" | "coverageAliases">,
): boolean {
  if (hasSameStructuredGoal(candidate, existing)) return true
  const candidateKeys = coverageKeys(candidate)
  const existingKeys = coverageKeys(existing)
  for (const key of candidateKeys) {
    if (!key) continue
    if (existingKeys.has(key)) return true
    for (const existingKey of existingKeys) {
      if (isSimilarCoverageKey(key, existingKey)) return true
    }
  }
  return false
}

function findExistingMatch(
  candidate: DetectedQuestion,
  questions: DetectedQuestion[],
  coverageRecords: QuestionCoverageRecord[],
): ExistingMatch {
  const question = questions.find((item) => hasSameAnswerGoal(candidate, item)) ?? null
  if (question) return { question, coverage: null }
  const coverage = coverageRecords.find((record) =>
    hasSameAnswerGoal(candidate, {
      text: record.canonicalText,
      answerGoal: record.answerGoal,
      topic: record.topic,
      intent: record.intent,
      coverageAliases: [normalizeCoverageKey(record.answerGoal), normalizeCoverageKey(record.canonicalText)],
    })
  ) ?? null
  return { question: null, coverage }
}

function phaseUpdateFor(input: QuestionCoverageEvaluationInput): ReversePhaseUpdate | null {
  if (input.conversationPhase === "reverse_question") {
    return {
      state: "active",
      startedAt: input.reverseQuestionPhase.startedAt ?? input.now,
      triggerSegmentIds: mergeIds(input.reverseQuestionPhase.triggerSegmentIds, candidateSourceIds(input.candidates)),
    }
  }
  if (input.conversationPhase === "resumed_evaluation") {
    return {
      state: "resumed_evaluation",
      resumeSegmentIds: mergeIds(input.reverseQuestionPhase.resumeSegmentIds, candidateSourceIds(input.candidates)),
    }
  }
  return null
}

function isReversePhaseActive(
  phase: ReverseQuestionPhase,
  conversationPhase?: ConversationPhase,
): boolean {
  if (conversationPhase === "resumed_evaluation") return false
  return conversationPhase === "reverse_question" || phase.state === "active"
}

function looksLikeReverseQuestion(candidate: DetectedQuestion): boolean {
  const text = `${candidate.text} ${candidate.answerGoal ?? ""}`
  return /(岗位|职位|团队|业务|部门|工作内容|职责|流程|面试流程|招聘|hc|AI测试开发岗位|这个岗位|您这边|你们这边|候选人|反问)/i.test(text)
}

function isClearerCandidate(candidate: DetectedQuestion, existing: DetectedQuestion): boolean {
  if (candidate.sourceSegmentIds.length > existing.sourceSegmentIds.length) return true
  return candidate.text.length > existing.text.length + 6
}

function refinedQuestionPatch(candidate: DetectedQuestion, existing: DetectedQuestion, now: number): Partial<DetectedQuestion> {
  return {
    text: candidate.text,
    answerGoal: canonicalAnswerGoal(candidate),
    topic: candidate.topic ?? existing.topic,
    intent: candidate.intent ?? existing.intent,
    entities: mergeIds(existing.entities ?? [], candidate.entities ?? []),
    sourceSegmentIds: mergeIds(existing.sourceSegmentIds, candidate.sourceSegmentIds),
    coverageAliases: mergeIds(existing.coverageAliases ?? [], [
      normalizeCoverageKey(existing.text),
      normalizeCoverageKey(candidate.text),
      normalizeCoverageKey(canonicalAnswerGoal(candidate)),
    ]),
    clarificationState: candidate.clarificationState ?? existing.clarificationState,
    refinementOfSegmentId: candidate.refinementOfSegmentId ?? existing.refinementOfSegmentId,
    updatedAt: now,
  }
}

function createOutcome(
  input: QuestionCoverageEvaluationInput,
  candidate: DetectedQuestion,
  outcome: QueueCandidateOutcomeType,
  questionId: string | null,
  answerGoal: string,
  reason: string,
): QueueCandidateOutcome {
  return {
    outcomeId: `candidate-outcome-${input.now}-${candidate.id}-${outcome}`,
    candidateId: candidate.id,
    outcome,
    questionId,
    questionText: candidate.text,
    answerGoal,
    topic: candidate.topic,
    intent: candidate.intent,
    sourceSegmentIds: candidate.sourceSegmentIds,
    reason,
    runId: input.runId,
    createdAt: input.now,
    ...routingFieldsFromQuestion(candidate),
  }
}

function createCoverageRecord(
  input: QuestionCoverageEvaluationInput,
  question: DetectedQuestion,
  questionId: string | null,
  answerGoal: string,
  outcome: QueueCandidateOutcomeType,
  status: QuestionCoverageRecord["status"] = question.status,
): QuestionCoverageRecord {
  return {
    coverageId: questionId ?? `coverage-${normalizeCoverageKey(answerGoal) || question.id}`,
    questionId,
    answerGoal,
    topic: question.topic,
    intent: question.intent,
    entities: question.entities,
    canonicalText: question.text,
    sourceSegmentIds: question.sourceSegmentIds,
    status,
    lastOutcome: outcome,
    createdAt: question.detectedAt,
    updatedAt: input.now,
    ...routingFieldsFromQuestion(question),
  }
}

function mergeReversePhaseUpdate(
  current: ReversePhaseUpdate | null,
  next: ReversePhaseUpdate,
): ReversePhaseUpdate {
  if (!current) return next
  return {
    ...current,
    ...next,
    triggerSegmentIds: mergeIds(current.triggerSegmentIds ?? [], next.triggerSegmentIds ?? []),
    resumeSegmentIds: mergeIds(current.resumeSegmentIds ?? [], next.resumeSegmentIds ?? []),
  }
}

function candidateSourceIds(candidates: DetectedQuestion[]): string[] {
  return candidates.flatMap((candidate) => candidate.sourceSegmentIds)
}

function coverageKeys(question: Pick<DetectedQuestion, "text" | "answerGoal" | "coverageAliases">): Set<string> {
  const canonicalGoal = canonicalAnswerGoal(question)
  return new Set([
    normalizeCoverageKey(question.text),
    normalizeCoverageKey(question.answerGoal ?? ""),
    normalizeCoverageKey(canonicalGoal),
    ...(question.coverageAliases ?? []).map(normalizeCoverageKey),
  ].filter(Boolean))
}

function isSimilarCoverageKey(a: string, b: string): boolean {
  if (!a || !b) return false
  const normalizedA = normalizeCoverageKey(a)
  const normalizedB = normalizeCoverageKey(b)
  if (!normalizedA || !normalizedB) return false
  if (normalizedA === normalizedB) return true
  const shorter = normalizedA.length <= normalizedB.length ? normalizedA : normalizedB
  const longer = normalizedA.length > normalizedB.length ? normalizedA : normalizedB
  if (shorter.length >= 10 && longer.includes(shorter) && shorter.length / longer.length >= 0.85) return true
  return diceCoefficient(normalizedA, normalizedB) >= 0.92
}

function diceCoefficient(a: string, b: string): number {
  const aBigrams = bigrams(a)
  const bBigrams = bigrams(b)
  if (aBigrams.size === 0 || bBigrams.size === 0) return 0
  let overlap = 0
  for (const item of aBigrams) {
    if (bBigrams.has(item)) overlap += 1
  }
  return (2 * overlap) / (aBigrams.size + bBigrams.size)
}

function bigrams(text: string): Set<string> {
  const normalized = normalizeCoverageKey(text)
  if (normalized.length <= 1) return new Set(normalized ? [normalized] : [])
  const out = new Set<string>()
  for (let index = 0; index < normalized.length - 1; index += 1) {
    out.add(normalized.slice(index, index + 2))
  }
  return out
}

function hasSameStructuredGoal(
  candidate: Pick<DetectedQuestion, "topic" | "intent">,
  existing: Pick<DetectedQuestion, "topic" | "intent">,
): boolean {
  const candidateTopic = normalizeCoverageKey(candidate.topic ?? "")
  const existingTopic = normalizeCoverageKey(existing.topic ?? "")
  const candidateIntent = normalizeCoverageKey(candidate.intent ?? "")
  const existingIntent = normalizeCoverageKey(existing.intent ?? "")
  if (!candidateTopic || !existingTopic || !candidateIntent || !existingIntent) return false
  return candidateIntent === existingIntent && isConservativeTopicMatch(candidateTopic, existingTopic)
}

function isConservativeTopicMatch(a: string, b: string): boolean {
  if (a === b) return true
  const shorter = a.length <= b.length ? a : b
  const longer = a.length > b.length ? a : b
  return shorter.length >= 6 && longer.includes(shorter) && shorter.length / longer.length >= 0.7
}

function stripLowInformationText(text: string): string {
  return text
    .replace(/^(描述|说明|介绍|讲解|回答|阐述|总结)\s*/i, "")
    .replace(/具体|相关|一个|一些|大概|内容|细节|情况/g, "")
}

function mergeIds(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b].filter(Boolean)))
}
