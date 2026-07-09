import { useTranslation } from "react-i18next"
import type { AudioInputStreamState, PrimaryProjectState, TranscriptSegment } from "@/lib/interview-types"

export interface TranscriptStreamItem {
  id: string
  timestamp: string
  speakerKey: string
  sourceKey: string
  asrLatency: string
  text: string
}

export interface TranscriptPrimaryProjectStateItem {
  projectLabel: string
  statusKey: string
  detailLabel: string
}

export function getTranscriptStreamItems(
  segments: TranscriptSegment[],
): TranscriptStreamItem[] {
  return segments.filter((segment) => (segment.state ?? "confirmed") === "confirmed").map((segment) => ({
    id: segment.id,
    timestamp: formatOffset(segment.startMs),
    speakerKey: `interview.speaker.${segment.speaker}`,
    sourceKey: `interview.audio.${segment.source}`,
    asrLatency: formatLatency(segment.asrLatencyMs),
    text: segment.text,
  }))
}

export function getTranscriptPrimaryProjectStateItem(
  primaryProjectState?: PrimaryProjectState,
): TranscriptPrimaryProjectStateItem {
  const state = primaryProjectState ?? {
    currentProject: null,
    status: "empty",
    updatedAt: null,
    sourceQuestionId: null,
    reason: null,
  }
  return {
    projectLabel: state.currentProject ?? "-",
    statusKey: `interview.primaryProjectStatus.${state.status}`,
    detailLabel: [
      state.reason,
      state.sourceQuestionId ? `question=${state.sourceQuestionId}` : null,
    ].filter(Boolean).join(" · ") || "-",
  }
}

interface TranscriptStreamProps {
  segments: TranscriptSegment[]
  streams?: AudioInputStreamState[]
  primaryProjectState?: PrimaryProjectState
}

export function TranscriptStream({ segments, streams = [], primaryProjectState }: TranscriptStreamProps) {
  const { t } = useTranslation()
  const items = getTranscriptStreamItems(segments)
  const projectState = getTranscriptPrimaryProjectStateItem(primaryProjectState)

  return (
    <section className="flex min-h-0 flex-col rounded-md border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="text-sm font-semibold">{t("interview.transcript")}</div>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span className="rounded-sm border px-2 py-1" title={projectState.detailLabel}>
            {t("interview.primaryProject")}: {projectState.projectLabel} · {t(projectState.statusKey)}
          </span>
          {streams.length > 0 && (
            <>
            {streams.map((stream) => (
              <span key={stream.id} className="rounded-sm border px-2 py-1">
                {t(`interview.audio.${stream.kind}`)} · {t(`interview.streamStatus.${stream.status}`)}
              </span>
            ))}
            </>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {items.length === 0 ? (
          <div className="text-sm text-muted-foreground">{t("interview.emptyTranscript")}</div>
        ) : (
          <div className="space-y-3">
            {items.map((item) => (
              <div
                key={item.id}
                className="grid grid-cols-[4rem_8rem_7rem_7rem_1fr] gap-2 text-sm"
              >
                <span className="tabular-nums text-muted-foreground">{item.timestamp}</span>
                <span className="font-medium">{t(item.sourceKey)}</span>
                <span>{t(item.speakerKey)}</span>
                <span className="tabular-nums text-muted-foreground">
                  {t("interview.asrLatency", { duration: item.asrLatency })}
                </span>
                <span className="min-w-0 break-words">{item.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function formatLatency(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "-"
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}
