import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFileAsBase64: vi.fn(),
  httpFetch: vi.fn(),
  eventListen: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFileAsBase64: mocks.readFileAsBase64,
}))

vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: async () => mocks.httpFetch,
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.eventListen,
}))

import { useWikiStore } from "@/stores/wiki-store"
import {
  LocalFileAudioSourceAdapter,
  OpenAiFileTranscriptProvider,
  attachStreamingAudioContext,
  createAudioSourceSelection,
  createPcm16AudioChunks,
  normalizeNativeAudioChunkEvent,
  normalizeNativeAudioStatusEvent,
  validateAudioCaptureCapabilitiesForSources,
  normalizeStreamingAsrEndpoint,
  resampleFloat32ToPcm16Mono,
  validateStreamingAudioChunk,
  validateAudioSourceSelection,
  type AudioChunk,
} from "./interview-audio"

const baselineLlmConfig = { ...useWikiStore.getState().llmConfig }
const baselineAsrConfig = { ...useWikiStore.getState().asrConfig }

beforeEach(() => {
  vi.clearAllMocks()
  useWikiStore.getState().setLlmConfig({
    ...baselineLlmConfig,
    provider: "anthropic",
    apiKey: "chat-key",
  })
  useWikiStore.getState().setAsrConfig({
    ...baselineAsrConfig,
    provider: "openai",
    apiKey: "asr-key",
    endpoint: "https://api.openai.com/v1/audio/transcriptions",
    model: "gpt-4o-transcribe-diarize",
    responseFormat: "diarized_json",
    chunkingStrategy: "auto",
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("interview audio source selection", () => {
  it("requires exactly one selected source before start", () => {
    expect(validateAudioSourceSelection(null)).toEqual({
      ok: false,
      error: "Select one audio source before starting.",
    })
    expect(validateAudioSourceSelection(
      createAudioSourceSelection("microphone", "Built-in microphone", 1000),
    )).toEqual({ ok: true })
  })

  it("validates local file selections", () => {
    expect(validateAudioSourceSelection({
      kind: "file",
      label: "Local file",
      fileName: null,
      selectedAt: 1000,
    })).toEqual({
      ok: false,
      error: "Select a local audio file.",
    })

    expect(validateAudioSourceSelection({
      kind: "file",
      label: "Local file",
      fileName: "interview.wav",
      selectedAt: 1000,
    })).toEqual({ ok: true })
  })

  it("accepts Tauri-selected local file paths", () => {
    const source = createAudioSourceSelection(
      "file",
      "interview.wav",
      1000,
      undefined,
      "/tmp/interview.wav",
    )

    expect(source).toMatchObject({
      kind: "file",
      fileName: "interview.wav",
      filePath: "/tmp/interview.wav",
    })
    expect(validateAudioSourceSelection(source)).toEqual({ ok: true })
  })
})

describe("live audio capture capability", () => {
  it("reports production capture unavailable when media APIs are missing", () => {
    vi.stubGlobal("navigator", {})
    vi.stubGlobal("AudioContext", class FakeAudioContext {})

    const validation = validateAudioCaptureCapabilitiesForSources([
      createAudioSourceSelection("system", "System audio", 1000),
      createAudioSourceSelection("microphone", "Microphone", 1000),
    ])

    expect(validation.ok).toBe(false)
    expect(validation.error).toContain("Microphone")
    expect(validation.error).toContain("System audio")
    expect(validation.report.microphone.available).toBe(false)
    expect(validation.report.system.available).toBe(false)
  })

  it("allows production capture when media and Web Audio APIs are available", () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(),
        getDisplayMedia: vi.fn(),
      },
    })
    vi.stubGlobal("AudioContext", class FakeAudioContext {})

    const validation = validateAudioCaptureCapabilitiesForSources([
      createAudioSourceSelection("system", "System audio", 1000),
      createAudioSourceSelection("microphone", "Microphone", 1000),
    ])

    expect(validation).toMatchObject({
      ok: true,
      report: {
        microphone: { available: true, reason: null },
        system: { available: true, reason: null },
      },
    })
  })

  it("allows native capture in the Tauri desktop runtime without Web media APIs", () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {})
    vi.stubGlobal("navigator", {})

    const validation = validateAudioCaptureCapabilitiesForSources([
      createAudioSourceSelection("system", "System audio", 1000),
      createAudioSourceSelection("microphone", "Microphone", 1000),
    ])

    expect(validation).toMatchObject({
      ok: true,
      report: {
        microphone: { available: true, reason: null },
        system: { available: true, reason: null },
      },
    })
  })
})

