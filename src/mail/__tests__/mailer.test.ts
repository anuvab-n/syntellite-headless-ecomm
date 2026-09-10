import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSmtpMailer, type MailerConfig } from '../mailer.js';

/**
 * The SMTP transport's CONFIGURATION, which is the part a deployment gets wrong.
 *
 * `nodemailer.createTransport` is spied on rather than stubbed with a fake transport, because
 * the thing under test is precisely the options object handed to it — whether `auth` is
 * present, whether `secure` is set, and whether a half-configured credential pair is passed
 * through. A test that injected `deps.transport` would skip that call entirely and prove
 * nothing about it.
 *
 * Three shapes matter and all three are exercised:
 *
 *  1. **Local, unauthenticated** — MailHog on 1025. Must keep working unchanged; it is the
 *     default and the only shape that existed before.
 *  2. **Authenticated** — every hosted provider. Must send `auth`, or nothing is delivered.
 *  3. **Implicit TLS** — SMTPS on 465. Must set `secure: true`.
 *
 * Plus the one that is a security property rather than a feature: the password must never
 * reach a log line.
 */
describe('smtp mailer configuration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const BASE: MailerConfig = {
    host: 'smtp.example.com',
    port: 587,
    from: 'no-reply@example.com',
  };

  /** A logger that records rather than prints, so assertions can read what was written. */
  function recordingLogger() {
    const lines: unknown[] = [];
    /*
     * Pino's signature is `(obj, msg)`, so BOTH arguments have to be captured — recording only
     * the object silently drops the event name every assertion below looks for.
     */
    const record = (obj: unknown, msg?: unknown) => {
      lines.push(msg === undefined ? obj : { ...(obj as object), msg });
    };
    return {
      lines,
      logger: {
        info: record,
        error: record,
        warn: record,
        debug: record,
        fatal: record,
        trace: record,
        child: () => recordingLogger().logger,
      } as never,
    };
  }

  /** Build a mailer and hand back the options `createTransport` actually received. */
  function optionsFor(config: MailerConfig) {
    const spy = vi
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail: async () => ({ messageId: 'x' }) } as never);

    const { logger, lines } = recordingLogger();
    createSmtpMailer({ config, logger });

    expect(spy).toHaveBeenCalledTimes(1);
    return { options: spy.mock.calls[0]![0] as Record<string, unknown>, lines };
  }

  /* ══ 1. Local, unauthenticated — the existing behaviour ════════════════ */

  it('builds an UNAUTHENTICATED cleartext transport when no credentials are configured', () => {
    const { options } = optionsFor({ ...BASE, host: 'localhost', port: 1025 });

    expect(options['host']).toBe('localhost');
    expect(options['port']).toBe(1025);
    expect(options['secure']).toBe(false);
    /*
     * ABSENT, not `undefined`. Nodemailer treats the key's presence as a request to
     * authenticate, so an explicit undefined would break the local relay.
     */
    expect('auth' in options).toBe(false);
  });

  it('keeps the timeouts that stop a hung send holding a worker', () => {
    const { options } = optionsFor(BASE);

    expect(options['connectionTimeout']).toBe(10_000);
    expect(options['greetingTimeout']).toBe(10_000);
    expect(options['socketTimeout']).toBe(20_000);
  });

  /* ══ 2. Authenticated ══════════════════════════════════════════════════ */

  it('sends AUTH when both a user and a password are configured', () => {
    const { options } = optionsFor({ ...BASE, user: 'apikey', password: 'super-secret' });

    expect(options['auth']).toEqual({ user: 'apikey', pass: 'super-secret' });
  });

  it('omits AUTH when only the user is configured', () => {
    // Half a credential makes nodemailer attempt AUTH and fail the whole send. Omitting it
    // degrades to the relay behaviour instead of a total, silent delivery outage.
    const { options } = optionsFor({ ...BASE, user: 'apikey' });

    expect('auth' in options).toBe(false);
  });

  it('omits AUTH when only the password is configured', () => {
    const { options } = optionsFor({ ...BASE, password: 'super-secret' });

    expect('auth' in options).toBe(false);
  });

  /* ══ 3. Implicit TLS ═══════════════════════════════════════════════════ */

  it('enables implicit TLS when secure is true', () => {
    const { options } = optionsFor({ ...BASE, port: 465, secure: true });

    expect(options['secure']).toBe(true);
    expect(options['port']).toBe(465);
  });

  it('defaults secure to false when it is not configured', () => {
    // STARTTLS-on-587 is the common case and the safe default; 465 must be opted into.
    const { options } = optionsFor(BASE);

    expect(options['secure']).toBe(false);
  });

  it('combines implicit TLS with credentials', () => {
    const { options } = optionsFor({
      ...BASE,
      port: 465,
      secure: true,
      user: 'apikey',
      password: 'super-secret',
    });

    expect(options['secure']).toBe(true);
    expect(options['auth']).toEqual({ user: 'apikey', pass: 'super-secret' });
  });

  /* ══ 4. The password never reaches a log ═══════════════════════════════ */

  it('never logs the password, and reports authentication as a boolean', () => {
    const { lines } = optionsFor({
      ...BASE,
      user: 'apikey',
      password: 'super-secret-do-not-log',
    });

    const serialised = JSON.stringify(lines);
    expect(serialised).not.toContain('super-secret-do-not-log');
    // The username is not logged either — only whether AUTH is in play.
    expect(serialised).not.toContain('apikey');
    expect(serialised).toContain('mailer_configured');
    expect(lines[0]).toMatchObject({ authenticated: true, secure: false, port: 587 });
  });

  it('reports authenticated:false for the unauthenticated shape', () => {
    const { lines } = optionsFor({ ...BASE, host: 'localhost', port: 1025 });

    expect(lines[0]).toMatchObject({ authenticated: false });
  });

  /* ══ 5. Sending is unchanged ═══════════════════════════════════════════ */

  it('still sends through the injected transport, and logs no body', async () => {
    const sent: Record<string, unknown>[] = [];
    const transport = {
      sendMail: async (message: Record<string, unknown>) => {
        sent.push(message);
        return { messageId: 'msg-1' };
      },
    } as never;

    const { logger, lines } = recordingLogger();
    const mailer = createSmtpMailer({
      config: { ...BASE, user: 'apikey', password: 'secret' },
      logger,
      transport,
    });

    await mailer.send({
      to: 'ada@example.com',
      subject: 'Reset your password',
      text: 'token=LIVE-RESET-TOKEN',
      html: '<a>token=LIVE-RESET-TOKEN</a>',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: BASE.from, to: 'ada@example.com' });

    // The one mail this system sends carries a credential in its body.
    const serialised = JSON.stringify(lines);
    expect(serialised).not.toContain('LIVE-RESET-TOKEN');
    expect(serialised).toContain('mail_sent');
  });

  it('rethrows a send failure so the outbox retries', async () => {
    const transport = {
      sendMail: async () => {
        throw new Error('relay refused');
      },
    } as never;

    const { logger } = recordingLogger();
    const mailer = createSmtpMailer({ config: BASE, logger, transport });

    await expect(
      mailer.send({ to: 'a@example.com', subject: 's', text: 't', html: '<p>t</p>' }),
    ).rejects.toThrow('relay refused');
  });
});
