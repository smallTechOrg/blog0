import { z } from 'zod';

import { NEWSLETTER_SETTINGS_LIMITS } from '@/lib/api/dto';

import {
  ADMIN_NOTE_MAX,
  CONSENT_TEXT_MAX,
  CONSENT_VERSION_MAX,
  EMAIL_MAX,
  NAME_MAX,
  SIGNUP_SOURCE_URL_MAX,
} from './constants';

// Zod bodies for every newsletter route (spec/api.md → newsletter; spec/architecture.md §13.1).
// Pure: no I/O, importable by route handlers of slices S7.1 and S7.3 alike.

const L = NEWSLETTER_SETTINGS_LIMITS;

const emailField = z.string().trim().toLowerCase().max(EMAIL_MAX).pipe(z.email());

/** A relative path the footer form was on: starts with one `/`, ≤ 500 chars, default `/`. */
export const sourceUrlField = z
  .string()
  .trim()
  .max(SIGNUP_SOURCE_URL_MAX)
  .refine((v) => v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\'), 'sourceUrl must be a relative path')
  .refine((v) => !/[\s<>"'`]/.test(v), 'sourceUrl must be a relative path');

/** Stage A: ms from form mount to submit — an integer 0 … 24 h (spec/api.md). */
export const FILL_MS_MAX = 86_400_000;
/** Stage A honeypot field (`website`): any string ≤ 200; non-empty after trim ⇒ silent drop (bot-check.ts). */
export const HONEYPOT_MAX = 200;

/** POST /api/newsletter */
export const subscribeBody = z.object({
  email: emailField,
  name: z
    .string()
    .trim()
    .max(NAME_MAX)
    .nullish()
    .transform((v) => (v ? v : null)),
  sourceUrl: sourceUrlField.optional().default('/'),
  website: z.string().max(HONEYPOT_MAX).optional(),
  fillMs: z.number().int().min(0).max(FILL_MS_MAX).optional(),
});
export type SubscribeInput = z.infer<typeof subscribeBody>;

/** POST /api/newsletter/confirm */
export const confirmBody = z.object({ token: z.string().trim().min(1).max(200) });
/** POST /api/newsletter/unsubscribe (JSON form; the one-click form is parsed by hand) */
export const unsubscribeBody = z.object({ token: z.string().trim().min(1).max(200) });

/** POST /api/newsletter/webhook */
export const webhookBody = z.object({
  event: z.enum(['unsubscribe', 'bounce', 'complaint']),
  email: emailField,
  reason: z.string().trim().max(500).optional(),
  occurredAt: z.string().trim().max(40).optional(),
  providerRef: z.string().trim().max(200).optional(),
});
export type WebhookInput = z.infer<typeof webhookBody>;

/** `{ confirm: true }` bodies (send-legacy-confirmations, sync, send). */
export const confirmTrueBody = z.object({ confirm: z.literal(true) });

/** POST /api/admin/subscribers/:id/erase (fix pass): the typed address; matched against the row in the service. */
export const eraseBody = z.object({ confirmEmail: z.string().trim().min(1, 'Type the address to confirm.').max(EMAIL_MAX) }).strict();

/** POST /api/admin/subscribers/:id/unsubscribe */
export const adminUnsubscribeBody = z.object({
  note: z
    .string()
    .trim()
    .max(ADMIN_NOTE_MAX, `Note must be ${ADMIN_NOTE_MAX} characters or fewer.`)
    .optional()
    .transform((v) => (v ? v : undefined)),
});

/** GET /api/admin/subscribers query */
export const subscriberStatusParam = z.enum(['pending', 'confirmed', 'unsubscribed', 'bounced', 'legacy_unconfirmed']);
export const subscriberListQuery = z.object({
  status: subscriberStatusParam.optional(),
  q: z.string().trim().max(100).optional(),
  format: z.enum(['csv', 'audit']).optional(),
});

/** PATCH /api/admin/newsletter/settings — `modeSetAt` is server-set and refused (strict). */
export const settingsPatch = z
  .object({
    mode: z.enum(['per_post', 'digest', 'manual']).optional(),
    autoSend: z.boolean().optional(),
    digestDays: z.number().int().min(L.digestDays[0]).max(L.digestDays[1]).optional(),
    digestPosts: z.number().int().min(L.digestPosts[0]).max(L.digestPosts[1]).optional(),
    consentText: z
      .string()
      .trim()
      .min(1, 'Consent text can’t be empty.')
      .max(CONSENT_TEXT_MAX, `Consent text must be ${CONSENT_TEXT_MAX} characters or fewer.`)
      .optional(),
    consentVersion: z
      .string()
      .trim()
      .min(1, 'Consent version can’t be empty.')
      .max(CONSENT_VERSION_MAX, `Consent version must be ${CONSENT_VERSION_MAX} characters or fewer.`)
      .optional(),
  })
  .strict();
export type SettingsPatchInput = z.infer<typeof settingsPatch>;

const issueTitle = z.string().trim().min(1, 'Title can’t be empty.').max(L.issueTitle);
const issueIntro = z.string().max(L.issueIntroMd);
const articleIds = z.array(z.uuid()).min(L.issuePosts[0]).max(L.issuePosts[1]);

/** POST /api/admin/newsletter/issues */
export const issueCreate = z.object({ title: issueTitle, introMd: issueIntro.optional().default(''), articleIds }).strict();
/** PATCH /api/admin/newsletter/issues/:id */
export const issueUpdate = z.object({ title: issueTitle.optional(), introMd: issueIntro.optional(), articleIds: articleIds.optional() }).strict();
