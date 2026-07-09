import type {
  AnswerPromptTemplateFamily,
  AnswerRetrievalPolicy,
  DetectedQuestion,
  InterviewProjectCategory,
  InterviewProjectProfile,
  InterviewQuestionType,
  InterviewRoutingFields,
  PrimaryProjectState,
  ProjectRoutingScoreDiagnostic,
  ProjectRoutingStatus,
  RoutingDiagnostic,
} from "./interview-types"
import {
  enabledProjectProfiles,
  projectProfileNames,
  profileRoutingHints,
} from "./interview-project-profiles"

export const INTERVIEW_QUESTION_TYPES: readonly InterviewQuestionType[] = [
  "项目经历概览类",
  "项目方法方案类",
  "项目细节深挖类",
  "知识八股类",
  "手撕代码类",
] as const

export const ANSWER_PROMPT_FAMILY_BY_QUESTION_TYPE: Record<InterviewQuestionType, AnswerPromptTemplateFamily> = {
  项目经历概览类: "project_experience_overview",
  项目方法方案类: "project_method_plan",
  项目细节深挖类: "project_detail_deep_dive",
  知识八股类: "knowledge_bagua",
  手撕代码类: "coding",
}

export const RETRIEVAL_POLICY_BY_QUESTION_TYPE: Record<InterviewQuestionType, AnswerRetrievalPolicy> = {
  项目经历概览类: "project_grounded",
  项目方法方案类: "project_grounded",
  项目细节深挖类: "project_grounded",
  知识八股类: "knowledge_first_with_fallback",
  手撕代码类: "direct_no_project_grounding",
}

export interface InterviewPromptRoutingResult {
  fields: Required<Pick<InterviewRoutingFields, "questionType" | "projectRoutingStatus" | "answerPromptFamily" | "retrievalPolicy">> &
    Pick<InterviewRoutingFields, "projectCategory" | "projectRoutingReason">
  primaryProjectState: PrimaryProjectState
  diagnostic: RoutingDiagnostic
}

export interface RouteInterviewQuestionInput {
  question: Pick<DetectedQuestion, "id" | "text" | "answerGoal" | "topic" | "intent" | "entities" | "questionType" | "projectCategory">
  primaryProjectState?: PrimaryProjectState
  projectProfiles?: readonly InterviewProjectProfile[]
  now: number
  runId?: string
}

export function createEmptyPrimaryProjectState(): PrimaryProjectState {
  return {
    currentProject: null,
    status: "empty",
    updatedAt: null,
    sourceQuestionId: null,
    reason: null,
  }
}

export function routeInterviewQuestion(input: RouteInterviewQuestionInput): InterviewPromptRoutingResult {
  const previous = input.primaryProjectState ?? createEmptyPrimaryProjectState()
  const questionType = inferQuestionType(input.question, input.projectProfiles)
  const answerPromptFamily = ANSWER_PROMPT_FAMILY_BY_QUESTION_TYPE[questionType]
  const retrievalPolicy = RETRIEVAL_POLICY_BY_QUESTION_TYPE[questionType]
  const projectEvaluation = evaluateProjectCategory(input.question, input.projectProfiles)
  const detectedProject = projectEvaluation.project

  let projectCategory: InterviewProjectCategory | undefined
  let projectRoutingStatus: ProjectRoutingStatus
  let reason: string

  if (questionType === "知识八股类" || questionType === "手撕代码类") {
    projectRoutingStatus = previous.currentProject ? "cleared" : "none"
    reason = questionType === "手撕代码类"
      ? "coding question uses direct answer mode"
      : "knowledge question is not forced into project grounding"
  } else if (detectedProject) {
    projectCategory = detectedProject
    projectRoutingStatus = previous.currentProject && previous.currentProject !== detectedProject
      ? "switched"
      : "detected"
    reason = projectRoutingStatus === "switched"
      ? `explicit topic switch to ${detectedProject}`
      : `project detected as ${detectedProject}`
  } else if (previous.currentProject) {
    projectCategory = previous.currentProject
    projectRoutingStatus = "inherited"
    reason = `continued previous project ${previous.currentProject}`
  } else {
    projectRoutingStatus = "none"
    reason = "no project detected or available for inheritance"
  }

  const primaryProjectState: PrimaryProjectState = projectCategory
    ? {
        currentProject: projectCategory,
        status: "active",
        updatedAt: input.now,
        sourceQuestionId: input.question.id,
        reason,
      }
    : {
        currentProject: null,
        status: projectRoutingStatus === "cleared" ? "cleared" : "empty",
        updatedAt: input.now,
        sourceQuestionId: input.question.id,
        reason,
      }

  const fields: InterviewPromptRoutingResult["fields"] = {
    questionType,
    projectRoutingStatus,
    projectRoutingReason: reason,
    answerPromptFamily,
    retrievalPolicy,
  }
  if (projectCategory) fields.projectCategory = projectCategory

  return {
    fields,
    primaryProjectState,
    diagnostic: {
      questionId: input.question.id,
      questionType,
      projectCategory,
      projectRoutingStatus,
      answerPromptFamily,
      retrievalPolicy,
      reason,
      routingSource: projectEvaluation.source,
      projectScores: projectEvaluation.scores,
      runId: input.runId,
      createdAt: input.now,
    },
  }
}

