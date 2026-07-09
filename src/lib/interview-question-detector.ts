import { streamChat, type ChatMessage } from "@/lib/llm-client"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import type {
  ConversationPhase,
  InterviewProjectCategory,
  InterviewProjectProfile,
  InterviewQuestionType,
  PrimaryProjectState,
  TranscriptSegment,
} from "./interview-types"
import {
  INTERVIEW_QUESTION_TYPES,
  buildProjectRoutingHints,
  normalizeInterviewProjectCategory,
  normalizeInterviewQuestionType,
} from "./interview-prompt-routing"
import { projectProfileNames } from "./interview-project-profiles"

export interface QuestionDetectionInput {
  recentSegments: TranscriptSegment[]
  existingQuestionTexts: string[]
  existingCoverageSummaries?: string[]
  primaryProjectState?: PrimaryProjectState
  projectProfiles?: readonly InterviewProjectProfile[]
  reverseQuestionPhaseActive?: boolean
  contextVersion?: number
}

export interface QuestionDetectionResult {
  contextVersion?: number
  turnComplete: boolean
  turnReason?: string
  conversationPhase: ConversationPhase
  questions: Array<{
    text: string
    answerGoal?: string
    topic?: string
    intent?: string
    entities?: string[]
    sourceSegmentIds: string[]
    confidence?: number
    clarificationState?: "none" | "candidate_clarifying" | "confirmed" | "rejected"
    refinementOfSegmentId?: string
    questionType?: InterviewQuestionType
    projectCategory?: InterviewProjectCategory
    routingReason?: string
  }>
}

export interface QuestionDetector {
  detect: (
    input: QuestionDetectionInput,
    signal: AbortSignal,
  ) => Promise<QuestionDetectionResult>
}

export interface LlmQuestionDetectorDeps {
  llmConfig?: LlmConfig
  getLlmConfig?: () => LlmConfig
  streamChat?: typeof streamChat
}

export class LlmQuestionDetector implements QuestionDetector {
  private readonly getLlmConfig: () => LlmConfig
  private readonly streamChat: typeof streamChat

  constructor(deps: LlmQuestionDetectorDeps = {}) {
    this.getLlmConfig = deps.getLlmConfig ?? (() => deps.llmConfig ?? useWikiStore.getState().llmConfig)
    this.streamChat = deps.streamChat ?? streamChat
  }

  async detect(input: QuestionDetectionInput, signal: AbortSignal): Promise<QuestionDetectionResult> {
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError")
    const segments = input.recentSegments
      .filter((segment) => (segment.state ?? "confirmed") === "confirmed")
      .filter((segment) => segment.text.trim())
    if (segments.length === 0) return emptyQuestionDetectionResult(input.contextVersion)

    const llmConfig = this.getLlmConfig()
    if (!hasUsableLlm(llmConfig) || !llmConfig.model.trim()) {
      return emptyQuestionDetectionResult(input.contextVersion)
    }

    const messages = buildInterviewQuestionDetectionMessages({
      recentSegments: segments,
      existingQuestionTexts: input.existingQuestionTexts,
      existingCoverageSummaries: input.existingCoverageSummaries ?? [],
      primaryProjectState: input.primaryProjectState,
      projectProfiles: input.projectProfiles,
      reverseQuestionPhaseActive: input.reverseQuestionPhaseActive ?? false,
    })
    const raw = await collectQuestionDetectorText(this.streamChat, llmConfig, messages, signal)
    const parsed = parseLlmQuestionDetectionResult(
      raw,
      new Set(segments.map((segment) => segment.id)),
      input.contextVersion,
      input.projectProfiles,
    )
    return {
      ...parsed,
      questions: parsed.turnComplete
        ? suppressDuplicateDetectedQuestions(parsed.questions, input.existingQuestionTexts)
        : [],
    }
  }
}

export class NoopQuestionDetector implements QuestionDetector {
  async detect(): Promise<QuestionDetectionResult> {
    return emptyQuestionDetectionResult()
  }
}

