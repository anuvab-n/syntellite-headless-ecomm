import { z } from 'zod';

import { boundedIntParam, type PaginationResponse } from '../../shared/pagination.js';

/**
 * Re-exported, so a caller of this module needs one import rather than two.
 *
 * The shape lives in `shared/pagination.ts` — one definition for every list endpoint.
 */
export type { PaginationResponse };

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

/* ── GET /admin/customers ────────────────────────────────────────────────── */

/** Page size for the staff customer list. */
export const ADMIN_CUSTOMER_LIST_DEFAULT_LIMIT = 25;
export const ADMIN_CUSTOMER_LIST_MAX_LIMIT = 100;

/**
 * An ISO-8601 instant WITH an offset, matching the promotions and tax modules and the two admin
 * lists that precede this one.
 *
 * **The client owns the timezone, deliberately.** A bare `YYYY-MM-DD` would force the server to
 * choose one to widen it into, and every choice is wrong somewhere.
 *
 * Both bounds are INCLUSIVE, stated on the endpoint and asserted by a test that registers an
 * account exactly on each boundary — a half-open range that silently dropped the last instant
 * would look like missing data rather than like a contract.
 */
const adminInstantField = z.iso.datetime({ offset: true });

/**
 * The staff customer list's query string.
 *
 * `strictObject`, so an unknown parameter is a `400` naming it rather than a filter silently
 * ignored. **`storeId` is not here and never will be** — tenancy comes from the verified staff
 * token, and because this object is strict, supplying one is a `400` rather than an ignored key.
 *
 * **There is no search parameter.** A substring match over emails and names is a different
 * feature with its own disclosure and indexing questions, and it is not part of this increment.
 */
export const AdminListCustomersQuerySchema = z.strictObject({
  limit: boundedIntParam({
    min: 1,
    max: ADMIN_CUSTOMER_LIST_MAX_LIMIT,
    default: ADMIN_CUSTOMER_LIST_DEFAULT_LIMIT,
  }),
  offset: boundedIntParam({ min: 0, default: 0 }),

  /**
   * Account status. Parsed from the two exact strings rather than with `z.coerce.boolean()`,
   * which treats every non-empty string as `true` — so `?isActive=false` would have filtered to
   * ACTIVE accounts, the precise opposite of what was asked, with no error to notice.
   */
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),

  /**
   * The operator's search box. Increment 56.
   *
   * One term matched case-insensitively as a SUBSTRING across `email`, `firstName`, `lastName`
   * and `phone` — the four identity fields the Customers screen shows. Bounded at the email
   * column's width, which is the widest of the four.
   *
   * Wider than the order list's `q`, which is an order number or an email. That one narrows a
   * list an operator is already looking at; this one is the customer directory, whose whole
   * purpose is finding a person from a partial name or a partial number.
   *
   * The phone arm compares digits only, so `98765`, `+91 98765` and `+919876543210` all find
   * the same customer. The other three arms take the term verbatim.
   */
  q: z.string().trim().min(1).max(320).optional(),

  createdFrom: adminInstantField.optional(),
  createdTo: adminInstantField.optional(),
});

export type AdminListCustomersQuery = z.infer<typeof AdminListCustomersQuerySchema>;

/* ── GET /admin/customers/{customerId} ───────────────────────────────────── */

/**
 * The path parameter: the customer's id.
 *
 * A UUID by SHAPE only. Whether the row exists, belongs to this store, or has been erased is
 * decided by the query — never by validation — so a malformed id is a `400` and every other
 * miss is a `404` that reveals nothing.
 *
 * Unlike an order, a customer has no business-facing number to be addressed by, which is why
 * `id` is the one internal identifier the admin customer contract publishes.
 */
export const CustomerIdParamsSchema = z.object({ customerId: z.uuid() });

export type CustomerIdParams = z.infer<typeof CustomerIdParamsSchema>;

/**
 * One row of the staff customer list.
 *
 * Built field by field from the repository's allowlisted projection — the same discipline
 * `toUserResponse` documents, applied one layer earlier as well, so a column added to `app_user`
 * has to pass two deliberate edits before it could reach a client.
 *
 * `id` IS published, and it is the one internal identifier here: a customer row has to be
 * addressable for anything that follows, and unlike an order there is no business-facing number
 * to address it by.
 *
 * Absent by construction: `passwordHash`, `isStaff`, `isSuperuser`, `storeId`, `deletedAt`, and
 * every password-reset or refresh-session field — those live in other tables the query does not
 * touch.
 */
