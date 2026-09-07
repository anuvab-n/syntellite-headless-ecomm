import type { Database } from '../../db/client.js';
import { withTransaction } from '../../db/transaction.js';
import type { AuditActor, AuditTrail } from '../../shared/audit.js';
import { NotFound } from '../../shared/errors.js';
import { newId } from '../../shared/id.js';
import type { Logger } from '../../shared/logger.js';
import { ADDRESS_AUDIT, ADDRESS_RESOURCE } from './addresses.events.js';
import type {
  AddressRecord,
  AddressesRepository,
  EditableAddressFields,
} from './addresses.repository.js';
import type { CreateAddressRequest, UpdateAddressRequest } from './dto.js';

/**
 * The addresses module's write API.
 *
 * A factory taking explicit dependencies, matching every other service in the project. No HTTP
 * types cross this boundary — it takes validated data, an owner, and an actor, and raises
 * `DomainError` subclasses the terminal middleware maps.
 *
 * ## Ownership is a parameter, never a payload field
 *
 * `userId` and `storeId` arrive as arguments the ROUTE reads from the verified access token.
 * They are absent from every request schema, so there is no path by which a client-supplied
 * value could reach here even by mistake.
 *
 * ## No `EventBus`
 *
 * There is no event bus in these dependencies, deliberately. Nothing consumes an address
 * change, and Increment 26 established that an event with no consumer is a guess at one. Audit
 * is the whole obligation for now — see `addresses.events.ts`.
 */

export type AddressesService = ReturnType<typeof createAddressesService>;