export function isInterviewQuestionType(value: unknown): value is InterviewQuestionType {
  return typeof value === "string" && INTERVIEW_QUESTION_TYPES.includes(value as InterviewQuestionType)
}

export function isInterviewProjectCategory(value: unknown): value is InterviewProjectCategory {
  return typeof value === "string" && value.trim().length > 0
}

export function normalizeInterviewQuestionType(value: unknown): InterviewQuestionType | undefined {
  return isInterviewQuestionType(value) ? value : undefined
}

export function normalizeInterviewProjectCategory(
  value: unknown,
  projectProfiles: readonly InterviewProjectProfile[] = [],
): InterviewProjectCategory | undefined {
  if (!isInterviewProjectCategory(value)) return undefined
  const trimmed = value.trim()
  const names = new Set(projectProfileNames(projectProfiles))
  return names.has(trimmed) ? trimmed : undefined
}

export function inferQuestionType(
  question: Pick<DetectedQuestion, "text" | "answerGoal" | "topic" | "intent" | "entities" | "questionType">,
  projectProfiles: readonly InterviewProjectProfile[] = [],
): InterviewQuestionType {
  const text = routingText(question)
  if (looksLikeCodingQuestion(text)) return "手撕代码类"

  const hinted = normalizeInterviewQuestionType(question.questionType)
  if (hinted) return hinted

  if (looksLikeProjectDetailQuestion(text)) return "项目细节深挖类"
  if (looksLikeProjectMethodQuestion(text)) return "项目方法方案类"
  if (looksLikeKnowledgeQuestion(text) && !detectProjectCategory(question, projectProfiles)) return "知识八股类"
  if (detectProjectCategory(question, projectProfiles) || looksLikeProjectOverviewQuestion(text)) return "项目经历概览类"
  if (looksLikeKnowledgeQuestion(text)) return "知识八股类"
  return "知识八股类"
}

export function detectProjectCategory(
  question: Pick<DetectedQuestion, "text" | "answerGoal" | "topic" | "intent" | "entities" | "projectCategory">,
  projectProfiles: readonly InterviewProjectProfile[] = [],
): InterviewProjectCategory | undefined {
  return evaluateProjectCategory(question, projectProfiles).project
}

function evaluateProjectCategory(
  question: Pick<DetectedQuestion, "text" | "answerGoal" | "topic" | "intent" | "entities" | "projectCategory">,
  projectProfiles: readonly InterviewProjectProfile[] = [],
): {
  project?: InterviewProjectCategory
  source: RoutingDiagnostic["routingSource"]
  scores: ProjectRoutingScoreDiagnostic[]
} {
  const profiles = enabledProjectProfiles(projectProfiles)
  const hinted = normalizeInterviewProjectCategory(question.projectCategory, profiles)
  const text = routingText(question)
  const matches = profiles
    .map((profile) => scoreProjectProfile(text, profile))
    .sort((a, b) => b.score - a.score || a.firstIndex - b.firstIndex)
  if (hinted) {
    return {
      project: hinted,
      source: "detector_hint",
      scores: matches.map(({ firstIndex: _firstIndex, ...score }) => score),
    }
  }
  const detected = matches.find((match) => match.score >= PROJECT_DETECTION_THRESHOLD)
  return {
    project: detected?.project,
    source: detected ? "profile_score" : "none",
    scores: matches.map(({ firstIndex: _firstIndex, ...score }) => score),
  }
}

