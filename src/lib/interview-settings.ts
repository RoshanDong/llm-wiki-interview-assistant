import type {
  AnswerPromptTemplateFamily,
  DetectedQuestion,
  InterviewQuestionType,
  PromptTemplate,
  PromptTemplateId,
  PromptTemplateSet,
} from "./interview-types"
import {
  ANSWER_PROMPT_FAMILY_BY_QUESTION_TYPE,
  INTERVIEW_QUESTION_TYPES,
  RETRIEVAL_POLICY_BY_QUESTION_TYPE,
  inferQuestionType,
} from "./interview-prompt-routing"
import {
  loadInterviewPromptTemplates,
  saveInterviewPromptTemplates,
} from "@/lib/project-store"

export const ANSWER_QUESTION_PLACEHOLDER = "（提问内容）"
export const DEFAULT_PREPARATION_PROMPT = "请根据我的知识库总结候选人的面试相关经历。"
export const DEFAULT_ANSWER_PROMPT =
  [
    "请结合知识库回答：（提问内容）。",
    "",
    "回答要求：",
    "- 优先查找知识库中的相关知识点；没有相关笔记就用专业通用知识回答。",
    "- 先用 2-3 句话直接回答问题。",
    "- 再补充定义/原理/场景/常见坑或对比。不要强行关联项目经历。",
    "- 用中文输出可直接口述的答案，尽量简洁。",
    "- 控制在 200-300 字，只保留关键做法、技术点和结果。",
    "- 知识库缺少相关内容时，用一句话说明缺口；不要编造。",
  ].join("\n")

export interface PromptTemplateStorage {
  load: () => Promise<Partial<PromptTemplateSet> | null>
  save: (templates: PromptTemplateSet) => Promise<void>
}

export interface DefaultAnswerPromptTemplatePreview {
  questionType: InterviewQuestionType
  answerPromptFamily: AnswerPromptTemplateFamily
  retrievalPolicy: string
  text: string
}

export type AnswerPromptTemplateTextMap = Record<AnswerPromptTemplateFamily, string>

const ANSWER_PROMPT_FAMILIES = INTERVIEW_QUESTION_TYPES.map(
  (questionType) => ANSWER_PROMPT_FAMILY_BY_QUESTION_TYPE[questionType],
)

export function createDefaultPromptTemplates(now = Date.now()): PromptTemplateSet {
  return {
    preparation: {
      id: "preparation",
      text: DEFAULT_PREPARATION_PROMPT,
      questionPlaceholder: null,
      updatedAt: now,
      isDefault: true,
    },
    answer: {
      id: "answer",
      text: DEFAULT_ANSWER_PROMPT,
      questionPlaceholder: ANSWER_QUESTION_PLACEHOLDER,
      updatedAt: now,
      isDefault: true,
    },
    answerTemplates: createDefaultAnswerPromptTemplates(now),
  }
}

export function createDefaultAnswerPromptTemplates(
  now = Date.now(),
): Record<AnswerPromptTemplateFamily, PromptTemplate> {
  return Object.fromEntries(ANSWER_PROMPT_FAMILIES.map((family) => [
    family,
    {
      id: family,
      text: buildDefaultAnswerPromptTemplateText(family),
      questionPlaceholder: ANSWER_QUESTION_PLACEHOLDER,
      updatedAt: now,
      isDefault: true,
    },
  ])) as Record<AnswerPromptTemplateFamily, PromptTemplate>
}

export function createMemoryPromptTemplateStorage(
  initial: Partial<PromptTemplateSet> | null = null,
): PromptTemplateStorage {
  let value = initial
  return {
    async load() {
      return value
    },
    async save(templates) {
      value = structuredCloneSafe(templates)
    },
  }
}

export async function loadPromptTemplatesFromStorage(
  storage: PromptTemplateStorage = projectPromptTemplateStorage,
  now = Date.now(),
): Promise<PromptTemplateSet> {
  const stored = await storage.load()
  return normalizePromptTemplates(stored, now)
}

