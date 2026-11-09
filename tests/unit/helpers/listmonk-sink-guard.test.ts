import { describe, expect, it } from 'vitest';

import { LISTMONK_ENV_FILE, smtpSinkViolations } from '../../helpers/listmonk';

// Listmonk tests must never send through a real relay: before any test touches the instance, the
// helper reads its /api/settings and refuses unless every ENABLED SMTP server is the Mailpit sink.

const sink = { enabled: true, host: 'mailpit', port: 1025 };

describe('smtpSinkViolations', () => {
  it('the test stack (mailpit:1025, or a loopback :1025) passes', () => {
    expect(smtpSinkViolations({ smtp: [sink] })).toEqual([]);
    expect(smtpSinkViolations({ smtp: [{ ...sink, host: '127.0.0.1' }, { ...sink, host: 'localhost' }, { ...sink, host: ' MailPit ' }] })).toEqual([]);
  });

  it('a disabled real relay is ignored; an enabled one is reported (host:port only)', () => {
    const relay = { enabled: true, host: 'smtp-relay.gmail.com', port: 587, username: 'u', password: '••••' };
    expect(smtpSinkViolations({ smtp: [sink, { ...relay, enabled: false }] })).toEqual([]);
    expect(smtpSinkViolations({ smtp: [sink, relay] })).toEqual(['smtp-relay.gmail.com:587']);
  });

  it('the Listmonk install default (smtp.yoursite.com:25), a sink host on another port, or a non-sink host on 1025 are refused', () => {
    expect(smtpSinkViolations({ smtp: [{ enabled: true, host: 'smtp.yoursite.com', port: 25 }] })).toEqual(['smtp.yoursite.com:25']);
    expect(smtpSinkViolations({ smtp: [{ ...sink, port: 25 }] })).toEqual(['mailpit:25']);
    expect(smtpSinkViolations({ smtp: [{ ...sink, host: 'mail.example.com' }] })).toEqual(['mail.example.com:1025']);
  });

  it('malformed settings fail closed: no smtp array, no enabled server, or a server without a host', () => {
    expect(smtpSinkViolations({})).toEqual(['no smtp settings']);
    expect(smtpSinkViolations(null)).toEqual(['no smtp settings']);
    expect(smtpSinkViolations({ smtp: [{ ...sink, enabled: false }] })).toEqual(['no enabled SMTP server (expected the Mailpit sink)']);
    expect(smtpSinkViolations({ smtp: [{ enabled: true, port: 1025 }] })).toEqual(['(no host):1025']);
  });
});

describe('LISTMONK_ENV_FILE', () => {
  it('is the TEST stack env file, never the dev one', () => {
    expect(LISTMONK_ENV_FILE).toMatch(/var[\\/]listmonk-test\.env$/);
  });
});
