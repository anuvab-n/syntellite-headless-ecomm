import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { appUser } from '../../db/schema/identity.js';
import { uniqueViolationConstraint } from '../../db/errors.js';
import { executor } from '../../db/transaction.js';
import type { MappableUser } from './dto.js';

/**
 * Identity data access.
 *
 * Imports `appUser` from its schema module directly, not through `db/schema/index.ts` — that
 * barrel exists for drizzle-kit and the test truncate helper, and its own docblock rules out
 * using it as a general dependency.
 *
 * Every query in this file is scoped by `storeId`. That is not defensive habit: `app_user`
 * is tenant-owned, and a query that forgets the scope returns another merchant's customer.
 * The scope is part of the WHERE clause, never a check the caller performs afterwards.
 */

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
  storeId: string;
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
  storeId: appUser.storeId,
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
  storeId: string;
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
  storeId: appUser.storeId,
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
  storeId: string;
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

/** The partial unique index on `(store_id, lower(email)) WHERE deleted_at IS NULL`. */
export const EMAIL_UNIQUE_CONSTRAINT = 'uq_user_email_active';

/** The partial unique index on `(store_id, phone) WHERE deleted_at IS NULL AND phone IS NOT NULL`. */
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
      storeId: string;
      email: string;
    }): Promise<MappableUser | undefined> {
      const [row] = await executor(db)
        .select(PUBLIC_COLUMNS)
        .from(appUser)
        .where(
          and(
            eq(appUser.storeId, params.storeId),
            sql`lower(${appUser.email}) = ${params.email}`,
            isNull(appUser.deletedAt),
          ),
        )
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
     * Same predicate as `findActiveByEmail` — store-scoped, `lower(email)`, `deletedAt IS
     * NULL` — so login and registration agree about which account an address refers to. A
     * soft-deleted user is therefore invisible here, which is correct: erasure anonymises,
     * and an erased account must not authenticate.
     *
     * `isActive` is returned rather than filtered. See the note on `CREDENTIAL_COLUMNS`.
     */
    async findCredentialsByEmail(params: {
      storeId: string;
      email: string;
    }): Promise<UserCredentials | undefined> {
      const [row] = await executor(db)
        .select(CREDENTIAL_COLUMNS)
        .from(appUser)
        .where(
          and(
            eq(appUser.storeId, params.storeId),
            sql`lower(${appUser.email}) = ${params.email}`,
            isNull(appUser.deletedAt),
          ),
        )
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
      storeId: string;
      userId: string;
    }): Promise<UserSubject | undefined> {
      const [row] = await executor(db)
        .select(SUBJECT_COLUMNS)
        .from(appUser)
        .where(
          and(
            eq(appUser.id, params.userId),
            eq(appUser.storeId, params.storeId),
            isNull(appUser.deletedAt),
          ),
        )
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
     * `deleted_at IS NULL` and the store predicate match `findCredentialsByEmail`, so an erased
     * or foreign account is invisible here too. `isActive` is returned rather than filtered,
     * per the note on `CREDENTIAL_COLUMNS` — the service decides what to do with it.
     */
    async findCredentialsById(params: {
      storeId: string;
      userId: string;
    }): Promise<UserCredentials | undefined> {
      const [row] = await executor(db)
        .select(CREDENTIAL_COLUMNS)
        .from(appUser)
        .where(
          and(
            eq(appUser.id, params.userId),
            eq(appUser.storeId, params.storeId),
            isNull(appUser.deletedAt),
          ),
        )
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
     * Store-scoped AND `deleted_at IS NULL` in the predicate, matching every other write here.
     * The id alone would be enough for correctness, and is deliberately not relied on.
     *
     * Returns the updated row through `SUBJECT_COLUMNS` — the same projection `findSubjectById`
     * uses — so the caller can map a response without a second read, and so the hash cannot
     * reach the response even by accident.
     */
    async updateUserProfile(params: {
      storeId: string;
      userId: string;
      fields: EditableUserFields;
      at: Date;
    }): Promise<UserSubject | undefined> {
      const [row] = await executor(db)
        .update(appUser)
        .set({ ...params.fields, updatedAt: params.at })
        .where(
          and(
            eq(appUser.id, params.userId),
            eq(appUser.storeId, params.storeId),
            isNull(appUser.deletedAt),
          ),
        )
        .returning(SUBJECT_COLUMNS);

      return row;
    },

    /**
     * Stamp a successful login.
     *
     * Store-scoped in the predicate even though the id is unique, so a bug that carried a
     * user id across tenants cannot write to another store's row.
     */
    async updateLastLoginAt(params: { storeId: string; userId: string; at: Date }): Promise<void> {
      await executor(db)
        .update(appUser)
        .set({ lastLoginAt: params.at, updatedAt: new Date() })
        .where(and(eq(appUser.id, params.userId), eq(appUser.storeId, params.storeId)));
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
      storeId: string;
      userId: string;
      expectedCurrentHash: string;
      passwordHash: string;
    }): Promise<boolean> {
      const updated = await executor(db)
        .update(appUser)
        .set({ passwordHash: params.passwordHash, updatedAt: new Date() })
        .where(
          and(
            eq(appUser.id, params.userId),
            eq(appUser.storeId, params.storeId),
            eq(appUser.passwordHash, params.expectedCurrentHash),
          ),
        )
        .returning({ id: appUser.id });

      return updated.length > 0;
    },
  };
}