export class HeuristicQuestionDetector implements QuestionDetector {
  async detect(input: QuestionDetectionInput, signal: AbortSignal): Promise<QuestionDetectionResult> {
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError")
    const existing = new Set(input.existingQuestionTexts.map(normalizeQuestionText))
    const lastSegment = input.recentSegments[input.recentSegments.length - 1]
    if (lastSegment && looksLikeCandidateClarification(lastSegment.text)) {
      return {
        contextVersion: input.contextVersion,
        turnComplete: false,
        conversationPhase: "normal_interview",
        turnReason: "awaiting interviewer clarification confirmation",
        questions: [],
      }
    }
    const questions: QuestionDetectionResult["questions"] = []
    const clarifiedPromptIds = new Set<string>()
    for (let index = 0; index < input.recentSegments.length; index += 1) {
      const segment = input.recentSegments[index]
      if (segment.speaker !== "interviewee" || !looksLikeCandidateClarification(segment.text)) continue
      const previous = findPreviousInterviewerPrompt(input.recentSegments, index)
      const confirmation = findFollowingInterviewerConfirmation(input.recentSegments, index)
      if (!previous || !confirmation) continue
      const refined = cleanupQuestionText(extractClarifiedQuestionText(segment.text) || previous.text)
      const normalized = normalizeQuestionText(refined)
      if (!normalized || existing.has(normalized)) continue
      existing.add(normalized)
      clarifiedPromptIds.add(previous.id)
      questions.push({
        text: refined,
        answerGoal: refined,
        sourceSegmentIds: [previous.id, segment.id, confirmation.id],
        confidence: Math.max(segment.confidence ?? 0.8, confirmation.confidence ?? 0.8),
        clarificationState: "confirmed",
        refinementOfSegmentId: previous.id,
      })
    }
    for (const segment of input.recentSegments.filter((item) => item.speaker === "interviewer")) {
      if (clarifiedPromptIds.has(segment.id)) continue
      const text = cleanupQuestionText(segment.text)
      if (!looksLikeQuestionText(text)) continue
      const normalized = normalizeQuestionText(text)
      if (!normalized || existing.has(normalized)) continue
      existing.add(normalized)
      questions.push({
        text,
        answerGoal: text,
        sourceSegmentIds: [segment.id],
        confidence: segment.confidence ?? undefined,
      })
    }
    return {
      contextVersion: input.contextVersion,
      turnComplete: true,
      conversationPhase: "normal_interview",
      questions,
    }
  }
}

export function emptyQuestionDetectionResult(contextVersion?: number): QuestionDetectionResult {
  return {
    contextVersion,
    turnComplete: true,
    conversationPhase: "normal_interview",
    questions: [],
  }
}

export function normalizeQuestionText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[?!？！，,.;；：:"“”'‘’()\[\]{}]/g, "")
    .replace(/\s+/g, " ")
}

