import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  createEmptyProjectProfileSet,
  loadProjectProfilesFromStorage,
  projectProfileStorage,
  saveProjectProfilesToStorage,
} from "@/lib/interview-project-profiles"
import {
  createDefaultPromptTemplates,
  getAnswerPromptTemplateTextMap,
  loadPromptTemplatesFromStorage,
  projectPromptTemplateStorage,
  updatePromptTemplateInStorage,
} from "@/lib/interview-settings"
import type {
  AnswerPromptTemplateFamily,
  InterviewAssistantState,
  InterviewProjectProfileSet,
  PromptTemplateSet,
} from "@/lib/interview-types"
import { createInterviewAssistant, createProductionInterviewStartInput } from "@/lib/interview-assistant"
import { saveInterviewMarkdownExport } from "@/lib/interview-export"
import { selectInterviewAssistantState, useInterviewStore } from "@/stores/interview-store"
import { PromptTemplatePanel } from "./prompt-template-panel"
import { ProjectProfilePanel } from "./project-profile-panel"
import { InterviewControls } from "./interview-controls"
import { TranscriptStream } from "./transcript-stream"
import { QuestionQueue } from "./question-queue"

export interface InterviewViewModel {
  startDisabled: boolean
  endDisabled: boolean
  resetVisible: boolean
  statusKey: string
}

export function getInterviewViewModel(state: InterviewAssistantState): InterviewViewModel {
  return {
    startDisabled: !state.startInterviewEnabled,
    endDisabled: !state.endInterviewEnabled,
    resetVisible: state.sessionStatus === "ended",
    statusKey: statusKeyFor(state.sessionStatus),
  }
}

