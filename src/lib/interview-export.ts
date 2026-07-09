import { writeFile } from "@/commands/fs"
import type {
  AnswerRequest,
  DetectedQuestion,
  InterviewSession,
  ProjectRoutingScoreDiagnostic,
  StatusEvent,
  TranscriptSegment,
} from "./interview-types"

export const DEFAULT_INTERVIEW_EXPORT_DIR = "/tmp/llm-wiki-interview-exports"

export interface InterviewMarkdownExportInput {
  session: InterviewSession
  answerRequests: AnswerRequest[]
  statusEvents?: StatusEvent[]
  exportedAt?: number
}

export interface InterviewMarkdownExportWriteDeps {
  writeFile?: (path: string, contents: string) => Promise<void>
}

export function buildInterviewMarkdownExport(input: InterviewMarkdownExportInput): string {
  const exportedAt = input.exportedAt ?? Date.now()
  const lines: string[] = [
    "# Interview Export",
    "",
    `- Session: ${input.session.id}`,
    `- Mode: ${input.session.mode ?? "unknown"}`,
    `- Status: ${input.session.status}`,
    `- Started: ${formatDate(input.session.startedAt)}`,
    `- Ended: ${formatDate(input.session.endedAt)}`,
    `- Exported: ${formatDate(exportedAt)}`,
    "",
    "## Audio Capture Capability",
    "",
    formatAudioCaptureCapability(input.statusEvents ?? []),
    "",
    "## Transcript",
    "",
  ]

  const confirmedSegments = input.session.transcriptSegments
    .filter((segment) => (segment.state ?? "confirmed") === "confirmed")
    .sort((a, b) => compareTranscriptSegments(input.session, a, b))
  if (confirmedSegments.length === 0) {
    lines.push("_No confirmed transcript segments._", "")
  } else {
    for (const segment of confirmedSegments) {
      lines.push(formatTranscriptSegment(segment), "")
    }
  }

  lines.push("## Primary Project Timeline", "")
  lines.push(formatPrimaryProjectTimeline(input.session), "")

  lines.push("## Project Routing Diagnostics", "")
  lines.push(formatProjectRoutingDiagnostics(input.session), "")

  lines.push("## Questions", "")
  if (input.session.questions.length === 0) {
    lines.push("_No detected questions._", "")
  } else {
    for (const question of input.session.questions) {
      lines.push(formatQuestion(question), "")
    }
  }

  lines.push("## LLM Wiki Answers", "")
  const answers = input.answerRequests.slice().sort((a, b) => a.submittedAt - b.submittedAt)
  if (answers.length === 0) {
    lines.push("_No answer requests submitted._", "")
  } else {
    for (const answer of answers) {
      const question = input.session.questions.find((item) => item.id === answer.questionId)
      lines.push(formatAnswer(answer, question), "")
    }
  }

  lines.push("## Test Metrics", "")
  const metricEvents = semanticMetricEvents(input.statusEvents ?? [])
  const candidateOutcomes = input.session.queueCandidateOutcomes ?? []
  if (metricEvents.length === 0 && candidateOutcomes.length === 0) {
    lines.push("_No semantic detection metrics captured._", "")
  } else {
    if (metricEvents.length > 0) lines.push(formatMetricTable(metricEvents), "")
    if (candidateOutcomes.length > 0) lines.push(formatCandidateOutcomeTable(candidateOutcomes), "")
  }

  return `${lines.join("\n").trimEnd()}\n`
}

function formatProjectRoutingDiagnostics(session: InterviewSession): string {
  const diagnostics = (session.routingDiagnostics ?? [])
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
  if (diagnostics.length === 0) return "_No project routing diagnostics captured._"

  const questionsById = new Map(session.questions.map((question) => [question.id, question]))
  return [
    "| Time | Question | Selected project | Routing | Source | Top scores | Strong terms | Weak terms | Technical terms | Strong combos | Negative terms | Reason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...diagnostics.map((diagnostic) => {
      const question = questionsById.get(diagnostic.questionId)
      const allScores = diagnostic.projectScores ?? []
      const topScores = allScores.slice(0, 3)
      const selectedScore = allScores.find((score) => score.project === diagnostic.projectCategory) ?? topScores[0]
      return [
        formatDate(diagnostic.createdAt),
        escapeMarkdownTableCell(question?.answerGoal || question?.text || diagnostic.questionId),
        escapeMarkdownTableCell(diagnostic.projectCategory || "-"),
        escapeMarkdownTableCell(diagnostic.projectRoutingStatus),
        escapeMarkdownTableCell(diagnostic.routingSource || "-"),
        escapeMarkdownTableCell(formatScoreSummary(topScores)),
        escapeMarkdownTableCell(formatScoreTerms(selectedScore, "matchedStrongTerms")),
        escapeMarkdownTableCell(formatScoreTerms(selectedScore, "matchedWeakTerms")),
        escapeMarkdownTableCell(formatScoreTerms(selectedScore, "matchedTechnicalTerms")),
        escapeMarkdownTableCell(formatScoreTerms(selectedScore, "matchedStrongCombos")),
        escapeMarkdownTableCell(formatScoreTerms(selectedScore, "matchedNegativeTerms")),
        escapeMarkdownTableCell(diagnostic.reason || "-"),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |")
    }),
  ].join("\n")
}

