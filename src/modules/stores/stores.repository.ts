import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { store } from '../../db/schema/store.js';
import { executor } from '../../db/transaction.js';

/**
 * Store data access.
 *
 * Imports `store` from its schema module directly rather than through `db/schema/index.ts`,
 * per that barrel's own rule: the barrel exists for drizzle-kit and the test truncate
 * helper, not as a general dependency. A module's repository is the only place permitted to
 * touch its own tables.
 */

export type StoreRepository = ReturnType<typeof createStoreRepository>;

/**
 * The subset of a store row the rest of the system needs to know about.
 *
 * Deliberately narrow. Returning the whole row would let a caller depend on `gstin` or
 * `registeredAddress` and quietly couple itself to columns that belong to invoicing.
 */
export type ResolvedStore = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly currency: string;
  readonly defaultLocale: string;
  readonly timezone: string;
};

const RESOLVED_COLUMNS = {
  id: store.id,
  slug: store.slug,
  name: store.name,
  currency: store.currency,
  defaultLocale: store.defaultLocale,
  timezone: store.timezone,
} as const;

/**
 * The store's BUSINESS PROFILE, as the admin settings screen sees it. Increment 62.
 *
 * Deliberately excludes every GST field — `legal_name`, `gstin`, `pan` and the whole origin
 * address. Those are owned by `PUT /admin/store/tax-profile`, which validates a GSTIN against
 * its checksum and a state code against the place-of-supply rules. Two endpoints writing the
 * same columns with different validation is how one of them ends up being the weak one.
 *
 * `slug` and `currency` are published but not editable: the slug is how the store is RESOLVED
 * on every request, and the currency is denominated into `NUMERIC(19,4)` money on every order,
 * payment, refund and invoice already written. Changing either is a migration, not a setting.
 */
export type StoreBusinessProfile = {
  readonly slug: string;
  readonly name: string;
  readonly domain: string | null;
  readonly currency: string;
  readonly defaultLocale: string;
  readonly timezone: string;
  readonly isActive: boolean;
};

const BUSINESS_PROFILE_COLUMNS = {
  slug: store.slug,
  name: store.name,
  domain: store.domain,
  currency: store.currency,
  defaultLocale: store.defaultLocale,
  timezone: store.timezone,
  isActive: store.isActive,
} as const;

export function createStoreRepository(deps: { db: Database }) {
  const { db } = deps;

  return {
    /** The store's editable business identity. Increment 62. */
    async findBusinessProfile(params: {
      storeId: string;
    }): Promise<StoreBusinessProfile | undefined> {
      const [row] = await executor(db)
        .select(BUSINESS_PROFILE_COLUMNS)
        .from(store)
        .where(eq(store.id, params.storeId))
        .limit(1);
      return row;
    },

    /**
     * Update the business identity. Increment 62.
     *
     * The column list is closed and contains no GST field, no `slug`, no `currency` and no
     * `id`: a caller cannot widen it, because the method accepts only these three values.
     */
    async updateBusinessProfile(params: {
      storeId: string;
      values: {
        name?: string | undefined;
        domain?: string | null | undefined;
        defaultLocale?: string | undefined;
        timezone?: string | undefined;
      };
      at: Date;
    }): Promise<StoreBusinessProfile | undefined> {
      const [row] = await executor(db)
        .update(store)
        .set({ ...params.values, updatedAt: params.at })
        .where(eq(store.id, params.storeId))
        .returning(BUSINESS_PROFILE_COLUMNS);
      return row;
    },
    /**
     * Look up an ACTIVE store by slug.
     *
     * `isActive` is part of the predicate rather than something the caller checks
     * afterwards: a deactivated store must be indistinguishable from a missing one at
     * every call site, or one forgotten check serves traffic for a store that was
     * deliberately switched off.
     *
     * Uses {@link executor} so a lookup inside a transaction sees that transaction's
     * writes — which is what makes it usable from the seed.
     */
    async findActiveBySlug(slug: string): Promise<ResolvedStore | undefined> {
      const [row] = await executor(db)
        .select(RESOLVED_COLUMNS)
        .from(store)
        .where(and(eq(store.slug, slug), eq(store.isActive, true)))
        .limit(1);
      return row;
    },

    /**
     * Insert a store if its slug is not already taken, and return the row either way.
     *
     * `ON CONFLICT DO NOTHING` plus a follow-up read rather than a read-then-insert: two
     * seeds running concurrently (a deploy hook and a developer, say) would both pass a
     * pre-check and one would then fail on the unique index. This is idempotent by
     * construction instead of by timing.
     */
    async createIfAbsent(values: {
      id: string;
      slug: string;
      name: string;
      currency: string;
    }): Promise<{ store: ResolvedStore; created: boolean }> {
      const inserted = await executor(db)
        .insert(store)
        .values({
          id: values.id,
          slug: values.slug,
          name: values.name,
          currency: values.currency,
          supportedCurrencies: sql`ARRAY[${values.currency}]::text[]`,
        })
        .onConflictDoNothing({ target: store.slug })
        .returning(RESOLVED_COLUMNS);

      const created = inserted[0];
      if (created) return { store: created, created: true };

      // The conflict path: somebody else has it. Read it back so the caller always gets a
      // store, which is what makes the seed safe to run repeatedly.
      const [existing] = await executor(db)
        .select(RESOLVED_COLUMNS)
        .from(store)
        .where(eq(store.slug, values.slug))
        .limit(1);

      if (!existing) {
        // Neither inserted nor found: the row was deleted between the two statements. Rare
        // enough to be worth reporting loudly rather than retrying silently.
        throw new Error(`store '${values.slug}' could not be created or found`);
      }
      return { store: existing, created: false };
    },
  };
}