export async function savePromptTemplatesToStorage(
  storage: PromptTemplateStorage,
  templates: PromptTemplateSet,
): Promise<void> {
  await storage.save(normalizePromptTemplates(templates))
}

export async function updatePromptTemplateInStorage(
  storage: PromptTemplateStorage,
  id: PromptTemplateId,
  text: string,
  now = Date.now(),
): Promise<PromptTemplateSet> {
  const current = await loadPromptTemplatesFromStorage(storage, now)
  const trimmed = text.trim()
  const defaults = createDefaultPromptTemplates(now)
  let next: PromptTemplateSet
  if (isAnswerPromptTemplateFamily(id)) {
    next = {
      ...current,
      answerTemplates: {
        ...current.answerTemplates,
        [id]: {
          ...current.answerTemplates[id],
          text: trimmed,
          updatedAt: now,
          isDefault: trimmed === defaults.answerTemplates[id].text,
        },
      },
    }
  } else {
    next = {
      ...current,
      [id]: {
        ...current[id],
        text: trimmed,
        updatedAt: now,
        isDefault: trimmed === defaults[id].text,
      },
    }
  }
  if (id === "answer" || isAnswerPromptTemplateFamily(id)) {
    const validation = validateAnswerPromptTemplate(trimmed)
    if (!validation.ok) throw new Error(validation.error)
  }
  await storage.save(next)
  return next
}

export function normalizePromptTemplates(
  value: Partial<PromptTemplateSet> | null | undefined,
  now = Date.now(),
): PromptTemplateSet {
  const defaults = createDefaultPromptTemplates(now)
  return {
    preparation: normalizeTemplate(value?.preparation, defaults.preparation),
    answer: normalizeTemplate(value?.answer, defaults.answer),
    answerTemplates: normalizeAnswerPromptTemplates(value?.answerTemplates, defaults.answerTemplates),
  }
}

export function validateAnswerPromptTemplate(
  text: string,
  placeholder = ANSWER_QUESTION_PLACEHOLDER,
): { ok: true } | { ok: false; error: string } {
  if (!text.trim()) return { ok: false, error: "Answer prompt cannot be empty." }
  if (!text.includes(placeholder)) {
    return { ok: false, error: `Answer prompt must include ${placeholder}.` }
  }
  return { ok: true }
}

export function interpolateAnswerPrompt(
  templateText: string,
  questionText: string,
  placeholder = ANSWER_QUESTION_PLACEHOLDER,
): string {
  const validation = validateAnswerPromptTemplate(templateText, placeholder)
  if (!validation.ok) throw new Error(validation.error)
  return templateText.split(placeholder).join(questionText.trim())
}

export function buildRoutedAnswerPrompt(
  question: Pick<DetectedQuestion,
    | "text"
    | "answerGoal"
    | "topic"
    | "intent"
    | "entities"
    | "questionType"
    | "projectCategory"
    | "projectRoutingStatus"
  >,
  fallbackTemplateText = DEFAULT_ANSWER_PROMPT,
  answerTemplateTexts: Partial<AnswerPromptTemplateTextMap> = {},
): string {
  const questionType = question.questionType ?? inferQuestionType(question)
  const family = ANSWER_PROMPT_FAMILY_BY_QUESTION_TYPE[questionType]
  if (!family) return interpolateAnswerPrompt(fallbackTemplateText, question.text)
  const templateText = answerTemplateTexts[family]
  if (templateText) return interpolateRoutedAnswerPrompt(templateText, question, family)
  return buildPromptFamily(family, question)
}

