import type { Database } from '../../db/client.js';
import { withTransaction } from '../../db/transaction.js';
import type { AuditActor, AuditTrail } from '../../shared/audit.js';
import { NotFound } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';

import { STORE_AUDIT, STORE_RESOURCE } from './stores.events.js';
import type { StoreBusinessProfile, StoreRepository } from './stores.repository.js';

/**
 * The store's own administration.
 *
 * Exactly one thing: the business profile behind the admin settings screen. The GST identity is
 * NOT here — `PUT /admin/store/tax-profile` in the tax module owns `legal_name`, `gstin`, `pan`
 * and the origin address, and validates each against rules this service has no business
 * restating. Splitting by validation authority rather than by table is what keeps a GSTIN from
 * having two writers with two different notions of valid.
 *
 * ## Why a service at all, for two endpoints
 *
 * The audit entry. A settings change that left no trail would be the one mutation in this
 * system nobody could attribute, and `audit.record` must run inside the same transaction as the
 * write — which is a service concern, not a route's.
 */
export type StoresService = ReturnType<typeof createStoresService>;

export function createStoresService(deps: {
  repository: StoreRepository;
  db: Database;
  audit: AuditTrail;
  logger: Logger;
}) {
  const { repository, db, audit, logger } = deps;

  return {
    /** The store's business identity. Store-scoped from the verified token, never the request. */
    async getBusinessProfile(params: { storeId: string }): Promise<StoreBusinessProfile> {
      const profile = await repository.findBusinessProfile(params);
      /* istanbul ignore next -- the store was resolved to authenticate this request. */
      if (!profile) throw new NotFound('store');
      return profile;
    },

    /**
     * Update the business identity.
     *
     * A PATCH: absent keys are left alone rather than nulled, so a client editing the timezone
     * cannot blank the store name by omitting it. An empty body is a no-op that still reads
     * back the current profile, which is the honest answer to "change nothing".
     *
     * The before/after pair goes into the audit metadata for the fields that actually moved.
     * None of these values is a secret — a store name, a domain, a locale and an IANA timezone
     * are all published to customers — so recording them is disclosure-safe.
     */
    async updateBusinessProfile(params: {
      storeId: string;
      values: {
        name?: string | undefined;
        domain?: string | null | undefined;
        defaultLocale?: string | undefined;
        timezone?: string | undefined;
      };
      actor: AuditActor;
    }): Promise<StoreBusinessProfile> {
      return withTransaction(db, logger, async () => {
        const before = await repository.findBusinessProfile({ storeId: params.storeId });
        /* istanbul ignore next -- the store was resolved to authenticate this request. */
        if (!before) throw new NotFound('store');

        if (Object.keys(params.values).length === 0) return before;

        const after = await repository.updateBusinessProfile({
          storeId: params.storeId,
          values: params.values,
          at: new Date(),
        });
        /* istanbul ignore next -- the row was read under this transaction immediately above. */
        if (!after) throw new NotFound('store');

        /* Only what MOVED, so a diff is readable rather than a restatement of the whole row. */
        const changed: Record<
          string,
          { from: string | boolean | null; to: string | boolean | null }
        > = {};
        for (const key of Object.keys(params.values) as (keyof typeof params.values)[]) {
          if (before[key] !== after[key]) changed[key] = { from: before[key], to: after[key] };
        }

        await audit.record({
          storeId: params.storeId,
          actor: params.actor,
          action: STORE_AUDIT.businessProfileUpdated,
          resourceType: STORE_RESOURCE,
          resourceId: params.storeId,
          metadata: { changed },
        });

        return after;
      });
    },
  };
}
