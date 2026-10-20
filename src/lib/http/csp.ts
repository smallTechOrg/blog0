// Runtime browser-hardening headers (spec/architecture.md §6, capability abuse-protection): the
// per-request CSP and HSTS the proxy sets in production. Pure. The static headers on every
// response (nosniff, Referrer-Policy, X-Frame-Options, COOP, Permissions-Policy) live in
// next.config.ts `headers()`.

export interface CspOptions {
  /** Fresh per request (base64 of 16 random bytes). */
  nonce: string;
  /** True when BLOG0_PUBLIC_BASE_URL is https: adds `upgrade-insecure-requests` (and HSTS below). */
  https: boolean;
}

/**
 * The page Content-Security-Policy. Scripts run only with the request's nonce ('strict-dynamic'
 * lets Next's nonce'd loader pull its chunks); styles allow inline (React style attributes cannot
 * carry nonces); images from self, data:, blob: and any https host (Markdown may embed remote
 * images); audio only from self (+ blob: for local previews); no framing, plugins or foreign forms.
 */
export function buildContentSecurityPolicy({ nonce, https }: CspOptions): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ];
  if (https) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

export const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

/** The per-request headers the proxy sets (lower-case names): the CSP, plus HSTS over https. */
export function runtimeSecurityHeaders(options: CspOptions): Record<string, string> {
  const headers: Record<string, string> = { 'content-security-policy': buildContentSecurityPolicy(options) };
  if (options.https) headers['strict-transport-security'] = HSTS_VALUE;
  return headers;
}

/** True when the public origin is https (HSTS + upgrade-insecure-requests apply). */
export function isHttpsOrigin(publicBaseUrl: string): boolean {
  return /^https:\/\//i.test(publicBaseUrl.trim());
}