export function createDefaultAnswerPromptTemplatePreviews(
  answerTemplates: Partial<Record<AnswerPromptTemplateFamily, Pick<PromptTemplate, "text">>> = {},
): DefaultAnswerPromptTemplatePreview[] {
  return INTERVIEW_QUESTION_TYPES.map((questionType) => {
    const answerPromptFamily = ANSWER_PROMPT_FAMILY_BY_QUESTION_TYPE[questionType]
    const retrievalPolicy = RETRIEVAL_POLICY_BY_QUESTION_TYPE[questionType]
    return {
      questionType,
      answerPromptFamily,
      retrievalPolicy,
      text: answerTemplates[answerPromptFamily]?.text ?? buildDefaultAnswerPromptTemplateText(answerPromptFamily),
    }
  })
}

export function getAnswerPromptTemplateTextMap(
  templates: PromptTemplateSet,
): AnswerPromptTemplateTextMap {
  return Object.fromEntries(ANSWER_PROMPT_FAMILIES.map((family) => [
    family,
    templates.answerTemplates[family].text,
  ])) as AnswerPromptTemplateTextMap
}

export const projectPromptTemplateStorage: PromptTemplateStorage = {
  load: loadInterviewPromptTemplates,
  save: saveInterviewPromptTemplates,
}

function normalizeTemplate(
  value: Partial<PromptTemplate> | undefined,
  fallback: PromptTemplate,
): PromptTemplate {
  const text = typeof value?.text === "string" && value.text.trim()
    ? value.text.trim()
    : fallback.text
  const updatedAt = typeof value?.updatedAt === "number" && Number.isFinite(value.updatedAt)
    ? value.updatedAt
    : fallback.updatedAt
  return {
    ...fallback,
    ...value,
    id: fallback.id,
    text,
    questionPlaceholder: fallback.questionPlaceholder,
    updatedAt,
    isDefault: text === fallback.text,
  }
}

function normalizeAnswerPromptTemplates(
  value: Partial<Record<AnswerPromptTemplateFamily, Partial<PromptTemplate>>> | undefined,
  defaults: Record<AnswerPromptTemplateFamily, PromptTemplate>,
): Record<AnswerPromptTemplateFamily, PromptTemplate> {
  return Object.fromEntries(ANSWER_PROMPT_FAMILIES.map((family) => [
    family,
    normalizeTemplate(value?.[family], defaults[family]),
  ])) as Record<AnswerPromptTemplateFamily, PromptTemplate>
}

