import { describe, expect, it, vi } from "vitest"

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}))

import { getInterviewControlsModel } from "./interview-controls"

describe("interview controls model", () => {
  it("locks source switching while listening", () => {
    expect(getInterviewControlsModel("listening", true, false).sourcesLocked).toBe(true)
    expect(getInterviewControlsModel("ready", false, true).sourcesLocked).toBe(false)
  })

  it("passes through start and end button states", () => {
    expect(getInterviewControlsModel("ready", false, true)).toMatchObject({
      startDisabled: false,
      endDisabled: true,
      resetVisible: false,
    })
  })

  it("shows reset only after the interview has ended", () => {
    expect(getInterviewControlsModel("listening", true, false).resetVisible).toBe(false)
    expect(getInterviewControlsModel("ended", true, true).resetVisible).toBe(true)
  })

  it("keeps file input debug-only while production start remains available", () => {
    expect(getInterviewControlsModel("ready", false, true, null)).toMatchObject({
      startDisabled: false,
      debugStartDisabled: true,
    })
    expect(getInterviewControlsModel("ready", false, true, {
      kind: "file",
      label: "debug.wav",
      fileName: "debug.wav",
      selectedAt: 1000,
    })).toMatchObject({
      startDisabled: false,
      debugStartDisabled: false,
    })
  })
})
