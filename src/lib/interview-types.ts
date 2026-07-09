export type AnswerPromptTemplateFamily =
  | "project_experience_overview"
  | "project_method_plan"
  | "project_detail_deep_dive"
  | "knowledge_bagua"
  | "coding"

export type PromptTemplateId = "preparation" | "answer" | AnswerPromptTemplateFamily

export interface PromptTemplate {
  id: PromptTemplateId
  text: string
  questionPlaceholder: string | null
  updatedAt: number
  isDefault: boolean
}

export interface PromptTemplateSet {
  preparation: PromptTemplate
  answer: PromptTemplate
  answerTemplates: Record<AnswerPromptTemplateFamily, PromptTemplate>
}

export type PreparationStatus = "idle" | "running" | "succeeded" | "failed"

export interface PreparationState {
  status: PreparationStatus
  startedAt: number | null
  completedAt: number | null
  conversationId: string | null
  error: string | null
}

export type AudioSourceKind = "system" | "microphone" | "file"
export type InterviewMode = "production" | "debug"

export interface AudioSourceSelection {
  kind: AudioSourceKind
  label: string
  fileName: string | null
  selectedAt: number
  file?: File
  filePath?: string
}

export interface StartProductionInterviewInput {
  mode: "production"
  system: AudioSourceSelection & { kind: "system" }
  microphone: AudioSourceSelection & { kind: "microphone" }
}

export interface StartDebugFileTranscriptionInput {
  mode: "debug"
  file: AudioSourceSelection & { kind: "file" }
}

export type InterviewStartInput = StartProductionInterviewInput | StartDebugFileTranscriptionInput

export type InterviewSessionStatus =
  | "idle"
  | "ready"
  | "connecting"
  | "listening"
  | "degraded"
  | "retrying"
  | "ending"
  | "ended"
  | "failed"
export type SpeakerLabel = "interviewer" | "interviewee" | "unknown"
export type TranscriptUpdateState = "provisional" | "confirmed"

export interface TranscriptSegment {
  id: string
  sessionId: string
  streamId?: string
  speaker: SpeakerLabel
  text: string
  startMs: number
  endMs: number
  confidence: number | null
  source: AudioSourceKind
  state?: TranscriptUpdateState
  definite?: boolean
  providerSequence?: number
  providerUtteranceId?: string
  revisionOf?: string
  replacesProvisionalId?: string
  asrLatencyMs?: number | null
  audioStartMs?: number
  audioEndMs?: number
  segmentDurationMs?: number
  recognitionProcessingMs?: number | null
  createdAt: number
}

export type AudioStreamStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "retrying"
  | "degraded"
  | "stopped"
  | "failed"

export type StreamingSessionStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "degraded"
  | "retrying"
  | "finalizing"
  | "stopped"
  | "failed"

export interface AudioInputStreamState {
  id: string
  kind: AudioSourceKind
  label: string
  status: AudioStreamStatus
  available: boolean
  retryAttempt: number
  lastErrorCode: string | null
  lastErrorMessage: string | null
  lastServiceLogId: string | null
  selectedAt: number
  fileName: string | null
}

export interface StreamingTranscriptionSession {
  id: string
  interviewSessionId: string
  mode: InterviewMode
  status: StreamingSessionStatus
  startedAt: number
  stoppedAt: number | null
  streams: AudioInputStreamState[]
}

export interface InterviewAsrStatusEvent {
  sessionId: string
  streamId?: string
  source?: AudioSourceKind
  status:
    | "connecting"
    | "listening"
    | "degraded"
    | "retrying"
    | "recovered"
    | "finalizing"
    | "stopped"
    | "failed"
  level: StatusEventLevel
  message: string
  retryAttempt?: number
  serviceLogId?: string
  errorCode?: string
  createdAt: number
}

export interface InterviewAsrTranscriptEvent {
  sessionId: string
  streamId: string
  source: AudioSourceKind
  providerSequence?: number
  providerUtteranceId?: string
  revisionOf?: string
  text: string
  startMs: number
  endMs: number
  speaker: SpeakerLabel
  confidence: number | null
  state: TranscriptUpdateState
  definite: boolean
  createdAt: number
}