describe("native audio events", () => {
  it("normalizes PCM16 chunks from Tauri events", () => {
    expect(normalizeNativeAudioChunkEvent({
      captureId: "capture-1",
      source: "microphone",
      sequence: 2,
      pcm16: [1, 2, 3, 4],
      sampleRate: 16000,
      channelCount: 1,
      durationMs: 100,
      isFinal: false,
      createdAt: 1234,
    })).toMatchObject({
      captureId: "capture-1",
      source: "microphone",
      sequence: 2,
      pcm16: new Uint8Array([1, 2, 3, 4]),
      sampleRate: 16000,
      channelCount: 1,
      durationMs: 100,
      isFinal: false,
      createdAt: 1234,
    })
  })

  it("normalizes native capture failure status", () => {
    expect(normalizeNativeAudioStatusEvent({
      captureId: "capture-1",
      source: "system",
      status: "failed",
      message: "ScreenCaptureKit permission denied.",
      createdAt: 1234,
    })).toEqual({
      captureId: "capture-1",
      source: "system",
      status: "failed",
      message: "ScreenCaptureKit permission denied.",
      createdAt: 1234,
    })
  })
})

describe("local file audio adapter", () => {
  it("reads bytes from a selected Tauri file path", async () => {
    mocks.readFileAsBase64.mockResolvedValue({ base64: "AQIDBA==", mimeType: "audio/wav" })
    const adapter = new LocalFileAudioSourceAdapter()
    const source = createAudioSourceSelection(
      "file",
      "interview.wav",
      1000,
      undefined,
      "/tmp/interview.wav",
    )

    const chunks: AudioChunk[] = []
    for await (const chunk of adapter.start(source, new AbortController().signal)) {
      chunks.push(chunk)
    }

    expect(mocks.readFileAsBase64).toHaveBeenCalledWith("/tmp/interview.wav")
    expect(chunks[0]).toMatchObject({
      source: "file",
      sampleRate: 16000,
      channelCount: 1,
      mimeType: "audio/wav",
      fileName: "interview.wav",
    })
    expect(chunks[0].pcm16).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(chunks[0].isFinal).toBe(true)
  })
})

describe("streaming ASR endpoint normalization", () => {
  it("converts HTTP endpoint schemes to WebSocket schemes", () => {
    expect(normalizeStreamingAsrEndpoint(
      "https://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
    )).toBe("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async")
    expect(normalizeStreamingAsrEndpoint("http://localhost:9000/asr")).toBe("ws://localhost:9000/asr")
  })

  it("resets the legacy OpenAI batch transcription endpoint", () => {
    expect(normalizeStreamingAsrEndpoint(
      "https://api.openai.com/v1/audio/transcriptions",
    )).toBe("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async")
  })
})