export function InterviewView() {
  const { t } = useTranslation()
  const assistantState = useInterviewStore(selectInterviewAssistantState)
  const session = useInterviewStore((s) => s.session)
  const answerRequests = useInterviewStore((s) => s.answerRequests)
  const setAudioSource = useInterviewStore((s) => s.setAudioSource)
  const resetSession = useInterviewStore((s) => s.resetSession)
  const model = getInterviewViewModel(assistantState)
  const savedPromptTemplatesRef = useRef<PromptTemplateSet>(createDefaultPromptTemplates())
  const savedProjectProfilesRef = useRef<InterviewProjectProfileSet>(createEmptyProjectProfileSet())
  const assistant = useMemo(() => createInterviewAssistant({
    answerPromptTemplates: () => getAnswerPromptTemplateTextMap(savedPromptTemplatesRef.current),
    projectProfiles: () => savedProjectProfilesRef.current.profiles,
  }), [])
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplateSet>(() => savedPromptTemplatesRef.current)
  const [projectProfiles, setProjectProfiles] = useState<InterviewProjectProfileSet>(() => savedProjectProfilesRef.current)
  const [actionError, setActionError] = useState<string | null>(null)
  const [exportPath, setExportPath] = useState<string | null>(null)
  const [savingAnswerTemplate, setSavingAnswerTemplate] = useState<AnswerPromptTemplateFamily | null>(null)
  const [savingProjectProfiles, setSavingProjectProfiles] = useState(false)

  useEffect(() => {
    let active = true
    Promise.all([
      loadPromptTemplatesFromStorage(projectPromptTemplateStorage),
      loadProjectProfilesFromStorage(projectProfileStorage),
    ]).then(([templates, profiles]) => {
      if (!active) return
      savedPromptTemplatesRef.current = templates
      savedProjectProfilesRef.current = profiles
      setPromptTemplates(templates)
      setProjectProfiles(profiles)
    }).catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  function handleAnswerTemplateChange(family: AnswerPromptTemplateFamily, value: string) {
    setPromptTemplates((current) => ({
      ...current,
      answerTemplates: {
        ...current.answerTemplates,
        [family]: {
          ...current.answerTemplates[family],
          text: value,
          isDefault: value.trim() === createDefaultPromptTemplates().answerTemplates[family].text,
        },
      },
    }))
  }

  async function handleSaveAnswerTemplate(family: AnswerPromptTemplateFamily) {
    setActionError(null)
    setSavingAnswerTemplate(family)
    try {
      const text = promptTemplates.answerTemplates[family].text
      const templates = await updatePromptTemplateInStorage(projectPromptTemplateStorage, family, text)
      savedPromptTemplatesRef.current = templates
      setPromptTemplates(templates)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingAnswerTemplate(null)
    }
  }

  async function handleResetAnswerTemplate(family: AnswerPromptTemplateFamily) {
    setActionError(null)
    setSavingAnswerTemplate(family)
    try {
      const text = createDefaultPromptTemplates().answerTemplates[family].text
      const templates = await updatePromptTemplateInStorage(projectPromptTemplateStorage, family, text)
      savedPromptTemplatesRef.current = templates
      setPromptTemplates(templates)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingAnswerTemplate(null)
    }
  }

  async function handleSaveProjectProfiles() {
    setActionError(null)
    setSavingProjectProfiles(true)
    try {
      const saved = await saveProjectProfilesToStorage(projectProfileStorage, projectProfiles)
      savedProjectProfilesRef.current = saved
      setProjectProfiles(saved)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingProjectProfiles(false)
    }
  }

  async function handleEnd() {
    setActionError(null)
    await assistant.end().catch((error) => {
      setActionError(error instanceof Error ? error.message : String(error))
    })
  }

  async function handleReset() {
    setActionError(null)
    setExportPath(null)
    await assistant.end().catch((error) => {
      setActionError(error instanceof Error ? error.message : String(error))
    })
    resetSession()
  }

  async function handleStartProduction() {
    setActionError(null)
    await assistant.start(createProductionInterviewStartInput()).catch((error) => {
      setActionError(error instanceof Error ? error.message : String(error))
    })
  }

  async function handleStartDebug() {
    if (!session.audioSource || session.audioSource.kind !== "file") return
    setActionError(null)
    await assistant.start({ mode: "debug", file: session.audioSource as typeof session.audioSource & { kind: "file" } }).catch((error) => {
      setActionError(error instanceof Error ? error.message : String(error))
    })
  }

  async function handleExportMarkdown() {
    setActionError(null)
    setExportPath(null)
    try {
      setExportPath(await saveInterviewMarkdownExport({
        session,
        answerRequests,
        statusEvents: assistantState.fullStatusEvents,
      }))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <main className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">{t("interview.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t(model.statusKey)}</p>
          </div>
        </div>
      </div>
      <InterviewControls
        selectedSource={assistantState.selectedAudioSource}
        sessionStatus={assistantState.sessionStatus}
        startDisabled={model.startDisabled}
        endDisabled={model.endDisabled}
        onSourceChange={setAudioSource}
        onStartProduction={handleStartProduction}
        onStartDebug={handleStartDebug}
        onEnd={handleEnd}
        onReset={handleReset}
      />
      <section className="shrink-0 border-b px-6 py-4">
        <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,0.95fr)]">
          <PromptTemplatePanel
            answerTemplates={promptTemplates.answerTemplates}
            savingAnswerTemplate={savingAnswerTemplate}
            onAnswerTemplateChange={handleAnswerTemplateChange}
            onSaveAnswerTemplate={(family) => void handleSaveAnswerTemplate(family)}
            onResetAnswerTemplate={(family) => void handleResetAnswerTemplate(family)}
          />
          <ProjectProfilePanel
            profileSet={projectProfiles}
            saving={savingProjectProfiles}
            onChange={setProjectProfiles}
            onSave={() => void handleSaveProjectProfiles()}
          />
        </div>
      </section>
      <section className="grid min-h-0 flex-1 gap-4 px-6 py-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]">
        <TranscriptStream
          segments={session.transcriptSegments}
          streams={session.audioStreams}
          primaryProjectState={session.primaryProjectState}
        />
        <div className="flex min-h-0 flex-col gap-4">
          <section className="rounded-md border px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium">{t("interview.export.title")}</div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleExportMarkdown}
                disabled={
                  session.transcriptSegments.length === 0 &&
                  session.questions.length === 0 &&
                  answerRequests.length === 0 &&
                  assistantState.fullStatusEvents.length === 0
                }
              >
                <Download className="h-4 w-4" />
                {t("interview.export.markdown")}
              </Button>
            </div>
            <div className="mt-1 text-muted-foreground">
              {t("interview.export.summary", {
                transcript: session.transcriptSegments.length,
                questions: session.questions.length,
                answers: answerRequests.length,
              })}
            </div>
            {exportPath && (
              <div className="mt-2 break-all text-xs text-muted-foreground">
                {t("interview.export.savedTo", { path: exportPath })}
              </div>
            )}
          </section>
          {actionError && <div className="rounded-md border px-4 py-3 text-sm text-destructive">{actionError}</div>}
          <QuestionQueue
            questions={session.questions}
            onRetry={(questionId) => void assistant.retryQuestion(questionId)}
            onSkip={assistant.skipQuestion}
            onMarkComplete={assistant.markQuestionComplete}
          />
          <section className="min-h-0 rounded-md border">
            <div className="border-b px-4 py-3 text-sm font-semibold">{t("interview.events")}</div>
            <div className="max-h-40 overflow-auto px-4 py-3">
              {assistantState.statusEvents.length === 0 ? (
                <div className="text-sm text-muted-foreground">{t("interview.emptyEvents")}</div>
              ) : (
                <div className="space-y-2">
                  {assistantState.statusEvents.slice(-8).map((event) => (
                    <div key={event.id} className="text-xs">
                      <span className="font-medium">{event.kind}</span>
                      <span className="ml-2 text-muted-foreground">{event.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </section>
    </main>
  )
}

function statusKeyFor(sessionStatus: InterviewAssistantState["sessionStatus"]): string {
  if (sessionStatus === "connecting") return "interview.status.connecting"
  if (sessionStatus === "listening") return "interview.status.listening"
  if (sessionStatus === "degraded") return "interview.status.degraded"
  if (sessionStatus === "retrying") return "interview.status.retrying"
  if (sessionStatus === "failed") return "interview.status.failed"
  if (sessionStatus === "ended") return "interview.status.ended"
  return "interview.status.ready"
}
