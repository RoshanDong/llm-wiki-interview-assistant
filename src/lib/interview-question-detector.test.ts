import { describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type { TranscriptSegment } from "./interview-types"
import {
  buildInterviewQuestionDetectionMessages,
  HeuristicQuestionDetector,
  LlmQuestionDetector,
  parseLlmQuestionDetectionResult,
} from "./interview-question-detector"
import { genericInterviewProjectProfiles } from "./interview-test-fakes"

function segment(
  text: string,
  speaker: TranscriptSegment["speaker"] = "interviewer",
  source: TranscriptSegment["source"] = "system",
  overrides: Partial<TranscriptSegment> = {},
): TranscriptSegment {
  return {
    id: `seg-${text.slice(0, 4)}`,
    sessionId: "session-1",
    streamId: `stream-${source}`,
    speaker,
    text,
    startMs: 0,
    endMs: 1000,
    confidence: 0.9,
    source,
    state: "confirmed",
    definite: true,
    createdAt: 1000,
    ...overrides,
  }
}

const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: "",
  model: "semantic-question-detector",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "http://localhost:1234/v1",
  maxContextSize: 128000,
}

describe("heuristic interview question detector", () => {
  it("detects concrete interviewer questions", async () => {
    const detector = new HeuristicQuestionDetector()

    const result = await detector.detect({
      recentSegments: [segment("Can you introduce one project you are proud of?")],
      existingQuestionTexts: [],
    }, new AbortController().signal)

    expect(result.questions[0]).toMatchObject({
      text: "Can you introduce one project you are proud of?",
      sourceSegmentIds: expect.any(Array),
    })
  })

  it("ignores non-questions and interviewee speech", async () => {
    const detector = new HeuristicQuestionDetector()

    await expect(detector.detect({
      recentSegments: [segment("I worked on the search pipeline.", "interviewee")],
      existingQuestionTexts: [],
    }, new AbortController().signal)).resolves.toMatchObject({ turnComplete: true, questions: [] })

    await expect(detector.detect({
      recentSegments: [segment("That sounds good.", "interviewer")],
      existingQuestionTexts: [],
    }, new AbortController().signal)).resolves.toMatchObject({ turnComplete: true, questions: [] })
  })

  it("suppresses duplicate questions", async () => {
    const detector = new HeuristicQuestionDetector()

    const result = await detector.detect({
      recentSegments: [segment("What is your strongest project?")],
      existingQuestionTexts: ["what is your strongest project"],
    }, new AbortController().signal)

    expect(result.questions).toEqual([])
  })

  it("keeps compound questions together when they share context", async () => {
    const detector = new HeuristicQuestionDetector()
    const text = "What was the situation, and how did you measure the result?"

    const result = await detector.detect({
      recentSegments: [segment(text)],
      existingQuestionTexts: [],
    }, new AbortController().signal)

    expect(result.questions.map((item) => item.text)).toEqual([text])
  })

  it("uses confirmed candidate clarification plus interviewer confirmation to refine a question", async () => {
    const detector = new HeuristicQuestionDetector()

    const result = await detector.detect({
      recentSegments: [
        segment("讲一下保障方案。", "interviewer", "system"),
        segment("是说针对缓存一致性的保障方案吗？", "interviewee", "microphone"),
        segment("对。", "interviewer", "system"),
      ],
      existingQuestionTexts: [],
    }, new AbortController().signal)

    expect(result.questions).toContainEqual(expect.objectContaining({
      text: "针对缓存一致性的保障方案吗",
      sourceSegmentIds: expect.arrayContaining(["seg-讲一下保", "seg-是说针对", "seg-对。"]),
      clarificationState: "confirmed",
      refinementOfSegmentId: "seg-讲一下保",
    }))
  })
})

