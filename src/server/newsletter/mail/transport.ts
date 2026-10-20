import 'server-only';

import nodemailer, { type Transporter } from 'nodemailer';

import { getConfig, STUB_MAIL_FROM, type SmtpConfig } from '../../config';
import { getDb } from '../../db/client';
import { newsletterMessage } from '../../db/schema';
import { log, maskEmail } from '../../log';
import { getCurrentSite } from '../../site/current';
import { redactConfirmUrl } from '../erase';

// Transactional mail (spec/architecture.md §13.2): the SMTP transport (nodemailer, BLOG0_SMTP_*) or,
// without BLOG0_SMTP_HOST, the recording stub whose `newsletter_message` row IS the delivery —
// designer mode, tests and E2E never need SMTP. Both transports insert the message row and log one
// `newsletter.mail` line (§7); only the stub adds `confirm_url` so a designer can follow the link.

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  kind: 'confirmation' | 'test_issue';
  subscriberId?: string;
  issueId?: string;
  /** Stub only: logged in clear so the signup → confirm walk runs with nothing configured. */
  confirmUrl?: string;
  /** Confirmation messages: the `List-Unsubscribe` + RFC 8058 one-click header target — the POST
   *  endpoint (`oneClickUnsubscribeUrl`), never the page. */
  listUnsubscribeUrl?: string;
  requestId?: string;
}

export interface MailResult {
  outcome: 'sent' | 'stubbed';
  transport: 'smtp' | 'stub';
  messageId: string;
  messageRowId: string;
}

export interface MailTransport {
  readonly kind: 'smtp' | 'stub';
  /** Throws MailError when the message was not accepted; the `newsletter_message` row still records the failure. */
  send(msg: MailMessage): Promise<MailResult>;
}

export class MailError extends Error {
  readonly transport: 'smtp' | 'stub';
  constructor(transport: 'smtp' | 'stub', message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MailError';
    this.transport = transport;
  }
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, 500);
}

/**
 * The stored row is the audit copy, not the delivery: a `confirmation` is stored with its confirm token
 * replaced (`…/newsletter/confirm?t=[redacted]`, fix pass) so a database copy can never confirm an
 * address. The transport still sends the real message; the stub's log line keeps `confirm_url`.
 */
async function recordMessage(msg: MailMessage, fields: { transport: 'smtp' | 'stub'; status: 'sent' | 'failed' | 'stubbed'; providerMessageId?: string | null; error?: string | null }): Promise<string> {
  const site = await getCurrentSite();
  const [row] = await getDb()
    .insert(newsletterMessage)
    .values({
      siteId: site.id,
      kind: msg.kind,
      subscriberId: msg.subscriberId ?? null,
      issueId: msg.issueId ?? null,
      toEmail: msg.to,
      subject: msg.subject,
      html: msg.kind === 'confirmation' ? redactConfirmUrl(msg.html) : msg.html,
      text: msg.kind === 'confirmation' ? redactConfirmUrl(msg.text) : msg.text,
      transport: fields.transport,
      status: fields.status,
      providerMessageId: fields.providerMessageId ?? null,
      error: fields.error ?? null,
    })
    .returning({ id: newsletterMessage.id });
  return row.id;
}

/** Records every message in `newsletter_message` (status `stubbed`) and logs the confirm URL. */
export class StubTransport implements MailTransport {
  readonly kind = 'stub' as const;

  async send(msg: MailMessage): Promise<MailResult> {
    const started = performance.now();
    const messageRowId = await recordMessage(msg, { transport: 'stub', status: 'stubbed' });
    const messageId = `stub-${messageRowId}`;
    log.info('newsletter.mail', {
      msg: `Stub mail recorded (${msg.kind})`,
      request_id: msg.requestId,
      kind: msg.kind,
      to_masked: maskEmail(msg.to),
      transport: 'stub',
      outcome: 'stubbed',
      latency_ms: Math.round(performance.now() - started),
      message_id: messageId,
      confirm_url: msg.confirmUrl,
    });
    return { outcome: 'stubbed', transport: 'stub', messageId, messageRowId };
  }
}

