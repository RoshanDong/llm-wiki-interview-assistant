import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { readFileAsBase64 } from "@/commands/fs"
import { getHttpFetch } from "@/lib/tauri-fetch"
import { DEFAULT_ASR_CONFIG, useWikiStore } from "@/stores/wiki-store"
import { looksLikeQuestionText } from "./interview-question-detector"
import { subscribeToInterviewAsrEvents } from "./interview-asr-events"
import type {
  AudioSourceKind,
  AudioSourceSelection,
  InterviewAsrDiagnosticEvent,
  InterviewAsrStatusEvent,
  InterviewAsrTranscriptEvent,
  SpeakerLabel,
  TranscriptSegment,
} from "./interview-types"

export interface AudioChunk {
  id: string
  sessionId?: string
  streamId?: string
  source: AudioSourceKind
  blob: Blob | null
  bytes: Uint8Array | null
  pcm16?: Uint8Array | null
  sequence?: number
  sampleRate?: 16000
  channelCount?: 1
  durationMs?: number
  isFinal?: boolean
  mimeType: string | null
  fileName?: string | null
  createdAt: number
}

export interface StreamingAudioChunk extends AudioChunk {
  sessionId: string
  streamId: string
  pcm16: Uint8Array
  bytes: Uint8Array
  blob: null
  sequence: number
  sampleRate: 16000
  channelCount: 1
  durationMs: number
  isFinal: boolean
}

export interface AudioSourceAdapter {
  kind: AudioSourceKind
  start: (source: AudioSourceSelection, signal: AbortSignal) => AsyncIterable<AudioChunk>
  stop: () => Promise<void>
}

export interface AudioCaptureSourceCapability {
  available: boolean
  reason: string | null
}

export interface AudioCaptureCapabilityReport {
  microphone: AudioCaptureSourceCapability
  system: AudioCaptureSourceCapability
}

export interface AudioCaptureCapabilityValidation {
  ok: boolean
  requiredSources: AudioSourceKind[]
  report: AudioCaptureCapabilityReport
  error: string | null
}

export interface TranscriptProvider {
  transcribe: (
    chunks: AsyncIterable<AudioChunk>,
    signal: AbortSignal,
  ) => AsyncIterable<TranscriptSegment>
}

export interface StreamingTranscriptProviderEvents {
  onStatus?: (event: InterviewAsrStatusEvent) => void
  onDiagnostic?: (event: InterviewAsrDiagnosticEvent) => void
}

export type AudioAdapterMap = Partial<Record<AudioSourceKind, AudioSourceAdapter>>

export const INTERVIEW_AUDIO_CHUNK_EVENT = "interview-audio://chunk"
export const INTERVIEW_AUDIO_STATUS_EVENT = "interview-audio://status"

export interface NativeAudioChunkEvent {
  captureId: string
  source: "system" | "microphone"
  sequence: number
  pcm16: Uint8Array
  sampleRate: 16000
  channelCount: 1
  durationMs: number
  isFinal: boolean
  createdAt: number
}

export interface NativeAudioStatusEvent {
  captureId: string
  source: "system" | "microphone"
  status: "started" | "stopped" | "failed"
  message: string
  createdAt: number
}

export function validateAudioSourceSelection(
  source: AudioSourceSelection | null,
): { ok: true } | { ok: false; error: string } {
  if (!source) return { ok: false, error: "Select one audio source before starting." }
  if (source.kind !== "system" && source.kind !== "microphone" && source.kind !== "file") {
    return { ok: false, error: "Unsupported audio source." }
  }
  if (source.kind === "file" && !source.fileName && !source.file && !source.filePath) {
    return { ok: false, error: "Select a local audio file." }
  }
  return { ok: true }
}

export function validateAudioCaptureCapabilitiesForSources(
  sources: AudioSourceSelection[],
): AudioCaptureCapabilityValidation {
  const requiredSources = Array.from(new Set(
    sources
      .map((source) => source.kind)
      .filter((kind) => kind === "system" || kind === "microphone"),
  ))
  const report = getAudioCaptureCapabilityReport()
  const failures: string[] = []

  if (requiredSources.includes("microphone") && !report.microphone.available) {
    failures.push(`Microphone: ${report.microphone.reason ?? "capture is unavailable."}`)
  }
  if (requiredSources.includes("system") && !report.system.available) {
    failures.push(`System audio: ${report.system.reason ?? "capture is unavailable."}`)
  }

  if (failures.length === 0) {
    return { ok: true, requiredSources, report, error: null }
  }

  return {
    ok: false,
    requiredSources,
    report,
    error: `Live audio capture is not available in this runtime. ${failures.join(" ")}`,
  }
}

export function getAudioCaptureCapabilityReport(): AudioCaptureCapabilityReport {
  if (hasTauriNativeAudioCapture()) {
    return {
      microphone: { available: true, reason: null },
      system: { available: true, reason: null },
    }
  }

  const devices = globalThis.navigator?.mediaDevices
  const webAudioReason = getAudioContextConstructor() ? null : "Web Audio AudioContext is unavailable."
  return {
    microphone: {
      available: typeof devices?.getUserMedia === "function" && !webAudioReason,
      reason: combineCapabilityReasons(mediaDevicesReason(devices, "getUserMedia"), webAudioReason),
    },
    system: {
      available: typeof devices?.getDisplayMedia === "function" && !webAudioReason,
      reason: combineCapabilityReasons(mediaDevicesReason(devices, "getDisplayMedia"), webAudioReason),
    },
  }
}