describe("LLM interview question detector", () => {
  it("builds a prompt that asks the model to ignore speaker labels and small confirmation questions", () => {
    const messages = buildInterviewQuestionDetectionMessages({
      recentSegments: [
        segment("那讲讲你们之前的一个大概的一个项目流程怎么样的？", "unknown", "file", { id: "seg-flow-1" }),
      ],
      existingQuestionTexts: ["已有问题"],
    })

    expect(messages[0].content).toContain("不要依赖 speaker")
    expect(messages[0].content).toContain("turnComplete")
    expect(messages[0].content).toContain("conversationPhase")
    expect(messages[0].content).toContain("answerGoal")
    expect(messages[0].content).toContain("topic")
    expect(messages[0].content).toContain("intent")
    expect(messages[0].content).toContain("entities")
    expect(messages[0].content).toContain("questionType")
    expect(messages[0].content).toContain("projectCategory")
    expect(messages[0].content).toContain("当前没有配置项目画像")
    expect(messages[0].content).not.toContain("项目路由线索")
    expect(messages[1].content).toContain("currentProjectContext")
    expect(messages[0].content).toContain("canonical topic")
    expect(messages[0].content).toContain("topic + intent")
    expect(messages[0].content).toContain("不要以“描述/说明/介绍/讲解/回答”开头")
    expect(messages[0].content).toContain("质疑式追问")
    expect(messages[0].content).toContain("忽略细小确认")
    expect(messages[1].content).toContain("seg-flow-1")
    expect(messages[1].content).toContain("已有问题")
  })

  it("includes only configured project profiles in the detector prompt", () => {
    const messages = buildInterviewQuestionDetectionMessages({
      recentSegments: [
        segment("搜索质量平台里的召回率怎么保障？", "unknown", "file", { id: "seg-search-1" }),
      ],
      existingQuestionTexts: [],
      projectProfiles: genericInterviewProjectProfiles,
    })

    expect(messages[0].content).toContain("只能从这些值中选择：搜索质量平台、支付风控测试平台、推荐评估系统")
    expect(messages[0].content).toContain("项目路由线索")
    expect(messages[0].content).toContain("搜索质量平台")
    expect(messages[0].content).toContain("召回率")
  })

  it("extracts semantic technical questions from unknown speaker dialogue", async () => {
    const streamChatMock = vi.fn(async (_cfg, messages, callbacks) => {
      expect(messages[0].content).toContain("技术问题、项目问题")
      callbacks.onToken(JSON.stringify({
        turnComplete: true,
        turnReason: "问题已完整",
        questions: [{
          text: "产研的一个项目流程是怎样的？测试的流程是什么？",
          answerGoal: "产研项目流程和测试流程",
          topic: "产研项目测试流程",
          intent: "流程",
          entities: ["产研", "项目流程", "测试流程"],
          sourceSegmentIds: ["seg-flow-1", "seg-flow-2", "seg-flow-3", "seg-flow-4"],
          confidence: 0.92,
        }],
      }))
      callbacks.onDone()
    }) as unknown as typeof import("./llm-client").streamChat
    const detector = new LlmQuestionDetector({ llmConfig, streamChat: streamChatMock })

    const result = await detector.detect({
      recentSegments: [
        segment("那讲讲你们之前的一个大概的一个项目流程怎么样的？", "unknown", "file", { id: "seg-flow-1" }),
        segment("项目流程是指什么什么项目流程？测试的项目流程吗？", "unknown", "file", { id: "seg-flow-2" }),
        segment("项目流程，项目就包括产品研发测试。", "unknown", "file", { id: "seg-flow-3" }),
        segment("就整个你的产研的一个项目流程是怎样的？", "unknown", "file", { id: "seg-flow-4" }),
      ],
      existingQuestionTexts: [],
    }, new AbortController().signal)

    expect(result.questions).toEqual([{
      text: "产研的一个项目流程是怎样的？测试的流程是什么？",
      answerGoal: "产研项目流程和测试流程",
      topic: "产研项目测试流程",
      intent: "流程",
      entities: ["产研", "项目流程", "测试流程"],
      sourceSegmentIds: ["seg-flow-1", "seg-flow-2", "seg-flow-3", "seg-flow-4"],
      confidence: 0.92,
    }])
    expect(result.conversationPhase).toBe("normal_interview")
  })

  it("accepts merged multi-part questions and suppresses duplicates returned by the model", async () => {
    const streamChatMock = vi.fn(async (_cfg, _messages, callbacks) => {
      callbacks.onToken(JSON.stringify({
        turnComplete: true,
        turnReason: "问题已完整",
        questions: [
          {
            text: "你有AI实践的情况吗？用过哪些AI工具？AI 在测试中有什么应用吗？",
            answerGoal: "AI测试实践工具与应用",
            sourceSegmentIds: ["seg-ai-1", "seg-ai-2", "seg-ai-3", "seg-ai-4"],
            confidence: 0.88,
          },
          {
            text: "已有问题？",
            sourceSegmentIds: ["seg-ai-1"],
            confidence: 0.7,
          },
        ],
      }))
      callbacks.onDone()
    }) as unknown as typeof import("./llm-client").streamChat
    const detector = new LlmQuestionDetector({ llmConfig, streamChat: streamChatMock })

    const result = await detector.detect({
      recentSegments: [
        segment("AI 这一块能讲讲你的了解和实践情况吗？", "unknown", "file", { id: "seg-ai-1" }),
        segment("AI 是指什么？比方说 Web coding 这些吗？", "unknown", "file", { id: "seg-ai-2" }),
        segment("就是我用过哪些工具还是什么？", "unknown", "file", { id: "seg-ai-3" }),
        segment("就是你对 AI 在测试中的一个应用。", "unknown", "file", { id: "seg-ai-4" }),
      ],
      existingQuestionTexts: ["已有问题"],
    }, new AbortController().signal)

    expect(result.questions.map((question) => question.text)).toEqual([
      "你有AI实践的情况吗？用过哪些AI工具？AI 在测试中有什么应用吗？",
    ])
  })

  it("parses JSON from code fences and ignores invalid source ids", () => {
    const result = parseLlmQuestionDetectionResult(
      [
        "```json",
        JSON.stringify({
          turnComplete: true,
          turnReason: "已完成",
          questions: [
            {
              text: "搜索质量平台里的召回率方案是如何测试的？",
              answerGoal: "召回率方案测试",
              topic: "召回率方案",
              intent: "方法",
              entities: ["搜索质量平台", "召回率", "测试"],
              sourceSegmentIds: ["seg-asr-1", "missing"],
              confidence: 2,
            },
            {
              text: "无来源问题",
              sourceSegmentIds: ["missing"],
            },
          ],
        }),
        "```",
      ].join("\n"),
      new Set(["seg-asr-1"]),
    )

    expect(result.questions).toEqual([{
      text: "搜索质量平台里的召回率方案是如何测试的？",
      answerGoal: "召回率方案测试",
      topic: "召回率方案",
      intent: "方法",
      entities: ["搜索质量平台", "召回率", "测试"],
      sourceSegmentIds: ["seg-asr-1"],
      confidence: 1,
    }])
  })

  it("parses valid routing hints and drops invalid taxonomy values", () => {
    const result = parseLlmQuestionDetectionResult(
      JSON.stringify({
        turnComplete: true,
        questions: [
          {
            text: "搜索质量平台你是怎么做的？",
            answerGoal: "搜索质量平台方案",
            sourceSegmentIds: ["seg-asr"],
            questionType: "项目方法方案类",
            projectCategory: "搜索质量平台",
            routingReason: "命中搜索项目",
          },
          {
            text: "未知项目怎么做？",
            answerGoal: "未知项目方案",
            sourceSegmentIds: ["seg-unknown"],
            questionType: "不存在类型",
            projectCategory: "不存在项目",
          },
        ],
      }),
      new Set(["seg-asr", "seg-unknown"]),
      undefined,
      genericInterviewProjectProfiles,
    )

    expect(result.questions[0]).toMatchObject({
      questionType: "项目方法方案类",
      projectCategory: "搜索质量平台",
      routingReason: "命中搜索项目",
    })
    expect(result.questions[1]).not.toHaveProperty("questionType")
    expect(result.questions[1]).not.toHaveProperty("projectCategory")
  })

  it("cleans verbose answer goals without domain-specific topic mapping", () => {
    const result = parseLlmQuestionDetectionResult(
      JSON.stringify({
        turnComplete: true,
        questions: [
          {
            text: "讲讲你们之前整个产研的项目流程是怎样的？",
            answerGoal: "描述之前团队的产品研发测试全流程",
            sourceSegmentIds: ["seg-flow"],
          },
          {
            text: "搜索质量平台里的召回率方案怎么测？",
            answerGoal: "描述搜索质量平台召回率方案的具体测试方法和流程",
            sourceSegmentIds: ["seg-asr"],
          },
        ],
      }),
      new Set(["seg-flow", "seg-asr"]),
    )

    expect(result.questions.map((question) => question.answerGoal)).toEqual([
      "产品研发测试流程",
      "搜索质量平台召回率方案测试流程",
    ])
  })

  it("returns no questions when the model marks the current semantic turn incomplete", () => {
    const result = parseLlmQuestionDetectionResult(
      JSON.stringify({
        turnComplete: false,
        turnReason: "等待面试官确认",
        questions: [{
          text: "不应输出的问题？",
          sourceSegmentIds: ["seg-1"],
        }],
      }),
      new Set(["seg-1"]),
      7,
    )

    expect(result).toMatchObject({
      contextVersion: 7,
      turnComplete: false,
      conversationPhase: "normal_interview",
      turnReason: "等待面试官确认",
      questions: [],
    })
  })

  it("parses reverse-question and resumed-evaluation conversation phases", () => {
    expect(parseLlmQuestionDetectionResult(
      JSON.stringify({
        turnComplete: true,
        conversationPhase: "reverse_question",
        questions: [{
          text: "这个岗位的工作内容是什么？",
          answerGoal: "岗位工作内容",
          sourceSegmentIds: ["seg-1"],
        }],
      }),
      new Set(["seg-1"]),
    )).toMatchObject({
      conversationPhase: "reverse_question",
      questions: [expect.objectContaining({ answerGoal: "岗位工作内容" })],
    })

    expect(parseLlmQuestionDetectionResult(
      JSON.stringify({
        turnComplete: true,
        conversationPhase: "resumed_evaluation",
        questions: [],
      }),
      new Set(["seg-1"]),
    )).toMatchObject({
      conversationPhase: "resumed_evaluation",
      questions: [],
    })
  })

  it("returns no questions for malformed model output", () => {
    expect(parseLlmQuestionDetectionResult("not json", new Set(["seg-1"]))).toMatchObject({
      turnComplete: true,
      questions: [],
    })
  })
})
