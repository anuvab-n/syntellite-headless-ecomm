import { z } from 'zod';

/**
 * The identity module's wire contracts.
 *
 * Two jobs, and both are security boundaries rather than plumbing:
 *
 *  1. Decide exactly which fields a client may send. Anything absent from the schema is a
 *     field an attacker cannot reach.
 *  2. Decide exactly which fields leave the system. `passwordHash` is a column; it is not
 *     part of any response, and the mapper is what guarantees that rather than every
 *     handler remembering.
 */

/* ── Field primitives ────────────────────────────────────────────────────── */

/**
 * Email, normalised BEFORE validation.
 *
 * Order matters: `.trim().toLowerCase()` then `.email()`. Validating first would reject
 * `" User@Example.com "` for having whitespace instead of accepting the address the user
 * plainly meant. Normalising first also means the value written to the database already
 * matches the `lower(email)` unique index, so the index and the application agree.
 *
 * 320 = 64-character local part + `@` + 255-character domain, the RFC 5321 maximum, and the
 * width of the column.
 */
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .email('must be a valid email address');

/**
 * Password.
 *
 * Length only — no composition rules. NIST SP 800-63B is explicit that mandatory character
 * classes push users toward predictable substitutions (`Password1!`) and offer little real
 * entropy, while length is what actually helps. 10 is the floor; the 128 ceiling bounds the
 * buffer handed to the Argon2 addon and matches the guard inside `password.ts`.
 *
 * Deliberately NOT trimmed: a leading or trailing space is a legitimate character in a
 * password, and silently stripping it means a password manager's value stops working.
 */
const passwordField = z
  .string()
  .min(10, 'must be at least 10 characters')
  .max(128, 'must be at most 128 characters');

/** Optional human name. Trimmed; empty becomes the column default rather than a null. */
const nameField = z.string().trim().max(150).optional();

/**
 * E.164-ish phone. Kept permissive on purpose: real customer phone formats vary more than
 * any regex we would write here, and the column is only 20 characters wide.
 */
const phoneField = z
  .string()
  .trim()
  .min(5)
  .max(20)
  .regex(/^\+?[0-9\s()-]+$/, 'must be a valid phone number')
  .optional();

/* ── POST /auth/register ─────────────────────────────────────────────────── */

/**
 * `strictObject`, not a plain object.
 *
 * A plain Zod object STRIPS unknown keys, so `{"email":…,"isStaff":true}` would succeed
 * with the extra key silently discarded. Stripping is safe here — the service never reads
 * client input for privilege fields — but silence is the wrong behaviour: a client sending
 * `isStaff` is either probing for a mass-assignment hole or badly confused, and both
 * deserve a 400 that says so.
 *
 * Note what is absent and therefore unreachable: `isStaff`, `isSuperuser`, `passwordHash`,
 * `storeId`, `id`, `emailVerifiedAt`, and every timestamp. The store comes from
 * `resolveStore`, the id from `newId()`, and the privilege flags are hard-coded false in
 * the service. None of them is a field a request can influence.
 */
export const RegisterRequestSchema = z.strictObject({
  email: emailField,
  password: passwordField,
  firstName: nameField,
  lastName: nameField,
  phone: phoneField,
  /** Explicit opt-in. Defaults to false, because consent is never assumed. */
  acceptsMarketing: z.boolean().optional(),
});

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

/* ── Responses ───────────────────────────────────────────────────────────── */

/**
 * The public shape of a user.
 *
 * An allowlist, built field by field. The alternative — spreading the row and deleting
 * `passwordHash` — inverts the safety: every column added to the table in a later phase
 * would be published by default, and the one that eventually leaks will be a column nobody
 * thought about. Here a new column is invisible until somebody adds it deliberately.
 */
export type UserResponse = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  emailVerified: boolean;
  acceptsMarketing: boolean;
  createdAt: string;
};

/** The row fields the mapper needs. Structural, so the repository picks the columns. */
export type MappableUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  emailVerifiedAt: Date | null;
  acceptsMarketing: boolean;
  createdAt: Date;
};