export function createAudioSourceSelection(
  kind: AudioSourceKind,
  label: string,
  now = Date.now(),
  file?: File,
  filePath?: string,
): AudioSourceSelection {
  return {
    kind,
    label,
    fileName: file?.name ?? fileNameFromPath(filePath),
    selectedAt: now,
    ...(file ? { file } : {}),
    ...(filePath ? { filePath } : {}),
  }
}

export class UnconfiguredTranscriptProvider implements TranscriptProvider {
  async *transcribe(_chunks: AsyncIterable<AudioChunk>, _signal: AbortSignal) {
    throw new Error("Transcript provider is not configured.")
  }
}

export interface VolcengineStreamingAsrConfig {
  endpoint: string
  apiKey: string
  resourceId: string
  packetMs: number
  enableNonstream: boolean
  showUtterances: boolean
  enableSpeakerInfo: boolean
  endWindowSizeMs: number
  forceToSpeechTimeMs: number
}

export function resolveStreamingAsrConfig(): VolcengineStreamingAsrConfig {
  const { asrConfig } = useWikiStore.getState()
  if (asrConfig.provider !== "volcengine-streaming") {
    throw new Error("Streaming ASR is not configured. Select Volcengine streaming WebSocket in Settings.")
  }
  const apiKey = asrConfig.apiKey.trim()
  const resourceId = asrConfig.resourceId.trim()
  if (!apiKey) throw new Error("Streaming ASR API key is required.")
  if (!resourceId) throw new Error("Streaming ASR resource ID is required.")
  return {
    endpoint: normalizeStreamingAsrEndpoint(asrConfig.endpoint),
    apiKey,
    resourceId,
    packetMs: clampPacketMs(asrConfig.packetMs),
    enableNonstream: asrConfig.enableNonstream,
    showUtterances: asrConfig.showUtterances,
    enableSpeakerInfo: asrConfig.enableSpeakerInfo,
    endWindowSizeMs: Math.max(200, Math.round(asrConfig.endWindowSizeMs || DEFAULT_ASR_CONFIG.endWindowSizeMs)),
    forceToSpeechTimeMs: Math.max(1, Math.round(
      asrConfig.forceToSpeechTimeMs || DEFAULT_ASR_CONFIG.forceToSpeechTimeMs,
    )),
  }
}

