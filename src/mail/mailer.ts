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
};

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
   * `secure: false` with no auth is correct for the configured default (port 1025, MailHog) and
   * for an in-cluster relay. A deployment terminating TLS or requiring credentials configures
   * that at the relay rather than here — which keeps SMTP credentials out of this codebase
   * entirely, and is why `config.ts` has no `SMTP_USER` or `SMTP_PASSWORD` to leak.
   */
  const transport =
    deps.transport ??
    nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: false,
      /* A mail that hangs must not hold a worker indefinitely. */
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

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