describe("streaming PCM audio chunks", () => {
  it("creates PCM16 mono 16 kHz chunks with final markers", async () => {
    const chunks = createPcm16AudioChunks({
      pcm16: new Uint8Array(16_000 * 2 / 10),
      source: "microphone",
      packetMs: 100,
      now: () => 1000,
    })
    const contextualized = []
    for await (const chunk of attachStreamingAudioContext(iterable(chunks), {
      sessionId: "session-1",
      streamId: "stream-mic",
    })) {
      contextualized.push(chunk)
    }

    expect(contextualized).toHaveLength(1)
    expect(validateStreamingAudioChunk(contextualized[0])).toEqual({ ok: true })
    expect(contextualized[0]).toMatchObject({
      sessionId: "session-1",
      streamId: "stream-mic",
      sampleRate: 16000,
      channelCount: 1,
      durationMs: 100,
      isFinal: true,
    })
  })

  it("resamples Float32 audio to little-endian PCM16", () => {
    const pcm16 = resampleFloat32ToPcm16Mono(new Float32Array([-1, 0, 1]), 48000, 16000)

    expect(pcm16.byteLength).toBe(2)
    expect(new DataView(pcm16.buffer).getInt16(0, true)).toBe(-32768)
  })
})

describe("OpenAI audio transcript provider", () => {
  it("submits audio bytes for diarized transcription and maps questions to interviewer speech", async () => {
    mocks.httpFetch.mockResolvedValue(new Response(JSON.stringify({
      segments: [
        { text: "Can you introduce one project?", start: 1.2, end: 3.4, speaker: "speaker_0" },
        { text: "I built the LLM Wiki retrieval flow.", start: 4, end: 5.5, speaker: "speaker_1" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }))
    const provider = new OpenAiFileTranscriptProvider()

    const segments = []
    for await (const segment of provider.transcribe(singleAudioChunk(), new AbortController().signal)) {
      segments.push(segment)
    }

    expect(mocks.httpFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer asr-key" },
        body: expect.any(FormData),
      }),
    )
    const request = mocks.httpFetch.mock.calls[0][1] as RequestInit
    const form = request.body as FormData
    expect(form.get("model")).toBe("gpt-4o-transcribe-diarize")
    expect(form.get("response_format")).toBe("diarized_json")
    expect(form.get("chunking_strategy")).toBe("auto")
    expect(segments[0]).toMatchObject({
      speaker: "interviewer",
      text: "Can you introduce one project?",
      startMs: 1200,
      endMs: 3400,
      source: "file",
    })
    expect(segments[1]).toMatchObject({
      speaker: "unknown",
      text: "I built the LLM Wiki retrieval flow.",
    })
  })

  it("uses the dedicated ASR endpoint and model instead of the main chat provider", async () => {
    useWikiStore.getState().setAsrConfig({
      ...baselineAsrConfig,
      provider: "custom",
      apiKey: "custom-asr-key",
      endpoint: "https://asr.example.com/v1",
      model: "asr-large",
      responseFormat: "json",
      chunkingStrategy: "none",
    })
    mocks.httpFetch.mockResolvedValue(new Response(JSON.stringify({
      text: "What did you build?",
    }), { status: 200, headers: { "Content-Type": "application/json" } }))

    const provider = new OpenAiFileTranscriptProvider()
    const segments = []
    for await (const segment of provider.transcribe(singleAudioChunk(), new AbortController().signal)) {
      segments.push(segment)
    }

    expect(mocks.httpFetch).toHaveBeenCalledWith(
      "https://asr.example.com/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer custom-asr-key" },
      }),
    )
    const request = mocks.httpFetch.mock.calls[0][1] as RequestInit
    const form = request.body as FormData
    expect(form.get("model")).toBe("asr-large")
    expect(form.get("response_format")).toBe("json")
    expect(form.get("chunking_strategy")).toBeNull()
    expect(segments[0]).toMatchObject({
      speaker: "interviewer",
      text: "What did you build?",
    })
  })
})

async function* singleAudioChunk(): AsyncIterable<AudioChunk> {
  yield {
    id: "chunk-1",
    source: "file",
    blob: null,
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: "audio/wav",
    fileName: "interview.wav",
    createdAt: 1000,
  }
}

async function* iterable(chunks: AudioChunk[]): AsyncIterable<AudioChunk> {
  for (const chunk of chunks) yield chunk
}
