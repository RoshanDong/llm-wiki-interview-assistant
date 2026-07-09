import { Plus, Save, Trash2 } from "lucide-react"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  combosToMultiline,
  createBlankProjectProfile,
  multilineToCombos,
  multilineToTerms,
  termsToMultiline,
} from "@/lib/interview-project-profiles"
import type {
  InterviewProjectProfile,
  InterviewProjectProfileSet,
} from "@/lib/interview-types"

interface ProjectProfilePanelProps {
  profileSet: InterviewProjectProfileSet
  saving: boolean
  onChange: (profileSet: InterviewProjectProfileSet) => void
  onSave: () => void
}

export function ProjectProfilePanel({
  profileSet,
  saving,
  onChange,
  onSave,
}: ProjectProfilePanelProps) {
  const { t } = useTranslation()
  const hasInvalidProfile = profileSet.profiles.some((profile) => !profile.name.trim())

  function updateProfiles(profiles: InterviewProjectProfile[]) {
    onChange({
      profiles,
      updatedAt: Date.now(),
    })
  }

  function updateProfile(id: string, patch: Partial<InterviewProjectProfile>) {
    updateProfiles(profileSet.profiles.map((profile) =>
      profile.id === id ? { ...profile, ...patch, updatedAt: Date.now() } : profile,
    ))
  }

  function addProfile() {
    updateProfiles([...profileSet.profiles, createBlankProjectProfile()])
  }

  function removeProfile(id: string) {
    updateProfiles(profileSet.profiles.filter((profile) => profile.id !== id))
  }

  return (
    <section className="min-h-0 rounded-md border p-3">
      <div className="min-h-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{t("interview.projectProfiles.title")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t("interview.projectProfiles.description")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={addProfile}>
              <Plus className="h-4 w-4" />
              {t("interview.projectProfiles.add")}
            </Button>
            <Button type="button" size="sm" disabled={saving || hasInvalidProfile} onClick={onSave}>
              <Save className="h-4 w-4" />
              {saving ? t("interview.projectProfiles.saving") : t("interview.projectProfiles.save")}
            </Button>
          </div>
        </div>

        {profileSet.profiles.length === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-5 text-sm text-muted-foreground">
            {t("interview.projectProfiles.empty")}
          </div>
        ) : (
          <div className="max-h-[13rem] overflow-y-auto pr-1">
            <div className="grid gap-3">
              {profileSet.profiles.map((profile) => (
                <ProfileEditor
                  key={profile.id}
                  profile={profile}
                  onChange={(patch) => updateProfile(profile.id, patch)}
                  onRemove={() => removeProfile(profile.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

interface ProfileEditorProps {
  profile: InterviewProjectProfile
  onChange: (patch: Partial<InterviewProjectProfile>) => void
  onRemove: () => void
}

function ProfileEditor({ profile, onChange, onRemove }: ProfileEditorProps) {
  const { t } = useTranslation()
  return (
    <div className="min-w-0 rounded-md border">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <label className="flex min-w-0 items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={profile.enabled}
            onChange={(event) => onChange({ enabled: event.currentTarget.checked })}
          />
          <span className="truncate">{t("interview.projectProfiles.enabled")}</span>
        </label>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
          {t("interview.projectProfiles.remove")}
        </Button>
      </div>
      <div className="grid gap-3 p-3 text-xs">
        <FieldLabel label={t("interview.projectProfiles.name")} required>
          <input
            value={profile.name}
            onChange={(event) => onChange({ name: event.currentTarget.value })}
            placeholder={t("interview.projectProfiles.namePlaceholder")}
            className="h-8 w-full rounded-md border bg-background px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </FieldLabel>
        <KeywordField
          label={t("interview.projectProfiles.aliases")}
          value={termsToMultiline(profile.aliases)}
          placeholder={t("interview.projectProfiles.aliasesPlaceholder")}
          onChange={(value) => onChange({ aliases: multilineToTerms(value) })}
        />
        <KeywordField
          label={t("interview.projectProfiles.strongTerms")}
          value={termsToMultiline(profile.strongTerms)}
          placeholder={t("interview.projectProfiles.strongTermsPlaceholder")}
          onChange={(value) => onChange({ strongTerms: multilineToTerms(value) })}
        />
        <KeywordField
          label={t("interview.projectProfiles.weakTerms")}
          value={termsToMultiline(profile.weakTerms)}
          placeholder={t("interview.projectProfiles.weakTermsPlaceholder")}
          onChange={(value) => onChange({ weakTerms: multilineToTerms(value) })}
        />
        <KeywordField
          label={t("interview.projectProfiles.technicalTerms")}
          value={termsToMultiline(profile.technicalTerms)}
          placeholder={t("interview.projectProfiles.technicalTermsPlaceholder")}
          onChange={(value) => onChange({ technicalTerms: multilineToTerms(value) })}
        />
        <KeywordField
          label={t("interview.projectProfiles.negativeTerms")}
          value={termsToMultiline(profile.negativeTerms)}
          placeholder={t("interview.projectProfiles.negativeTermsPlaceholder")}
          onChange={(value) => onChange({ negativeTerms: multilineToTerms(value) })}
        />
        <KeywordField
          label={t("interview.projectProfiles.strongCombos")}
          value={combosToMultiline(profile.strongCombos)}
          placeholder={t("interview.projectProfiles.strongCombosPlaceholder")}
          onChange={(value) => onChange({ strongCombos: multilineToCombos(value) })}
        />
      </div>
    </div>
  )
}

function FieldLabel({
  label,
  required = false,
  children,
}: {
  label: string
  required?: boolean
  children: ReactNode
}) {
  return (
    <label className="grid gap-1">
      <span className="font-medium">
        {label}
        {required ? <span className="ml-1 text-destructive">*</span> : null}
      </span>
      {children}
    </label>
  )
}

function KeywordField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  onChange: (value: string) => void
}) {
  return (
    <FieldLabel label={label}>
      <textarea
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="min-h-16 w-full resize-y rounded-md border bg-background px-2 py-1.5 leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      />
    </FieldLabel>
  )
}
