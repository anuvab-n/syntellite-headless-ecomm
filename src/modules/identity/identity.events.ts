/**
 * The identity module's event and audit vocabulary.
 *
 * Same reasoning as the catalogue's: an event name is persisted and matched against a handler
 * registry, so a typo produces an event nothing handles rather than a failure. A constant
 * makes it a compile error.
 */

export const USER_AGGREGATE = 'app_user';

export const USER_EVENTS = {
  /**
   * A customer account was created.
   *
   * The first producer in the system and the one the outbox was designed around — a welcome
   * email must not be sent by the registration request itself, because a mail provider being
   * slow would then make signing up slow, and a mail provider being down would make it fail.
   */
  registered: 'user.registered',
  /**
   * A customer asked to reset their password, and a token was issued.
   *
   * **The SECOND producer, and the first with a real consumer.** The payload carries the reset
   * token, because the mail the consumer sends has to contain it — see
   * `requestPasswordReset` on why that trade-off is the right one and what bounds it.
   *
   * Unlike `user.registered`, this event is not optional to deliver: a token nobody mails is a
   * customer who stays locked out. That is why the mailer is registered in the handler registry
   * rather than deferred like every event before it.
   */
  passwordResetRequested: 'user.password_reset_requested',
} as const;

/**
 * Audit actions.
 *
 * Prefixed `auth.` rather than `user.` because these are authentication events read during a
 * security review, and an auditor filtering for `auth.` should find all of them together.
 */
export const AUTH_AUDIT = {
  passwordChanged: 'auth.password_changed',
  registered: 'auth.registered',
  /** A reset was REQUESTED. Records that a token was minted, never the token. */
  passwordResetRequested: 'auth.password_reset_requested',
  /** A reset COMPLETED. The pair of these two bounds how long the window was open. */
  passwordReset: 'auth.password_reset',
} as const;

/** The `resource_type` for identity audit entries. Matches the table name, as elsewhere. */
export const USER_RESOURCE = 'app_user';
