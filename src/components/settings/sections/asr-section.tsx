import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { AsrChunkingStrategy, AsrProvider, AsrResponseFormat } from "@/stores/wiki-store"
import type { DraftSetter, SettingsDraft } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

const PROVIDER_OPTIONS: Array<{ value: AsrProvider; label: string }> = [
  { value: "volcengine-streaming", label: "Volcengine streaming WebSocket" },
  { value: "openai", label: "OpenAI" },
  { value: "custom", label: "Custom OpenAI-compatible" },
]

const RESPONSE_FORMAT_OPTIONS: Array<{ value: AsrResponseFormat; label: string }> = [
  { value: "diarized_json", label: "Diarized JSON" },
  { value: "verbose_json", label: "Verbose JSON" },
  { value: "json", label: "JSON" },
]

const CHUNKING_OPTIONS: Array<{ value: AsrChunkingStrategy; labelKey: string; fallback: string }> = [
  { value: "auto", labelKey: "settings.sections.asr.chunkingAuto", fallback: "Auto" },
  { value: "none", labelKey: "settings.sections.asr.chunkingNone", fallback: "None" },
]

export function AsrSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const streaming = draft.asrProvider === "volcengine-streaming"

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.asr.title", "ASR transcription")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "settings.sections.asr.description",
            "Dedicated speech-to-text settings for the Interview Assistant. These do not affect the main chat model.",
          )}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.asr.provider", "Provider")}</Label>
        <select
          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          value={draft.asrProvider}
          onChange={(event) => setDraft("asrProvider", event.target.value as AsrProvider)}
        >
          {PROVIDER_OPTIONS.map((provider) => (
            <option key={provider.value} value={provider.value}>
              {provider.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.asr.endpoint", "Endpoint")}</Label>
        <Input
          value={draft.asrEndpoint}
          onChange={(event) => setDraft("asrEndpoint", event.target.value)}
          placeholder={streaming
            ? "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
            : "https://api.openai.com/v1/audio/transcriptions"}
        />
        <p className="text-xs text-muted-foreground">
          {streaming
            ? t(
                "settings.sections.asr.streamingEndpointHint",
                "Official optimized bidirectional streaming ASR WebSocket endpoint.",
              )
            : draft.asrProvider === "custom"
            ? t(
                "settings.sections.asr.customEndpointHint",
                "Use either a full /audio/transcriptions URL or an OpenAI-compatible /v1 base URL.",
              )
            : t(
                "settings.sections.asr.openaiEndpointHint",
                "OpenAI transcription endpoint. Leave as default unless you need a proxy gateway.",
              )}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.asr.apiKey", "API key")}</Label>
        <Input
          type="password"
          value={draft.asrApiKey}
          onChange={(event) => setDraft("asrApiKey", event.target.value)}
          placeholder={t("settings.sections.asr.apiKeyPlaceholder", "ASR provider API key")}
        />
      </div>

      {streaming ? (
        <>
          <div className="space-y-2">
            <Label>{t("settings.sections.asr.resourceId", "Resource ID")}</Label>
            <Input
              value={draft.asrResourceId}
              onChange={(event) => setDraft("asrResourceId", event.target.value)}
              placeholder="volc.bigasr.sauc.duration"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label>{t("settings.sections.asr.packetMs", "Packet duration (ms)")}</Label>
              <Input
                type="number"
                min={100}
                max={200}
                value={draft.asrPacketMs}
                onChange={(event) => setDraft("asrPacketMs", Number(event.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("settings.sections.asr.endWindowSizeMs", "End window (ms)")}</Label>
              <Input
                type="number"
                min={200}
                value={draft.asrEndWindowSizeMs}
                onChange={(event) => setDraft("asrEndWindowSizeMs", Number(event.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("settings.sections.asr.forceToSpeechTimeMs", "Force speech time (ms)")}</Label>
              <Input
                type="number"
                min={1}
                value={draft.asrForceToSpeechTimeMs}
                onChange={(event) => setDraft("asrForceToSpeechTimeMs", Number(event.target.value))}
              />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.asrEnableNonstream}
                onChange={(event) => setDraft("asrEnableNonstream", event.target.checked)}
              />
              {t("settings.sections.asr.enableNonstream", "Enable final/definite output")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.asrShowUtterances}
                onChange={(event) => setDraft("asrShowUtterances", event.target.checked)}
              />
              {t("settings.sections.asr.showUtterances", "Show utterances")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.asrEnableSpeakerInfo}
                onChange={(event) => setDraft("asrEnableSpeakerInfo", event.target.checked)}
              />
              {t("settings.sections.asr.enableSpeakerInfo", "Speaker info")}
            </label>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-2">
            <Label>{t("settings.sections.asr.model", "Model")}</Label>
            <Input
              value={draft.asrModel}
              onChange={(event) => setDraft("asrModel", event.target.value)}
              placeholder="gpt-4o-transcribe-diarize"
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "settings.sections.asr.modelHint",
                "Use a diarization-capable model with Diarized JSON when you want speaker labels.",
              )}
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("settings.sections.asr.responseFormat", "Response format")}</Label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={draft.asrResponseFormat}
                onChange={(event) => setDraft("asrResponseFormat", event.target.value as AsrResponseFormat)}
              >
                {RESPONSE_FORMAT_OPTIONS.map((format) => (
                  <option key={format.value} value={format.value}>
                    {format.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label>{t("settings.sections.asr.chunkingStrategy", "Chunking")}</Label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={draft.asrChunkingStrategy}
                onChange={(event) => setDraft("asrChunkingStrategy", event.target.value as AsrChunkingStrategy)}
              >
                {CHUNKING_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey, option.fallback)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