export function buildInterviewQuestionDetectionMessages(input: {
  recentSegments: TranscriptSegment[]
  existingQuestionTexts: string[]
  existingCoverageSummaries?: string[]
  primaryProjectState?: PrimaryProjectState
  projectProfiles?: readonly InterviewProjectProfile[]
  reverseQuestionPhaseActive?: boolean
}): ChatMessage[] {
  const projectNames = projectProfileNames(input.projectProfiles)
  const projectRoutingHints = buildProjectRoutingHints(input.projectProfiles)
  const projectRoutingInstructions = projectNames.length > 0
    ? [
        `- 如果问题明确对应已配置项目，尽量输出 projectCategory，且只能从这些值中选择：${projectNames.join("、")}；非项目问题不要输出 projectCategory。`,
        "- 项目路由线索：",
        ...projectRoutingHints.map((hint) => `  - ${hint}`),
      ]
    : [
        "- 当前没有配置项目画像，不要输出 projectCategory。",
      ]
  const schemaExample = projectNames.length > 0
    ? `JSON schema: {"turnComplete":true,"turnReason":"简短原因","conversationPhase":"normal_interview","questions":[{"text":"清晰的问题文本","answerGoal":"canonical topic","topic":"稳定主题","intent":"方法","entities":["关键实体"],"questionType":"项目方法方案类","projectCategory":"${projectNames[0]}","routingReason":"命中已配置项目","sourceSegmentIds":["seg-id-1"],"confidence":0.0}]}`
    : 'JSON schema: {"turnComplete":true,"turnReason":"简短原因","conversationPhase":"normal_interview","questions":[{"text":"清晰的问题文本","answerGoal":"canonical topic","topic":"稳定主题","intent":"方法","entities":["关键实体"],"questionType":"项目方法方案类","routingReason":"问题类型依据","sourceSegmentIds":["seg-id-1"],"confidence":0.0}]}'
  return [
    {
      role: "system",
      content: [
        "你是一个实时面试问题语义抽取器。你的任务不是复述每个问句，而是从 ASR 对话片段中抽取“值得触发知识库/LLM 回答”的技术或项目面试问题。",
        "",
        "先判断 turnComplete：当前问题、追问或澄清交换是否已经足够完整。若仍在等待候选人澄清或面试官确认，turnComplete=false 且 questions=[]。",
        "同时判断 conversationPhase：normal_interview 表示正常面试；reverse_question 表示面试官已进入“你有什么想问我”等候选人反问阶段；resumed_evaluation 表示反问后面试官明确恢复技术或项目评估。",
        "",
        "抽取规则：",
        "- 同时阅读双方发言，不要依赖 speaker；speaker/source 只能作为弱提示。",
        "- 只抽取技术问题、项目问题、测试/开发/架构/算法/AI 实践/质量保障/工程流程相关问题。",
        "- 忽略寒暄、姓名确认、自我介绍、职级、离职原因、通勤、薪资、候选人反问岗位等非技术内容。",
        "- 忽略细小确认或事实核对问题，例如“是 SDK 接到客户端上吗？”“是 HTTP 接口吗？”“就你一个人吗？”。",
        "- 面试官提出问题、候选人澄清、面试官确认时，要合并成一个更明确的问题。",
        "- 同一主题且答题目标相同的连续追问要合并，不要拆成多个碎片问题；同主题但需要明显不同回答的追问要保留为独立问题。",
        "- 每个问题必须输出 answerGoal：它是 4-14 个中文字的 canonical topic，用名词短语表达答题目标，不要以“描述/说明/介绍/讲解/回答”开头，不要写“具体内容和细节”。",
        "- 每个问题必须输出 topic、intent、entities，用于本地保守去重：topic 是稳定主题名词短语；intent 是答题意图；entities 是关键实体/技术词数组。",
        "- intent 只能从这些通用标签中选择：流程、方法、实现、影响、监控评估、工具实践、项目经验、架构设计、问题排查、质量标准、其他。",
        `- 同时尽量输出 questionType，且只能从这些值中选择：${INTERVIEW_QUESTION_TYPES.join("、")}。`,
        ...projectRoutingInstructions,
        "- 如果是短追问且当前话题没有明显切换，可以参考用户消息里的 currentProjectContext 作为项目分类线索。",
        "- questionType/projectCategory 只是分类提示；不能确定时宁可省略，也不要编造项目或类型。",
        "- routingReason 可用 20 个中文字以内解释分类依据。",
        "- 判断是否重复时以 topic + intent 为准：同 topic 但 intent 不同的问题应保留，例如“ASR准确率/影响”和“ASR准确率/监控评估”是两个问题。",
        "- answerGoal 示例：产研项目测试流程、搜索质量平台测试、Python SDK交互脚本、AI测试实践工具应用、Java接口开发流程、模型准确率生产影响、生产模型准确率监控评估。",
        "- topic/intent 示例：topic=模型准确率 intent=影响；topic=模型准确率 intent=监控评估；topic=AI测试实践 intent=工具实践；topic=Java接口 intent=流程。",
        "- 如果进入候选人反问阶段，conversationPhase=reverse_question；候选人询问岗位、团队、业务、流程、AI岗位职责等问题可以作为候选输出，但要标清 answerGoal，后续会本地抑制。",
        "- 最多输出 3 个清晰、独立、适合查询知识库并生成回答的中文问题。",
        "- 已有问题中已经覆盖的语义，不要重复输出。",
        "- 如果当前片段没有新的有效技术/项目问题，返回空数组。",
        "",
        "判断尺度示例：",
        "- “项目流程是指什么？测试流程吗？项目就包括产品研发测试。整个产研项目流程是怎样的？” => “产研的一个项目流程是怎样的？测试的流程是什么？”",
        "- “搜索质量平台里的召回模型，这个模型怎么测？你是怎么测的？” => “搜索质量平台的召回模型是如何测试的？”",
        "- “用 Python 脚本怎么样和 SDK 做交互？脚本大概怎么写？” => “你的语音算法测试 Python 大概是怎么写的？”",
        "- “AI 这一块实践情况？用过哪些工具？AI 在测试中的应用？” => “你有 AI 实践的情况吗？用过哪些 AI 工具？AI 在测试中有什么应用吗？”",
        "- “Java 去开发一个接口，大概流程是什么样？” => “Java 开发一个接口的流程是什么样的？”",
        "- “算法准确或者不准确，对生产不会产生什么影响吧？”这类质疑式追问 => “算法准确率下降对生产环境和用户体验有什么影响？”",
        "- “生产环境真实用户准确率怎么看得到？有什么监控吗？” => “如何评估或监控生产环境真实用户的 ASR 准确率？”",
        "- “SDK 接到客户端上，是吗？”、“是 HTTP 接口吗？”这类确认关系的小问题不要输出。",
        "",
        "输出要求：只返回紧凑 JSON，不要 markdown，不要解释。turnReason 不超过 20 个中文字。",
        schemaExample,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "已有问题：",
        JSON.stringify(input.existingQuestionTexts, null, 2),
        "",
        "已覆盖答题目标：",
        JSON.stringify(input.existingCoverageSummaries ?? [], null, 2),
        "",
        "currentProjectContext：",
        JSON.stringify({
          currentProject: input.primaryProjectState?.currentProject ?? null,
          status: input.primaryProjectState?.status ?? "empty",
        }, null, 2),
        "",
        `当前是否已在反问阶段：${input.reverseQuestionPhaseActive ? "是" : "否"}`,
        "",
        "最近 confirmed ASR 片段：",
        ...input.recentSegments.map(formatSegmentForPrompt),
      ].join("\n"),
    },
  ]
}