function isAnswerPromptTemplateFamily(id: PromptTemplateId): id is AnswerPromptTemplateFamily {
  return (ANSWER_PROMPT_FAMILIES as PromptTemplateId[]).includes(id)
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

function buildDefaultAnswerPromptTemplateText(family: AnswerPromptTemplateFamily): string {
  return buildPromptFamily(family, {
    text: ANSWER_QUESTION_PLACEHOLDER,
    projectCategory: RETRIEVAL_POLICY_BY_QUESTION_TYPE[
      INTERVIEW_QUESTION_TYPES.find((questionType) =>
        ANSWER_PROMPT_FAMILY_BY_QUESTION_TYPE[questionType] === family
      ) ?? "知识八股类"
    ] === "project_grounded" ? "（识别/继承的项目）" : undefined,
    projectRoutingStatus: "detected",
  })
}

function interpolateRoutedAnswerPrompt(
  templateText: string,
  question: Pick<DetectedQuestion, "text" | "answerGoal" | "projectRoutingStatus"> & { projectCategory?: string },
  family: AnswerPromptTemplateFamily,
): string {
  const projectCategory = question.projectCategory ?? "未识别项目"
  const questionText = normalizeQuestionForPrompt(question.text)
  const questionTextForFamily = family === "coding" && questionText.startsWith("手撕代码")
    ? questionText
    : questionText
  return templateText
    .split(ANSWER_QUESTION_PLACEHOLDER).join(questionTextForFamily)
    .split("（识别/继承的项目）").join(projectCategory)
}

function buildPromptFamily(
  family: AnswerPromptTemplateFamily,
  question: Pick<DetectedQuestion, "text" | "answerGoal" | "projectRoutingStatus"> & { projectCategory?: string },
): string {
  const promptQuestion = formatKnowledgeQuestion(question, family)
  const header = [promptQuestion]
  const projectGrounding = question.projectCategory
    ? `优先使用知识库中与「${question.projectCategory}」直接相关的项目材料。`
    : "优先使用知识库中的相关项目材料。"

  const bodyByFamily: Record<AnswerPromptTemplateFamily, string> = {
    project_experience_overview: [
      "回答要求：",
      `- ${projectGrounding}`,
      "- 先用 2-3 句先概括项目背景、职责/贡献和结果。",
      "- 再用 STAR （背景、目标/职责、关键动作、结果）简要展开。突出个人贡献和可验证结果，少讲技术细节。",
      "- 用中文输出可直接口述的答案，尽量简洁。",
      "- 控制在 200-300 字，只保留关键做法、技术点和结果。",
      "- 知识库缺少相关内容时，用一句话说明缺口；不要编造。",
    ].join("\n"),
    project_method_plan: [
      "回答要求：",
      `- ${projectGrounding}`,
      "- 先用 2-3 句话直接回答主要方法方案。",
      "- 再按目标、方法论（重要）、具体流程和方案（输入/数据、技术手段、工具/平台、输出等）、最终结果展开。",
      "- 用中文输出可直接口述的答案，尽量简洁。",
      "- 控制在 200-300 字，只保留关键做法、技术点和结果。",
      "- 知识库缺少相关内容时，用一句话说明缺口；不要编造。",
    ].join("\n"),
    project_detail_deep_dive: [
      "回答要求：",
      `- ${projectGrounding}`,
      "- 先用 2-3 句话直接回答结论。",
      "- 再说明细节：技术选型、实施步骤、数据处理、指标口径、最终结果、困难或局限等。",
      "- 用中文输出可直接口述的答案，尽量简洁。",
      "- 控制在 200-300 字，只保留关键做法、技术点和结果。",
      "- 知识库缺少相关内容时，用一句话说明缺口；不要编造。",
    ].join("\n"),
    knowledge_bagua: [
      "回答要求：",
      "- 优先查找知识库中的相关知识点；没有相关笔记就用专业通用知识回答。",
      "- 先用 2-3 句话直接回答问题。",
      "- 再补充定义/原理/场景/常见坑或对比。不要强行关联项目经历。",
      "- 用中文输出可直接口述的答案，尽量简洁。",
      "- 控制在 200-300 字，只保留关键做法、技术点和结果。",
      "- 知识库缺少相关内容时，用一句话说明缺口；不要编造。",
    ].join("\n"),
    coding: [
      "回答要求：",
      "- 无需查询知识库或关联项目经历。",
      "- 如果有多种解题思路，优先给出最通用、复杂度最低的。",
      "- 先用 2-3 句话给出思路。",
      "- 再给复杂度、可运行代码、代码简短口述解释。",
      "- 题目未指定语言时优先使用 Python。",
    ].join("\n"),
  }

  return [
    ...header,
    "",
    bodyByFamily[family],
  ].join("\n").trim()
}

function formatKnowledgeQuestion(
  question: Pick<DetectedQuestion, "text" | "answerGoal" | "projectRoutingStatus"> & { projectCategory?: string },
  family: AnswerPromptTemplateFamily,
): string {
  const text = normalizeQuestionForPrompt(question.text)
  if (family === "coding") {
    return `请回答编程题：${text}`
  }
  if (question.projectCategory) {
    return `结合知识库回答：在「${question.projectCategory}」项目中，${text}`
  }
  return `结合知识库回答：${text}`
}

function normalizeQuestionForPrompt(text: string): string {
  const trimmed = text.trim()
  return trimmed
    .replace(/^你们\s*/, "")
    .replace(/^你在\s*/, "在")
    .replace(/^你的\s*/, "")
    .replace(/^你\s*/, "")
}
