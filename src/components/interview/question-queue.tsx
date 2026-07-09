import { useTranslation } from "react-i18next"
import { Check, RotateCcw, SkipForward } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { DetectedQuestion } from "@/lib/interview-types"
import { deriveQuestionWaitingMs } from "@/stores/interview-store"

export interface QuestionQueueItem {
  id: string
  text: string
  statusKey: string
  clarificationKey: string | null
  questionType: string | null
  projectCategory: string | null
  answerPromptFamily: string | null
  sourceCount: number
  waitingLabel: string
}

export function getQuestionQueueItems(
  questions: DetectedQuestion[],
  now = Date.now(),
): QuestionQueueItem[] {
  return questions.map((question) => ({
    id: question.id,
    text: question.text,
    statusKey: `interview.questionStatus.${question.status}`,
    clarificationKey: question.clarificationState && question.clarificationState !== "none"
      ? `interview.clarificationState.${question.clarificationState}`
      : null,
    questionType: question.questionType ?? null,
    projectCategory: question.projectCategory ?? null,
    answerPromptFamily: question.answerPromptFamily ?? null,
    sourceCount: question.sourceSegmentIds.length,
    waitingLabel: formatDuration(deriveQuestionWaitingMs(question, now)),
  }))
}

interface QuestionQueueProps {
  questions: DetectedQuestion[]
  onRetry?: (questionId: string) => void
  onSkip?: (questionId: string) => void
  onMarkComplete?: (questionId: string) => void
}

export function QuestionQueue({ questions, onRetry, onSkip, onMarkComplete }: QuestionQueueProps) {
  const { t } = useTranslation()
  const items = getQuestionQueueItems(questions)

  return (
    <section className="flex min-h-0 flex-col rounded-md border">
      <div className="border-b px-4 py-3 text-sm font-semibold">{t("interview.questions")}</div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {items.length === 0 ? (
          <div className="text-sm text-muted-foreground">{t("interview.emptyQuestions")}</div>
        ) : (
          <div className="space-y-3">
            {items.map((item) => (
              <div key={item.id} className="rounded-md border px-3 py-2">
                <div className="break-words text-sm font-medium">{item.text}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{t(item.statusKey)}</span>
                  {item.clarificationKey && <span>{t(item.clarificationKey)}</span>}
                  {item.questionType && <span>{t("interview.questionMeta.type")}: {item.questionType}</span>}
                  {item.projectCategory && <span>{t("interview.questionMeta.project")}: {item.projectCategory}</span>}
                  <span>{t("interview.sourceSegments", { count: item.sourceCount })}</span>
                  <span>{t("interview.waitingFor", { duration: item.waitingLabel })}</span>
                </div>
                {questions.find((question) => question.id === item.id)?.status === "attention" && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => onRetry?.(item.id)}>
                      <RotateCcw className="h-3.5 w-3.5" />
                      {t("interview.retry")}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => onSkip?.(item.id)}>
                      <SkipForward className="h-3.5 w-3.5" />
                      {t("interview.skip")}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => onMarkComplete?.(item.id)}>
                      <Check className="h-3.5 w-3.5" />
                      {t("interview.markComplete")}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
}