export function parseLlmQuestionDetectionResult(
  output: string,
  validSegmentIds: Set<string>,
  contextVersion?: number,
  projectProfiles: readonly InterviewProjectProfile[] = [],
): QuestionDetectionResult {
  const jsonText = extractJsonObject(output)
  if (!jsonText) return emptyQuestionDetectionResult(contextVersion)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return emptyQuestionDetectionResult(contextVersion)
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.questions)) return emptyQuestionDetectionResult(contextVersion)

  const turnComplete = parsed.turnComplete !== false
  const turnReason = typeof parsed.turnReason === "string"
    ? parsed.turnReason.trim().slice(0, 80)
    : undefined
  const conversationPhase = normalizeConversationPhase(parsed.conversationPhase)
  if (!turnComplete) {
    return {
      contextVersion,
      turnComplete,
      conversationPhase,
      turnReason,
      questions: [],
    }
  }
  const questions: QuestionDetectionResult["questions"] = []
  for (const item of parsed.questions) {
    if (!isRecord(item)) continue
    const text = typeof item.text === "string" ? item.text.trim() : ""
    if (!text) continue
    const sourceSegmentIds = Array.isArray(item.sourceSegmentIds)
      ? item.sourceSegmentIds
        .filter((id): id is string => typeof id === "string" && validSegmentIds.has(id))
      : []
    if (sourceSegmentIds.length === 0) continue
    const answerGoal = normalizeAnswerGoal(item.answerGoal, text)
    const question: QuestionDetectionResult["questions"][number] = {
      text,
      answerGoal,
      sourceSegmentIds: Array.from(new Set(sourceSegmentIds)),
    }
    const topic = normalizeSemanticField(item.topic)
    const intent = normalizeSemanticField(item.intent)
    const entities = normalizeEntities(item.entities)
    const confidence = normalizeConfidence(item.confidence)
    const clarificationState = normalizeClarificationState(item.clarificationState)
    const refinementOfSegmentId = normalizeRefinementOfSegmentId(item.refinementOfSegmentId, validSegmentIds)
    if (topic) question.topic = topic
    if (intent) question.intent = intent
    if (entities.length > 0) question.entities = entities
    if (confidence !== undefined) question.confidence = confidence
    if (clarificationState) question.clarificationState = clarificationState
    if (refinementOfSegmentId) question.refinementOfSegmentId = refinementOfSegmentId
    const questionType = normalizeInterviewQuestionType(item.questionType)
    const projectCategory = normalizeInterviewProjectCategory(item.projectCategory, projectProfiles)
    const routingReason = normalizeRoutingReason(item.routingReason)
    if (questionType) question.questionType = questionType
    if (projectCategory) question.projectCategory = projectCategory
    if (routingReason) question.routingReason = routingReason
    questions.push(question)
  }
  return { contextVersion, turnComplete, conversationPhase, turnReason, questions }
}

