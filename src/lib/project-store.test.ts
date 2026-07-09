import { describe, expect, it } from "vitest"
import { __projectStoreTest } from "./project-store"

describe("project-store MinerU config normalization", () => {
  it("preserves valid MinerU config values", () => {
    expect(__projectStoreTest.normalizeMineruConfig({
      enabled: true,
      token: "token-123",
      modelVersion: "pipeline",
    })).toEqual({
      enabled: true,
      token: "token-123",
      modelVersion: "pipeline",
    })
  })

  it("migrates legacy and malformed MinerU config values to safe defaults", () => {
    expect(__projectStoreTest.normalizeMineruConfig({
      enabled: "yes" as unknown as boolean,
      token: 123 as unknown as string,
      modelVersion: "mineru-html" as "vlm",
    })).toEqual({
      enabled: false,
      token: "",
      modelVersion: "vlm",
    })
  })
})

describe("project-store ASR config normalization", () => {
  it("preserves valid ASR config values", () => {
    expect(__projectStoreTest.normalizeAsrConfig({
      provider: "custom",
      apiKey: "asr-key",
      endpoint: "https://example.com/v1/audio/transcriptions",
      resourceId: "volc.bigasr.sauc.duration",
      packetMs: 200,
      sampleRate: 16000,
      enableNonstream: true,
      showUtterances: true,
      enableSpeakerInfo: false,
      endWindowSizeMs: 800,
      forceToSpeechTimeMs: 1000,
      model: "custom-transcribe",
      responseFormat: "json",
      chunkingStrategy: "none",
    })).toEqual({
      provider: "custom",
      apiKey: "asr-key",
      endpoint: "https://example.com/v1/audio/transcriptions",
      resourceId: "volc.bigasr.sauc.duration",
      packetMs: 200,
      sampleRate: 16000,
      enableNonstream: true,
      showUtterances: true,
      enableSpeakerInfo: false,
      endWindowSizeMs: 800,
      forceToSpeechTimeMs: 1000,
      model: "custom-transcribe",
      responseFormat: "json",
      chunkingStrategy: "none",
    })
  })

  it("migrates malformed ASR config values to safe defaults", () => {
    expect(__projectStoreTest.normalizeAsrConfig({
      provider: "anthropic",
      apiKey: 123,
      endpoint: "",
      model: "",
      responseFormat: "xml",
      chunkingStrategy: "manual",
    })).toEqual({
      provider: "volcengine-streaming",
      apiKey: "",
      endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
      resourceId: "volc.bigasr.sauc.duration",
      packetMs: 200,
      sampleRate: 16000,
      enableNonstream: true,
      showUtterances: true,
      enableSpeakerInfo: false,
      endWindowSizeMs: 800,
      forceToSpeechTimeMs: 1000,
      model: "bigmodel",
      responseFormat: "diarized_json",
      chunkingStrategy: "auto",
    })
  })

  it("normalizes Volcengine streaming ASR fields and preserves credentials", () => {
    expect(__projectStoreTest.normalizeAsrConfig({
      provider: "volcengine-streaming",
      apiKey: "secret-asr-key",
      endpoint: " wss://asr.example.test/ws ",
      resourceId: " volc.test.resource ",
      packetMs: 160.4,
      enableNonstream: false,
      showUtterances: false,
      enableSpeakerInfo: true,
      endWindowSizeMs: 120,
      forceToSpeechTimeMs: 0,
    })).toMatchObject({
      provider: "volcengine-streaming",
      apiKey: "secret-asr-key",
      endpoint: "wss://asr.example.test/ws",
      resourceId: "volc.test.resource",
      packetMs: 160,
      sampleRate: 16000,
      enableNonstream: false,
      showUtterances: false,
      enableSpeakerInfo: true,
      endWindowSizeMs: 200,
      forceToSpeechTimeMs: 1,
    })
  })

  it("normalizes Volcengine streaming endpoint schemes", () => {
    expect(__projectStoreTest.normalizeAsrConfig({
      provider: "volcengine-streaming",
      endpoint: "https://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
    }).endpoint).toBe("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async")

    expect(__projectStoreTest.normalizeAsrConfig({
      provider: "volcengine-streaming",
      endpoint: "http://localhost:9000/asr",
    }).endpoint).toBe("ws://localhost:9000/asr")
  })

  it("resets legacy OpenAI batch ASR endpoint when using Volcengine streaming", () => {
    expect(__projectStoreTest.normalizeAsrConfig({
      provider: "volcengine-streaming",
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
    }).endpoint).toBe("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async")
  })
})

describe("project-store zoom normalization", () => {
  it("preserves valid zoom values", () => {
    expect(__projectStoreTest.normalizeZoomLevel(0.5)).toBe(0.5)
    expect(__projectStoreTest.normalizeZoomLevel(1.25)).toBe(1.25)
    expect(__projectStoreTest.normalizeZoomLevel(3)).toBe(3)
  })

  it("clamps finite out-of-range values", () => {
    expect(__projectStoreTest.normalizeZoomLevel(-2)).toBe(0.5)
    expect(__projectStoreTest.normalizeZoomLevel(0)).toBe(0.5)
    expect(__projectStoreTest.normalizeZoomLevel(0.49)).toBe(0.5)
    expect(__projectStoreTest.normalizeZoomLevel(3.01)).toBe(3)
  })

  it("falls back to 100% for malformed values", () => {
    expect(__projectStoreTest.normalizeZoomLevel(undefined)).toBe(1)
    expect(__projectStoreTest.normalizeZoomLevel(null)).toBe(1)
    expect(__projectStoreTest.normalizeZoomLevel(Number.NaN)).toBe(1)
    expect(__projectStoreTest.normalizeZoomLevel(Number.POSITIVE_INFINITY)).toBe(1)
    expect(__projectStoreTest.normalizeZoomLevel("150")).toBe(1)
  })
})