export interface InterviewAsrDiagnosticEvent {
  sessionId: string
  streamId?: string
  source?: AudioSourceKind
  level: StatusEventLevel
  category:
    | "configuration"
    | "audio"
    | "connectivity"
    | "service"
    | "protocol"
    | "retry"
    | "redaction"
  message: string
  errorCode?: string
  serviceLogId?: string
  retryAttempt?: number
  createdAt: number
}

export type QuestionStatus = "pending" | "answering" | "completed" | "attention" | "canceled"
export type ConversationPhase = "normal_interview" | "reverse_question" | "resumed_evaluation"
export type InterviewProjectCategory = string
export interface InterviewProjectProfile {
  id: string
  name: InterviewProjectCategory
  aliases: string[]
  strongTerms: string[]
  weakTerms: string[]
  technicalTerms: string[]
  negativeTerms: string[]
  strongCombos: string[][]
  enabled: boolean
  updatedAt: number
}

export interface InterviewProjectProfileSet {
  profiles: InterviewProjectProfile[]
  updatedAt: number
}
export type InterviewQuestionType =
  | "项目经历概览类"
  | "项目方法方案类"
  | "项目细节深挖类"
  | "知识八股类"
  | "手撕代码类"
export type ProjectRoutingStatus = "detected" | "inherited" | "switched" | "cleared" | "none"
export type PrimaryProjectStateStatus = "empty" | "active" | "cleared"
export type AnswerRetrievalPolicy =
  | "project_grounded"
  | "knowledge_first_with_fallback"
  | "direct_no_project_grounding"
export type QueueCandidateOutcomeType =
  | "added"
  | "merged"
  | "refined_pending"
  | "skipped_duplicate"
  | "suppressed_reverse_question"
  | "ignored_not_actionable"

export type ReverseQuestionPhaseStatus = "inactive" | "active" | "resumed_evaluation"

export interface ReverseQuestionPhase {
  state: ReverseQuestionPhaseStatus
  startedAt: number | null
  triggerSegmentIds: string[]
  lastSuppressedAt: number | null
  resumeSegmentIds: string[]
}

export interface PrimaryProjectState {
  currentProject: InterviewProjectCategory | null
  status: PrimaryProjectStateStatus
  updatedAt: number | null
  sourceQuestionId: string | null
  reason: string | null
}

export interface InterviewRoutingFields {
  questionType?: InterviewQuestionType
  projectCategory?: InterviewProjectCategory
  projectRoutingStatus?: ProjectRoutingStatus
  projectRoutingReason?: string
  answerPromptFamily?: AnswerPromptTemplateFamily
  retrievalPolicy?: AnswerRetrievalPolicy
}

export interface QuestionCoverageRecord {
  coverageId: string
  questionId: string | null
  answerGoal: string
  topic?: string
  intent?: string
  entities?: string[]
  canonicalText: string
  sourceSegmentIds: string[]
  status: QuestionStatus | "skipped" | "suppressed"
  lastOutcome: QueueCandidateOutcomeType
  createdAt: number
  updatedAt: number
  questionType?: InterviewQuestionType
  projectCategory?: InterviewProjectCategory
  projectRoutingStatus?: ProjectRoutingStatus
  projectRoutingReason?: string
  answerPromptFamily?: AnswerPromptTemplateFamily
  retrievalPolicy?: AnswerRetrievalPolicy
}

export interface QueueCandidateOutcome {
  outcomeId: string
  candidateId: string
  outcome: QueueCandidateOutcomeType
  questionId: string | null
  questionText: string
  answerGoal: string
  topic?: string
  intent?: string
  sourceSegmentIds: string[]
  reason: string
  runId?: string
  createdAt: number
  questionType?: InterviewQuestionType
  projectCategory?: InterviewProjectCategory
  projectRoutingStatus?: ProjectRoutingStatus
  projectRoutingReason?: string
  answerPromptFamily?: AnswerPromptTemplateFamily
  retrievalPolicy?: AnswerRetrievalPolicy
}