function cleanupQuestionText(text: string): string {
  return text.trim().replace(/\s+/g, " ")
}

export function looksLikeQuestionText(text: string): boolean {
  if (!text) return false
  if (/[?？]\s*$/.test(text)) return true
  return /\b(what|why|how|when|where|which|who|tell me|describe|can you|could you|would you|do you|did you)\b/i.test(text) ||
    /(什么|为什么|如何|怎么|怎样|哪|谁|请.*(介绍|说明|描述|讲讲|说说)|能否|能不能|可以.*吗|吗|呢)/.test(text)
}

export function looksLikeCandidateClarification(text: string): boolean {
  const cleaned = cleanupQuestionText(text)
  return /[?？]\s*$/.test(cleaned) && (
    /\b(do you mean|are you asking|is it about|you mean|regarding)\b/i.test(cleaned) ||
    /(你是说|是说|是不是说|是指|是针对|关于|针对).*(吗|么|对吗|是吗)[?？]?$/i.test(cleaned)
  )
}

function extractClarifiedQuestionText(text: string): string {
  const cleaned = cleanupQuestionText(text)
  return cleaned
    .replace(/^(do you mean|are you asking|is it about|you mean)\s+/i, "")
    .replace(/^(你是说|是说|是不是说|是指|是针对)\s*/i, "")
    .replace(/[?？]\s*$/, "")
    .trim()
}

function findPreviousInterviewerPrompt(segments: TranscriptSegment[], fromIndex: number): TranscriptSegment | null {
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (segment.speaker === "interviewer") return segment
  }
  return null
}

function findFollowingInterviewerConfirmation(segments: TranscriptSegment[], fromIndex: number): TranscriptSegment | null {
  for (let index = fromIndex + 1; index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment.speaker !== "interviewer") continue
    if (looksLikeConfirmation(segment.text)) return segment
    if (looksLikeQuestionText(segment.text)) return null
  }
  return null
}

