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
} as const;

/** The `resource_type` for identity audit entries. Matches the table name, as elsewhere. */
export const USER_RESOURCE = 'app_user';