/** RFC 2369 + RFC 8058 headers for a one-click unsubscribe target (none without one). */
export function listUnsubscribeHeaders(url: string | undefined): Record<string, string> {
  if (!url) return {};
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

export class SmtpTransport implements MailTransport {
  readonly kind = 'smtp' as const;
  readonly #from: string;
  readonly #transporter: Transporter;

  /**
   * `options.requireTLS: false` exists for the integration tests' Mailpit sink only (plain SMTP on
   * 127.0.0.1:1025); configuration never turns STARTTLS off (spec/architecture.md §10 BLOG0_SMTP_PORT).
   */
  constructor(smtp: SmtpConfig, options: { requireTLS?: boolean } = {}) {
    this.#from = smtp.from;
    this.#transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      requireTLS: smtp.port !== 465 && options.requireTLS !== false,
      auth: smtp.user !== null && smtp.pass !== null ? { user: smtp.user, pass: smtp.pass.reveal() } : undefined,
      connectionTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(msg: MailMessage): Promise<MailResult> {
    const started = performance.now();
    const headers = listUnsubscribeHeaders(msg.listUnsubscribeUrl);
    let providerMessageId: string | null = null;
    let failure: unknown = null;
    try {
      const info = await this.#transporter.sendMail({ from: this.#from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, headers });
      providerMessageId = typeof info.messageId === 'string' ? info.messageId : null;
    } catch (err) {
      failure = err;
    }
    const messageRowId = await recordMessage(msg, {
      transport: 'smtp',
      status: failure ? 'failed' : 'sent',
      providerMessageId,
      error: failure ? errorText(failure) : null,
    });
    const latency = Math.round(performance.now() - started);
    if (failure) {
      log.warn('newsletter.mail', {
        msg: `SMTP send failed (${msg.kind})`,
        request_id: msg.requestId,
        kind: msg.kind,
        to_masked: maskEmail(msg.to),
        transport: 'smtp',
        outcome: 'failed',
        latency_ms: latency,
        err_code: (failure as { code?: string } | null)?.code ?? 'SMTP_ERROR',
      });
      throw new MailError('smtp', `The mail server did not accept the message: ${errorText(failure)}`, { cause: failure });
    }
    const messageId = providerMessageId ?? `smtp-${messageRowId}`;
    log.info('newsletter.mail', {
      msg: `Mail sent (${msg.kind})`,
      request_id: msg.requestId,
      kind: msg.kind,
      to_masked: maskEmail(msg.to),
      transport: 'smtp',
      outcome: 'sent',
      latency_ms: latency,
      message_id: messageId,
    });
    return { outcome: 'sent', transport: 'smtp', messageId, messageRowId };
  }
}

const transportKey = Symbol.for('blog0.mailTransport');
const warnedKey = Symbol.for('blog0.mailNotConfiguredWarned');
type GlobalWithTransport = typeof globalThis & { [transportKey]?: MailTransport; [warnedKey]?: boolean };

export function createMailTransport(): MailTransport {
  const config = getConfig();
  if (config.newsletter.smtp) return new SmtpTransport(config.newsletter.smtp);
  const g = globalThis as GlobalWithTransport;
  if (config.isProduction && !g[warnedKey]) {
    g[warnedKey] = true;
    log.warn('newsletter.mail_not_configured', {
      msg: 'No BLOG0_SMTP_HOST: confirmation and test messages are recorded, not delivered',
      hint: 'set BLOG0_SMTP_HOST/PORT/USER/PASS/FROM in .env (docs/deploy.md → Newsletter)',
    });
  }
  return new StubTransport();
}

/** The process-wide transport (globalThis so every server bundle shares one). */
export function getMailTransport(): MailTransport {
  const g = globalThis as GlobalWithTransport;
  g[transportKey] ??= createMailTransport();
  return g[transportKey];
}

/** Tests: inject a transport, or clear it so the next call re-selects from config. */
export function resetMailTransportForTests(transport?: MailTransport): void {
  const g = globalThis as GlobalWithTransport;
  g[transportKey] = transport;
  g[warnedKey] = undefined;
}

/** What Admin → Site → Newsletter shows: the transport kind and From address. */
export function mailStatus(): { transport: 'smtp' | 'stub'; from: string | null } {
  const smtp = getConfig().newsletter.smtp;
  return smtp ? { transport: 'smtp', from: smtp.from } : { transport: 'stub', from: STUB_MAIL_FROM };
}