function looksLikeConfirmation(text: string): boolean {
  return /^(yes|yeah|correct|right|exactly|that's right|对|是的|没错|可以|嗯|嗯对)[.!。！\s]*$/i.test(text.trim())
}

async function collectQuestionDetectorText(
  streamChatImpl: typeof streamChat,
  llmConfig: LlmConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  let output = ""
  let error: Error | null = null
  await streamChatImpl(
    llmConfig,
    messages,
    {
      onToken: (token) => { output += token },
      onReasoningToken: () => {},
      onDone: () => {},
      onError: (err) => { error = err },
    },
    signal,
    { temperature: 0, max_tokens: 360, reasoning: { mode: "off" } },
  )
  if (error) throw error
  return output
}

function suppressDuplicateDetectedQuestions(
  questions: QuestionDetectionResult["questions"],
  existingQuestionTexts: string[],
): QuestionDetectionResult["questions"] {
  const existing = new Set(existingQuestionTexts.map(normalizeQuestionText))
  const out: QuestionDetectionResult["questions"] = []
  for (const question of questions) {
    const normalized = normalizeQuestionText(question.text)
    if (!normalized || existing.has(normalized)) continue
    existing.add(normalized)
    out.push(question)
  }
  return out
}

function formatSegmentForPrompt(segment: TranscriptSegment): string {
  return [
    `- id: ${segment.id}`,
    `  time: ${formatOffset(segment.startMs)}-${formatOffset(segment.endMs)}`,
    `  speaker: ${segment.speaker}`,
    `  source: ${segment.source}`,
    `  text: ${JSON.stringify(compactPromptSegmentText(segment.text))}`,
  ].join("\n")
}

function compactPromptSegmentText(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ")
  if (cleaned.length <= 280) return cleaned
  return `${cleaned.slice(0, 120)} ... ${cleaned.slice(-140)}`
}

function extractJsonObject(output: string): string | null {
  const stripped = output
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim()
  const start = stripped.indexOf("{")
  const end = stripped.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  return stripped.slice(start, end + 1)
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(1, value))
}

function normalizeClarificationState(value: unknown): QuestionDetectionResult["questions"][number]["clarificationState"] {
  return value === "none" ||
    value === "candidate_clarifying" ||
    value === "confirmed" ||
    value === "rejected"
    ? value
    : undefined
}

function normalizeRefinementOfSegmentId(value: unknown, validSegmentIds: Set<string>): string | undefined {
  return typeof value === "string" && validSegmentIds.has(value) ? value : undefined
}

function normalizeConversationPhase(value: unknown): ConversationPhase {
  return value === "reverse_question" || value === "resumed_evaluation" || value === "normal_interview"
    ? value
    : "normal_interview"
}

function normalizeAnswerGoal(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : ""
  return canonicalizeAnswerGoalText(text || fallback.trim(), fallback).slice(0, 80)
}

function normalizeSemanticField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const text = canonicalizeAnswerGoalText(value.trim())
  return text ? text.slice(0, 60) : undefined
}

function normalizeEntities(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== "string") continue
    const entity = item.trim().replace(/\s+/g, " ").slice(0, 40)
    if (entity && !out.includes(entity)) out.push(entity)
    if (out.length >= 8) break
  }
  return out
}

function normalizeRoutingReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.trim().replace(/\s+/g, " ")
  return text ? text.slice(0, 80) : undefined
}

export function canonicalizeAnswerGoalText(value: string, fallback = value): string {
  const raw = (value.trim() || fallback.trim()).replace(/\s+/g, " ")
  const stripped = raw
    .replace(/^(描述|说明|介绍|讲解|回答|阐述|总结)\s*/i, "")
    .replace(/^(之前团队的|之前的|团队的)\s*/i, "")
    .replace(/^(一下|一下子|清楚)?(在|关于|针对)?/i, "")
    .replace(/(方式|方法)和流程/g, "流程")
    .replace(/全流程/g, "流程")
    .replace(/(的)?(具体(内容|细节|情况)|内容和细节|细节|情况)$/i, "")
    .replace(/具体|相关|一个|一些|大概/g, "")
    .replace(/[的]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return stripped || raw
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
