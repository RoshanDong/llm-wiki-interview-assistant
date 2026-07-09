import { describe, expect, it } from "vitest"
import {
  createFakeDetectedQuestion,
  genericInterviewProjectProfiles,
  interviewPromptRoutingFixtures,
} from "./interview-test-fakes"
import {
  createEmptyPrimaryProjectState,
  detectProjectCategory,
  inferQuestionType,
  routeInterviewQuestion,
} from "./interview-prompt-routing"

describe("interview prompt routing", () => {
  it("classifies the five interview question types and allowed projects", () => {
    for (const fixture of interviewPromptRoutingFixtures) {
      const question = createFakeDetectedQuestion({
        id: `q-${fixture.expectedType}`,
        text: fixture.text,
        answerGoal: fixture.text,
      })

      expect(inferQuestionType(question)).toBe(fixture.expectedType)
      expect(detectProjectCategory(question, genericInterviewProjectProfiles)).toBe(fixture.expectedProject)
    }
  })

  it("does not route to any project when no project profiles are configured", () => {
    const question = createFakeDetectedQuestion({
      text: "搜索质量平台里召回率怎么保障？",
      topic: "搜索质量召回率",
      entities: ["搜索质量平台", "召回率"],
    })

    expect(detectProjectCategory(question)).toBeUndefined()
    expect(routeInterviewQuestion({
      question,
      primaryProjectState: createEmptyPrimaryProjectState(),
      now: 2000,
    }).fields.projectRoutingStatus).toBe("none")
  })

  it("rejects invalid project and question type hints", () => {
    const routed = routeInterviewQuestion({
      question: createFakeDetectedQuestion({
        text: "未知项目你们是怎么做质量保障的？",
        questionType: "不存在类型" as never,
        projectCategory: "不存在项目" as never,
      }),
      primaryProjectState: createEmptyPrimaryProjectState(),
      projectProfiles: genericInterviewProjectProfiles,
      now: 2000,
    })

    expect(routed.fields.questionType).toBe("项目方法方案类")
    expect(routed.fields.projectCategory).toBeUndefined()
    expect(routed.fields.projectRoutingStatus).toBe("none")
  })

  it("selects only one primary project when multiple projects appear", () => {
    const routed = routeInterviewQuestion({
      question: createFakeDetectedQuestion({
        text: "搜索质量平台和支付风控测试平台这两个项目你先讲搜索召回率怎么保障？",
      }),
      primaryProjectState: createEmptyPrimaryProjectState(),
      projectProfiles: genericInterviewProjectProfiles,
      now: 2000,
    })

    expect(routed.fields.projectCategory).toBe("支付风控测试平台")
    expect(routed.fields.projectRoutingStatus).toBe("detected")
  })

  it("inherits, switches, and clears primary project state", () => {
    const initial = routeInterviewQuestion({
      question: createFakeDetectedQuestion({
        id: "q-search",
        text: "搜索质量平台你是怎么搭建的？",
      }),
      primaryProjectState: createEmptyPrimaryProjectState(),
      projectProfiles: genericInterviewProjectProfiles,
      now: 2000,
    })
    const inherited = routeInterviewQuestion({
      question: createFakeDetectedQuestion({
        id: "q-follow-up",
        text: "那这个指标怎么算？",
      }),
      primaryProjectState: initial.primaryProjectState,
      projectProfiles: genericInterviewProjectProfiles,
      now: 3000,
    })
    const switched = routeInterviewQuestion({
      question: createFakeDetectedQuestion({
        id: "q-payment",
        text: "支付风控测试平台的流程是什么？",
      }),
      primaryProjectState: inherited.primaryProjectState,
      projectProfiles: genericInterviewProjectProfiles,
      now: 4000,
    })
    const cleared = routeInterviewQuestion({
      question: createFakeDetectedQuestion({
        id: "q-knowledge",
        text: "Transformer attention 的原理是什么？",
      }),
      primaryProjectState: switched.primaryProjectState,
      projectProfiles: genericInterviewProjectProfiles,
      now: 5000,
    })

    expect(initial.fields).toMatchObject({
      projectCategory: "搜索质量平台",
      projectRoutingStatus: "detected",
    })
    expect(inherited.fields).toMatchObject({
      projectCategory: "搜索质量平台",
      projectRoutingStatus: "inherited",
    })
    expect(switched.fields).toMatchObject({
      projectCategory: "支付风控测试平台",
      projectRoutingStatus: "switched",
    })
    expect(cleared.fields).toMatchObject({
      questionType: "知识八股类",
      projectRoutingStatus: "cleared",
      retrievalPolicy: "knowledge_first_with_fallback",
    })
    expect(cleared.primaryProjectState.currentProject).toBeNull()
  })

  it("routes configured project aliases from project profile terms", () => {
    const routed = routeInterviewQuestion({
      question: createFakeDetectedQuestion({
        id: "q-search",
        text: "你在搜索质量平台里针对召回率下降做的自动诊断，使用了什么方案？",
        answerGoal: "召回率自动诊断方案",
        topic: "召回率自动诊断",
        entities: ["自动诊断", "召回率", "搜索质量平台"],
      }),
      primaryProjectState: createEmptyPrimaryProjectState(),
      projectProfiles: genericInterviewProjectProfiles,
      now: 2000,
    })

    expect(routed.fields.projectCategory).toBe("搜索质量平台")
    expect(routed.diagnostic.routingSource).toBe("profile_score")
    expect(routed.diagnostic.projectScores?.[0]).toMatchObject({
      project: "搜索质量平台",
      matchedStrongTerms: expect.arrayContaining(["搜索质量平台", "召回率"]),
    })

    expect(detectProjectCategory(createFakeDetectedQuestion({
      text: "你在检索质量项目里做重排时，训练集是如何构建和标注的？",
      answerGoal: "重排训练集构建",
      topic: "重排训练集",
      entities: ["检索质量", "重排", "训练集"],
    }), genericInterviewProjectProfiles)).toBe("搜索质量平台")

    expect(detectProjectCategory(createFakeDetectedQuestion({
      text: "支付风控里交易拦截策略如何回放验证？",
      answerGoal: "交易拦截策略回放验证",
      topic: "交易拦截策略",
      entities: ["支付风控", "交易拦截", "回放"],
    }), genericInterviewProjectProfiles)).toBe("支付风控测试平台")

    expect(detectProjectCategory(createFakeDetectedQuestion({
      text: "推荐质量项目里的离线评估具体用了哪些指标？",
      answerGoal: "推荐离线评估指标",
      topic: "推荐离线评估",
      entities: ["推荐质量", "离线评估", "指标"],
    }), genericInterviewProjectProfiles)).toBe("推荐评估系统")
  })

  it("keeps weak or shared technical terms from forcing a project", () => {
    expect(detectProjectCategory(createFakeDetectedQuestion({
      text: "ResNet 模型训练时如何避免过拟合？",
      topic: "ResNet 模型训练",
      entities: ["ResNet", "过拟合"],
    }), genericInterviewProjectProfiles)).toBeUndefined()

    expect(detectProjectCategory(createFakeDetectedQuestion({
      text: "RAG 的检索召回和重排一般怎么做？",
      topic: "RAG 检索重排",
      entities: ["RAG", "重排"],
    }), genericInterviewProjectProfiles)).toBeUndefined()
  })

  it("uses profile scoring to separate easily confused project terms", () => {
    expect(detectProjectCategory(createFakeDetectedQuestion({
      text: "支付风控规则引擎里的交易拦截率怎么统计？",
      topic: "支付风控规则引擎",
      entities: ["支付风控", "规则引擎", "交易拦截率"],
    }), genericInterviewProjectProfiles)).toBe("支付风控测试平台")

    expect(detectProjectCategory(createFakeDetectedQuestion({
      text: "搜索链路里 BM25 和 rerank 如何配合提升召回率？",
      topic: "搜索链路召回率",
      entities: ["搜索链路", "BM25", "rerank", "召回率"],
    }), genericInterviewProjectProfiles)).toBe("搜索质量平台")

    expect(detectProjectCategory(createFakeDetectedQuestion({
      text: "推荐链路里的 precision 和 recall 怎么结合评估？",
      topic: "推荐链路评估",
      entities: ["推荐链路", "precision", "recall"],
    }), genericInterviewProjectProfiles)).toBe("推荐评估系统")
  })
})