export type AdminCustomerResponse = {
  id: string;
  email: string;
  /** Nullable, permanently: `phone` has never been required at registration. */
  phone: string | null;
  firstName: string;
  lastName: string;
  /** `false` once an account is deactivated; its tokens then fail on the next request. */
  isActive: boolean;
  createdAt: string;
  updatedAt: string;

  /**
   * Orders this customer has placed that were not cancelled. Increment 56.
   *
   * `0` for a customer who has never ordered AND for one whose every order was cancelled. The
   * two are deliberately the same number: neither is a sale.
   */
  orderCount: number;

  /**
   * **What this customer has been billed: the sum of `grandTotal` over their non-cancelled
   * orders.** A decimal string at `NUMERIC(19,4)` scale, never a number.
   *
   * Tax-inclusive, because `grandTotal` is. Cancelled orders are excluded. Returns are NOT
   * deducted — this system has no refund execution, so no money has ever moved back, and
   * subtracting a requested refund would report a reversal that never happened.
   *
   * It is billed value, not cash received. A COD payment never reaches `succeeded` in this
   * system, so a definition based on captured money would report zero for every
   * cash-on-delivery sale; this one does not have that defect, and pays for it by counting an
   * order whose online payment later failed.
   */
  totalSpent: string;

  /** The most recent non-cancelled order's `placedAt`, or `null` if there is none. */
  lastOrderAt: string | null;
};

/** The row fields the mapper needs. Structural, so the repository picks the columns. */
export type MappableAdminCustomer = {
  id: string;
  email: string;
  phone: string | null;
  firstName: string;
  lastName: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  orderCount: number;
  totalSpent: string;
  lastOrderAt: Date | null;
};

/**
 * The store's customers by account status. Increment 56.
 *
 * The screen's tabs. Scoped to the tenant and to live accounts and to NOTHING ELSE — not to the
 * list's filters, and not to the search term. A tab count that moved as you typed could never
 * tell you how many rows switching to that tab would show, which is the only question a tab
 * count answers.
 *
 * So `counts.total` and `pagination.total` differ whenever a filter is applied, and that is
 * correct: one counts the store, the other counts the query.
 *
 * `active + inactive === total` always. Both keys are present at zero, so the shape does not
 * change with the data.
 */
export type AdminCustomerCountsResponse = {
  total: number;
  active: number;
  inactive: number;
};

export type AdminCustomerListResponse = {
  customers: AdminCustomerResponse[];
  counts: AdminCustomerCountsResponse;
  pagination: PaginationResponse;
};

export function toAdminCustomerResponse(row: MappableAdminCustomer): AdminCustomerResponse {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    firstName: row.firstName,
    lastName: row.lastName,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    orderCount: row.orderCount,
    totalSpent: row.totalSpent,
    lastOrderAt: row.lastOrderAt?.toISOString() ?? null,
  };
}

export function toAdminCustomerListResponse(page: {
  items: readonly MappableAdminCustomer[];
  total: number;
  limit: number;
  offset: number;
  counts: AdminCustomerCountsResponse;
}): AdminCustomerListResponse {
  return {
    customers: page.items.map(toAdminCustomerResponse),
    counts: page.counts,
    pagination: { limit: page.limit, offset: page.offset, total: page.total },
  };
}

/* ── Customer activation. Increment 62. ──────────────────────────────────── */

/**
 * The activation body: one boolean and nothing else.
 *
 * `strictObject`, so a request that also tried to send `isStaff`, `isSuperuser`, `email` or
 * `storeId` is a `400` naming the field rather than a silently ignored privilege attempt. The
 * repository could not write any of them regardless — two independent defences, because the
 * consequence of losing this one is an account taking a privilege nobody granted.
 */
export const SetCustomerActiveRequestSchema = z.strictObject({
  isActive: z.boolean(),
});

export type SetCustomerActiveRequest = z.infer<typeof SetCustomerActiveRequestSchema>;

/* ── The audit log. Increment 62. ────────────────────────────────────────── */

const AUDIT_LOG_MAX_LIMIT = 100;
const AUDIT_LOG_DEFAULT_LIMIT = 20;

/**
 * The audit log query.
 *
 * Every filter is an EXACT match, not a substring: these are closed vocabularies an operator
 * picks from a list, and a substring search over `action` would let `payment` quietly match
 * `payment.captured`, `payment.failed` and anything a future module adds — a filter whose
 * meaning changes as the codebase grows.
 *
 * `storeId` is absent and always will be. Tenancy comes from the verified staff token.
 */
