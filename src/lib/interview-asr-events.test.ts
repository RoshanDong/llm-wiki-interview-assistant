import { describe, expect, it } from "vitest"
import {
  normalizeAsrDiagnosticEvent,
  normalizeAsrStatusEvent,
  normalizeAsrTranscriptEvent,
} from "./interview-asr-events"

describe("interview ASR event normalization", () => {
  it("maps provisional and confirmed transcript payloads", () => {
    expect(normalizeAsrTranscriptEvent({
      sessionId: "session-1",
      streamId: "stream-system",
      source: "system",
      text: "临时文本",
      startMs: 0,
      endMs: 500,
      speaker: "interviewer",
      confidence: 0.7,
      state: "provisional",
      definite: false,
      createdAt: 1000,
    })).toMatchObject({
      state: "provisional",
      definite: false,
      source: "system",
    })

    expect(normalizeAsrTranscriptEvent({
      sessionId: "session-1",
      streamId: "stream-system",
      source: "system",
      text: "确认文本",
      startMs: 0,
      endMs: 1000,
      speaker: "interviewer",
      state: "confirmed",
      definite: true,
      createdAt: 1100,
    })).toMatchObject({
      confidence: null,
      state: "confirmed",
      definite: true,
    })
  })

  it("redacts credential-like status and diagnostic messages", () => {
    expect(normalizeAsrStatusEvent({
      sessionId: "session-1",
      status: "retrying",
      level: "warn",
      message: "x-api-key: secret-value failed",
      createdAt: 1000,
    })?.message).toBe("x-api-key: [REDACTED] failed")

    expect(normalizeAsrDiagnosticEvent({
      sessionId: "session-1",
      level: "error",
      category: "service",
      message: "Authorization: Bearer secret-token",
      createdAt: 1000,
    })?.message).toBe("Authorization: Bearer [REDACTED]")
  })

  it("rejects invalid transcript event payloads", () => {
    expect(normalizeAsrTranscriptEvent({
      sessionId: "session-1",
      streamId: "stream-1",
      source: "unknown-source",
      text: "hello",
      speaker: "interviewer",
      state: "confirmed",
    })).toBeNull()
  })
})
