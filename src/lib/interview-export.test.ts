import { describe, expect, it, vi } from "vitest"
import { createInitialInterviewSession } from "@/stores/interview-store"
import type { AnswerRequest, DetectedQuestion, StatusEvent, TranscriptSegment } from "./interview-types"
import {
  buildInterviewMarkdownExport,
  DEFAULT_INTERVIEW_EXPORT_DIR,
  defaultInterviewExportFileName,
  defaultInterviewExportPath,
  saveInterviewMarkdownExport,
} from "./interview-export"

const fsMocks = vi.hoisted(() => ({
  writeFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  writeFile: fsMocks.writeFile,
}))

function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "seg-1",
    sessionId: "session-1",
    streamId: "stream-system",
    speaker: "interviewer",
    text: "Can you explain your cache strategy?",
    startMs: 1500,
    endMs: 2600,
    confidence: 0.92,
    source: "system",
    state: "confirmed",
    definite: true,
    asrLatencyMs: 420,
    createdAt: 3200,
    ...overrides,
  }
}

function question(overrides: Partial<DetectedQuestion> = {}): DetectedQuestion {
  return {
    id: "q1",
    sessionId: "session-1",
    text: "Can you explain your cache strategy?",
    sourceSegmentIds: ["seg-1"],
    detectedAt: 3000,
    status: "completed",
    queuedAt: 3000,
    startedAt: 3100,
    completedAt: 5000,
    canceledAt: null,
    attentionReason: null,
    ...overrides,
  }
}

function answer(overrides: Partial<AnswerRequest> = {}): AnswerRequest {
  return {
    id: "answer-1",
    questionId: "q1",
    conversationId: "conv-1",
    submittedPrompt: "Answer this: cache strategy?",
    assistantMessageContent: "Use write-through for consistency and cache-aside for hot reads.",
    status: "completed",
    submittedAt: 3100,
    completedAt: 5000,
    canceledAt: null,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  }
}

function statusEvent(overrides: Partial<StatusEvent> = {}): StatusEvent {
  return {
    id: "status-1",
    sessionId: "session-1",
    kind: "question",
    message: "Stable questions emitted (asr 420ms, wait 1000ms, llm 850ms, stable 700ms, total 2950ms)",
    level: "info",
    createdAt: 6200,
    details: {
      runId: "semantic-detection-1",
      contextVersion: 3,
      segmentCount: 4,
      asrLatencyMs: 420,
      confirmedToRunMs: 1000,
      llmDetectionMs: 850,
      stabilizationWaitMs: 700,
      runToEmitMs: 1550,
      confirmedToEmitMs: 2950,
    },
    ...overrides,
  }
}

