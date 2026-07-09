import { open } from "@tauri-apps/plugin-dialog"
import { FileAudio, Mic, MonitorSpeaker, Play, RotateCcw, Square } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { createAudioSourceSelection } from "@/lib/interview-audio"
import type { AudioSourceSelection, InterviewSessionStatus } from "@/lib/interview-types"

interface InterviewControlsProps {
  selectedSource: AudioSourceSelection | null
  sessionStatus: InterviewSessionStatus
  startDisabled: boolean
  endDisabled: boolean
  onSourceChange: (source: AudioSourceSelection) => void
  onStartProduction: () => void
  onStartDebug: () => void
  onEnd: () => void
  onReset: () => void
}

export interface InterviewControlsModel {
  sourcesLocked: boolean
  startDisabled: boolean
  debugStartDisabled: boolean
  endDisabled: boolean
  resetVisible: boolean
}

export function getInterviewControlsModel(
  sessionStatus: InterviewSessionStatus,
  startDisabled: boolean,
  endDisabled: boolean,
  selectedSource: AudioSourceSelection | null = null,
): InterviewControlsModel {
  return {
    sourcesLocked:
      sessionStatus === "connecting" ||
      sessionStatus === "listening" ||
      sessionStatus === "degraded" ||
      sessionStatus === "retrying" ||
      sessionStatus === "ending",
    startDisabled,
    debugStartDisabled: startDisabled || selectedSource?.kind !== "file",
    endDisabled,
    resetVisible: sessionStatus === "ended",
  }
}

const AUDIO_FILE_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "webm", "mp4"]

export function InterviewControls({
  selectedSource,
  sessionStatus,
  startDisabled,
  endDisabled,
  onSourceChange,
  onStartProduction,
  onStartDebug,
  onEnd,
  onReset,
}: InterviewControlsProps) {
  const { t } = useTranslation()
  const model = getInterviewControlsModel(sessionStatus, startDisabled, endDisabled, selectedSource)
  const handleDebugFileClick = async () => {
    const label = t("interview.audio.debugFile")
    const selected = await open({
      multiple: false,
      title: label,
      filters: [{ name: "Audio", extensions: AUDIO_FILE_EXTENSIONS }],
    })
    const filePath = Array.isArray(selected) ? selected[0] : selected
    if (!filePath || typeof filePath !== "string") return
    onSourceChange(createAudioSourceSelection(
      "file",
      fileNameFromPath(filePath) ?? label,
      Date.now(),
      undefined,
      filePath,
    ))
  }

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border px-3 py-2 text-sm">
          <MonitorSpeaker className="h-4 w-4" />
          <Mic className="h-4 w-4" />
          <span>{t("interview.audio.productionDual")}</span>
        </div>
        <Button
          type="button"
          variant={selectedSource?.kind === "file" ? "secondary" : "outline"}
          disabled={model.sourcesLocked}
          onClick={() => void handleDebugFileClick()}
        >
          <FileAudio className="h-4 w-4" />
          <span className="max-w-48 truncate">
            {selectedSource?.kind === "file" && selectedSource.fileName
              ? selectedSource.fileName
              : t("interview.audio.debugFile")}
          </span>
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="max-w-72 text-xs text-muted-foreground">{t("interview.recordingNotice")}</span>
        <Button type="button" disabled={model.startDisabled} onClick={onStartProduction}>
          <Play className="h-4 w-4" />
          {t("interview.startInterview")}
        </Button>
        <Button type="button" variant="outline" disabled={model.debugStartDisabled} onClick={onStartDebug}>
          <FileAudio className="h-4 w-4" />
          {t("interview.startDebugReplay")}
        </Button>
        <Button type="button" variant="outline" disabled={model.endDisabled} onClick={onEnd}>
          <Square className="h-4 w-4" />
          {t("interview.endInterview")}
        </Button>
        {model.resetVisible && (
          <Button type="button" variant="secondary" onClick={onReset}>
            <RotateCcw className="h-4 w-4" />
            {t("interview.resetInterviewState")}
          </Button>
        )}
      </div>
    </section>
  )
}

function fileNameFromPath(path: string): string | null {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? null
}