export const AdminAuditLogQuerySchema = z.strictObject({
  limit: boundedIntParam({
    min: 1,
    max: AUDIT_LOG_MAX_LIMIT,
    default: AUDIT_LOG_DEFAULT_LIMIT,
  }),
  offset: boundedIntParam({ min: 0, default: 0 }),

  action: z.string().trim().min(1).max(128).optional(),
  actorType: z.enum(['staff', 'customer', 'system', 'job']).optional(),
  actorUserId: z.uuid().optional(),
  resourceType: z.string().trim().min(1).max(64).optional(),
  resourceId: z.string().trim().min(1).max(64).optional(),

  /**
   * Both bounds inclusive; the upper one names a MILLISECOND and admits all of it. ISO-8601
   * with an offset, so the client owns the timezone — the same contract the orders, payments,
   * customers and returns lists use.
   */
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export type AdminAuditLogQuery = z.infer<typeof AdminAuditLogQuerySchema>;

/**
 * One audit entry on the wire.
 *
 * `metadata` is deliberately absent. Each module writes its own per-action context, reviewed at
 * its own call site; publishing the union of all of them through one endpoint would make every
 * future `audit.record` call a disclosure decision on this route. What is published is who did
 * what to which resource, and when.
 *
 * `actorUserId` IS published here, unlike on the order and return timelines. This endpoint is
 * the accountability surface — "which colleague did this" is the question it exists to answer —
 * and it is a distinct read that an operator reaches deliberately.
 */
export type AuditLogEntryResponse = {
  action: string;
  actorType: string;
  actorUserId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  at: string;
};

export function toAuditLogEntryResponse(entry: {
  readonly action: string;
  readonly actorType: string;
  readonly actorUserId: string | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly createdAt: Date;
}): AuditLogEntryResponse {
  return {
    action: entry.action,
    actorType: entry.actorType,
    actorUserId: entry.actorUserId,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    at: entry.createdAt.toISOString(),
  };
}

/* ── Admin sessions. Increment 63. ───────────────────────────────────────── */

const SESSION_LIST_MAX_LIMIT = 100;
const SESSION_LIST_DEFAULT_LIMIT = 20;

export const AdminSessionsQuerySchema = z.strictObject({
  limit: boundedIntParam({
    min: 1,
    max: SESSION_LIST_MAX_LIMIT,
    default: SESSION_LIST_DEFAULT_LIMIT,
  }),
  offset: boundedIntParam({ min: 0, default: 0 }),
});

export type AdminSessionsQuery = z.infer<typeof AdminSessionsQuerySchema>;

export const AdminSessionParamsSchema = z.object({
  customerId: z.uuid(),
  sessionId: z.uuid(),
});

export type AdminSessionParams = z.infer<typeof AdminSessionParamsSchema>;

/**
 * One refresh session on the wire.
 *
 * **No token material of any kind.** `token_hash` is not merely omitted here — it is never
 * selected by the repository, so there is no value in scope for this mapper to publish even by
 * accident. `userId` is absent too: the caller named the customer in the path.
 *
 * `isCurrent` is deliberately NOT published. Answering "is this the session you are using right
 * now" would require comparing against the caller's own refresh token, and the caller is a
 * STAFF member looking at somebody else's account — the question is meaningless here, and
 * answering it for the customer's own view would need a token this endpoint must never see.
 *
 * `active` is derived rather than stored: a session is usable when it has not been revoked and
 * has not expired. Computed in one place so the screen cannot disagree with what refresh does.
 */
export type AdminSessionResponse = {
  id: string;
  familyId: string;
  active: boolean;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toAdminSessionResponse(
  record: {
    readonly id: string;
    readonly familyId: string;
    readonly expiresAt: Date;
    readonly consumedAt: Date | null;
    readonly revokedAt: Date | null;
    readonly revokedReason: string | null;
    readonly userAgent: string | null;
    readonly ipAddress: string | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  },
  now: Date,
): AdminSessionResponse {
  return {
    id: record.id,
    familyId: record.familyId,
    active: record.revokedAt === null && record.expiresAt.getTime() > now.getTime(),
    expiresAt: record.expiresAt.toISOString(),
    consumedAt: record.consumedAt === null ? null : record.consumedAt.toISOString(),
    revokedAt: record.revokedAt === null ? null : record.revokedAt.toISOString(),
    revokedReason: record.revokedReason,
    userAgent: record.userAgent,
    ipAddress: record.ipAddress,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