export function normalizeStreamingAsrEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim() || DEFAULT_ASR_CONFIG.endpoint
  if (isLegacyOpenAiBatchEndpoint(trimmed)) return DEFAULT_ASR_CONFIG.endpoint
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`
  return trimmed
}

function isLegacyOpenAiBatchEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    return url.hostname === "api.openai.com" && url.pathname.includes("/audio/transcriptions")
  } catch {
    return false
  }
}

export function createDefaultAudioAdapters(): AudioAdapterMap {
  if (hasTauriNativeAudioCapture()) {
    return {
      system: new NativeAudioSourceAdapter("system"),
      microphone: new NativeAudioSourceAdapter("microphone"),
      file: new LocalFileAudioSourceAdapter(),
    }
  }

  return {
    system: new SystemAudioSourceAdapter(),
    microphone: new MicrophoneAudioSourceAdapter(),
    file: new LocalFileAudioSourceAdapter(),
  }
}

export function normalizeNativeAudioChunkEvent(payload: unknown): NativeAudioChunkEvent | null {
  if (!isRecord(payload)) return null
  const captureId = stringValue(payload.captureId)
  const source = liveAudioSourceValue(payload.source)
  const sequence = numberValue(payload.sequence)
  const pcm16 = bytesValue(payload.pcm16)
  const sampleRate = numberValue(payload.sampleRate)
  const channelCount = numberValue(payload.channelCount)
  const durationMs = numberValue(payload.durationMs)
  if (
    !captureId ||
    !source ||
    !sequence ||
    !pcm16 ||
    sampleRate !== 16000 ||
    channelCount !== 1 ||
    !durationMs
  ) {
    return null
  }
  return {
    captureId,
    source,
    sequence,
    pcm16,
    sampleRate: 16000,
    channelCount: 1,
    durationMs,
    isFinal: payload.isFinal === true,
    createdAt: numberValue(payload.createdAt) ?? Date.now(),
  }
}

export function normalizeNativeAudioStatusEvent(payload: unknown): NativeAudioStatusEvent | null {
  if (!isRecord(payload)) return null
  const captureId = stringValue(payload.captureId)
  const source = liveAudioSourceValue(payload.source)
  const status = nativeAudioStatusValue(payload.status)
  const message = stringValue(payload.message)
  if (!captureId || !source || !status || !message) return null
  return {
    captureId,
    source,
    status,
    message,
    createdAt: numberValue(payload.createdAt) ?? Date.now(),
  }
}

export function createDefaultTranscriptProvider(): TranscriptProvider {
  return new StreamingTranscriptProvider()
}

export class StreamingTranscriptProvider implements TranscriptProvider {
  constructor(private readonly events: StreamingTranscriptProviderEvents = {}) {}

  async *transcribe(
    chunks: AsyncIterable<AudioChunk>,
    signal: AbortSignal,
  ): AsyncIterable<TranscriptSegment> {
    const queue: TranscriptSegment[] = []
    let wake: (() => void) | null = null
    let activeSession: { sessionId: string; streamId: string } | null = null
    let pumpDone = false
    let pumpError: unknown = null
    const wakeConsumer = () => {
      wake?.()
      wake = null
    }

    const unlisten = await subscribeToInterviewAsrEvents({
      onStatus: (event) => {
        if (activeSession && !matchesActiveStream(event, activeSession)) return
        this.events.onStatus?.(event)
      },
      onDiagnostic: (event) => {
        if (activeSession && !matchesActiveStream(event, activeSession)) return
        this.events.onDiagnostic?.(event)
      },
      onTranscript: (event) => {
        if (!activeSession || !matchesActiveStream(event, activeSession)) return
        queue.push(transcriptEventToSegment(event))
        wakeConsumer()
      },
    })

    const pump = (async () => {
      try {
        const config = resolveStreamingAsrConfig()
        for await (const rawChunk of chunks) {
          if (signal.aborted) throw new DOMException("Request aborted", "AbortError")
          const chunk = assertStreamingAudioChunk(rawChunk)
          if (!activeSession) {
            activeSession = { sessionId: chunk.sessionId, streamId: chunk.streamId }
            await startStreamingAsrSessionWithRetry(chunk, config, signal)
          }
          if (
            activeSession.sessionId !== chunk.sessionId ||
            activeSession.streamId !== chunk.streamId
          ) {
            throw new Error("A streaming transcript provider can process only one stream at a time.")
          }
          await pushStreamingAudioWithRetry(chunk, config, signal)
          if (chunk.isFinal) {
            await invoke("interview_asr_stop_session", {
              request: {
                sessionId: chunk.sessionId,
                streamId: chunk.streamId,
                reason: "source_ended",
              },
            }).catch(() => undefined)
          }
        }
      } catch (error) {
        pumpError = error
      } finally {
        pumpDone = true
        wakeConsumer()
      }
    })()

    try {
      while (!pumpDone || queue.length > 0) {
        if (signal.aborted) throw new DOMException("Request aborted", "AbortError")
        const next = queue.shift()
        if (next) {
          yield next
          continue
        }
        if (pumpDone) break
        await new Promise<void>((resolve) => {
          wake = resolve
          setTimeout(resolve, 100)
        })
      }
      await pump
      if (pumpError) throw pumpError
    } finally {
      unlisten()
      const sessionToStop = activeSession as { sessionId: string; streamId: string } | null
      if (sessionToStop) {
        await invoke("interview_asr_stop_session", {
          request: {
            sessionId: sessionToStop.sessionId,
            streamId: sessionToStop.streamId,
            reason: signal.aborted ? "user_stop" : "source_ended",
          },
        }).catch(() => undefined)
      }
    }
  }
}

async function startStreamingAsrSession(
  chunk: StreamingAudioChunk,
  config: VolcengineStreamingAsrConfig,
): Promise<void> {
  await invoke("interview_asr_start_session", {
    request: {
      sessionId: chunk.sessionId,
      streamId: chunk.streamId,
      source: chunk.source,
      endpoint: config.endpoint,
      resourceId: config.resourceId,
      apiKey: config.apiKey,
      audio: {
        format: "pcm",
        codec: "raw",
        rate: 16000,
        bits: 16,
        channel: 1,
      },
      request: {
        modelName: "bigmodel",
        enableNonstream: config.enableNonstream,
        showUtterances: config.showUtterances,
        resultType: "single",
        endWindowSizeMs: config.endWindowSizeMs,
        forceToSpeechTimeMs: config.forceToSpeechTimeMs,
        enableSpeakerInfo: config.enableSpeakerInfo,
      },
    },
  })
}

async function startStreamingAsrSessionWithRetry(
  chunk: StreamingAudioChunk,
  config: VolcengineStreamingAsrConfig,
  signal: AbortSignal,
): Promise<void> {
  await retryStreamingOperation(signal, async () => startStreamingAsrSession(chunk, config))
}

async function pushStreamingAudioWithRetry(
  chunk: StreamingAudioChunk,
  config: VolcengineStreamingAsrConfig,
  signal: AbortSignal,
): Promise<void> {
  await retryStreamingOperation(signal, async (attempt) => {
    if (attempt > 1) {
      await invoke("interview_asr_stop_session", {
        request: {
          sessionId: chunk.sessionId,
          streamId: chunk.streamId,
          reason: "retry",
        },
      }).catch(() => undefined)
      await startStreamingAsrSession(chunk, config)
    }
    await invoke("interview_asr_push_audio", {
      request: {
        sessionId: chunk.sessionId,
        streamId: chunk.streamId,
        sequence: chunk.sequence,
        pcm16: Array.from(chunk.pcm16),
        isFinal: chunk.isFinal,
      },
    })
  })
}

async function retryStreamingOperation(
  signal: AbortSignal,
  operation: (attempt: number) => Promise<void>,
  maxAttempts = 3,
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError")
    try {
      await operation(attempt)
      return
    } catch (error) {
      lastError = error
      if (attempt >= maxAttempts) break
      await sleep(250 * attempt)
    }
  }
  throw lastError
}

function matchesActiveStream(
  event: { sessionId: string; streamId?: string },
  active: { sessionId: string; streamId: string },
): boolean {
  return event.sessionId === active.sessionId && (!event.streamId || event.streamId === active.streamId)
}

function transcriptEventToSegment(event: InterviewAsrTranscriptEvent): TranscriptSegment {
  const providerKey = event.providerUtteranceId ?? `${event.streamId}-${event.providerSequence ?? event.createdAt}`
  return {
    id: `asr-${event.streamId}-${providerKey}-${event.state}`,
    sessionId: event.sessionId,
    streamId: event.streamId,
    speaker: event.speaker,
    text: event.text,
    startMs: event.startMs,
    endMs: event.endMs,
    confidence: event.confidence,
    source: event.source,
    state: event.state,
    definite: event.definite,
    providerSequence: event.providerSequence,
    providerUtteranceId: event.providerUtteranceId,
    revisionOf: event.revisionOf,
    createdAt: event.createdAt,
  }
}

export class NativeAudioSourceAdapter implements AudioSourceAdapter {
  private activeCaptureId: string | null = null
  private wake: (() => void) | null = null

  constructor(readonly kind: "system" | "microphone") {}

  async *start(source: AudioSourceSelection, signal: AbortSignal): AsyncIterable<AudioChunk> {
    const captureId = createNativeCaptureId(source.kind)
    const queue: AudioChunk[] = []
    let stopped = false
    let failure: Error | null = null
    const wakeConsumer = () => {
      this.wake?.()
      this.wake = null
    }
    const unlisteners: UnlistenFn[] = []
    const onAbort = () => {
      stopped = true
      wakeConsumer()
      void this.stop()
    }

    unlisteners.push(await listen<unknown>(INTERVIEW_AUDIO_CHUNK_EVENT, (event) => {
      const chunk = normalizeNativeAudioChunkEvent(event.payload)
      if (!chunk || chunk.captureId !== captureId) return
      queue.push({
        id: `audio-${chunk.source}-${chunk.createdAt}-${chunk.sequence}`,
        source: chunk.source,
        blob: null,
        bytes: chunk.pcm16,
        pcm16: chunk.pcm16,
        sequence: chunk.sequence,
        sampleRate: chunk.sampleRate,
        channelCount: chunk.channelCount,
        durationMs: chunk.durationMs,
        isFinal: chunk.isFinal,
        mimeType: "audio/pcm",
        fileName: source.fileName,
        createdAt: chunk.createdAt,
      })
      wakeConsumer()
    }))
    unlisteners.push(await listen<unknown>(INTERVIEW_AUDIO_STATUS_EVENT, (event) => {
      const status = normalizeNativeAudioStatusEvent(event.payload)
      if (!status || status.captureId !== captureId) return
      if (status.status === "failed") {
        failure = new Error(status.message)
        stopped = true
      } else if (status.status === "stopped") {
        stopped = true
      }
      wakeConsumer()
    }))

    signal.addEventListener("abort", onAbort, { once: true })
    this.activeCaptureId = captureId
    await invoke("interview_audio_start_capture", {
      request: {
        captureId,
        source: this.kind,
        label: source.label,
        packetMs: currentPacketMs(),
      },
    })

    try {
      while (!signal.aborted && !stopped) {
        const next = queue.shift()
        if (next) {
          yield next
          continue
        }
        if (failure) throw failure
        await new Promise<void>((resolve) => {
          this.wake = resolve
          setTimeout(resolve, 100)
        })
      }
      while (queue.length > 0) {
        const next = queue.shift()
        if (next) yield next
      }
      if (failure) throw failure
    } finally {
      signal.removeEventListener("abort", onAbort)
      for (const unlisten of unlisteners) unlisten()
      await this.stop()
    }
  }

  async stop(): Promise<void> {
    const captureId = this.activeCaptureId
    this.activeCaptureId = null
    this.wake?.()
    this.wake = null
    if (!captureId) return
    await invoke("interview_audio_stop_capture", {
      request: { captureId },
    }).catch(() => undefined)
  }
}

export class SystemAudioSourceAdapter implements AudioSourceAdapter {
  readonly kind = "system" as const
  private activeStream: MediaStream | null = null

  async *start(source: AudioSourceSelection, signal: AbortSignal): AsyncIterable<AudioChunk> {
    await invoke("interview_audio_start_system_capture", { label: source.label })
    const devices = globalThis.navigator?.mediaDevices
    const getDisplayMedia = devices?.getDisplayMedia?.bind(devices)
    if (!getDisplayMedia) throw new Error("System audio capture is not available in this runtime.")
    const stream = await getDisplayMedia({
      audio: true,
      video: true,
    })
    this.activeStream = stream
    if (stream.getAudioTracks().length === 0) {
      await this.stop()
      throw new Error("Selected system source did not provide an audio track.")
    }
    try {
      for await (const chunk of streamMediaToPcm16Chunks(stream, source, signal)) {
        yield chunk
      }
    } finally {
      await this.stop()
    }
  }

  async stop(): Promise<void> {
    this.activeStream?.getTracks().forEach((track) => track.stop())
    this.activeStream = null
    await invoke("interview_audio_stop_system_capture").catch(() => undefined)
  }
}

export class MicrophoneAudioSourceAdapter implements AudioSourceAdapter {
  readonly kind = "microphone" as const
  private activeStream: MediaStream | null = null

  async *start(source: AudioSourceSelection, signal: AbortSignal): AsyncIterable<AudioChunk> {
    const devices = globalThis.navigator?.mediaDevices
    if (!devices?.getUserMedia) throw new Error("Microphone capture is not available in this runtime.")
    const stream = await devices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
    this.activeStream = stream
    try {
      for await (const chunk of streamMediaToPcm16Chunks(stream, source, signal)) {
        yield chunk
      }
    } finally {
      await this.stop()
    }
  }

  async stop(): Promise<void> {
    this.activeStream?.getTracks().forEach((track) => track.stop())
    this.activeStream = null
  }
}

export class LocalFileAudioSourceAdapter implements AudioSourceAdapter {
  readonly kind = "file" as const

  async *start(source: AudioSourceSelection, signal: AbortSignal): AsyncIterable<AudioChunk> {
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError")
    if (source.file) {
      const buffer = await source.file.arrayBuffer()
      if (signal.aborted) throw new DOMException("Request aborted", "AbortError")
      for await (const chunk of replayDecodedFileChunks(new Uint8Array(buffer), source, source.file.type || null, signal)) {
        yield chunk
      }
      return
    }

    if (source.filePath) {
      const { base64, mimeType } = await readFileAsBase64(source.filePath)
      if (signal.aborted) throw new DOMException("Request aborted", "AbortError")
      for await (const chunk of replayDecodedFileChunks(decodeBase64ToBytes(base64), source, mimeType || null, signal)) {
        yield chunk
      }
      return
    }

    throw new Error("Select a local audio file.")
  }

  async stop(): Promise<void> {}
}

export async function* attachStreamingAudioContext(
  chunks: AsyncIterable<AudioChunk>,
  context: { sessionId: string; streamId: string },
): AsyncIterable<AudioChunk> {
  let sequence = 0
  for await (const chunk of chunks) {
    const pcm16 = chunk.pcm16 ?? chunk.bytes
    if (!pcm16) {
      yield { ...chunk, sessionId: context.sessionId, streamId: context.streamId }
      continue
    }
    sequence = chunk.sequence ?? sequence + 1
    yield {
      ...chunk,
      sessionId: context.sessionId,
      streamId: context.streamId,
      bytes: pcm16,
      pcm16,
      sequence,
      sampleRate: 16000,
      channelCount: 1,
      durationMs: chunk.durationMs ?? durationMsForPcm16Bytes(pcm16.byteLength),
      isFinal: chunk.isFinal ?? false,
    }
  }
}

export function assertStreamingAudioChunk(chunk: AudioChunk): StreamingAudioChunk {
  const validation = validateStreamingAudioChunk(chunk)
  if (!validation.ok) throw new Error(validation.error)
  const sessionId = chunk.sessionId as string
  const streamId = chunk.streamId as string
  const pcm16 = chunk.pcm16 as Uint8Array
  const sequence = chunk.sequence as number
  const durationMs = chunk.durationMs as number
  return {
    ...chunk,
    sessionId,
    streamId,
    blob: null,
    bytes: pcm16,
    pcm16,
    sequence,
    sampleRate: 16000,
    channelCount: 1,
    durationMs,
    isFinal: chunk.isFinal === true,
  }
}

export function validateStreamingAudioChunk(
  chunk: AudioChunk,
): { ok: true } | { ok: false; error: string } {
  if (!chunk.sessionId) return { ok: false, error: "Streaming audio chunk is missing sessionId." }
  if (!chunk.streamId) return { ok: false, error: "Streaming audio chunk is missing streamId." }
  if (!chunk.pcm16 || chunk.pcm16.byteLength === 0) {
    return { ok: false, error: "Streaming audio chunk is missing PCM16 payload." }
  }
  if (chunk.pcm16.byteLength % 2 !== 0) {
    return { ok: false, error: "Streaming audio chunk PCM16 payload has an odd byte length." }
  }
  if (chunk.sampleRate !== 16000) {
    return { ok: false, error: "Streaming audio chunk must be 16 kHz." }
  }
  if (chunk.channelCount !== 1) {
    return { ok: false, error: "Streaming audio chunk must be mono." }
  }
  if (typeof chunk.sequence !== "number" || chunk.sequence < 1) {
    return { ok: false, error: "Streaming audio chunk must have a positive sequence." }
  }
  if (typeof chunk.durationMs !== "number" || chunk.durationMs <= 0) {
    return { ok: false, error: "Streaming audio chunk must include durationMs." }
  }
  if (chunk.durationMs > 200 && !chunk.isFinal) {
    return { ok: false, error: "Streaming audio chunk duration must be 100-200 ms." }
  }
  return { ok: true }
}

export function resampleFloat32ToPcm16Mono(
  samples: Float32Array,
  inputSampleRate: number,
  outputSampleRate = 16000,
): Uint8Array {
  if (inputSampleRate <= 0) throw new Error("Input sample rate must be positive.")
  const ratio = inputSampleRate / outputSampleRate
  const outputLength = Math.max(1, Math.round(samples.length / ratio))
  const bytes = new Uint8Array(outputLength * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio
    const low = Math.floor(sourceIndex)
    const high = Math.min(samples.length - 1, low + 1)
    const weight = sourceIndex - low
    const sample = samples[low] * (1 - weight) + samples[high] * weight
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return bytes
}

export function createPcm16AudioChunks(options: {
  pcm16: Uint8Array
  source: AudioSourceKind
  packetMs?: number
  mimeType?: string | null
  fileName?: string | null
  sequenceStart?: number
  now?: () => number
}): AudioChunk[] {
  const packetMs = clampPacketMs(options.packetMs ?? currentPacketMs())
  const bytesPerPacket = Math.max(2, Math.floor(16000 * 2 * packetMs / 1000))
  const chunks: AudioChunk[] = []
  let sequence = options.sequenceStart ?? 1
  for (let offset = 0; offset < options.pcm16.byteLength; offset += bytesPerPacket) {
    const end = Math.min(options.pcm16.byteLength, offset + bytesPerPacket)
    const pcm16 = options.pcm16.slice(offset, end)
    const isFinal = end >= options.pcm16.byteLength
    chunks.push({
      id: `audio-${options.source}-${options.now?.() ?? Date.now()}-${sequence}`,
      source: options.source,
      blob: null,
      bytes: pcm16,
      pcm16,
      sequence,
      sampleRate: 16000,
      channelCount: 1,
      durationMs: durationMsForPcm16Bytes(pcm16.byteLength),
      isFinal,
      mimeType: options.mimeType ?? "audio/pcm",
      fileName: options.fileName ?? null,
      createdAt: options.now?.() ?? Date.now(),
    })
    sequence += 1
  }
  if (chunks.length === 0) {
    throw new Error("Audio source did not produce PCM16 bytes.")
  }
  return chunks
}

async function* replayDecodedFileChunks(
  bytes: Uint8Array,
  source: AudioSourceSelection,
  mimeType: string | null,
  signal: AbortSignal,
): AsyncIterable<AudioChunk> {
  const pcm16 = await decodeAudioBytesToPcm16(bytes)
  const chunks = createPcm16AudioChunks({
    pcm16,
    source: "file",
    packetMs: currentPacketMs(),
    mimeType,
    fileName: source.fileName ?? fileNameFromPath(source.filePath),
  })
  for (const chunk of chunks) {
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError")
    yield chunk
    if (!chunk.isFinal) await sleep(chunk.durationMs ?? currentPacketMs())
  }
}

async function* streamMediaToPcm16Chunks(
  stream: MediaStream,
  source: AudioSourceSelection,
  signal: AbortSignal,
): AsyncIterable<AudioChunk> {
  const AudioContextCtor = getAudioContextConstructor()
  if (!AudioContextCtor) throw new Error("Web Audio capture is not available in this runtime.")
  const audioContext = new AudioContextCtor()
  const queue: AudioChunk[] = []
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array()
  let sequence = 1
  let resolveNext: (() => void) | null = null
  const wake = () => {
    resolveNext?.()
    resolveNext = null
  }
  const packetMs = currentPacketMs()
  const bytesPerPacket = Math.max(2, Math.floor(16000 * 2 * packetMs / 1000))
  const mediaSource = audioContext.createMediaStreamSource(stream)
  const processor = audioContext.createScriptProcessor(4096, 1, 1)
  processor.onaudioprocess = (event) => {
    const mono = inputBufferToMono(event.inputBuffer)
    const pcm16 = resampleFloat32ToPcm16Mono(mono, event.inputBuffer.sampleRate)
    pending = concatBytes(pending, pcm16)
    while (pending.byteLength >= bytesPerPacket) {
      const payload = pending.slice(0, bytesPerPacket)
      pending = pending.slice(bytesPerPacket)
      queue.push(audioChunkFromPcm16(payload, source, sequence, false, packetMs))
      sequence += 1
    }
    wake()
  }
  mediaSource.connect(processor)
  processor.connect(audioContext.destination)

  try {
    while (!signal.aborted) {
      const chunk = queue.shift()
      if (chunk) {
        yield chunk
        continue
      }
      await new Promise<void>((resolve) => {
        resolveNext = resolve
        setTimeout(resolve, 100)
      })
    }
    if (pending.byteLength > 0) {
      yield audioChunkFromPcm16(pending, source, sequence, true, durationMsForPcm16Bytes(pending.byteLength))
    }
  } finally {
    processor.disconnect()
    mediaSource.disconnect()
    await audioContext.close().catch(() => undefined)
  }
}

async function decodeAudioBytesToPcm16(bytes: Uint8Array): Promise<Uint8Array> {
  const AudioContextCtor = getAudioContextConstructor()
  if (!AudioContextCtor) {
    if (bytes.byteLength % 2 !== 0) throw new Error("Raw debug audio bytes must be PCM16-aligned.")
    return bytes
  }
  const audioContext = new AudioContextCtor()
  try {
    const decoded = await audioContext.decodeAudioData(bytesToArrayBuffer(bytes))
    return resampleFloat32ToPcm16Mono(inputBufferToMono(decoded), decoded.sampleRate)
  } catch {
    if (bytes.byteLength % 2 !== 0) throw new Error("Debug audio could not be decoded as audio or raw PCM16.")
    return bytes
  } finally {
    await audioContext.close().catch(() => undefined)
  }
}

export class OpenAiFileTranscriptProvider implements TranscriptProvider {
  async *transcribe(
    chunks: AsyncIterable<AudioChunk>,
    signal: AbortSignal,
  ): AsyncIterable<TranscriptSegment> {
    const audio = await collectAudioForTranscription(chunks, signal)
    const config = resolveOpenAiTranscriptionConfig()
    const form = new FormData()
    form.append("file", audio.blob, audio.fileName)
    form.append("model", config.model)
    form.append("response_format", config.responseFormat)
    if (config.chunkingStrategy === "auto") {
      form.append("chunking_strategy", "auto")
    }

    const httpFetch = await getHttpFetch()
    const response = await httpFetch(config.endpoint, {
      method: "POST",
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
      body: form,
      signal,
    })
    if (!response.ok) {
      const body = await response.text().catch(() => "")
      throw new Error(
        `OpenAI transcription failed (${response.status}): ${extractOpenAiErrorMessage(body)}`,
      )
    }

    const payload = await response.json() as OpenAiTranscriptionResponse
    for (const segment of toTranscriptSegments(payload, audio.source)) {
      if (signal.aborted) throw new DOMException("Request aborted", "AbortError")
      yield segment
    }
  }
}

interface OpenAiTranscriptionConfig {
  endpoint: string
  apiKey: string
  model: string
  responseFormat: string
  chunkingStrategy: "auto" | "none"
}

interface CollectedAudio {
  blob: Blob
  fileName: string
  source: AudioSourceKind
}

interface OpenAiTranscriptionResponse {
  text?: unknown
  segments?: Array<{
    text?: unknown
    start?: unknown
    end?: unknown
    speaker?: unknown
    confidence?: unknown
  }>
}

function resolveOpenAiTranscriptionConfig(): OpenAiTranscriptionConfig {
  const { asrConfig } = useWikiStore.getState()
  const apiKey = asrConfig.apiKey.trim()
  if (asrConfig.provider === "openai" && !apiKey) {
    throw new Error(
      "ASR is not configured. Set an OpenAI ASR API key in Settings before audio-file transcription.",
    )
  }
  return {
    endpoint: normalizeTranscriptionEndpoint(asrConfig.endpoint),
    apiKey,
    model: asrConfig.model.trim() || DEFAULT_ASR_CONFIG.model,
    responseFormat: asrConfig.responseFormat,
    chunkingStrategy: asrConfig.chunkingStrategy,
  }
}

function normalizeTranscriptionEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim() || DEFAULT_ASR_CONFIG.endpoint
  const withoutTrailingSlash = trimmed.replace(/\/+$/, "")
  if (withoutTrailingSlash.endsWith("/audio/transcriptions")) return withoutTrailingSlash
  if (withoutTrailingSlash.endsWith("/v1")) return `${withoutTrailingSlash}/audio/transcriptions`
  return withoutTrailingSlash
}

async function collectAudioForTranscription(
  chunks: AsyncIterable<AudioChunk>,
  signal: AbortSignal,
): Promise<CollectedAudio> {
  const parts: BlobPart[] = []
  let mimeType: string | null = null
  let fileName: string | null = null
  let source: AudioSourceKind = "file"

  for await (const chunk of chunks) {
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError")
    source = chunk.source
    mimeType ??= chunk.mimeType
    fileName ??= chunk.fileName ?? null
    if (chunk.blob) {
      parts.push(chunk.blob)
    } else if (chunk.bytes) {
      parts.push(bytesToArrayBuffer(chunk.bytes))
    }
  }

  if (parts.length === 0) {
    throw new Error("Audio source did not produce any transcription bytes.")
  }

  return {
    blob: new Blob(parts, { type: mimeType ?? "application/octet-stream" }),
    fileName: fileName ?? defaultAudioFileName(source, mimeType),
    source,
  }
}

function toTranscriptSegments(
  payload: OpenAiTranscriptionResponse,
  source: AudioSourceKind,
): TranscriptSegment[] {
  const createdAt = Date.now()
  const segments = Array.isArray(payload.segments) ? payload.segments : []
  if (segments.length === 0) {
    const text = typeof payload.text === "string" ? payload.text.trim() : ""
    if (!text) return []
    return [{
      id: `asr-${createdAt}-0`,
      sessionId: "audio-file",
      speaker: inferSpeakerLabel(null, text),
      text,
      startMs: 0,
      endMs: 0,
      confidence: null,
      source,
      createdAt,
    }]
  }

  return segments
    .map((segment, index) => {
      const text = typeof segment.text === "string" ? segment.text.trim() : ""
      if (!text) return null
      const startMs = secondsToMs(segment.start, 0)
      const endMs = secondsToMs(segment.end, startMs)
      return {
        id: `asr-${createdAt}-${index}`,
        sessionId: "audio-file",
        speaker: inferSpeakerLabel(segment.speaker, text),
        text,
        startMs,
        endMs,
        confidence: numberOrNull(segment.confidence),
        source,
        createdAt,
      } satisfies TranscriptSegment
    })
    .filter((segment): segment is TranscriptSegment => Boolean(segment))
}

function inferSpeakerLabel(rawSpeaker: unknown, text: string): SpeakerLabel {
  const speaker = String(rawSpeaker ?? "").toLowerCase()
  if (/(interviewer|recruiter|面试官|hr)/i.test(speaker)) return "interviewer"
  if (/(candidate|interviewee|applicant|answerer|user|me|候选人|应聘者)/i.test(speaker)) return "interviewee"
  if (looksLikeQuestionText(text)) return "interviewer"
  return "unknown"
}

function secondsToMs(value: unknown, fallbackMs: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value * 1000))
    : fallbackMs
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function clampPacketMs(value: number): number {
  return Math.max(100, Math.min(200, Math.round(value)))
}

function currentPacketMs(): number {
  const packetMs = useWikiStore.getState().asrConfig.packetMs
  return clampPacketMs(typeof packetMs === "number" ? packetMs : DEFAULT_ASR_CONFIG.packetMs)
}

function durationMsForPcm16Bytes(byteLength: number): number {
  return Math.max(1, Math.round(byteLength / 2 / 16000 * 1000))
}

function audioChunkFromPcm16(
  pcm16: Uint8Array,
  source: AudioSourceSelection,
  sequence: number,
  isFinal: boolean,
  durationMs: number,
): AudioChunk {
  return {
    id: `audio-${source.kind}-${Date.now()}-${sequence}`,
    source: source.kind,
    blob: null,
    bytes: pcm16,
    pcm16,
    sequence,
    sampleRate: 16000,
    channelCount: 1,
    durationMs,
    isFinal,
    mimeType: "audio/pcm",
    fileName: source.fileName,
    createdAt: Date.now(),
  }
}

function inputBufferToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels <= 1) return new Float32Array(buffer.getChannelData(0))
  const output = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let index = 0; index < buffer.length; index += 1) {
      output[index] += data[index] / buffer.numberOfChannels
    }
  }
  return output
}

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array {
  const combined = new Uint8Array(left.byteLength + right.byteLength)
  combined.set(left, 0)
  combined.set(right, left.byteLength)
  return combined
}

function getAudioContextConstructor(): typeof AudioContext | null {
  return globalThis.AudioContext ??
    (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
}

function mediaDevicesReason(
  devices: MediaDevices | undefined,
  method: "getUserMedia" | "getDisplayMedia",
): string | null {
  if (!devices) return "navigator.mediaDevices is unavailable."
  if (typeof devices[method] !== "function") return `navigator.mediaDevices.${method} is unavailable.`
  return null
}

function combineCapabilityReasons(...reasons: Array<string | null>): string | null {
  const activeReasons = reasons.filter((reason): reason is string => Boolean(reason))
  return activeReasons.length > 0 ? activeReasons.join(" ") : null
}

function hasTauriNativeAudioCapture(): boolean {
  const tauriGlobal = globalThis as typeof globalThis & {
    __TAURI_INTERNALS__?: unknown
    __TAURI__?: unknown
  }
  return Boolean(tauriGlobal.__TAURI_INTERNALS__ || tauriGlobal.__TAURI__)
}

function createNativeCaptureId(source: AudioSourceKind): string {
  const random = Math.random().toString(36).slice(2)
  return `native-${source}-${Date.now()}-${random}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function liveAudioSourceValue(value: unknown): "system" | "microphone" | null {
  return value === "system" || value === "microphone" ? value : null
}