export function toUserResponse(user: MappableUser): UserResponse {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    /**
     * A boolean, not the timestamp. When an email was verified is an internal detail; that
     * it is verified is what a client needs in order to decide what to render.
     */
    emailVerified: user.emailVerifiedAt !== null,
    acceptsMarketing: user.acceptsMarketing,
    createdAt: user.createdAt.toISOString(),
  };
}

/* ── POST /auth/login ────────────────────────────────────────────────────── */

/**
 * `strictObject` again, and the same `emailField` registration uses.
 *
 * Sharing the field means the two endpoints normalise identically — trim then lowercase then
 * validate. If they diverged, an address that registered successfully could fail to log in,
 * which is a genuinely baffling bug to be handed.
 *
 * `passwordField` is deliberately NOT reused. Its 10–128 bounds are a *policy* for choosing a
 * new password; applying them at login would reject anyone whose password predates a policy
 * change, and the 10-character floor would leak that short passwords cannot exist. Login
 * accepts any non-empty string within a sane ceiling and lets verification decide.
 */
export const LoginRequestSchema = z.strictObject({
  email: emailField,
  /**
   * Bounded only to protect the Argon2 addon from an unbounded buffer — the same reason
   * `password.ts` guards internally. Not trimmed: whitespace is a legitimate password
   * character, and trimming here would reject a password that registration accepted.
   */
  password: z.string().min(1).max(1_024),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * The login response.
 *
 * An allowlist, like `UserResponse`. Note what is absent: no `familyId`, no `sessionId`, no
 * token hash, no expiry timestamp for the session. Those are persistence internals; exposing
 * them would invite a client to depend on them and would tell an attacker holding one token
 * something about the shape of the session store.
 *
 * `expiresIn` is seconds — the OAuth 2.0 convention (RFC 6749 §5.1), so clients already know
 * how to read it. It describes the ACCESS token only; the refresh token's lifetime is
 * deliberately not advertised.
 */
export type LoginResponse = {
  user: UserResponse;
  accessToken: string;
  /** Always `Bearer`. Stated explicitly so a client does not have to guess the scheme. */
  tokenType: 'Bearer';
  expiresIn: number;
  /** The raw opaque refresh token. Returned here exactly once and never recoverable again. */
  refreshToken: string;
};

/**
 * The refresh request.
 *
 * **JSON body, not a cookie.** That is not a preference, it is what the existing architecture
 * already established: login returns `refreshToken` in its response body, the project has no
 * cookie dependency and no `res.cookie` call anywhere, and the API is consumed as a headless
 * JSON service with `Authorization` headers rather than a browser session. Inventing a cookie
 * here would mean two transports for one credential, plus CSRF protection that does not exist
 * yet — a browser automatically attaching a refresh cookie to a cross-site request is exactly
 * the attack a JSON body cannot suffer.
 *
 * `strictObject`, so a client that sends `{ refresh_token }` or adds a stray field gets a 400
 * rather than a confusing 401 from a token that was never read.
 */
export const RefreshRequestSchema = z.strictObject({
  /**
   * Bounded, not shaped.
   *
   * A generated token is exactly 43 base64url characters, but pinning `length(43)` here would
   * make a malformed token fail as a 400 while a well-formed-but-unknown one fails as a 401 —
   * telling an attacker which of their guesses had the right *shape*. Both should be 401, so
   * validation only guards against an unbounded string reaching the hash function.
   */
  refreshToken: z.string().min(1).max(512),
});

export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

/* ── POST /users/me/password ─────────────────────────────────────────────── */

/**
 * The password-change request.
 *
 * The two fields use DIFFERENT validators, and that asymmetry is deliberate — it is the same
 * distinction `LoginRequestSchema` already draws.
 *
 *  - `newPassword` reuses `passwordField`, the registration policy. It is a password being
 *    CHOSEN, so the 10–128 rule applies exactly as it does at registration. Reusing the
 *    primitive rather than restating the bounds is what stops a policy change from applying to
 *    one endpoint and not the other.
 *
 *  - `currentPassword` reuses login's permissive bound instead. Applying the policy here would
 *    reject anyone whose existing password predates a policy change — locking the user out of
 *    the very endpoint that would fix it — and the 10-character floor would leak that shorter
 *    passwords cannot exist. Neither is trimmed: whitespace is a legitimate password character.
 *
 * `strictObject`, so `userId`, `storeId`, `email`, and `passwordHash` are unreachable rather
 * than ignored. The subject comes from the verified token's `sub` claim and from nowhere else,
 * so there is no field here that could redirect the operation at another account.
 *
 * Note what is NOT required: the current refresh token. Revocation is derived server-side from
 * the user id, so the caller cannot influence which sessions are revoked — and could not
 * narrow it to spare a session even if they tried.
 */
export const ChangePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(1_024),
  newPassword: passwordField,
});

