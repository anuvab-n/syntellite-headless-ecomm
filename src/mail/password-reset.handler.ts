import type { EventHandler } from '../shared/events.js';
import type { Logger } from '../shared/logger.js';
import type { Mailer } from './mailer.js';

/**
 * The password-reset email handler.
 *
 * **The first real outbox consumer in this system.** Every event before it shipped without one,
 * on the rule that an event with no consumer is a guess at one. This is the case that rule was
 * waiting for: a reset token nobody mails is not a deferred feature, it is a customer locked
 * out of their account.
 *
 * Lives in `mail/` rather than in the identity module because it is a delivery concern. It
 * reads an event and calls a port; it knows nothing about `app_user`, and the identity module
 * knows nothing about SMTP.
 *
 * ## Idempotency
 *
 * The outbox is at-least-once, so this WILL occasionally run twice — a worker crash after the
 * send but before the ack is enough. Sending a second identical reset mail is a tolerable
 * outcome (the token is the same, and it is single-use), so this handler does not claim a
 * `processed_event` row. That is a deliberate reading of the trade-off: the alternative is a
 * claim that, if the send then failed, would suppress the retry and lose the mail. For a
 * credential-recovery mail, a duplicate is much cheaper than a miss.
 *
 * ## What is not in the log
 *
 * Never the token, and never the rendered body. The event id and the outcome are what an
 * operator needs to trace a delivery; the rest is a live credential.
 */

/** How the link is built. A deployment concern, so it arrives as config, not as event data. */
export type PasswordResetMailConfig = {
  /**
   * Where the reset form lives, e.g. `https://shop.example.com/reset-password`.
   *
   * From configuration and NEVER from the request — a client-supplied URL that ended up in
   * this mail would be an open redirect carrying a live token wherever the caller asked, which
   * is why `ForgotPasswordRequestSchema` has no `redirectUrl` field to supply.
   */
  readonly resetUrlBase: string;
  /** Shown in the mail so the recipient knows who it is from. */
  readonly storeName: string;
};

/**
 * Read the fields this handler needs out of an event payload.
 *
 * Hand-narrowed rather than trusted. The payload is `JsonObject` by the time it reaches here,
 * and an event written by an older version of the producer is a real possibility after a
 * deploy — so a missing field is a thrown error the outbox will surface, not a mail addressed
 * to `undefined`.
 */
function readPayload(payload: Record<string, unknown>): { email: string; token: string } {
  const email = payload['email'];
  const token = payload['token'];

  if (typeof email !== 'string' || email.length === 0) {
    throw new Error('password reset event carried no email');
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('password reset event carried no token');
  }
  return { email, token };
}

export function createPasswordResetMailHandler(deps: {
  mailer: Mailer;
  config: PasswordResetMailConfig;
  logger: Logger;
}): EventHandler {
  const { mailer, config, logger } = deps;

  return async (event) => {
    const { email, token } = readPayload(event.payload);

    /*
     * `encodeURIComponent` because the token is base64url — which is URL-safe by construction,
     * so this is belt and braces rather than a fix. It costs nothing and it means a future
     * change to the token encoding cannot silently produce a broken link.
     */
    const link = `${config.resetUrlBase}?token=${encodeURIComponent(token)}`;

    const text = [
      `Someone asked to reset the password for your ${config.storeName} account.`,
      '',
      'To choose a new password, open this link:',
      link,
      '',
      'The link works once and expires in one hour.',
      '',
      'If you did not ask for this, you can ignore this email — your password has not changed.',
    ].join('\n');

    /*
     * The link text is the URL itself rather than "click here". A recipient can then see where
     * it goes before following it, which is the one thing that makes a reset mail
     * distinguishable from a phishing mail imitating one.
     */
    const html = [
      `<p>Someone asked to reset the password for your ${config.storeName} account.</p>`,
      `<p><a href="${link}">${link}</a></p>`,
      '<p>The link works once and expires in one hour.</p>',
      '<p>If you did not ask for this, you can ignore this email — your password has not changed.</p>',
    ].join('\n');

    await mailer.send({
      to: email,
      subject: `Reset your ${config.storeName} password`,
      text,
      html,
    });

    logger.info({ eventId: event.id, attempts: event.attempts }, 'password_reset_mail_sent');
  };
}