export function createAddressesService(deps: {
  repository: AddressesRepository;
  db: Database;
  audit: AuditTrail;
  logger: Logger;
}) {
  const { repository, db, audit, logger } = deps;

  /**
   * Record one address change.
   *
   * **Identifiers and changed FIELD NAMES only — never address values.**
   *
   * That is a deliberate departure from the catalogue's habit of recording before/after values,
   * and the reason is written into `audit_log`'s own doc comment: it is *"read by more people
   * than the database, and frequently shipped to a log aggregator with different access
   * controls."* docs/DECISIONS.md §36 already refuses to store address payloads in
   * `idempotency_key` for exactly this reason, and §10 forbids logging request bodies because
   * *"a checkout body holds an address"*.
   *
   * So an auditor learns that this actor changed the city and postal code of this address at
   * this time, which is what an audit trail is for, without the trail becoming a second copy of
   * the customer's home address.
   *
   * `store_id`, `actor_user_id`, `request_id` and the timestamp are written by the shared audit
   * infrastructure and are not repeated here. MUST be called inside a transaction — `record`
   * asserts that itself, so a caller who forgets fails loudly at the first test.
   */
  async function recordAddressChange(args: {
    storeId: string;
    actor: AuditActor;
    addressId: string;
    action: string;
    /** Field NAMES, not values. Absent for create and delete, where the action says it all. */
    changed?: readonly string[];
  }): Promise<void> {
    await audit.record({
      action: args.action,
      actor: args.actor,
      resourceType: ADDRESS_RESOURCE,
      resourceId: args.addressId,
      storeId: args.storeId,
      ...(args.changed === undefined ? {} : { metadata: { changed: [...args.changed] } }),
    });
  }

  return {
    /**
     * Create an address for the authenticated user.
     *
     * The insert and the audit entry share one transaction, so a rollback discards both: an
     * audit trail recording a creation that did not happen is worse than no entry at all.
     */
    async createAddress(params: {
      userId: string;
      storeId: string;
      actor: AuditActor;
      input: CreateAddressRequest;
    }): Promise<AddressRecord> {
      const { userId, storeId, actor, input } = params;

      return withTransaction(db, logger, async () => {
        const row = await repository.insertAddress({
          id: newId(),
          // From the verified token, threaded as arguments. Never from the request body.
          userId,
          storeId,
          label: input.label,
          recipientName: input.recipientName,
          phone: input.phone,
          line1: input.line1,
          // The column defaults are `''`; naming them here keeps the decision visible at the
          // one place an address's optional lines are set.
          line2: input.line2 ?? '',
          landmark: input.landmark ?? '',
          city: input.city,
          state: input.state,
          postalCode: input.postalCode,
          countryCode: input.countryCode ?? 'IN',
        });

        await recordAddressChange({
          storeId,
          actor,
          addressId: row.id,
          action: ADDRESS_AUDIT.created,
        });

        /**
         * Identifiers only. No address field reaches a log line — §10's "no bodies, ever" rule
         * exists precisely because a checkout body holds an address, and a log is the easiest
         * place for PII to escape unnoticed.
         */
        logger.info({ storeId, userId, addressId: row.id }, 'address_created');
        return row;
      });
    },

    /** This user's live addresses. Unpaged; visibility belongs to the repository query. */
    async getAddressesForUser(params: {
      userId: string;
      storeId: string;
    }): Promise<AddressRecord[]> {
      return repository.listAddressesForUser(params);
    },

    /**
     * One address, or 404.
     *
     * An unknown id, another user's address, another store's address, and a soft-deleted one
     * all produce the same `NotFound` — the §25 rule that ownership belongs in the query rather
     * than in a comparison afterwards. A 403 for "someone else's" would confirm the id exists,
     * which is exactly the leak the single answer closes.
     */
    async getAddressById(params: {
      id: string;
      userId: string;
      storeId: string;
    }): Promise<AddressRecord> {
      const row = await repository.findAddressById(params);
      if (!row) {
        logger.info(
          { storeId: params.storeId, userId: params.userId, addressId: params.id },
          'address_not_found',
        );
        throw new NotFound('address');
      }
      return row;
    },

    /**
     * Update an address's editable fields.
     *
     * The update's own predicate is the enforcement — it carries the id, the user, the store
     * and `deleted_at IS NULL` — so there is no second lookup and no place for the ownership
     * check to be forgotten. Matching nothing is a 404, with no attempt to distinguish why.
     */
    async updateAddress(params: {
      id: string;
      userId: string;
      storeId: string;
      actor: AuditActor;
      input: UpdateAddressRequest;
    }): Promise<AddressRecord> {
      const { id, userId, storeId, actor, input } = params;

      /**
       * Built field by field rather than spread.
       *
       * Spreading would need an `as` cast to satisfy `EditableAddressFields`, and that cast is
       * precisely what would let a widened schema carry `userId` or `storeId` through — the
       * reasoning Increment 21 recorded for `EditableUserFields`. Explicit is also what makes
       * `changed` below honest: it names exactly the fields this statement writes.
       */
      const fields: EditableAddressFields = {
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.recipientName === undefined ? {} : { recipientName: input.recipientName }),
        ...(input.phone === undefined ? {} : { phone: input.phone }),
        ...(input.line1 === undefined ? {} : { line1: input.line1 }),
        ...(input.line2 === undefined ? {} : { line2: input.line2 }),
        ...(input.landmark === undefined ? {} : { landmark: input.landmark }),
        ...(input.city === undefined ? {} : { city: input.city }),
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.postalCode === undefined ? {} : { postalCode: input.postalCode }),
        ...(input.countryCode === undefined ? {} : { countryCode: input.countryCode }),
      };

      const updated = await withTransaction(db, logger, async () => {
        const row = await repository.updateAddressFields({
          id,
          userId,
          storeId,
          fields,
          at: new Date(),
        });

        if (!row) return undefined;

        await recordAddressChange({
          storeId,
          actor,
          addressId: row.id,
          action: ADDRESS_AUDIT.updated,
          // Names only. `Object.keys(fields)` is exactly the set of columns written.
          changed: Object.keys(fields),
        });

        logger.info({ storeId, userId, addressId: row.id }, 'address_updated');
        return row;
      });

      if (!updated) {
        logger.info({ storeId, userId, addressId: id }, 'address_not_found');
        throw new NotFound('address');
      }

      return updated;
    },

    /**
     * Soft-delete one address.
     *
     * The row survives, per docs/DECISIONS.md §3 decision 15 ("anonymise, never delete"). There
     * is no restore endpoint: none was asked for, and adding one would need its own decision
     * about what a restored address means if its label now collides or its country rules have
     * changed.
     */
    async deleteAddress(params: {
      id: string;
      userId: string;
      storeId: string;
      actor: AuditActor;
    }): Promise<void> {
      const { id, userId, storeId, actor } = params;

      const deleted = await withTransaction(db, logger, async () => {
        const row = await repository.softDeleteAddress({
          id,
          userId,
          storeId,
          at: new Date(),
        });

        if (!row) return undefined;

        await recordAddressChange({
          storeId,
          actor,
          addressId: row.id,
          action: ADDRESS_AUDIT.deleted,
        });

        return row;
      });

      if (!deleted) {
        logger.info({ storeId, userId, addressId: id }, 'address_not_found');
        throw new NotFound('address');
      }

      logger.info({ storeId, userId, addressId: id }, 'address_deleted');
    },
  };
}