export interface DetectedQuestion extends InterviewRoutingFields {
  id: string
  sessionId: string
  text: string
  answerGoal?: string
  topic?: string
  intent?: string
  entities?: string[]
  coverageAliases?: string[]
  sourceSegmentIds: string[]
  clarificationState?: "none" | "candidate_clarifying" | "confirmed" | "rejected"
  refinementOfSegmentId?: string
  detectedAt: number
  updatedAt?: number
  status: QuestionStatus
  queuedAt: number
  startedAt: number | null
  completedAt: number | null
  canceledAt: number | null
  attentionReason: string | null
}

export type AnswerRequestStatus = "submitting" | "answering" | "completed" | "failed" | "canceled"

export interface AnswerRequest {
  id: string
  questionId: string
  conversationId: string | null
  submittedPrompt: string
  assistantMessageContent: string | null
  status: AnswerRequestStatus
  submittedAt: number
  completedAt: number | null
  canceledAt: number | null
  errorCode: string | null
  errorMessage: string | null
  questionType?: InterviewQuestionType
  projectCategory?: InterviewProjectCategory
  projectRoutingStatus?: ProjectRoutingStatus
  projectRoutingReason?: string
  answerPromptFamily?: AnswerPromptTemplateFamily
  retrievalPolicy?: AnswerRetrievalPolicy
}

export interface RoutingDiagnostic {
  questionId: string
  questionType: InterviewQuestionType
  projectCategory?: InterviewProjectCategory
  projectRoutingStatus: ProjectRoutingStatus
  answerPromptFamily: AnswerPromptTemplateFamily
  retrievalPolicy: AnswerRetrievalPolicy
  reason?: string
  routingSource?: "detector_hint" | "profile_score" | "none"
  projectScores?: ProjectRoutingScoreDiagnostic[]
  runId?: string
  createdAt: number
}

export interface ProjectRoutingScoreDiagnostic {
  project: InterviewProjectCategory
  score: number
  matchedStrongTerms: string[]
  matchedWeakTerms: string[]
  matchedTechnicalTerms: string[]
  matchedNegativeTerms: string[]
  matchedStrongCombos: string[]
}

export type StatusEventKind =
  | "preparation"
  | "audio"
  | "asr"
  | "question"
  | "queue"
  | "chat"
  | "error"
  | "cancel"
  | "session"

export type StatusEventLevel = "info" | "warn" | "error"
export type StatusEventDetails = Record<string, string | number | boolean | null | undefined>

export interface StatusEvent {
  id: string
  sessionId: string | null
  kind: StatusEventKind
  message: string
  level: StatusEventLevel
  createdAt: number
  details: StatusEventDetails
}

export interface InterviewSession {
  id: string
  status: InterviewSessionStatus
  preparation: PreparationState
  audioSource: AudioSourceSelection | null
  mode: InterviewMode | null
  streaming: StreamingTranscriptionSession | null
  audioStreams: AudioInputStreamState[]
  provisionalTranscriptSegments: TranscriptSegment[]
  diagnostics: InterviewAsrDiagnosticEvent[]
  startedAt: number | null
  endedAt: number | null
  transcriptSegments: TranscriptSegment[]
  questions: DetectedQuestion[]
  questionCoverage: QuestionCoverageRecord[]
  reverseQuestionPhase: ReverseQuestionPhase
  primaryProjectState: PrimaryProjectState
  routingDiagnostics: RoutingDiagnostic[]
  queueCandidateOutcomes: QueueCandidateOutcome[]
  activeQuestionId: string | null
  lastError: string | null
}

export interface InterviewAssistantState {
  preparationStatus: PreparationStatus
  sessionStatus: InterviewSessionStatus
  selectedAudioSource: AudioSourceSelection | null
  mode: InterviewMode | null
  streamingStatus: StreamingSessionStatus | null
  audioStreams: AudioInputStreamState[]
  provisionalTranscriptSegments: TranscriptSegment[]
  diagnostics: InterviewAsrDiagnosticEvent[]
  transcriptSegments: TranscriptSegment[]
  questions: DetectedQuestion[]
  activeQuestionId: string | null
  queueLength: number
  statusEvents: StatusEvent[]
  fullStatusEvents: StatusEvent[]
  startInterviewEnabled: boolean
  endInterviewEnabled: boolean
}

export interface ChatTurnResult {
  conversationId: string
  userMessageId: string
  assistantMessageId: string
  assistantMessageContent?: string
  completedAt: number
}
