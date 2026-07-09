import { describe, expect, it } from "vitest"
import type { InterviewAssistantState } from "@/lib/interview-types"
import { getInterviewViewModel } from "./interview-view"

function state(overrides: Partial<InterviewAssistantState> = {}): InterviewAssistantState {
  return {
    preparationStatus: "idle",
    sessionStatus: "idle",
    selectedAudioSource: null,
    mode: null,
    streamingStatus: null,
    audioStreams: [],
    provisionalTranscriptSegments: [],
    diagnostics: [],
    transcriptSegments: [],
    questions: [],
    activeQuestionId: null,
    queueLength: 0,
    statusEvents: [],
    fullStatusEvents: [],
    startInterviewEnabled: false,
    endInterviewEnabled: false,
    ...overrides,
  }
}

describe("interview view model", () => {
  it("allows Start Interview without a preparation step when controls enable it", () => {
    expect(getInterviewViewModel(state()).startDisabled).toBe(true)
    expect(getInterviewViewModel(state({
      startInterviewEnabled: false,
    })).startDisabled).toBe(true)
    expect(getInterviewViewModel(state({
      selectedAudioSource: {
        kind: "microphone",
        label: "Built-in microphone",
        fileName: null,
        selectedAt: 1000,
      },
      startInterviewEnabled: true,
    })).startDisabled).toBe(false)
  })

  it("does not expose generated answer content in the view model", () => {
    const unsafeState = {
      ...state(),
      generatedAnswerContent: "secret generated answer",
    } as InterviewAssistantState

    expect(JSON.stringify(getInterviewViewModel(unsafeState))).not.toContain("secret generated answer")
  })

  it("summarizes the live monitoring state for active interviews", () => {
    const model = getInterviewViewModel(state({
      sessionStatus: "listening",
      queueLength: 2,
      startInterviewEnabled: false,
      endInterviewEnabled: true,
    }))

    expect(model.statusKey).toBe("interview.status.listening")
    expect(model.startDisabled).toBe(true)
    expect(model.endDisabled).toBe(false)
  })

  it("requires a reset before starting a new interview after End Interview", () => {
    const model = getInterviewViewModel(state({
      sessionStatus: "ended",
      startInterviewEnabled: false,
      endInterviewEnabled: false,
    }))

    expect(model.statusKey).toBe("interview.status.ended")
    expect(model.startDisabled).toBe(true)
    expect(model.endDisabled).toBe(true)
    expect(model.resetVisible).toBe(true)
  })
})