function nativeAudioStatusValue(value: unknown): NativeAudioStatusEvent["status"] | null {
  return value === "started" || value === "stopped" || value === "failed" ? value : null
}

function bytesValue(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (!Array.isArray(value)) return null
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index]
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) return null
    bytes[index] = byte
  }
  return bytes
}

function defaultAudioFileName(source: AudioSourceKind, mimeType: string | null): string {
  if (mimeType?.includes("webm")) return "interview-audio.webm"
  if (mimeType?.includes("mpeg")) return "interview-audio.mp3"
  if (mimeType?.includes("mp4")) return "interview-audio.m4a"
  return source === "microphone" ? "interview-audio.webm" : "interview-audio.wav"
}

function fileNameFromPath(path?: string): string | null {
  if (!path) return null
  const normalized = path.replace(/\\/g, "/")
  return normalized.split("/").filter(Boolean).pop() ?? null
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }
  const maybeBuffer = (globalThis as typeof globalThis & {
    Buffer?: { from: (input: string, encoding: "base64") => Uint8Array }
  }).Buffer
  if (maybeBuffer) return new Uint8Array(maybeBuffer.from(base64, "base64"))
  throw new Error("Base64 decoding is not available in this runtime.")
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function extractOpenAiErrorMessage(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: unknown } }
    if (typeof parsed.error?.message === "string" && parsed.error.message.trim()) {
      return parsed.error.message.trim()
    }
  } catch {
    // Fall through to raw response text.
  }
  return rawBody.trim().slice(0, 500) || "Unknown error"
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
