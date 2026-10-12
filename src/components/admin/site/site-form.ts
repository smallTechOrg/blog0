// Admin → Site form helpers (pure, isomorphic): saved settings ⇄ form draft, the minimal PATCH
// (spec/api.md PATCH /api/admin/site — any subset), client-side validation mirroring the server
// schema (src/server/site/service.ts), and the server's VALIDATION_FAILED details → field errors.

import { SITE_SETTINGS_LIMITS, type SiteSettingsDto, type SiteSettingsPatch } from '@/lib/api/dto';

export type SiteField = keyof SiteSettingsDto;

/** Every input is a string; a null social URL is an empty input. */
export type SiteSettingsDraft = Record<SiteField, string>;

export type FieldErrors = Partial<Record<SiteField, string>>;

export const SITE_FIELDS: readonly SiteField[] = [
  'tagline',
  'contactEmail',
  'aboutStrap',
  'aboutStand',
  'aboutBodyMd',
  'socialXUrl',
  'socialLinkedinUrl',
] as const;

const URL_FIELDS: ReadonlySet<SiteField> = new Set<SiteField>(['socialXUrl', 'socialLinkedinUrl']);

export const FIELD_LABELS: Record<SiteField, string> = {
  tagline: 'Tagline',
  contactEmail: 'Contact email',
  aboutStrap: 'About strap',
  aboutStand: 'About standfirst',
  aboutBodyMd: 'About text',
  socialXUrl: 'X URL',
  socialLinkedinUrl: 'LinkedIn URL',
};

export function maxLengthOf(field: SiteField): number {
  return URL_FIELDS.has(field) ? SITE_SETTINGS_LIMITS.socialUrl : SITE_SETTINGS_LIMITS[field as Exclude<SiteField, 'socialXUrl' | 'socialLinkedinUrl'>];
}

export function draftFrom(saved: SiteSettingsDto): SiteSettingsDraft {
  const draft = {} as SiteSettingsDraft;
  for (const f of SITE_FIELDS) draft[f] = saved[f] ?? '';
  return draft;
}

/** The value the server would store for a draft input (trimmed; a blank URL → null). */
function normalized(field: SiteField, value: string): string | null {
  const v = value.trim();
  if (URL_FIELDS.has(field)) return v || null;
  return v;
}

/** Only the fields that differ from the saved settings, as the server would store them. */
export function patchFrom(saved: SiteSettingsDto, draft: SiteSettingsDraft): SiteSettingsPatch {
  const patch: Record<string, string | null> = {};
  for (const f of SITE_FIELDS) {
    const next = normalized(f, draft[f]);
    const prev = saved[f] ?? null;
    if (next !== prev) patch[f] = next;
  }
  return patch as SiteSettingsPatch;
}

export function isDirty(saved: SiteSettingsDto, draft: SiteSettingsDraft): boolean {
  return Object.keys(patchFrom(saved, draft)).length > 0;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Client-side checks (the server re-checks everything); {} when the draft can be saved. */
export function validateDraft(draft: SiteSettingsDraft): FieldErrors {
  const errors: FieldErrors = {};
  for (const f of SITE_FIELDS) {
    const v = draft[f].trim();
    const label = FIELD_LABELS[f];
    const max = maxLengthOf(f);
    if (URL_FIELDS.has(f)) {
      if (!v) continue;
      if (v.length > max) errors[f] = `${label} must be ${max} characters or fewer.`;
      else if (!isHttpUrl(v)) errors[f] = `${label} must start with https:// (or http://).`;
      continue;
    }
    if (!v) errors[f] = `${label} can’t be empty.`;
    else if (v.length > max) errors[f] = `${label} must be ${max} characters or fewer.`;
    else if (f === 'contactEmail' && !EMAIL_RE.test(v)) errors[f] = 'Enter a valid email address.';
  }
  return errors;
}

/** `error.details` of a 400 VALIDATION_FAILED ({ fieldErrors: { field: [msg] } }) → per-field messages. */
export function fieldErrorsFrom(details: unknown): FieldErrors {
  if (!details || typeof details !== 'object') return {};
  const fe = (details as { fieldErrors?: unknown }).fieldErrors;
  if (!fe || typeof fe !== 'object' || Array.isArray(fe)) return {};
  const out: FieldErrors = {};
  for (const f of SITE_FIELDS) {
    const msgs = (fe as Record<string, unknown>)[f];
    const first = Array.isArray(msgs) ? msgs.find((m) => typeof m === 'string' && m) : typeof msgs === 'string' ? msgs : undefined;
    if (typeof first === 'string' && first) out[f] = first;
  }
  return out;
}
