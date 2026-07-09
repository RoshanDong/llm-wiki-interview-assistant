import { describe, expect, it } from "vitest"
import type { DetectedQuestion } from "@/lib/interview-types"
import { getQuestionQueueItems } from "./question-queue"

function question(overrides: Partial<DetectedQuestion> = {}): DetectedQuestion {
  return {
    id: "q1",
    sessionId: "session-1",
    text: "How did you improve retrieval quality?",
    sourceSegmentIds: ["seg-1"],
    detectedAt: 1000,
    status: "answering",
    queuedAt: 1000,
    startedAt: 1200,
    completedAt: null,
    canceledAt: null,
    attentionReason: null,
    ...overrides,
  }
}

describe("question queue model", () => {
  it("shows status and derived waiting time without answer content", () => {
    const items = getQuestionQueueItems([question()], 3500)

    expect(items).toEqual([{
      id: "q1",
      text: "How did you improve retrieval quality?",
      statusKey: "interview.questionStatus.answering",
      clarificationKey: null,
      questionType: null,
      projectCategory: null,
      answerPromptFamily: null,
      sourceCount: 1,
      waitingLabel: "00:02",
    }])
    expect(JSON.stringify(items)).not.toContain("generated answer")
  })

  it("exposes compact routing labels for queued questions", () => {
    const items = getQuestionQueueItems([question({
      questionType: "项目方法方案类",
      projectCategory: "搜索质量平台",
      answerPromptFamily: "project_method_plan",
    })], 3500)

    expect(items[0]).toMatchObject({
      questionType: "项目方法方案类",
      projectCategory: "搜索质量平台",
      answerPromptFamily: "project_method_plan",
    })
  })
})
