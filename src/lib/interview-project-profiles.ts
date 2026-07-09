import {
  loadInterviewProjectProfiles,
  saveInterviewProjectProfiles,
} from "@/lib/project-store"
import type {
  InterviewProjectProfile,
  InterviewProjectProfileSet,
} from "./interview-types"

export interface ProjectProfileStorage {
  load: () => Promise<Partial<InterviewProjectProfileSet> | null>
  save: (profiles: InterviewProjectProfileSet) => Promise<void>
}

export const EMPTY_PROJECT_PROFILE_SET: InterviewProjectProfileSet = {
  profiles: [],
  updatedAt: 0,
}

const MAX_PROFILES = 20
const MAX_TERMS_PER_FIELD = 80
const MAX_TERM_LENGTH = 80
const MAX_PROJECT_NAME_LENGTH = 80

export function createEmptyProjectProfileSet(now = Date.now()): InterviewProjectProfileSet {
  return {
    profiles: [],
    updatedAt: now,
  }
}

export function createBlankProjectProfile(now = Date.now()): InterviewProjectProfile {
  return {
    id: `project-profile-${now}`,
    name: "",
    aliases: [],
    strongTerms: [],
    weakTerms: [],
    technicalTerms: [],
    negativeTerms: [],
    strongCombos: [],
    enabled: true,
    updatedAt: now,
  }
}

export function normalizeProjectProfileSet(
  value: Partial<InterviewProjectProfileSet> | null | undefined,
  now = Date.now(),
): InterviewProjectProfileSet {
  if (!value || !Array.isArray(value.profiles)) return createEmptyProjectProfileSet(now)
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  const profiles: InterviewProjectProfile[] = []

  for (const rawProfile of value.profiles.slice(0, MAX_PROFILES)) {
    const profile = normalizeProjectProfile(rawProfile, now)
    if (!profile) continue
    const nameKey = normalizeProfileKey(profile.name)
    if (!nameKey || seenNames.has(nameKey)) continue
    let id = profile.id
    if (seenIds.has(id)) id = `${id}-${profiles.length + 1}`
    seenIds.add(id)
    seenNames.add(nameKey)
    profiles.push({ ...profile, id })
  }

  return {
    profiles,
    updatedAt: numberOrNow(value.updatedAt, now),
  }
}

export function normalizeProjectProfile(
  value: Partial<InterviewProjectProfile> | null | undefined,
  now = Date.now(),
): InterviewProjectProfile | null {
  if (!value || typeof value !== "object") return null
  const name = trimLength(value.name, MAX_PROJECT_NAME_LENGTH)
  if (!name) return null
  const id = trimLength(value.id, 120) || stableProfileId(name)
  return {
    id,
    name,
    aliases: normalizeTerms(value.aliases),
    strongTerms: normalizeTerms(value.strongTerms),
    weakTerms: normalizeTerms(value.weakTerms),
    technicalTerms: normalizeTerms(value.technicalTerms),
    negativeTerms: normalizeTerms(value.negativeTerms),
    strongCombos: normalizeCombos(value.strongCombos),
    enabled: value.enabled !== false,
    updatedAt: numberOrNow(value.updatedAt, now),
  }
}

export function enabledProjectProfiles(
  profiles: readonly InterviewProjectProfile[] | undefined,
): InterviewProjectProfile[] {
  return (profiles ?? [])
    .map((profile) => normalizeProjectProfile(profile))
    .filter((profile): profile is InterviewProjectProfile => Boolean(profile?.enabled))
}

export function projectProfileNames(
  profiles: readonly InterviewProjectProfile[] | undefined,
): string[] {
  return enabledProjectProfiles(profiles).map((profile) => profile.name)
}

export function profileRoutingHints(
  profiles: readonly InterviewProjectProfile[] | undefined,
): string[] {
  return enabledProjectProfiles(profiles).map((profile) => {
    const terms = [
      ...profile.aliases,
      ...profile.strongTerms,
      ...profile.weakTerms,
      ...profile.technicalTerms,
    ].slice(0, 18)
    return terms.length > 0
      ? `${profile.name}：${terms.join("/")}`
      : `${profile.name}：未配置关键词，仅可通过项目名匹配`
  })
}

export function termsToMultiline(terms: readonly string[]): string {
  return terms.join("\n")
}

export function multilineToTerms(value: string): string[] {
  return normalizeTerms(value.split(/[\n,，;；]/g))
}

export function combosToMultiline(combos: readonly string[][]): string {
  return combos.map((combo) => combo.join(" + ")).join("\n")
}

export function multilineToCombos(value: string): string[][] {
  return normalizeCombos(
    value
      .split(/\n/g)
      .map((line) => line.split(/[+＋,，、]/g)),
  )
}

export async function loadProjectProfilesFromStorage(
  storage: ProjectProfileStorage = projectProfileStorage,
  now = Date.now(),
): Promise<InterviewProjectProfileSet> {
  const stored = await storage.load()
  return normalizeProjectProfileSet(stored, now)
}

export async function saveProjectProfilesToStorage(
  storage: ProjectProfileStorage,
  profiles: InterviewProjectProfileSet,
  now = Date.now(),
): Promise<InterviewProjectProfileSet> {
  const normalized = normalizeProjectProfileSet({
    ...profiles,
    updatedAt: now,
    profiles: profiles.profiles.map((profile) => ({ ...profile, updatedAt: now })),
  }, now)
  await storage.save(normalized)
  return normalized
}

export function createMemoryProjectProfileStorage(
  initial: Partial<InterviewProjectProfileSet> | null = null,
): ProjectProfileStorage {
  let state = initial
  return {
    async load() {
      return state
    },
    async save(profiles) {
      state = profiles
    },
  }
}

export const projectProfileStorage: ProjectProfileStorage = {
  load: loadInterviewProjectProfiles,
  save: saveInterviewProjectProfiles,
}

function normalizeTerms(value: unknown): string[] {
  const terms = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const term of terms) {
    const cleaned = trimLength(term, MAX_TERM_LENGTH)
    const key = normalizeProfileKey(cleaned)
    if (!cleaned || seen.has(key)) continue
    seen.add(key)
    normalized.push(cleaned)
    if (normalized.length >= MAX_TERMS_PER_FIELD) break
  }
  return normalized
}

function normalizeCombos(value: unknown): string[][] {
  const combos = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const normalized: string[][] = []
  for (const combo of combos) {
    const terms = normalizeTerms(combo)
    if (terms.length < 2) continue
    const key = terms.map(normalizeProfileKey).join("+")
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(terms)
    if (normalized.length >= MAX_TERMS_PER_FIELD) break
  }
  return normalized
}

function trimLength(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : ""
}

function numberOrNow(value: unknown, now: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : now
}

function stableProfileId(name: string): string {
  const key = normalizeProfileKey(name).replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
  return `project-profile-${key || "unnamed"}`
}

function normalizeProfileKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "")
}
