import { describe, expect, it } from "vitest"
import {
  ANSWER_QUESTION_PLACEHOLDER,
  DEFAULT_ANSWER_PROMPT,
  DEFAULT_PREPARATION_PROMPT,
  buildRoutedAnswerPrompt,
  createDefaultPromptTemplates,
  createMemoryPromptTemplateStorage,
  getAnswerPromptTemplateTextMap,
  interpolateAnswerPrompt,
  loadPromptTemplatesFromStorage,
  savePromptTemplatesToStorage,
  updatePromptTemplateInStorage,
  validateAnswerPromptTemplate,
} from "./interview-settings"

describe("interview prompt settings", () => {
  it("creates default editable preparation and answer templates", () => {
    const templates = createDefaultPromptTemplates(1000)

    expect(templates.preparation.text).toBe(DEFAULT_PREPARATION_PROMPT)
    expect(templates.answer.text).toBe(DEFAULT_ANSWER_PROMPT)
    expect(templates.answer.questionPlaceholder).toBe(ANSWER_QUESTION_PLACEHOLDER)
    expect(templates.preparation.isDefault).toBe(true)
    expect(templates.answer.isDefault).toBe(true)
    expect(templates.answerTemplates.project_experience_overview.text).toContain("STAR")
    expect(templates.answerTemplates.coding.text).toContain("请回答编程题")
  })

  it("persists updated prompt templates through the provided storage", async () => {
    const storage = createMemoryPromptTemplateStorage()
    const templates = createDefaultPromptTemplates(1000)

    await savePromptTemplatesToStorage(storage, templates)
    await updatePromptTemplateInStorage(storage, "preparation", "custom prep", 2000)
    const loaded = await loadPromptTemplatesFromStorage(storage, 3000)

    expect(loaded.preparation.text).toBe("custom prep")
    expect(loaded.preparation.updatedAt).toBe(2000)
    expect(loaded.preparation.isDefault).toBe(false)
    expect(loaded.answer.text).toBe(DEFAULT_ANSWER_PROMPT)
    expect(loaded.answerTemplates.knowledge_bagua.text).toContain("没有相关笔记")
  })

  it("persists per-family answer template edits", async () => {
    const storage = createMemoryPromptTemplateStorage()
    const customTemplate = [
      "结合知识库回答：在「（识别/继承的项目）」项目中，（提问内容）",
      "",
      "回答要求：自定义项目方法模板。",
    ].join("\n")

    await savePromptTemplatesToStorage(storage, createDefaultPromptTemplates(1000))
    await updatePromptTemplateInStorage(storage, "project_method_plan", customTemplate, 2000)
    const loaded = await loadPromptTemplatesFromStorage(storage, 3000)

    expect(loaded.answerTemplates.project_method_plan.text).toBe(customTemplate)
    expect(loaded.answerTemplates.project_method_plan.updatedAt).toBe(2000)
    expect(loaded.answerTemplates.project_method_plan.isDefault).toBe(false)
    expect(getAnswerPromptTemplateTextMap(loaded).project_method_plan).toBe(customTemplate)
  })

  it("preserves custom answer prompts when loading templates", async () => {
    const customAnswerPrompt = "请结合知识库简短回答：（提问内容）。"
    const storage = createMemoryPromptTemplateStorage({
      answer: {
        id: "answer",
        text: customAnswerPrompt,
        questionPlaceholder: ANSWER_QUESTION_PLACEHOLDER,
        updatedAt: 1000,
        isDefault: false,
      },
    })

    const loaded = await loadPromptTemplatesFromStorage(storage, 2000)

    expect(loaded.answer.text).toBe(customAnswerPrompt)
    expect(loaded.answer.isDefault).toBe(false)
  })

  it("requires the answer prompt placeholder and interpolates the detected question", () => {
    const question = "你如何处理线上事故？"

    expect(validateAnswerPromptTemplate(DEFAULT_ANSWER_PROMPT).ok).toBe(true)
    expect(interpolateAnswerPrompt(DEFAULT_ANSWER_PROMPT, question)).toContain(question)
    expect(DEFAULT_ANSWER_PROMPT).toContain("控制在 200-300 字")
    expect(validateAnswerPromptTemplate("没有占位符").ok).toBe(false)
  })

  it("builds five routed answer prompt families with the expected retrieval posture", () => {
    const overview = buildRoutedAnswerPrompt({
      text: "介绍一下搜索质量平台项目。",
      questionType: "项目经历概览类",
      projectCategory: "搜索质量平台",
      projectRoutingStatus: "detected",
    })
    const method = buildRoutedAnswerPrompt({
      text: "这个项目你是怎么落地的？",
      questionType: "项目方法方案类",
      projectCategory: "搜索质量平台",
      projectRoutingStatus: "inherited",
    })
    const detail = buildRoutedAnswerPrompt({
      text: "指标口径和阈值怎么算？",
      questionType: "项目细节深挖类",
      projectCategory: "搜索质量平台",
      projectRoutingStatus: "inherited",
    })
    const knowledge = buildRoutedAnswerPrompt({
      text: "RAG 和传统搜索有什么区别？",
      questionType: "知识八股类",
    })
    const coding = buildRoutedAnswerPrompt({
      text: "手撕代码：写函数反转链表。",
      questionType: "手撕代码类",
    })

    expect(overview).toContain("结合知识库回答：在「搜索质量平台」项目中")
    expect(overview).not.toContain("Answer prompt family")
    expect(overview).not.toContain("Retrieval policy")
    expect(overview).not.toContain("项目路由状态")
    expect(overview).toContain("STAR")
    expect(overview).toContain("搜索质量平台")
    expect(method).toContain("目标")
    expect(method).toContain("方法论（重要）")
    expect(detail).toContain("先用 2-3 句话直接回答结论")
    expect(detail).toContain("再说明细节：技术选型、实施步骤、数据处理、指标口径、最终结果、困难或局限等")
    expect(knowledge).toContain("没有相关笔记")
    expect(knowledge).toContain("不要强行关联项目经历")
    expect(coding).toContain("无需查询知识库")
    expect(coding).toContain("复杂度")
    expect(coding).toContain("代码简短口述解释")
    expect(detail).toContain("200-300 字")
    expect(detail).not.toContain("回答主体")
    expect(detail).not.toContain("候选人")
  })

  it("rewrites project questions as natural knowledge-base instructions", () => {
    const prompt = buildRoutedAnswerPrompt({
      text: "你们ASR服务的部署是用的什么来部署的？",
      questionType: "项目细节深挖类",
      projectCategory: "搜索质量平台",
      projectRoutingStatus: "detected",
    })

    expect(prompt).toContain("结合知识库回答：在「搜索质量平台」项目中，ASR服务的部署是用的什么来部署的？")
    expect(prompt).toContain("先用 2-3 句话直接回答结论")
    expect(prompt).not.toContain("回答主体")
    expect(prompt).not.toContain("候选人")
    expect(prompt).not.toContain("面试问题：")
    expect(prompt).not.toContain("问题类型：")
    expect(prompt).not.toContain("project_detail_deep_dive")
    expect(prompt).not.toContain("project_grounded")
  })

  it("mentions the provided project category in project-grounded prompts", () => {
    const projects = [
      "搜索质量平台",
      "支付风控测试平台",
      "推荐评估系统",
    ] as const

    for (const project of projects) {
      expect(buildRoutedAnswerPrompt({
        text: `${project} 的方案是什么？`,
        questionType: "项目方法方案类",
        projectCategory: project,
      })).toContain(project)
    }
  })

  it("uses saved answer template text when building routed prompts", () => {
    const prompt = buildRoutedAnswerPrompt({
      text: "你们方案怎么落地的？",
      questionType: "项目方法方案类",
      projectCategory: "支付风控测试平台",
      projectRoutingStatus: "detected",
    }, DEFAULT_ANSWER_PROMPT, {
      project_method_plan: "CUSTOM：在「（识别/继承的项目）」里回答（提问内容）",
    })

    expect(prompt).toBe("CUSTOM：在「支付风控测试平台」里回答方案怎么落地的？")
  })
})
