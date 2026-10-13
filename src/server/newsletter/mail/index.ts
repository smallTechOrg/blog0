import 'server-only';

import { getConfig } from '../../config';
import type { NewsletterSubscriberRow, SiteRow } from '../../db/schema';

import { CONFIRM_TOKEN_TTL_MS } from '../constants';
import { confirmUrl, oneClickUnsubscribeUrl, unsubscribeUrl } from '../links';
import { confirmationEmail } from './templates';
import { getMailTransport, type MailResult } from './transport';

export { confirmationEmail, esc, type RenderedEmail } from './templates';
export {
  createMailTransport,
  getMailTransport,
  listUnsubscribeHeaders,
  MailError,
  mailStatus,
  resetMailTransportForTests,
  SmtpTransport,
  StubTransport,
  type MailMessage,
  type MailResult,
  type MailTransport,
} from './transport';

/** Composes and sends the confirmation message for `subscriber` with its freshly issued `token`. */
export async function sendConfirmationMail(
  subscriber: Pick<NewsletterSubscriberRow, 'id' | 'email'>,
  token: string,
  site: Pick<SiteRow, 'brandName' | 'newsletterConsentText'>,
  requestId?: string,
): Promise<MailResult> {
  const link = confirmUrl(token);
  const unsubscribe = unsubscribeUrl(subscriber.id);
  const rendered = confirmationEmail({
    brand: site.brandName,
    confirmUrl: link,
    unsubscribeUrl: unsubscribe,
    consentText: site.newsletterConsentText,
    expiresHours: Math.round(CONFIRM_TOKEN_TTL_MS / 3_600_000),
    publicBaseUrl: getConfig().publicBaseUrl,
  });
  return getMailTransport().send({
    to: subscriber.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    kind: 'confirmation',
    subscriberId: subscriber.id,
    confirmUrl: link,
    // The header goes to the RFC 8058 POST endpoint; the body links (above) stay the page.
    listUnsubscribeUrl: oneClickUnsubscribeUrl(subscriber.id),
    requestId,
  });
}
