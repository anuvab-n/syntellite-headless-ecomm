import { and, asc, eq, isNull } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { address } from '../../db/schema/address.js';
import { executor } from '../../db/transaction.js';

/**
 * Address data access.
 *
 * **Every query here is scoped by BOTH `user_id` AND `store_id`, in the WHERE clause** — not by
 * a check the caller performs afterwards, and not by trusting that middleware got it right. A
 * future caller arriving from a CLI command or a background job inherits the same isolation.
 *
 * `store_id` is arguably redundant once `fk_address_user_store` exists: the composite foreign
 * key guarantees an address's store equals its user's store, and `user_id` alone therefore
 * already pins the tenant. It is stated anyway because every predicate in this codebase carries
 * its own scope, so a reader never has to trace tenancy through a constraint to be sure of it.
 * That redundancy is deliberate and is reported as such rather than engineered away.
 *
 * No `db.query.*` anywhere: the query builder is the project default, and it is the only API
 * that can express `.for('update')` should this module ever need one.
 */

export type AddressesRepository = ReturnType<typeof createAddressesRepository>;

/**
 * An address row as the rest of the system sees it.
 *
 * `userId`, `storeId` and `deletedAt` are deliberately ABSENT. Ownership and tenancy are
 * invariants of the query rather than fields for a caller to inspect and re-check, and a
 * deleted address is never returned at all — so publishing any of the three would only give a
 * client something it must not act on.
 */
export type AddressRecord = {
  readonly id: string;
  readonly label: string;
  readonly recipientName: string;
  readonly phone: string;
  readonly line1: string;
  readonly line2: string;
  readonly landmark: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly countryCode: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

const RECORD_COLUMNS = {
  id: address.id,
  label: address.label,
  recipientName: address.recipientName,
  phone: address.phone,
  line1: address.line1,
  landmark: address.landmark,
  line2: address.line2,
  city: address.city,
  state: address.state,
  postalCode: address.postalCode,
  countryCode: address.countryCode,
  createdAt: address.createdAt,
  updatedAt: address.updatedAt,
} as const;

export type InsertAddressValues = {
  id: string;
  /** From the verified token, never from a request body. */
  userId: string;
  /** From the verified token, never from a request body. */
  storeId: string;
  label: string;
  recipientName: string;
  phone: string;
  line1: string;
  line2: string;
  landmark: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
};

/**
 * The columns an edit may write, and the complete list of them.
 *
 * Deliberately NOT `Partial<InsertAddressValues>`: that would admit `id`, `userId` and
 * `storeId`, turning a compile-time guarantee into a runtime hope. Widening this type is the
 * only way to make another column editable, which is exactly the friction that decision
 * deserves — the same discipline `EditableSkuFields` and `EditableOptionFields` apply.
 */
export type EditableAddressFields = {
  label?: string;
  recipientName?: string;
  phone?: string;
  line1?: string;
  line2?: string;
  landmark?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  countryCode?: string;
};

export function createAddressesRepository(deps: { db: Database }) {
  const { db } = deps;

  /**
   * "This live address, belonging to this user, in this store."
   *
   * ONE predicate, used identically by the read, the update and the delete, so an address can
   * never be readable but not editable (or the reverse) because two predicates drifted. It is
   * also what makes another user's address a 404 rather than a 403: ownership lives in the
   * query, so there is no comparison afterwards that could be forgotten.
   */
  const scopeToOne = (params: { id: string; userId: string; storeId: string }) =>
    and(
      eq(address.id, params.id),
      eq(address.userId, params.userId),
      eq(address.storeId, params.storeId),
      isNull(address.deletedAt),
    );

  return {
    async insertAddress(values: InsertAddressValues): Promise<AddressRecord> {
      const [row] = await executor(db).insert(address).values(values).returning(RECORD_COLUMNS);
      // Drizzle returns exactly one row for a single-row insert; a failure throws.
      return row!;
    },

    /**
     * This user's live addresses.
     *
     * UNPAGED, deliberately. An address book is bounded by what one person can plausibly
     * maintain — the same judgement §28 applied to a single product's SKUs, and the opposite of
     * the one it applied to a store's products. Ordered by `label` then `id` so a page is
     * stable and a customer can find a row; `id` breaks ties because labels are not unique.
     */
    async listAddressesForUser(params: {
      userId: string;
      storeId: string;
    }): Promise<AddressRecord[]> {
      return executor(db)
        .select(RECORD_COLUMNS)
        .from(address)
        .where(
          and(
            eq(address.userId, params.userId),
            eq(address.storeId, params.storeId),
            isNull(address.deletedAt),
          ),
        )
        .orderBy(asc(address.label), asc(address.id));
    },

    async findAddressById(params: {
      id: string;
      userId: string;
      storeId: string;
    }): Promise<AddressRecord | undefined> {
      const [row] = await executor(db)
        .select(RECORD_COLUMNS)
        .from(address)
        .where(scopeToOne(params))
        .limit(1);
      return row;
    },

    /**
     * Update an address's editable fields.
     *
     * ONE atomic scoped statement, and the whole scope is in the predicate. Without `user_id`
     * the statement would rewrite another customer's address; without `id` it would rewrite
     * every address the customer owns — the blast-radius failure that survived §29's first
     * suite because every test kept a single row.
     *
     * Returns `undefined` when nothing matched, which the service reports as a 404 without a
     * second lookup: unknown, another user's, another store's and deleted are all the same
     * answer, so there is nothing to disambiguate.
     */
    async updateAddressFields(params: {
      id: string;
      userId: string;
      storeId: string;
      fields: EditableAddressFields;
      at: Date;
    }): Promise<AddressRecord | undefined> {
      const [row] = await executor(db)
        .update(address)
        .set({ ...params.fields, updatedAt: params.at })
        .where(scopeToOne(params))
        .returning(RECORD_COLUMNS);
      return row;
    },

    /**
     * Soft-delete one address.
     *
     * `deleted_at IS NULL` in the predicate makes a second delete match nothing rather than
     * re-stamping the timestamp and losing the original deletion time — the same rule
     * `softDeleteProduct` and `softDeleteSku` follow, and what lets the route answer 404 the
     * second time.
     *
     * The row is never physically removed: docs/DECISIONS.md §3 decision 15 is "anonymise,
     * never delete", and an address is personal data inside that story. Erasure itself is a
     * later concern; this increment only refrains from making it impossible.
     */
    async softDeleteAddress(params: {
      id: string;
      userId: string;
      storeId: string;
      at: Date;
    }): Promise<AddressRecord | undefined> {
      const [row] = await executor(db)
        .update(address)
        .set({ deletedAt: params.at, updatedAt: params.at })
        .where(scopeToOne(params))
        .returning(RECORD_COLUMNS);
      return row;
    },
  };
}