export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

/* ── POST /auth/forgot-password ──────────────────────────────────────────── */

/**
 * Begin a password reset.
 *
 * One field, and `strictObject` so that is enforceable. Reuses the same `emailField` login and
 * registration use — trimmed and lowercased — so a customer who typed `  Ada@Example.COM  `
 * when registering is found by the same address here.
 *
 * There is deliberately no `redirectUrl` or `returnTo`. A client-supplied URL that ends up in
 * an email is an open-redirect and a phishing vector: the link would carry a live reset token
 * to wherever the caller asked. Where the link points is a deployment decision, not a request
 * parameter.
 */
export const ForgotPasswordRequestSchema = z.strictObject({
  email: emailField,
});

export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

/* ── POST /auth/reset-password ───────────────────────────────────────────── */

/**
 * Complete a password reset.
 *
 * `token` is bounded but otherwise unvalidated in shape: it is opaque to the client and to this
 * schema, and the only thing that decides whether it is real is the digest lookup. A regex
 * asserting base64url would be a second place the token format is defined, and it would reject
 * a future format change with a `400` that looked like a client bug.
 *
 * `newPassword` goes through the SAME `passwordField` as registration and change-password, so
 * the reset path cannot become a way to set a password the other two would refuse.
 *
 * No `email` field. The token identifies the account; asking for the address as well would let
 * a caller pair a stolen token with a different account and learn something from the mismatch.
 */
export const ResetPasswordRequestSchema = z.strictObject({
  token: z.string().min(1).max(512),
  newPassword: passwordField,
});

export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

/* ── PATCH /users/me ─────────────────────────────────────────────────────── */

/**
 * The self-service profile update.
 *
 * Three fields, and the list is the security boundary. `strictObject` makes everything absent
 * from it a 400 that names the field rather than a silently discarded key: a client sending
 * `isStaff`, `isSuperuser`, `storeId`, `passwordHash`, `email`, `isActive`, `emailVerifiedAt`,
 * or `id` is either probing for a mass-assignment hole or badly confused, and both deserve to
 * be told. Stripping them would work today and fail silently the day a handler starts
 * spreading the parsed body.
 *
 * `email` is excluded for reasons beyond privilege — it is the login identifier, it collides
 * with `uq_user_email_active`, and changing it must invalidate `email_verified_at`. That is an
 * email-change flow with its own verification step, not a profile field.
 *
 * `phone` is excluded too, deliberately: it carries `uq_user_phone_active` and
 * `phone_verified_at`, so it has the same shape of problem as email. Neither is in scope here.
 *
 * `firstName` and `lastName` reuse `nameField`, so the bounds match registration exactly. An
 * empty string is valid and CLEARS the name to the column default, matching how the catalogue
 * treats a cleared description (§29); `null` is not accepted, because the columns are NOT NULL.
 *
 * At least one field is required. An empty PATCH asks for nothing: it would bump `updated_at`,
 * return 200, and leave a caller believing something changed. Same rule, and the same
 * `.refine()` mechanism, as `UpdateProductRequestSchema` (§29).
 */
export const UpdateProfileRequestSchema = z
  .strictObject({
    firstName: nameField,
    lastName: nameField,
    acceptsMarketing: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one of firstName, lastName, or acceptsMarketing must be provided',
  });

export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

export function toLoginResponse(args: {
  user: MappableUser;
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string;
}): LoginResponse {
  return {
    // Reuses the registration mapper, so both endpoints describe a user identically.
    user: toUserResponse(args.user),
    accessToken: args.accessToken,
    tokenType: 'Bearer',
    expiresIn: args.expiresInSeconds,
    refreshToken: args.refreshToken,
  };
}
