import { describe, expect, it } from "vitest"
import {
  combosToMultiline,
  createBlankProjectProfile,
  createEmptyProjectProfileSet,
  createMemoryProjectProfileStorage,
  loadProjectProfilesFromStorage,
  multilineToCombos,
  multilineToTerms,
  normalizeProjectProfileSet,
  profileRoutingHints,
  saveProjectProfilesToStorage,
  termsToMultiline,
} from "./interview-project-profiles"

describe("interview project profiles", () => {
  it("defaults to an empty profile set without bundled personal projects", () => {
    expect(createEmptyProjectProfileSet(1000)).toEqual({
      profiles: [],
      updatedAt: 1000,
    })
    expect(normalizeProjectProfileSet(null, 1000)).toEqual({
      profiles: [],
      updatedAt: 1000,
    })
  })

  it("normalizes user-provided profiles and drops invalid entries", () => {
    const normalized = normalizeProjectProfileSet({
      updatedAt: 1000,
      profiles: [
        {
          id: "search",
          name: " 搜索质量平台 ",
          aliases: ["搜索质量", "搜索质量", ""],
          strongTerms: ["召回率"],
          weakTerms: ["检索"],
          technicalTerms: ["rerank"],
          negativeTerms: ["支付"],
          strongCombos: [["搜索", "召回率"], ["搜索"]],
          enabled: true,
          updatedAt: 1000,
        },
        {
          id: "blank",
          name: " ",
          aliases: ["无效"],
          strongTerms: [],
          weakTerms: [],
          technicalTerms: [],
          negativeTerms: [],
          strongCombos: [],
          enabled: true,
          updatedAt: 1000,
        },
      ],
    }, 2000)

    expect(normalized.profiles).toEqual([{
      id: "search",
      name: "搜索质量平台",
      aliases: ["搜索质量"],
      strongTerms: ["召回率"],
      weakTerms: ["检索"],
      technicalTerms: ["rerank"],
      negativeTerms: ["支付"],
      strongCombos: [["搜索", "召回率"]],
      enabled: true,
      updatedAt: 1000,
    }])
  })

  it("converts multiline editor values to terms and combos", () => {
    expect(multilineToTerms("搜索质量\n召回率，重排; ")).toEqual(["搜索质量", "召回率", "重排"])
    expect(termsToMultiline(["搜索质量", "召回率"])).toBe("搜索质量\n召回率")
    expect(multilineToCombos("搜索 + 召回率\n支付，风控")).toEqual([
      ["搜索", "召回率"],
      ["支付", "风控"],
    ])
    expect(combosToMultiline([["搜索", "召回率"], ["支付", "风控"]])).toBe("搜索 + 召回率\n支付 + 风控")
  })

  it("persists normalized profile sets through storage", async () => {
    const storage = createMemoryProjectProfileStorage()
    const blank = createBlankProjectProfile(1000)
    blank.name = "搜索质量平台"
    blank.strongTerms = ["召回率"]

    const saved = await saveProjectProfilesToStorage(storage, {
      profiles: [blank],
      updatedAt: 1000,
    }, 2000)
    const loaded = await loadProjectProfilesFromStorage(storage, 3000)

    expect(saved.updatedAt).toBe(2000)
    expect(loaded.profiles[0]).toMatchObject({
      name: "搜索质量平台",
      strongTerms: ["召回率"],
      updatedAt: 2000,
    })
  })

  it("builds prompt routing hints from enabled profiles only", () => {
    expect(profileRoutingHints([
      {
        id: "enabled",
        name: "搜索质量平台",
        aliases: ["搜索质量"],
        strongTerms: ["召回率"],
        weakTerms: [],
        technicalTerms: ["rerank"],
        negativeTerms: [],
        strongCombos: [],
        enabled: true,
        updatedAt: 1000,
      },
      {
        id: "disabled",
        name: "支付风控测试平台",
        aliases: ["支付风控"],
        strongTerms: ["拦截率"],
        weakTerms: [],
        technicalTerms: [],
        negativeTerms: [],
        strongCombos: [],
        enabled: false,
        updatedAt: 1000,
      },
    ])).toEqual(["搜索质量平台：搜索质量/召回率/rerank"])
  })
})