describe("interview markdown export", () => {
  it("exports confirmed transcript, questions, and LLM Wiki answer content", () => {
    const session = {
      ...createInitialInterviewSession(1000),
      id: "session-1",
      mode: "debug" as const,
      status: "ended" as const,
      startedAt: 1000,
      endedAt: 6000,
      transcriptSegments: [
        segment(),
        segment({
          id: "prov-1",
          text: "Can you",
          state: "provisional",
          definite: false,
        }),
      ],
      questions: [question()],
    }

    const markdown = buildInterviewMarkdownExport({
      session,
      answerRequests: [answer()],
      exportedAt: 7000,
    })

    expect(markdown).toContain("# Interview Export")
    expect(markdown).toContain("Can you explain your cache strategy?")
    expect(markdown).toContain("- ASR latency: 420 ms")
    expect(markdown).toContain("- Received: 1970-01-01T00:00:03.200Z")
    expect(markdown).toContain("## Primary Project Timeline")
    expect(markdown).toContain("Answer this: cache strategy?")
    expect(markdown).toContain("Use write-through for consistency")
    expect(markdown).not.toContain("Can you\n")
  })

  it("exports semantic detection test metrics from status events", () => {
    const session = { ...createInitialInterviewSession(1000), id: "session-1" }

    const markdown = buildInterviewMarkdownExport({
      session,
      answerRequests: [],
      statusEvents: [
        statusEvent(),
        statusEvent({
          id: "status-2",
          message: "Question detection skipped: turn incomplete",
          details: {
            runId: "semantic-detection-2",
            contextVersion: 4,
            segmentCount: 5,
            confirmedToRunMs: 1200,
            llmDetectionMs: 600,
            reason: "awaiting confirmation",
          },
        }),
        statusEvent({
          id: "status-chat",
          kind: "chat",
          message: "Answer prompt completed",
          details: { questionId: "q1" },
        }),
      ],
      exportedAt: 7000,
    })

    expect(markdown).toContain("## Test Metrics")
    expect(markdown).toContain("| Time | Event | Run | Context | Segments | ASR | Wait | LLM | Stable | Run to emit | Total | Notes |")
    expect(markdown).toContain("| 1970-01-01T00:00:06.200Z | stable emitted | semantic-detection-1 | 3 | 4 | 420 ms | 1.0 s | 850 ms | 700 ms | 1.6 s | 3.0 s | - |")
    expect(markdown).toContain("| 1970-01-01T00:00:06.200Z | turn incomplete | semantic-detection-2 | 4 | 5 | - | 1.2 s | 600 ms | - | - | - | awaiting confirmation |")
    expect(markdown).not.toContain("Answer prompt completed")
  })

  it("exports live audio capture capability diagnostics", () => {
    const session = { ...createInitialInterviewSession(1000), id: "session-1" }

    const markdown = buildInterviewMarkdownExport({
      session,
      answerRequests: [],
      statusEvents: [
        statusEvent({
          id: "audio-capture",
          kind: "audio",
          level: "error",
          message: "Audio capture capability check failed",
          details: {
            audioCaptureCapabilityCheck: true,
            requiredAudioSources: "system,microphone",
            microphoneAvailable: false,
            microphoneReason: "navigator.mediaDevices.getUserMedia is unavailable.",
            systemAvailable: false,
            systemReason: "navigator.mediaDevices.getDisplayMedia is unavailable.",
          },
        }),
      ],
      exportedAt: 7000,
    })

    expect(markdown).toContain("## Audio Capture Capability")
    expect(markdown).toContain("- Required sources: system,microphone")
    expect(markdown).toContain("- Result: failed")
    expect(markdown).toContain("Microphone: unavailable")
    expect(markdown).toContain("getUserMedia is unavailable")
    expect(markdown).toContain("System audio: unavailable")
    expect(markdown).toContain("getDisplayMedia is unavailable")
  })

  it("exports candidate outcomes and non-secret queue timing metrics", () => {
    const session = {
      ...createInitialInterviewSession(1000),
      id: "session-1",
      queueCandidateOutcomes: [{
        outcomeId: "outcome-1",
        candidateId: "candidate-1",
        outcome: "suppressed_reverse_question" as const,
        questionId: null,
        questionText: "这个岗位做什么？",
        answerGoal: "岗位工作内容",
        sourceSegmentIds: ["seg-1"],
        reason: "candidate reverse question during reverse-question phase",
        createdAt: 6500,
      }],
    }

    const markdown = buildInterviewMarkdownExport({
      session,
      answerRequests: [],
      statusEvents: [
        statusEvent({
          id: "queue-submit",
          kind: "queue",
          message: "Question submitted for answer",
          details: { questionId: "q1", queueWaitMs: 1200 },
        }),
      ],
      exportedAt: 7000,
    })

    expect(markdown).toContain("answer submitted")
    expect(markdown).toContain("1.2 s")
    expect(markdown).toContain("| Time | Outcome | Candidate | Question | Answer goal | Question type | Project | Routing | Prompt family | Retrieval | Topic | Intent | Reason |")
    expect(markdown).toContain("suppressed_reverse_question")
    expect(markdown).toContain("岗位工作内容")
    expect(markdown).not.toContain("Access Token")
  })

  it("exports routing diagnostics for accepted questions and answer requests", () => {
    const routedQuestion = question({
      answerGoal: "召回率指标口径",
      questionType: "项目细节深挖类",
      projectCategory: "搜索质量平台",
      projectRoutingStatus: "inherited",
      projectRoutingReason: "continued previous project",
      answerPromptFamily: "project_detail_deep_dive",
      retrievalPolicy: "project_grounded",
    })
    const session = {
      ...createInitialInterviewSession(1000),
      id: "session-1",
      questions: [routedQuestion],
      routingDiagnostics: [{
        questionId: routedQuestion.id,
        questionType: "项目细节深挖类" as const,
        projectCategory: "搜索质量平台" as const,
        projectRoutingStatus: "inherited" as const,
        answerPromptFamily: "project_detail_deep_dive" as const,
        retrievalPolicy: "project_grounded" as const,
        routingSource: "profile_score" as const,
        reason: "continued previous project",
        createdAt: 3000,
        projectScores: [{
          project: "搜索质量平台" as const,
          score: 14,
          matchedStrongTerms: ["搜索质量平台", "召回率"],
          matchedWeakTerms: ["检索"],
          matchedTechnicalTerms: ["rerank"],
          matchedNegativeTerms: [],
          matchedStrongCombos: ["搜索 + 召回率"],
        }],
      }],
      queueCandidateOutcomes: [{
        outcomeId: "outcome-1",
        candidateId: "candidate-1",
        outcome: "added" as const,
        questionId: "q1",
        questionText: routedQuestion.text,
        answerGoal: "召回率指标口径",
        sourceSegmentIds: ["seg-1"],
        reason: "new answer goal accepted",
        createdAt: 3000,
        questionType: "项目细节深挖类" as const,
        projectCategory: "搜索质量平台" as const,
        projectRoutingStatus: "inherited" as const,
        answerPromptFamily: "project_detail_deep_dive" as const,
        retrievalPolicy: "project_grounded" as const,
      }],
    }

    const markdown = buildInterviewMarkdownExport({
      session,
      answerRequests: [answer({
        questionType: "项目细节深挖类",
        projectCategory: "搜索质量平台",
        answerPromptFamily: "project_detail_deep_dive",
        retrievalPolicy: "project_grounded",
      })],
      exportedAt: 7000,
    })

    expect(markdown).toContain("- Question type: 项目细节深挖类")
    expect(markdown).toContain("- Project category: 搜索质量平台")
    expect(markdown).toContain("- Project routing status: inherited")
    expect(markdown).toContain("- Answer prompt family: project_detail_deep_dive")
    expect(markdown).toContain("- Retrieval policy: project_grounded")
    expect(markdown).toContain("continued previous project")
    expect(markdown).toContain("## Primary Project Timeline")
    expect(markdown).toContain("## Project Routing Diagnostics")
    expect(markdown).toContain("搜索质量平台:14")
    expect(markdown).toContain("搜索质量平台, 召回率")
    expect(markdown).toContain("搜索 + 召回率")
    expect(markdown).toContain("| 1970-01-01T00:00:03.000Z | 召回率指标口径 | 搜索质量平台 | inherited | continued previous project |")
    expect(markdown).not.toContain("sk-")
  })

  it("orders debug-file transcript by receive time and keeps audio timeline visible", () => {
    const session = {
      ...createInitialInterviewSession(1000),
      id: "session-1",
      mode: "debug" as const,
      transcriptSegments: [
        segment({
          id: "late-low-timeline",
          text: "late ASR result with low audio timeline",
          startMs: 0,
          endMs: 1_000,
          createdAt: 5_000,
          audioStartMs: 0,
          audioEndMs: 1_000,
        }),
        segment({
          id: "early-higher-timeline",
          text: "early ASR result with higher audio timeline",
          startMs: 10_000,
          endMs: 11_000,
          createdAt: 2_000,
          audioStartMs: 10_000,
          audioEndMs: 11_000,
        }),
      ],
    }

    const markdown = buildInterviewMarkdownExport({
      session,
      answerRequests: [],
      exportedAt: 7000,
    })

    expect(markdown.indexOf("early ASR result with higher audio timeline")).toBeLessThan(
      markdown.indexOf("late ASR result with low audio timeline"),
    )
    expect(markdown).toContain("- Audio timeline: 00:10-00:11")
    expect(markdown).toContain("- Audio timeline: 00:00-00:01")
  })

  it("exports debug-file audio timing separately from ASR latency", () => {
    const session = {
      ...createInitialInterviewSession(1000),
      id: "session-1",
      mode: "debug" as const,
      transcriptSegments: [segment({
        asrLatencyMs: null,
        audioStartMs: 120_000,
        audioEndMs: 121_500,
        segmentDurationMs: 1500,
        recognitionProcessingMs: 800,
      })],
    }

    const markdown = buildInterviewMarkdownExport({
      session,
      answerRequests: [],
      exportedAt: 7000,
    })

    expect(markdown).toContain("- ASR latency: -")
    expect(markdown).toContain("- Audio timeline: 02:00-02:01")
    expect(markdown).toContain("- Segment duration: 1.5 s")
    expect(markdown).toContain("- Recognition processing: 800 ms")
  })

  it("builds markdown filenames from the session id and export timestamp", () => {
    const session = { ...createInitialInterviewSession(1000), id: "session-1" }

    expect(defaultInterviewExportFileName(session, 0)).toBe("interview-session-1-1970-01-01T00-00-00-000Z.md")
  })

  it("builds the default export path under the configured exports directory", () => {
    const session = { ...createInitialInterviewSession(1000), id: "session-1" }

    expect(defaultInterviewExportPath({ session, answerRequests: [], exportedAt: 0 })).toBe(
      `${DEFAULT_INTERVIEW_EXPORT_DIR}/interview-session-1-1970-01-01T00-00-00-000Z.md`,
    )
  })

  it("writes markdown to the default export path", async () => {
    const session = { ...createInitialInterviewSession(1000), id: "session-1" }
    const writeFile = vi.fn(async () => undefined)

    const path = await saveInterviewMarkdownExport(
      { session, answerRequests: [], exportedAt: 0 },
      { writeFile },
    )

    expect(path).toBe(`${DEFAULT_INTERVIEW_EXPORT_DIR}/interview-session-1-1970-01-01T00-00-00-000Z.md`)
    expect(writeFile).toHaveBeenCalledWith(path, expect.stringContaining("# Interview Export"))
  })
})
