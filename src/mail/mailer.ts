import nodemailer, { type Transporter } from 'nodemailer';

import type { Logger } from '../shared/logger.js';

/**
 * The SMTP mailer.
 *
 * **The only file in `src/` that knows how mail is sent.** Everything above it depends on the
 * `Mailer` port, so a handler cannot accidentally couple itself to nodemailer, and swapping SMTP
 * for a provider API is a sibling file plus one line in the composition root — the same shape
 * `razorpay/gateway.ts` gives the payment provider.
 *
 * Parallel to `redis/rate-limiter.ts`: an adapter for an external system, at the top level
 * rather than inside a domain module, because a domain module that imported a transport could
 * not be tested without one.
 *
 * ## Why a dependency here and not for Razorpay
 *
 * The payment adapter needed two operations, both one standard-library call, so it takes none.
 * SMTP is the opposite: the protocol has TLS negotiation, AUTH mechanisms, line-ending and
 * dot-stuffing rules, header encoding for non-ASCII names and subjects, and connection reuse.
 * Hand-rolling that is a genuine source of silent delivery failures, and `nodemailer` is the
 * one obvious, long-standing implementation. One dependency, chosen for the part that is
 * actually hard.
 *
 * ## What this file must never log
 *
 * Not the message body, and not the recipient beyond what an operator needs to trace a
 * delivery. A reset mail body contains a live password-reset token; a log store is read by more
 * people than the database. What is logged is the outcome and the message id.
 */

/**
 * Sending one message, as the rest of the system needs it.
 *
 * Deliberately tiny: a recipient, a subject, and both bodies. No attachments, no CC, no
 * templates, no scheduling — none of it is needed by the one caller that exists, and each would
 * be a guess at a shape a later feature might want.
 */
export type Mailer = {
  send(message: { to: string; subject: string; text: string; html: string }): Promise<void>;
};

export type MailerConfig = {
  readonly host: string;
  readonly port: number;
  /** The `From` header. A deployment concern, never a per-message argument. */
  readonly from: string;
  /**
   * SMTP credentials. Both optional, and they travel together — see `authOf`.
   *
   * Absent is the local shape (MailHog accepts mail from anyone). Present is every hosted
   * provider, none of which will relay without AUTH.
   */
  readonly user?: string | undefined;
  readonly password?: string | undefined;
  /**
   * Implicit TLS from the first byte (SMTPS, conventionally port 465).
   *
   * `false` means start in the clear and upgrade via STARTTLS when offered — what port 587
   * and MailHog both want. Explicit rather than inferred from the port, because guessing from
   * `465` silently does the wrong thing for a provider that puts implicit TLS elsewhere.
   */
  readonly secure?: boolean | undefined;
};

/**
 * The `auth` block nodemailer should receive, or nothing at all.
 *
 * **Both halves or neither.** A username with no password makes nodemailer attempt AUTH and
 * fail the whole send; passing a half-configured pair would turn a deployment typo into a
 * silent, total delivery outage. Omitting `auth` entirely is the documented way to say
 * "unauthenticated relay", which is exactly what the local MailHog setup is.
 */
function authOf(config: MailerConfig): { user: string; pass: string } | undefined {
  if (config.user === undefined || config.password === undefined) return undefined;
  return { user: config.user, pass: config.password };
}

export function createSmtpMailer(deps: {
  config: MailerConfig;
  logger: Logger;
  /** Injected by tests so the adapter can be driven without a server. */
  transport?: Transporter;
}): Mailer {
  const { config, logger } = deps;

  /**
   * Created once and reused, so a burst of mail does not open a connection per message.
   *
   * Both `secure` and `auth` come from configuration rather than being fixed here. The
   * unauthenticated cleartext shape — port 1025, MailHog, or an in-cluster relay that does its
   * own TLS — is still the DEFAULT and needs no new variables: omit `SMTP_USER`/`SMTP_PASS`
   * and leave `SMTP_SECURE` unset and this builds exactly the transport it always did.
   *
   * What changed is that a hosted provider is now expressible. SES, SendGrid and Postmark all
   * refuse to relay without AUTH, so a build that could not send credentials could not send
   * mail at all in production.
   */
  const auth = authOf(config);
  const transport =
    deps.transport ??
    nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure ?? false,
      /*
       * Spread, never `auth: undefined`. Nodemailer treats the key's PRESENCE as a request to
       * authenticate, so an explicit `undefined` is not the same as omitting it.
       */
      ...(auth === undefined ? {} : { auth }),
      /* A mail that hangs must not hold a worker indefinitely. */
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

  /*
   * One line at startup so an operator can see WHICH shape was built without reading the
   * environment — the single most useful fact when mail silently stops.
   *
   * `authenticated` is a boolean, never the username, and the password is not referenced here
   * at all. Nothing in this file logs either, and `shared/logger.ts` redacts `password` as a
   * second line of defence.
   */
  logger.info(
    {
      host: config.host,
      port: config.port,
      secure: config.secure ?? false,
      authenticated: auth !== undefined,
    },
    'mailer_configured',
  );

  return {
    async send(message) {
      try {
        const result = await transport.sendMail({
          from: config.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });

        /*
         * The message id and the subject only. Never `text`, never `html` — the body of the one
         * mail this system sends contains a credential.
         */
        logger.info({ messageId: result.messageId, subject: message.subject }, 'mail_sent');
      } catch (err) {
        /*
         * Rethrown, always. The outbox retries on a throw and marks the event delivered on a
         * return, so swallowing this would lose the mail permanently — and for a password reset
         * that means a customer who stays locked out with no error anywhere.
         */
        logger.error({ err, subject: message.subject }, 'mail_send_failed');
        throw err;
      }
    },
  };
}
