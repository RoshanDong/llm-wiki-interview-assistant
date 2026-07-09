import { useState } from "react"
import { RotateCcw, Save } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  createDefaultAnswerPromptTemplatePreviews,
  validateAnswerPromptTemplate,
} from "@/lib/interview-settings"
import type {
  AnswerPromptTemplateFamily,
  PromptTemplateSet,
} from "@/lib/interview-types"

interface PromptTemplatePanelProps {
  answerTemplates: PromptTemplateSet["answerTemplates"]
  savingAnswerTemplate: AnswerPromptTemplateFamily | null
  onAnswerTemplateChange: (family: AnswerPromptTemplateFamily, value: string) => void
  onSaveAnswerTemplate: (family: AnswerPromptTemplateFamily) => void
  onResetAnswerTemplate: (family: AnswerPromptTemplateFamily) => void
}

export function PromptTemplatePanel({
  answerTemplates,
  savingAnswerTemplate,
  onAnswerTemplateChange,
  onSaveAnswerTemplate,
  onResetAnswerTemplate,
}: PromptTemplatePanelProps) {
  const { t } = useTranslation()
  const answerTemplatePreviews = createDefaultAnswerPromptTemplatePreviews(answerTemplates)
  const [selectedFamily, setSelectedFamily] = useState(answerTemplatePreviews[0].answerPromptFamily)
  const selectedTemplate =
    answerTemplatePreviews.find((template) => template.answerPromptFamily === selectedFamily) ??
    answerTemplatePreviews[0]
  const selectedStoredTemplate = answerTemplates[selectedTemplate.answerPromptFamily]
  const selectedTemplateValidation = validateAnswerPromptTemplate(selectedTemplate.text)
  const savingSelectedTemplate = savingAnswerTemplate === selectedTemplate.answerPromptFamily
  const selectedTemplateIsDefault = selectedStoredTemplate?.isDefault ?? false

  return (
    <section className="min-h-0 rounded-md border p-3">
      <div className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t("interview.answerPromptTemplates")}</h2>
        </div>
        <p className="text-xs text-muted-foreground">{t("interview.answerPromptTemplatesDescription")}</p>
        <div className="grid min-h-0 gap-3 md:grid-cols-[minmax(8rem,0.36fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-1">
            {answerTemplatePreviews.map((template) => {
              const active = template.answerPromptFamily === selectedTemplate.answerPromptFamily
              const retrievalPolicyLabel = t(retrievalPolicyLabelKey(template.retrievalPolicy))
              return (
                <button
                  key={template.answerPromptFamily}
                  type="button"
                  onClick={() => setSelectedFamily(template.answerPromptFamily)}
                  className={[
                    "w-full rounded-md border px-3 py-2 text-left text-xs transition-colors",
                    active ? "border-ring bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
                  ].join(" ")}
                  title={`${template.questionType} · ${retrievalPolicyLabel}`}
                >
                  <span className="block truncate font-medium">{template.questionType}</span>
                  <span className="mt-1 block truncate">{retrievalPolicyLabel}</span>
                </button>
              )
            })}
          </div>
          <div className="min-w-0 rounded-md border">
            <div className="flex items-start justify-between gap-3 border-b px-3 py-2 text-xs">
              <div className="min-w-0">
                <div className="truncate font-medium">{selectedTemplate.questionType}</div>
                <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                  <span className="max-w-full truncate">{t(retrievalPolicyLabelKey(selectedTemplate.retrievalPolicy))}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={savingSelectedTemplate || selectedTemplateIsDefault}
                  onClick={() => onResetAnswerTemplate(selectedTemplate.answerPromptFamily)}
                  title={t("interview.resetDefault")}
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={savingSelectedTemplate || !selectedTemplateValidation.ok}
                  onClick={() => onSaveAnswerTemplate(selectedTemplate.answerPromptFamily)}
                  title={selectedTemplateValidation.ok ? t("interview.saveTemplate") : selectedTemplateValidation.error}
                >
                  <Save className="h-4 w-4" />
                  {savingSelectedTemplate ? t("interview.savingTemplate") : t("interview.saveTemplate")}
                </Button>
              </div>
            </div>
            <textarea
              value={selectedTemplate.text}
              onChange={(event) =>
                onAnswerTemplateChange(selectedTemplate.answerPromptFamily, event.currentTarget.value)
              }
              className="max-h-64 min-h-40 w-full resize-y border-0 bg-background px-3 py-2 text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>
        </div>
      </div>
    </section>
  )
}

function retrievalPolicyLabelKey(policy: string): string {
  if (policy === "project_grounded") return "interview.retrievalPolicy.projectGrounded"
  if (policy === "knowledge_first_with_fallback") return "interview.retrievalPolicy.knowledgeFirst"
  if (policy === "direct_no_project_grounding") return "interview.retrievalPolicy.direct"
  return "interview.retrievalPolicy.unknown"
}