export function routingFieldsFromQuestion(question: InterviewRoutingFields): InterviewRoutingFields {
  return {
    questionType: question.questionType,
    projectCategory: question.projectCategory,
    projectRoutingStatus: question.projectRoutingStatus,
    projectRoutingReason: question.projectRoutingReason,
    answerPromptFamily: question.answerPromptFamily,
    retrievalPolicy: question.retrievalPolicy,
  }
}

export const PROJECT_DETECTION_THRESHOLD = 6

export function buildProjectRoutingHints(
  profiles: readonly InterviewProjectProfile[] = [],
): string[] {
  return profileRoutingHints(profiles)
}

function routingText(
  question: Pick<DetectedQuestion, "text" | "answerGoal" | "topic" | "intent" | "entities">,
): string {
  return [
    question.text,
    question.answerGoal,
    question.topic,
    question.intent,
    ...(question.entities ?? []),
  ].filter(Boolean).join(" ").toLowerCase()
}

function scoreProjectProfile(text: string, profile: InterviewProjectProfile): {
  project: InterviewProjectCategory
  score: number
  matchedStrongTerms: string[]
  matchedWeakTerms: string[]
  matchedTechnicalTerms: string[]
  matchedNegativeTerms: string[]
  matchedStrongCombos: string[]
  firstIndex: number
} {
  let score = 0
  let firstIndex = Number.MAX_SAFE_INTEGER

  const addMatches = (terms: string[], weight: number): string[] => {
    const matched: string[] = []
    for (const term of terms) {
      const index = termIndex(text, term)
      if (index < 0) continue
      score += weight
      matched.push(term)
      firstIndex = Math.min(firstIndex, index)
    }
    return matched
  }

  const matchedStrongTerms = addMatches([profile.name, ...profile.aliases, ...profile.strongTerms], 6)
  const matchedWeakTerms = addMatches(profile.weakTerms, 2)
  const matchedTechnicalTerms = addMatches(profile.technicalTerms, 1)
  const matchedNegativeTerms = addMatches(profile.negativeTerms, -8)
  const matchedStrongCombos: string[] = []

  for (const combo of profile.strongCombos) {
    const indices = combo.map((term) => termIndex(text, term))
    if (indices.some((index) => index < 0)) continue
    score += 8
    matchedStrongCombos.push(combo.join(" + "))
    firstIndex = Math.min(firstIndex, ...indices)
  }

  return {
    project: profile.name,
    score,
    matchedStrongTerms,
    matchedWeakTerms,
    matchedTechnicalTerms,
    matchedNegativeTerms,
    matchedStrongCombos,
    firstIndex,
  }
}

function termIndex(text: string, term: string): number {
  return normalizeRoutingTerm(text).indexOf(normalizeRoutingTerm(term))
}

function normalizeRoutingTerm(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "")
}

function looksLikeCodingQuestion(text: string): boolean {
  return /(手撕|写.*代码|代码实现|实现.*代码|编程题|算法题|leetcode|sql|复杂度|边界条件|debug|调试代码|函数实现|给.*数组|链表|二叉树|动态规划|排序算法)/i.test(text)
}

function looksLikeProjectDetailQuestion(text: string): boolean {
  return /(具体|细节|怎么算|计算|口径|指标|阈值|数据量|参数|模型名|准确率|召回率|precision|recall|最终结果|结果是多少|怎么实现|实现步骤|技术选型|为什么选|线上问题|trade[- ]?off|取舍)/i.test(text)
}

function looksLikeProjectMethodQuestion(text: string): boolean {
  return /(方法|方案|流程|怎么做|如何做|怎么测|如何测试|落地|搭建|保障|闭环|链路|推进|设计)/i.test(text)
}

function looksLikeProjectOverviewQuestion(text: string): boolean {
  return /(项目经历|项目介绍|介绍.*项目|讲.*项目|负责.*什么|做了什么|背景|贡献|star|总结)/i.test(text)
}

function looksLikeKnowledgeQuestion(text: string): boolean {
  return /(什么是|区别|原理|概念|八股|测试理论|计算机网络|tcp|http|进程|线程|索引|事务|transformer|attention|rag|agent|大模型|llm|算法基础|软件测试)/i.test(text)
}
