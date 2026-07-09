import { describe, expect, it } from "vitest"
import type { TranscriptSegment } from "@/lib/interview-types"
import {
  getTranscriptPrimaryProjectStateItem,
  getTranscriptStreamItems,
} from "./transcript-stream"

function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "seg-1",
    sessionId: "session-1",
    speaker: "interviewer",
    text: "Can you introduce yourself?",
    startMs: 1500,
    endMs: 2600,
    confidence: 0.9,
    source: "microphone",
    createdAt: 3000,
    ...overrides,
  }
}

describe("transcript stream model", () => {
  it("formats timestamped speaker-labeled transcript items", () => {
    expect(getTranscriptStreamItems([segment()])).toEqual([{
      id: "seg-1",
      timestamp: "00:01",
      speakerKey: "interview.speaker.interviewer",
      sourceKey: "interview.audio.microphone",
      asrLatency: "-",
      text: "Can you introduce yourself?",
    }])
  })

  it("keeps empty transcript state explicit", () => {
    expect(getTranscriptStreamItems([])).toEqual([])
  })

  it("hides provisional transcript updates from the transcript view", () => {
    expect(getTranscriptStreamItems([segment({
      id: "prov-1",
      state: "provisional",
      definite: false,
      text: "Can you",
    })])).toEqual([])
  })

  it("formats ASR latency for confirmed items", () => {
    expect(getTranscriptStreamItems([segment({ asrLatencyMs: 850 })])[0]).toMatchObject({
      asrLatency: "850 ms",
    })
  })

  it("formats primary project state for transcript debugging", () => {
    expect(getTranscriptPrimaryProjectStateItem({
      currentProject: "搜索质量平台",
      status: "active",
      updatedAt: 2000,
      sourceQuestionId: "q1",
      reason: "continued previous project",
    })).toEqual({
      projectLabel: "搜索质量平台",
      statusKey: "interview.primaryProjectStatus.active",
      detailLabel: "continued previous project · question=q1",
    })

    expect(getTranscriptPrimaryProjectStateItem()).toMatchObject({
      projectLabel: "-",
      statusKey: "interview.primaryProjectStatus.empty",
    })
  })
})
