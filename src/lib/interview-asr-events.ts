import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type {
  AudioSourceKind,
  InterviewAsrDiagnosticEvent,
  InterviewAsrStatusEvent,
  InterviewAsrTranscriptEvent,
  SpeakerLabel,
  TranscriptUpdateState,
} from "./interview-types"

export const INTERVIEW_ASR_STATUS_EVENT = "interview-asr://status"
export const INTERVIEW_ASR_TRANSCRIPT_EVENT = "interview-asr://transcript"
export const INTERVIEW_ASR_DIAGNOSTIC_EVENT = "interview-asr://diagnostic"

export interface InterviewAsrEventHandlers {
  onStatus?: (event: InterviewAsrStatusEvent) => void
  onTranscript?: (event: InterviewAsrTranscriptEvent) => void
  onDiagnostic?: (event: InterviewAsrDiagnosticEvent) => void
}

export async function subscribeToInterviewAsrEvents(
  handlers: InterviewAsrEventHandlers,
): Promise<UnlistenFn> {
  const unlisteners = await Promise.all([
    listen<unknown>(INTERVIEW_ASR_STATUS_EVENT, (event) => {
      const normalized = normalizeAsrStatusEvent(event.payload)
      if (normalized) handlers.onStatus?.(normalized)
    }),
    listen<unknown>(INTERVIEW_ASR_TRANSCRIPT_EVENT, (event) => {
      const normalized = normalizeAsrTranscriptEvent(event.payload)
      if (normalized) handlers.onTranscript?.(normalized)
    }),
    listen<unknown>(INTERVIEW_ASR_DIAGNOSTIC_EVENT, (event) => {
      const normalized = normalizeAsrDiagnosticEvent(event.payload)
      if (normalized) handlers.onDiagnostic?.(normalized)
    }),
  ])

  return () => {
    for (const unlisten of unlisteners) unlisten()
  }
}

export function normalizeAsrStatusEvent(payload: unknown): InterviewAsrStatusEvent | null {
  if (!isRecord(payload)) return null
  const sessionId = stringValue(payload.sessionId)
  const status = stringValue(payload.status)
  const level = stringValue(payload.level)
  const message = stringValue(payload.message)
  if (!sessionId || !isAsrStatus(status) || !isLevel(level) || !message) return null
  const source = optionalSource(payload.source)
  if (payload.source !== undefined && !source) return null
  return {
    sessionId,
    streamId: optionalString(payload.streamId),
    source,
    status,
    level,
    message: redactCredentialText(message),
    retryAttempt: optionalNumber(payload.retryAttempt),
    serviceLogId: optionalString(payload.serviceLogId),
    errorCode: optionalString(payload.errorCode),
    createdAt: numberValue(payload.createdAt) ?? Date.now(),
  }
}

export function normalizeAsrTranscriptEvent(payload: unknown): InterviewAsrTranscriptEvent | null {
  if (!isRecord(payload)) return null
  const sessionId = stringValue(payload.sessionId)
  const streamId = stringValue(payload.streamId)
  const source = optionalSource(payload.source)
  const text = stringValue(payload.text).trim()
  const speaker = speakerValue(payload.speaker)
  const state = transcriptStateValue(payload.state)
  if (!sessionId || !streamId || !source || !text || !speaker || !state) return null
  return {
    sessionId,
    streamId,
    source,
    providerSequence: optionalNumber(payload.providerSequence),
    providerUtteranceId: optionalString(payload.providerUtteranceId),
    revisionOf: optionalString(payload.revisionOf),
    text,
    startMs: numberValue(payload.startMs) ?? 0,
    endMs: numberValue(payload.endMs) ?? 0,
    speaker,
    confidence: optionalNumber(payload.confidence) ?? null,
    state,
    definite: payload.definite === true,
    createdAt: numberValue(payload.createdAt) ?? Date.now(),
  }
}

export function normalizeAsrDiagnosticEvent(payload: unknown): InterviewAsrDiagnosticEvent | null {
  if (!isRecord(payload)) return null
  const sessionId = stringValue(payload.sessionId)
  const level = stringValue(payload.level)
  const category = stringValue(payload.category)
  const message = stringValue(payload.message)
  if (!sessionId || !isLevel(level) || !isDiagnosticCategory(category) || !message) return null
  const source = optionalSource(payload.source)
  if (payload.source !== undefined && !source) return null
  return {
    sessionId,
    streamId: optionalString(payload.streamId),
    source,
    level,
    category,
    message: redactCredentialText(message),
    errorCode: optionalString(payload.errorCode),
    serviceLogId: optionalString(payload.serviceLogId),
    retryAttempt: optionalNumber(payload.retryAttempt),
    createdAt: numberValue(payload.createdAt) ?? Date.now(),
  }
}

export function redactCredentialText(text: string): string {
  return text
    .replace(/(x-api-key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(api[_ -]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function optionalSource(value: unknown): AudioSourceKind | undefined {
  return value === "system" || value === "microphone" || value === "file" ? value : undefined
}

function speakerValue(value: unknown): SpeakerLabel | null {
  return value === "interviewer" || value === "interviewee" || value === "unknown" ? value : null
}

function transcriptStateValue(value: unknown): TranscriptUpdateState | null {
  return value === "provisional" || value === "confirmed" ? value : null
}

function isLevel(value: string): value is "info" | "warn" | "error" {
  return value === "info" || value === "warn" || value === "error"
}

function isAsrStatus(value: string): value is InterviewAsrStatusEvent["status"] {
  return (
    value === "connecting" ||
    value === "listening" ||
    value === "degraded" ||
    value === "retrying" ||
    value === "recovered" ||
    value === "finalizing" ||
    value === "stopped" ||
    value === "failed"
  )
}

function isDiagnosticCategory(value: string): value is InterviewAsrDiagnosticEvent["category"] {
  return (
    value === "configuration" ||
    value === "audio" ||
    value === "connectivity" ||
    value === "service" ||
    value === "protocol" ||
    value === "retry" ||
    value === "redaction"
  )
}