function formatAudioCaptureCapability(events: StatusEvent[]): string {
  const event = events
    .filter((item) => item.details.audioCaptureCapabilityCheck === true)
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  if (!event) return "_No audio capture capability check captured._"
  const details = event.details
  const microphone = details.microphoneAvailable === true ? "available" : "unavailable"
  const system = details.systemAvailable === true ? "available" : "unavailable"
  return [
    `- Checked: ${formatDate(event.createdAt)}`,
    `- Required sources: ${formatDetail(details.requiredAudioSources)}`,
    `- Result: ${event.level === "error" ? "failed" : "passed"}`,
    `- Microphone: ${microphone}${formatReason(details.microphoneReason)}`,
    `- System audio: ${system}${formatReason(details.systemReason)}`,
  ].join("\n")
}

function formatReason(reason: StatusEvent["details"][string]): string {
  return typeof reason === "string" && reason.trim() ? ` (${reason.trim()})` : ""
}

function formatScoreSummary(scores: ProjectRoutingScoreDiagnostic[]): string {
  if (scores.length === 0) return "-"
  return scores.map((score) => `${score.project}:${score.score}`).join("; ")
}

function formatScoreTerms(
  score: ProjectRoutingScoreDiagnostic | undefined,
  key: keyof Pick<ProjectRoutingScoreDiagnostic,
    | "matchedStrongTerms"
    | "matchedWeakTerms"
    | "matchedTechnicalTerms"
    | "matchedStrongCombos"
    | "matchedNegativeTerms"
  >,
): string {
  const terms = score?.[key] ?? []
  return terms.length > 0 ? terms.join(", ") : "-"
}

export function defaultInterviewExportFileName(session: InterviewSession, exportedAt = Date.now()): string {
  const stamp = new Date(exportedAt).toISOString().replace(/[:.]/g, "-")
  return `interview-${session.id}-${stamp}.md`
}

export function defaultInterviewExportPath(input: InterviewMarkdownExportInput): string {
  return `${DEFAULT_INTERVIEW_EXPORT_DIR}/${defaultInterviewExportFileName(input.session, input.exportedAt)}`
}

export async function saveInterviewMarkdownExport(
  input: InterviewMarkdownExportInput,
  deps: InterviewMarkdownExportWriteDeps = {},
): Promise<string> {
  const content = buildInterviewMarkdownExport(input)
  const path = defaultInterviewExportPath(input)
  await (deps.writeFile ?? writeFile)(path, content)
  return path
}

function formatTranscriptSegment(segment: TranscriptSegment): string {
  const latency = formatLatency(segment.asrLatencyMs)
  const lines = [
    `### ${formatOffset(segment.startMs)} ${segment.speaker}`,
    "",
    `- Source: ${segment.source}`,
    `- ASR latency: ${latency}`,
    segment.audioStartMs !== undefined || segment.audioEndMs !== undefined
      ? `- Audio timeline: ${formatOffset(segment.audioStartMs ?? segment.startMs)}-${formatOffset(segment.audioEndMs ?? segment.endMs)}`
      : null,
    `- Received: ${formatDate(segment.createdAt)}`,
    typeof segment.segmentDurationMs === "number" ? `- Segment duration: ${formatLatency(segment.segmentDurationMs)}` : null,
    typeof segment.recognitionProcessingMs === "number"
      ? `- Recognition processing: ${formatLatency(segment.recognitionProcessingMs)}`
      : null,
    `- Confidence: ${formatConfidence(segment.confidence)}`,
    "",
    segment.text.trim() || "_Empty segment._",
  ].filter((line): line is string => line !== null)
  return lines.join("\n")
}

