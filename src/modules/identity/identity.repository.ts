import { and, count, desc, eq, gte, ilike, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { appUser, auditLog } from '../../db/schema/identity.js';
import { order } from '../../db/schema/orders.js';
import { uniqueViolationConstraint } from '../../db/errors.js';
import { executor } from '../../db/transaction.js';
import { exclusiveEndOfMillisecond } from '../../shared/time-bounds.js';
import type { MappableUser } from './dto.js';

/**
 * Identity data access.
 *
 * Imports `appUser` from its schema module directly, not through `db/schema/index.ts` — that
 * barrel exists for drizzle-kit and the test truncate helper, and its own docblock rules out
 * using it as a general dependency.
 *
 * `app_user` is a single global identity with no `store_id`. Self-service reads and writes
 * (login, refresh, profile, password) act on the caller's own account and are not store-scoped.
 * Every STAFF-facing customer query is: it requires `storeId` and admits only customers with at
 * least one order in that store (`customerOfStore`), inside the WHERE clause.
 */

/** A customer belongs to a store once they have ordered from it. */
function customerOfStore(storeId: string): SQL {
  return sql`exists (select 1 from ${order} where ${order.userId} = ${appUser.id} and ${order.storeId} = ${storeId})`;
}

export type IdentityRepository = ReturnType<typeof createIdentityRepository>;

/**
 * The columns a registration response needs, plus nothing else.
 *
 * `passwordHash` is deliberately absent. A repository that selected it would hand every
 * caller something they must remember not to leak; not selecting it means they cannot.
 * Login will add a separate, explicitly named method that does select it.
 */
const PUBLIC_COLUMNS = {
  id: appUser.id,
  email: appUser.email,
  firstName: appUser.firstName,
  lastName: appUser.lastName,
  phone: appUser.phone,
  emailVerifiedAt: appUser.emailVerifiedAt,
  acceptsMarketing: appUser.acceptsMarketing,
  createdAt: appUser.createdAt,
} as const;

export type InsertUserValues = {
  id: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  acceptsMarketing: boolean;
};

/**
 * The columns login needs, and only login.
 *
 * A SEPARATE, explicitly named projection rather than widening `PUBLIC_COLUMNS`, which the
 * docblock above anticipated. Two consequences worth stating:
 *
 *  - `passwordHash` is reachable only through `findCredentialsByEmail`, so a reader can grep
 *    one method name to find every place the hash is loaded.
 *  - The type is distinct from `MappableUser`, so a credential row cannot be handed to
 *    `toUserResponse` — the response mapper does not accept this shape.
 *
 * `isActive` is SELECTED, not filtered. Login must not branch on it before verifying the
 * password: skipping an Argon2 verify for a disabled account makes that response measurably
 * faster, which turns the endpoint into an account-state oracle.
 */
const CREDENTIAL_COLUMNS = {
  id: appUser.id,
  email: appUser.email,
  firstName: appUser.firstName,
  lastName: appUser.lastName,
  phone: appUser.phone,
  emailVerifiedAt: appUser.emailVerifiedAt,
  acceptsMarketing: appUser.acceptsMarketing,
  createdAt: appUser.createdAt,
  passwordHash: appUser.passwordHash,
  isActive: appUser.isActive,
  isStaff: appUser.isStaff,
  isSuperuser: appUser.isSuperuser,
} as const;

/**
 * A user row including credential material.
 *
 * Structurally a superset of `MappableUser`, so the public fields can be mapped for the
 * response while the sensitive ones stay in the service.
 */
export type UserCredentials = MappableUser & {
  passwordHash: string;
  isActive: boolean;
  isStaff: boolean;
  isSuperuser: boolean;
};

/**
 * The columns needed to re-issue a session, and only those.
 *
 * `CREDENTIAL_COLUMNS` minus `passwordHash`. Refresh needs the store, the authorization
 * flags, and the public fields for the response — it has no business loading credential
 * material, because it never verifies a password.
 */
const SUBJECT_COLUMNS = {
  id: appUser.id,
  email: appUser.email,
  firstName: appUser.firstName,
  lastName: appUser.lastName,
  phone: appUser.phone,
  emailVerifiedAt: appUser.emailVerifiedAt,
  acceptsMarketing: appUser.acceptsMarketing,
  createdAt: appUser.createdAt,
  isActive: appUser.isActive,
  isStaff: appUser.isStaff,
  isSuperuser: appUser.isSuperuser,
} as const;

/**
 * A user row without credential material.
 *
 * Structurally `UserCredentials` minus `passwordHash`, so the public fields still map for
 * the response, but the type itself makes it impossible to reach for a hash that was never
 * selected.
 */
export type UserSubject = MappableUser & {
  isActive: boolean;
  isStaff: boolean;
  isSuperuser: boolean;
};

/**
 * The `app_user` columns a user may edit on their OWN profile, and the complete list of them.
 *
 * A security boundary expressed as a type. Deliberately NOT `Partial<InsertUserValues>`, which
 * would admit `email`, `passwordHash`, `isStaff`, `isSuperuser`, `storeId`, `isActive`, and
 * every verification timestamp — every one of them a privilege-escalation or account-takeover
 * vector if a request could reach it.
 *
 * The Zod schema rejects those fields at the boundary; this type means that even a service bug
 * that forwarded one could not compile. Two independent defences, because the consequence of
 * losing this one is a customer promoting themselves to staff.
 *
 * `email` is absent for a second reason beyond privilege: changing it collides with
 * `uq_user_email_active`, invalidates `email_verified_at`, and moves the login identifier.
 * That is an email-change flow, not a profile field.
 */
export type EditableUserFields = {
  firstName?: string;
  lastName?: string;
  acceptsMarketing?: boolean;
};

/** The partial unique index on `lower(email) WHERE deleted_at IS NULL` — global, not per store. */
export const EMAIL_UNIQUE_CONSTRAINT = 'uq_user_email_active';

/** The partial unique index on `phone WHERE deleted_at IS NULL AND phone IS NOT NULL` — global. */
export const PHONE_UNIQUE_CONSTRAINT = 'uq_user_phone_active';

/**
 * Re-exported so `identity.service.ts` keeps importing it from here, unchanged.
 *
 * The implementation moved to `db/errors.ts` once a second caller appeared — which is exactly
 * what the note that used to sit here anticipated: *"a shared helper invented for a single
 * caller is a guess about the second one."* There are four now.
 */
export { uniqueViolationConstraint };

export function createIdentityRepository(deps: { db: Database }) {
  const { db } = deps;

  return {
    /**
     * Find an ACTIVE, non-deleted user by email within a store.
     *
     * `lower(email) = $email` rather than `email = $email`, so this uses the same expression
     * as the unique index and therefore the same notion of "already taken". Comparing the
     * raw column would let `User@x.com` and `user@x.com` look like different accounts to
     * this query while the index considers them the same — a pre-check that disagrees with
     * the constraint it is trying to anticipate.
     *
     * `deletedAt IS NULL` mirrors the index's WHERE clause: an erased account does not block
     * a fresh signup, which is the behaviour the partial index was chosen to give.
     */
    async findActiveByEmail(params: {
      email: string;
      storeId?: string;
    }): Promise<MappableUser | undefined> {
      const [row] = await executor(db)
        .select(PUBLIC_COLUMNS)
        .from(appUser)
        .where(and(sql`lower(${appUser.email}) = ${params.email}`, isNull(appUser.deletedAt)))
        .limit(1);
      return row;
    },

    /**
     * Insert a user and return its public columns.
     *
     * Lets a unique violation propagate rather than swallowing it. The service catches it
     * and translates — which is the only correct place, because the RACE is real: two
     * simultaneous registrations for one address both pass the pre-check, and the database
     * is the only thing that can arbitrate. A pre-check narrows the window; the constraint
     * closes it.
     *
     * `isStaff` and `isSuperuser` are not settable through this signature at all. The column
     * defaults are `false`, and `InsertUserValues` has no field for either, so no caller —
     * present or future — can grant privilege through the registration path.
     */
    async insertUser(values: InsertUserValues): Promise<MappableUser> {
      const [row] = await executor(db).insert(appUser).values(values).returning(PUBLIC_COLUMNS);

      if (!row) {
        // Unreachable with a plain INSERT ... RETURNING, but the array type admits it and a
        // silent `undefined` here would surface much later as a confusing mapper failure.
        throw new Error('insertUser returned no row');
      }
      return row;
    },

    /**
     * Load a user's credentials for authentication.
     *
     * The ONLY method that selects `passwordHash`.
     *
     * Same predicate as `findActiveByEmail` — `lower(email)`, `deletedAt IS
     * NULL` — so login and registration agree about which account an address refers to. A
     * soft-deleted user is therefore invisible here, which is correct: erasure anonymises,
     * and an erased account must not authenticate.
     *
     * `isActive` is returned rather than filtered. See the note on `CREDENTIAL_COLUMNS`.
     */
    async findCredentialsByEmail(params: {
      email: string;
      storeId?: string;
    }): Promise<UserCredentials | undefined> {
      const [row] = await executor(db)
        .select(CREDENTIAL_COLUMNS)
        .from(appUser)
        .where(and(sql`lower(${appUser.email}) = ${params.email}`, isNull(appUser.deletedAt)))
        .limit(1);
      return row;
    },

    /**
     * Load a user for re-issuing a session, WITHOUT their password hash.
     *
     * A third projection rather than reusing `CREDENTIAL_COLUMNS`, and the omission is the
     * whole point: refresh proves possession of a refresh token, not knowledge of a password,
     * so there is no reason for the hash to be in memory on this path at all. The narrower
     * projection means a future bug on the refresh path cannot leak it.
     *
     * The authorization flags are read FRESH rather than carried in the refresh token. A staff
     * member demoted mid-session loses the `isStaff` claim on their next refresh, which is
     * what makes the 15-minute access token the actual bound on stale privilege.
     *
     * `isActive` is selected rather than filtered, matching `findCredentialsByEmail` — the
     * service branches on it so the event can be logged distinctly. There is no timing oracle
     * to worry about here: the caller already holds a valid refresh token, so they are not
     * probing for which accounts exist.
     */
    async findSubjectById(params: {
      userId: string;
      storeId?: string;
    }): Promise<UserSubject | undefined> {
      const [row] = await executor(db)
        .select(SUBJECT_COLUMNS)
        .from(appUser)
        .where(and(eq(appUser.id, params.userId), isNull(appUser.deletedAt)))
        .limit(1);
      return row;
    },

    /**
     * Load a user WITH their password hash, by id.
     *
     * The password-change path, and the mirror of `findCredentialsByEmail` — same projection,
     * different key. A password change proves knowledge of the current password, so unlike
     * `findSubjectById` (which deliberately omits the hash) this path genuinely needs it.
     *
     * Keyed by id rather than by email because the id comes from the verified access token's
     * `sub` claim. Looking the row up by an email the client supplied would reintroduce exactly
     * the enumeration surface `GET /users/me` was built to avoid, and would let a caller aim
     * the operation at an account that is not theirs.
     *
     * `deleted_at IS NULL` matches `findCredentialsByEmail`, so an erased account is invisible here too.
     * `isActive` is returned rather than filtered, per the note on `CREDENTIAL_COLUMNS` — the service decides what to do with it.
     */
    async findCredentialsById(params: {
      userId: string;
      storeId?: string;
    }): Promise<UserCredentials | undefined> {
      const [row] = await executor(db)
        .select(CREDENTIAL_COLUMNS)
        .from(appUser)
        .where(and(eq(appUser.id, params.userId), isNull(appUser.deletedAt)))
        .limit(1);
      return row;
    },

    /**
     * Update a user's own editable profile fields.
     *
     * `fields` is `EditableUserFields`, which lists the three writable columns and nothing
     * else. Deliberately NOT `Partial<InsertUserValues>`: that would admit `email`, `isStaff`,
     * `isSuperuser`, `storeId`, and `passwordHash`, turning a compile-time guarantee into a
     * runtime hope. Widening that type is the only way to make another column editable, which
     * is exactly the friction the decision deserves — the same reasoning as
     * `EditableProductFields` in the catalogue (§29).
     *
     * `deleted_at IS NULL` in the predicate, matching every other write here.
     *
     * Returns the updated row through `SUBJECT_COLUMNS` — the same projection `findSubjectById`
     * uses — so the caller can map a response without a second read, and so the hash cannot
     * reach the response even by accident.
     */
    async updateUserProfile(params: {
      userId: string;
      fields: EditableUserFields;
      at: Date;
      storeId?: string;
    }): Promise<UserSubject | undefined> {
      const [row] = await executor(db)
        .update(appUser)
        .set({ ...params.fields, updatedAt: params.at })
        .where(and(eq(appUser.id, params.userId), isNull(appUser.deletedAt)))
        .returning(SUBJECT_COLUMNS);

      return row;
    },

    /**
     * Stamp a successful login.
     */
    async updateLastLoginAt(params: { userId: string; at: Date; storeId?: string }): Promise<void> {
      await executor(db)
        .update(appUser)
        .set({ lastLoginAt: params.at, updatedAt: new Date() })
        .where(eq(appUser.id, params.userId));
    },

    /**
     * Replace a password hash with one computed under current parameters.
     *
     * The cost-factor upgrade path. Called only after a password has ALREADY been verified
     * successfully, so the plaintext was legitimate and the new hash covers the same secret.
     *
     * `expectedCurrentHash` makes the update conditional: if a concurrent request already
     * rehashed the row, or a password change landed in between, the WHERE clause matches
     * nothing and this is a no-op. Without it, two simultaneous logins could each write a
     * hash derived from what they believed the current password to be — and a password change
     * racing a rehash could resurrect the old password.
     */
    async updatePasswordHash(params: {
      userId: string;
      expectedCurrentHash: string;
      passwordHash: string;
      storeId?: string;
    }): Promise<boolean> {
      const updated = await executor(db)
        .update(appUser)
        .set({ passwordHash: params.passwordHash, updatedAt: new Date() })
        .where(
          and(eq(appUser.id, params.userId), eq(appUser.passwordHash, params.expectedCurrentHash)),
        )
        .returning({ id: appUser.id });

      return updated.length > 0;
    },

    /**
     * **One customer in this store, for staff.** Increment 52. Read-only.
     *
     * Deliberately NOT `findSubjectById`, which exists for token refresh and selects
     * `SUBJECT_COLUMNS` — including `is_staff` and `is_superuser`. Reusing it here
     * would publish privilege flags on an operator screen, so this takes the same
     * `ADMIN_CUSTOMER_COLUMNS` allowlist the list uses and nothing else.
     *
     * The predicate is the list's, narrowed to one id: liveness, store membership, identity.
     */
    async findStoreCustomerById(params: {
      customerId: string;
      storeId: string;
    }): Promise<AdminCustomerRecord | undefined> {
      const [row] = await executor(db)
        .select(ADMIN_CUSTOMER_COLUMNS)
        .from(appUser)
        .where(
          and(
            eq(appUser.id, params.customerId),
            isNull(appUser.deletedAt),
            customerOfStore(params.storeId),
          ),
        )
        .limit(1);
      return row;
    },

    /**
     * Set a customer's active flag, with a compare-and-swap on the old value.
     * Increment 62.
     *
     * The `is_active <> :next` predicate is the idempotency: a second identical request matches
     * no row and comes back `undefined`, so the caller answers `409` rather than writing an
     * audit entry for a change that did not happen. Without it, deactivating an already
     * deactivated account would leave a trail suggesting two separate decisions.
     *
     * **`is_staff` and `is_superuser` are untouched and unreadable from here.** This flips one
     * boolean on one customer; it is not a privilege operation and must never become one.
     *
     * Soft-deleted accounts are excluded: re-activating a deleted customer would resurrect an
     * account the deletion policy retired.
     */
    async setCustomerActive(params: {
      customerId: string;
      isActive: boolean;
      at: Date;
      storeId: string;
    }): Promise<AdminCustomerRecord | undefined> {
      const [row] = await executor(db)
        .update(appUser)
        .set({ isActive: params.isActive, updatedAt: params.at })
        .where(
          and(
            eq(appUser.id, params.customerId),
            isNull(appUser.deletedAt),
            ne(appUser.isActive, params.isActive),
            customerOfStore(params.storeId),
          ),
        )
        .returning(ADMIN_CUSTOMER_COLUMNS);
      return row;
    },

    /**
     * A page of the store's audit log, newest first. Increment 62.
     *
     * **Read-only, and the only read of this table anywhere.** `audit_log` is append-only by
     * policy; nothing in this file updates or deletes it, and exposing it does not change that.
     *
     * `metadata` is deliberately NOT selected. Entries carry per-action context written by
     * whichever module recorded them, and while each is reviewed at its call site, publishing
     * the union of every module's metadata through one endpoint means every future `audit.record`
     * call would become a disclosure decision on this route. The columns here are the ones every
     * entry has and every entry is safe to show.
     *
     * Ordered `(created_at DESC, id DESC)`. The timestamp is not a total order — a single
     * transaction writes several entries at one `now()` — and `id` is UUIDv7, so it orders
     * within the tie by creation. `ix_audit_log_store_time (store_id, created_at)` serves the
     * leading column.
     */
    async listStoreAuditLog(params: {
      storeId: string;
      action?: string;
      actorType?: string;
      actorUserId?: string;
      resourceType?: string;
      resourceId?: string;
      from?: Date;
      to?: Date;
      limit: number;
      offset: number;
    }): Promise<{ items: AuditLogRecord[]; total: number }> {
      const predicate = auditLogFilter(params);

      const items = await executor(db)
        .select({
          action: auditLog.action,
          actorType: auditLog.actorType,
          actorUserId: auditLog.actorUserId,
          resourceType: auditLog.resourceType,
          resourceId: auditLog.resourceId,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .where(predicate)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(params.limit)
        .offset(params.offset);

      const [counted] = await executor(db)
        .select({ total: sql<string>`count(*)` })
        .from(auditLog)
        .where(predicate);

      return { items, total: Number(counted?.total ?? 0) };
    },

    async listStoreCustomers(params: {
      filters: AdminCustomerFilters;
      limit: number;
      offset: number;
      storeId: string;
    }): Promise<{ items: AdminCustomerRecord[]; total: number }> {
      const where = adminCustomerPredicate(params.storeId, params.filters);

      const [items, [counted]] = await Promise.all([
        executor(db)
          .select(ADMIN_CUSTOMER_COLUMNS)
          .from(appUser)
          .where(where)
          .orderBy(desc(appUser.createdAt), desc(appUser.id))
          .limit(params.limit)
          .offset(params.offset),
        executor(db).select({ total: count() }).from(appUser).where(where),
      ]);

      return { items, total: counted?.total ?? 0 };
    },

    /**
     * **How many of the store's customers are active, and how many are not.** Increment 56.
     *
     * Soft-deleted accounts are excluded, exactly as they are from the list — an erased customer
     * is invisible to staff for the same reason it is invisible to authentication.
     */
    async countStoreCustomersByStatus(params: {
      storeId: string;
    }): Promise<{ isActive: boolean; count: number }[]> {
      return executor(db)
        .select({ isActive: appUser.isActive, count: count() })
        .from(appUser)
        .where(and(isNull(appUser.deletedAt), customerOfStore(params.storeId)))
        .groupBy(appUser.isActive);
    },
  };
}

/**
 * The columns the staff customer list reads. **An allowlist, and the omissions are the point.**
 *
 * Selected explicitly rather than with `select()`: a bare select would silently start returning
 * any column a later increment adds, which is how an internal field reaches a response body
 * nobody meant to widen.
 *
 * Never selected, here or anywhere downstream:
 *
 *  - `password_hash` — a credential. It has exactly two legitimate readers, both of them
 *    authentication paths with their own projections (`CREDENTIAL_COLUMNS`), and a list is
 *    neither of them.
 *  - `is_staff`, `is_superuser` — privilege flags. Publishing them would make an operator
 *    screen double as a map of which accounts are worth attacking.
 *  - `deleted_at` — every row here is live by construction.
 *
 * Password-reset tokens and refresh sessions live in their own tables and are not reachable
 * from this query at all.
 */
const ADMIN_CUSTOMER_COLUMNS = {
  id: appUser.id,
  email: appUser.email,
  /**
   * The mobile number the operator screen shows. Increment 56.
   *
   * Nullable, and it always will be: `phone` has never been required at registration, so a
   * customer who signed up with an email alone has none. `uq_user_phone_active` makes it unique
   * per store where it is present.
   */
  phone: appUser.phone,
  firstName: appUser.firstName,
  lastName: appUser.lastName,
  isActive: appUser.isActive,
  createdAt: appUser.createdAt,
  updatedAt: appUser.updatedAt,
} as const;

/** One customer as the staff list reads them. Structurally the projection above. */
export type AdminCustomerRecord = {
  readonly id: string;
  readonly email: string;
  readonly phone: string | null;
  readonly firstName: string;
  readonly lastName: string;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** The filters the staff customer list accepts. Every one of them is optional. */
export type AdminCustomerFilters = {
  readonly isActive?: boolean;
  readonly createdFrom?: Date;
  readonly createdTo?: Date;
  readonly q?: string;
};

/**
 * The staff list's WHERE clause: liveness, store membership, then whichever filters were supplied.
 */
function adminCustomerPredicate(storeId: string, filters: AdminCustomerFilters): SQL | undefined {
  const clauses: SQL[] = [isNull(appUser.deletedAt), customerOfStore(storeId)];

  if (filters.isActive !== undefined) clauses.push(eq(appUser.isActive, filters.isActive));

  /*
   * The lower bound needs no adjustment: every microsecond inside the named millisecond is
   * already greater than its start, so `>=` admits them all.
   */
  if (filters.createdFrom !== undefined) clauses.push(gte(appUser.createdAt, filters.createdFrom));
  /*
   * STRICT `<` against the start of the NEXT millisecond, not `<=` against this one.
   *
   * `created_at` is microsecond-precise in the database and millisecond-precise everywhere in
   * this API, so `<=` dropped every row whose stored microseconds were non-zero — including the
   * row a client had just read the bound from. `exclusiveEndOfMillisecond` carries the reasoning.
   */
  if (filters.createdTo !== undefined) {
    clauses.push(lt(appUser.createdAt, exclusiveEndOfMillisecond(filters.createdTo)));
  }

  /**
   * The operator's search box: one term across the four identity fields the screen shows.
   * Increment 56.
   *
   * Case-insensitive substring, the same shape `GET /admin/orders?q=` already uses, with `%` and
   * `_` escaped first — an unescaped `%` would turn a typo into a term that matched every row,
   * which reads to an operator as "the filter is broken".
   *
   * **Wider than the order list's search, deliberately.** That one is an order number or an
   * email, because those are what an operator holds in hand. This is the customer DIRECTORY: its
   * entire purpose is finding a person from a partial name or a partial number, so names and
   * phone are in scope here and the disclosure is the feature rather than a leak.
   *
   * The phone arm matches on digits alone. A stored `+919876543210` must be found by `98765`
   * and by `+91 98765` alike, so the term's separators are stripped for that comparison only —
   * the other three arms keep the term verbatim, because a name may legitimately contain any of
   * those characters.
   *
   * Unindexed by construction: a leading-wildcard `LIKE` cannot use a B-tree, and this codebase
   * has no `pg_trgm`. Measured before it shipped rather than assumed — see the increment's
   * EXPLAIN evidence — and if the store outgrows it the answer is a trigram GIN index, which is
   * an extension and therefore its own decision.
   */
  if (filters.q !== undefined && filters.q.length > 0) {
    const escaped = filters.q.replace(/([\\%_])/gu, '\\$1');
    const term = `%${escaped}%`;

    const arms: SQL[] = [
      ilike(appUser.email, term),
      ilike(appUser.firstName, term),
      ilike(appUser.lastName, term),
    ];

    const digits = filters.q.replace(/\D/gu, '');
    if (digits.length > 0) arms.push(ilike(appUser.phone, `%${digits}%`));

    const match = or(...arms);
    if (match) clauses.push(match);
  }

  return and(...clauses);
}

/**
 * One audit entry, as the admin API publishes it. Increment 62.
 *
 * `metadata` is absent from the shape, not merely from the response: a read model that never
 * carries it cannot leak it through a later careless DTO change.
 */
export type AuditLogRecord = {
  readonly action: string;
  readonly actorType: string;
  readonly actorUserId: string | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly createdAt: Date;
};

/**
 * The audit log's WHERE clause. Increment 62.
 *
 * One builder for the page and its count, so a total cannot be computed from a different
 * predicate than the rows it claims to count.
 *
 * **`store_id` is unconditional and first.** `audit_log.store_id` is nullable — platform-level
 * entries carry none — and that is exactly why the predicate is an equality rather than an
 * `OR IS NULL`: a tenant's admin must not see the platform's entries, and a NULL store can
 * never satisfy `= :storeId`.
 */
function auditLogFilter(params: {
  storeId: string;
  action?: string;
  actorType?: string;
  actorUserId?: string;
  resourceType?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
}): SQL | undefined {
  const clauses: SQL[] = [eq(auditLog.storeId, params.storeId)];

  /* Exact matches, not substrings: these are closed vocabularies an operator picks from. */
  if (params.action !== undefined) clauses.push(eq(auditLog.action, params.action));
  if (params.actorType !== undefined) clauses.push(eq(auditLog.actorType, params.actorType));
  if (params.actorUserId !== undefined) clauses.push(eq(auditLog.actorUserId, params.actorUserId));
  if (params.resourceType !== undefined) {
    clauses.push(eq(auditLog.resourceType, params.resourceType));
  }
  if (params.resourceId !== undefined) clauses.push(eq(auditLog.resourceId, params.resourceId));

  if (params.from !== undefined) clauses.push(gte(auditLog.createdAt, params.from));
  /*
   * Inclusive of the whole millisecond named — the project-wide convention. `created_at` is
   * microsecond-precise in storage and millisecond-precise in this API, so a plain `<=` would
   * drop the entry an operator copied the bound from.
   */
  if (params.to !== undefined)
    clauses.push(lt(auditLog.createdAt, exclusiveEndOfMillisecond(params.to)));

  return and(...clauses);
}
