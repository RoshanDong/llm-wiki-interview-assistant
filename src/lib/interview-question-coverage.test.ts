import { describe, expect, it } from "vitest"
import type { DetectedQuestion, ReverseQuestionPhase } from "./interview-types"
import {
  evaluateQuestionCandidates,
  hasSameAnswerGoal,
} from "./interview-question-coverage"
import { genericInterviewProjectProfiles } from "./interview-test-fakes"

function question(overrides: Partial<DetectedQuestion> = {}): DetectedQuestion {
  return {
    id: "q1",
    sessionId: "session-1",
    text: "你在AI方面有哪些实践？用过哪些AI工具？",
    answerGoal: "AI测试实践工具与应用",
    topic: "AI测试实践",
    intent: "工具实践",
    entities: ["AI", "测试", "工具"],
    sourceSegmentIds: ["seg-1"],
    detectedAt: 1000,
    updatedAt: 1000,
    status: "pending",
    queuedAt: 1000,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    attentionReason: null,
    ...overrides,
  }
}

const inactiveReversePhase: ReverseQuestionPhase = {
  state: "inactive",
  startedAt: null,
  triggerSegmentIds: [],
  lastSuppressedAt: null,
  resumeSegmentIds: [],
}

describe("question coverage evaluator", () => {
  it("matches semantically equivalent questions through structured topic and intent", () => {
    expect(hasSameAnswerGoal(
      question({
        text: "讲讲你们之前的一个大概的项目流程是怎么样的？",
        answerGoal: "描述之前团队的项目研发或测试流程",
        topic: "产研项目流程",
        intent: "流程",
      }),
      question({
        id: "q2",
        text: "讲讲你们之前整个产研的项目流程是怎样的？",
        answerGoal: "描述之前团队的产品研发测试全流程",
        topic: "产研项目流程",
        intent: "流程",
      }),
    )).toBe(true)

    expect(hasSameAnswerGoal(
      question({
        text: "搜索质量平台的这个召回方案是怎么测试的？",
        answerGoal: "描述搜索质量平台召回方案的测试方法和流程",
        topic: "搜索质量召回方案",
        intent: "方法",
      }),
      question({
        id: "q3",
        text: "搜索质量平台里的召回率方案，这个方案怎么测？",
        answerGoal: "描述搜索质量平台召回率方案的具体测试方法和流程",
        topic: "搜索质量召回方案",
        intent: "方法",
      }),
    )).toBe(true)
  })

  it("matches same answer goals even when wording differs", () => {
    expect(hasSameAnswerGoal(
      question({ text: "你对AI在测试中的应用有什么了解或实践？" }),
      question({ id: "q2", text: "你在AI方面有哪些实践？用过哪些AI工具？" }),
    )).toBe(true)
  })

  it("keeps same broad topic separate when answer goals differ", () => {
    const result = evaluateQuestionCandidates({
      sessionId: "session-1",
      candidates: [
        question({
          id: "candidate-1",
          text: "AI 在测试中有什么应用？",
          answerGoal: "AI测试应用场景",
          topic: "AI测试应用",
          intent: "工具实践",
        }),
      ],
      existingQuestions: [
        question({
          id: "existing-1",
          text: "你如何治理 AI 模型训练数据？",
          answerGoal: "AI模型训练数据治理",
          topic: "AI模型训练数据",
          intent: "方法",
        }),
      ],
      coverageRecords: [],
      reverseQuestionPhase: inactiveReversePhase,
      now: 2000,
    })

    expect(result.added.map((item) => item.id)).toEqual(["candidate-1"])
    expect(result.outcomes[0]).toMatchObject({ outcome: "added" })
  })

  it("adds routing metadata only for accepted candidates", () => {
    const result = evaluateQuestionCandidates({
      sessionId: "session-1",
      candidates: [
        question({
          id: "candidate-search",
          text: "搜索质量平台你是怎么做测试方案的？",
          answerGoal: "搜索质量平台测试方案",
          topic: "搜索质量平台",
          intent: "方法",
        }),
      ],
      existingQuestions: [],
      coverageRecords: [],
      reverseQuestionPhase: inactiveReversePhase,
      projectProfiles: genericInterviewProjectProfiles,
      now: 2000,
    })

    expect(result.added[0]).toMatchObject({
      questionType: "项目方法方案类",
      projectCategory: "搜索质量平台",
      projectRoutingStatus: "detected",
      answerPromptFamily: "project_method_plan",
      retrievalPolicy: "project_grounded",
    })
    expect(result.coverageRecords[0]).toMatchObject({
      questionType: "项目方法方案类",
      projectCategory: "搜索质量平台",
    })
    expect(result.outcomes[0]).toMatchObject({
      outcome: "added",
      questionType: "项目方法方案类",
      projectCategory: "搜索质量平台",
    })
    expect(result.routingDiagnostics[0]).toMatchObject({
      questionId: "candidate-search",
      answerPromptFamily: "project_method_plan",
    })
  })

  it("keeps same topic separate when intents require different answers", () => {
    const result = evaluateQuestionCandidates({
      sessionId: "session-1",
      candidates: [
        question({
          id: "candidate-monitoring",
          text: "你们如何监控和评估生产环境中真实用户的语音转文本准确率？",
          answerGoal: "生产ASR准确率监控评估",
          topic: "ASR准确率",
          intent: "监控评估",
          entities: ["ASR", "准确率", "生产环境"],
        }),
      ],
      existingQuestions: [
        question({
          id: "existing-impact",
          text: "算法准确率下降对生产环境和用户体验有什么影响？",
          answerGoal: "ASR准确率生产影响",
          topic: "ASR准确率",
          intent: "影响",
          status: "completed",
          completedAt: 3000,
        }),
      ],
      coverageRecords: [],
      reverseQuestionPhase: inactiveReversePhase,
      now: 4000,
    })

    expect(result.added.map((item) => item.id)).toEqual(["candidate-monitoring"])
    expect(result.outcomes[0]).toMatchObject({ outcome: "added" })
  })

  it("refines a pending duplicate in place when the candidate is clearer", () => {
    const result = evaluateQuestionCandidates({
      sessionId: "session-1",
      candidates: [
        question({
          id: "candidate-1",
          text: "你在AI方面有哪些实践？用过哪些AI工具？AI在测试中有什么应用？",
          answerGoal: "AI测试实践工具与应用",
          sourceSegmentIds: ["seg-1", "seg-2", "seg-3"],
        }),
      ],
      existingQuestions: [question({ id: "existing-1" })],
      coverageRecords: [],
      reverseQuestionPhase: inactiveReversePhase,
      now: 2000,
    })

    expect(result.added).toEqual([])
    expect(result.questionUpdates).toEqual([expect.objectContaining({
      questionId: "existing-1",
      patch: expect.objectContaining({
        text: "你在AI方面有哪些实践？用过哪些AI工具？AI在测试中有什么应用？",
        sourceSegmentIds: ["seg-1", "seg-2", "seg-3"],
      }),
    })])
    expect(result.outcomes[0]).toMatchObject({ outcome: "refined_pending" })
    expect(result.questionUpdates[0].patch.questionType).toBe("知识八股类")
  })

  it("skips duplicates of completed questions without restarting answer flow", () => {
    const result = evaluateQuestionCandidates({
      sessionId: "session-1",
      candidates: [question({ id: "candidate-1" })],
      existingQuestions: [question({ id: "existing-1", status: "completed", completedAt: 3000 })],
      coverageRecords: [],
      reverseQuestionPhase: inactiveReversePhase,
      now: 4000,
    })

    expect(result.added).toEqual([])
    expect(result.questionUpdates).toEqual([])
    expect(result.outcomes[0]).toMatchObject({
      outcome: "skipped_duplicate",
      questionId: "existing-1",
    })
    expect(result.outcomes[0].questionType).toBeUndefined()
  })

  it("suppresses candidate role questions during reverse-question phase", () => {
    const result = evaluateQuestionCandidates({
      sessionId: "session-1",
      candidates: [
        question({
          id: "candidate-role",
          text: "这个AI测试开发岗位的具体工作内容是什么？",
          answerGoal: "AI测试开发岗位工作内容",
        }),
      ],
      existingQuestions: [],
      coverageRecords: [],
      reverseQuestionPhase: { ...inactiveReversePhase, state: "active", startedAt: 1000 },
      conversationPhase: "reverse_question",
      now: 2000,
    })

    expect(result.added).toEqual([])
    expect(result.outcomes[0]).toMatchObject({
      outcome: "suppressed_reverse_question",
      questionId: null,
    })
    expect(result.outcomes[0].questionType).toBeUndefined()
    expect(result.reversePhaseUpdate).toMatchObject({
      state: "active",
      lastSuppressedAt: 2000,
    })
  })
})
