// Newsletter list constants (spec/architecture.md §13.1; capability newsletter-list.md "Assumed"
// block — each value is a product decision, reversible here in one place).

/** A confirmation link is good for 72 h after the signup that issued it. */
export const CONFIRM_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;
/** Confirmation emails per subscriber per rolling 24 h; a signup past the cap succeeds silently. */
export const CONFIRMATION_SENDS_PER_DAY = 3;
export const CONFIRMATION_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** signup_ip / confirmed_ip are nulled this long after confirmation (or signup, never confirmed). */
export const IP_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
export const SIGNUP_SOURCE_URL_MAX = 500;
export const USER_AGENT_MAX = 300;
export const CONSENT_TEXT_MAX = 300;
export const CONSENT_VERSION_MAX = 20;
export const EMAIL_MAX = 254;
export const NAME_MAX = 120;
export const ADMIN_NOTE_MAX = 300;
/** Confirm + unsubscribe links: per known client IP per hour. */
export const LINK_CAP_PER_IP = 30;
/** Confirm + unsubscribe links: per site per hour. */
export const LINK_CAP_PER_SITE = 1000;
export const LINK_WINDOW_MS = 60 * 60 * 1000;
/** `sendAllLegacyConfirmations`: rows per batch and the pause between batches. */
export const LEGACY_BATCH_SIZE = 20;
export const LEGACY_BATCH_PAUSE_MS = 200;