function formatPrimaryProjectTimeline(session: InterviewSession): string {
  const lines: string[] = [
    `- Current project: ${session.primaryProjectState.currentProject ?? "-"}`,
    `- Status: ${session.primaryProjectState.status}`,
    `- Reason: ${session.primaryProjectState.reason ?? "-"}`,
  ]
  const routedQuestions = session.questions
    .filter((question) => question.projectRoutingStatus || question.projectCategory)
    .slice()
    .sort((a, b) => a.detectedAt - b.detectedAt)

  if (routedQuestions.length === 0) {
    lines.push("", "_No project routing events captured._")
    return lines.join("\n")
  }

  lines.push(
    "",
    "| Time | Question | Project | Routing | Reason |",
    "| --- | --- | --- | --- | --- |",
    ...routedQuestions.map((question) => [
      formatDate(question.detectedAt),
      escapeMarkdownTableCell(question.answerGoal || question.text),
      escapeMarkdownTableCell(question.projectCategory || "-"),
      escapeMarkdownTableCell(question.projectRoutingStatus || "-"),
      escapeMarkdownTableCell(question.projectRoutingReason || "-"),
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |")),
  )
  return lines.join("\n")
}

function compareTranscriptSegments(
  session: InterviewSession,
  left: TranscriptSegment,
  right: TranscriptSegment,
): number {
  if (session.mode === "debug") {
    const createdDiff = left.createdAt - right.createdAt
    if (createdDiff !== 0) return createdDiff
  }
  const startDiff = left.startMs - right.startMs
  if (startDiff !== 0) return startDiff
  return left.createdAt - right.createdAt
}

function formatQuestion(question: DetectedQuestion): string {
  return [
    `### ${question.text}`,
    "",
    `- Status: ${question.status}`,
    question.answerGoal ? `- Answer goal: ${question.answerGoal}` : null,
    question.questionType ? `- Question type: ${question.questionType}` : null,
    question.projectCategory ? `- Project category: ${question.projectCategory}` : null,
    question.projectRoutingStatus ? `- Project routing status: ${question.projectRoutingStatus}` : null,
    question.answerPromptFamily ? `- Answer prompt family: ${question.answerPromptFamily}` : null,
    question.retrievalPolicy ? `- Retrieval policy: ${question.retrievalPolicy}` : null,
    question.projectRoutingReason ? `- Routing reason: ${question.projectRoutingReason}` : null,
    question.topic ? `- Topic: ${question.topic}` : null,
    question.intent ? `- Intent: ${question.intent}` : null,
    question.entities && question.entities.length > 0 ? `- Entities: ${question.entities.join(", ")}` : null,
    `- Detected: ${formatDate(question.detectedAt)}`,
    `- Updated: ${formatDate(question.updatedAt ?? null)}`,
    `- Source segments: ${question.sourceSegmentIds.join(", ") || "-"}`,
    question.attentionReason ? `- Attention: ${question.attentionReason}` : null,
  ].filter(Boolean).join("\n")
}

function formatAnswer(answer: AnswerRequest, question: DetectedQuestion | undefined): string {
  return [
    `### ${question?.text ?? answer.questionId}`,
    "",
    `- Status: ${answer.status}`,
    `- Submitted: ${formatDate(answer.submittedAt)}`,
    `- Completed: ${formatDate(answer.completedAt)}`,
    `- Conversation: ${answer.conversationId ?? "-"}`,
    answer.questionType ? `- Question type: ${answer.questionType}` : null,
    answer.projectCategory ? `- Project category: ${answer.projectCategory}` : null,
    answer.answerPromptFamily ? `- Answer prompt family: ${answer.answerPromptFamily}` : null,
    answer.retrievalPolicy ? `- Retrieval policy: ${answer.retrievalPolicy}` : null,
    answer.errorMessage ? `- Error: ${answer.errorMessage}` : null,
    "",
    "#### Prompt",
    "",
    answer.submittedPrompt.trim() || "_Empty prompt._",
    "",
    "#### Answer",
    "",
    answer.assistantMessageContent?.trim() || "_No answer content captured._",
  ].filter((line): line is string => line !== null).join("\n")
}

function semanticMetricEvents(events: StatusEvent[]): StatusEvent[] {
  return events
    .filter((event) => hasSemanticMetricDetails(event))
    .sort((a, b) => a.createdAt - b.createdAt)
}

function hasSemanticMetricDetails(event: StatusEvent): boolean {
  const details = event.details
  return typeof details.runId === "string" ||
    typeof details.asrLatencyMs === "number" ||
    typeof details.confirmedToRunMs === "number" ||
    typeof details.llmDetectionMs === "number" ||
    typeof details.stabilizationWaitMs === "number" ||
    typeof details.runToEmitMs === "number" ||
    typeof details.confirmedToEmitMs === "number" ||
    typeof details.runElapsedMs === "number" ||
    typeof details.queueWaitMs === "number" ||
    typeof details.answerDurationMs === "number" ||
    typeof details.candidateOutcome === "string" ||
    details.skippedLowValue === true
}

function formatMetricTable(events: StatusEvent[]): string {
  return [
    "| Time | Event | Run | Context | Segments | ASR | Wait | LLM | Stable | Run to emit | Total | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...events.map(formatMetricRow),
  ].join("\n")
}

function formatMetricRow(event: StatusEvent): string {
  const details = event.details
  const notes = typeof details.reason === "string" && details.reason.trim()
    ? details.reason.trim()
    : typeof details.error === "string" && details.error.trim()
      ? details.error.trim()
      : "-"
  return [
    formatDate(event.createdAt),
    classifyMetricEvent(event.message),
    formatDetail(details.runId),
    formatDetail(details.contextVersion),
    formatDetail(details.segmentCount),
    formatDuration(details.asrLatencyMs),
    formatDuration(typeof details.confirmedToRunMs === "number" ? details.confirmedToRunMs : details.queueWaitMs),
    formatDuration(details.llmDetectionMs),
    formatDuration(details.stabilizationWaitMs),
    formatDuration(details.runToEmitMs),
    formatDuration(typeof details.confirmedToEmitMs === "number" ? details.confirmedToEmitMs : details.answerDurationMs),
    escapeMarkdownTableCell(notes),
  ].join(" | ").replace(/^/, "| ").replace(/$/, " |")
}

function classifyMetricEvent(message: string): string {
  if (/Stable questions emitted/i.test(message)) return "stable emitted"
  if (/Question candidate/i.test(message)) return "candidate outcome"
  if (/submitted for answer/i.test(message)) return "answer submitted"
  if (/Answer prompt completed/i.test(message)) return "answer completed"
  if (/low-value context/i.test(message)) return "skipped low value"
  if (/turn incomplete/i.test(message)) return "turn incomplete"
  if (/no question/i.test(message)) return "no question"
  if (/timed out/i.test(message)) return "timeout"
  if (/stale/i.test(message)) return "stale discarded"
  if (/failed/i.test(message)) return "failed"
  if (/scheduled/i.test(message)) return "scheduled"
  return message.trim() || "-"
}

function formatCandidateOutcomeTable(outcomes: InterviewSession["queueCandidateOutcomes"]): string {
  return [
    "| Time | Outcome | Candidate | Question | Answer goal | Question type | Project | Routing | Prompt family | Retrieval | Topic | Intent | Reason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...outcomes
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((outcome) => [
        formatDate(outcome.createdAt),
        outcome.outcome,
        escapeMarkdownTableCell(outcome.candidateId),
        escapeMarkdownTableCell(outcome.questionId ?? "-"),
        escapeMarkdownTableCell(outcome.answerGoal || "-"),
        escapeMarkdownTableCell(outcome.questionType || "-"),
        escapeMarkdownTableCell(outcome.projectCategory || "-"),
        escapeMarkdownTableCell(outcome.projectRoutingStatus || "-"),
        escapeMarkdownTableCell(outcome.answerPromptFamily || "-"),
        escapeMarkdownTableCell(outcome.retrievalPolicy || "-"),
        escapeMarkdownTableCell(outcome.topic || "-"),
        escapeMarkdownTableCell(outcome.intent || "-"),
        escapeMarkdownTableCell(outcome.reason || "-"),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |")),
  ].join("\n")
}

function formatDetail(value: StatusEvent["details"][string]): string {
  if (typeof value === "string" && value.trim()) return escapeMarkdownTableCell(value.trim())
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "boolean") return String(value)
  return "-"
}

function formatDuration(value: StatusEvent["details"][string]): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-"
  if (value < 1000) return `${Math.round(value)} ms`
  return `${(value / 1000).toFixed(1)} s`
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

function formatDate(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "-"
  return new Date(ms).toISOString()
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function formatLatency(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "-"
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

function formatConfidence(confidence: number | null): string {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return "-"
  return `${Math.round(confidence * 100)}%`
}
