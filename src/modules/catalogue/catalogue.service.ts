import type { Database } from '../../db/client.js';
import { uniqueViolationConstraint } from '../../db/errors.js';
import { withTransaction } from '../../db/transaction.js';
import type { AuditActor, AuditTrail } from '../../shared/audit.js';
import {
  Conflict,
  InvalidStateTransition,
  NotFound,
  ValidationError,
} from '../../shared/errors.js';
import type { EventBus, JsonObject } from '../../shared/events.js';
import { newId } from '../../shared/id.js';
import type { Logger } from '../../shared/logger.js';
import { isCurrency, money, toDb, type Currency } from '../../shared/money.js';
import {
  OPTION_NAME_UNIQUE_CONSTRAINT,
  OPTION_VALUE_UNIQUE_CONSTRAINT,
  PRODUCT_SLUG_UNIQUE_CONSTRAINT,
  SKU_CODE_UNIQUE_CONSTRAINT,
  SKU_COMBINATION_UNIQUE_CONSTRAINT,
  type CatalogueRepository,
  type EditableOptionFields,
  type EditableOptionValueFields,
  type EditableProductFields,
  type EditableSkuFields,
  type OptionRecord,
  type OptionValueRecord,
  type ProductRecord,
  type SkuOptionRecord,
  type SkuRecord,
} from './catalogue.repository.js';
import {
  OPTION_AGGREGATE,
  OPTION_AUDIT,
  OPTION_EVENTS,
  OPTION_RESOURCE,
  OPTION_VALUE_AGGREGATE,
  OPTION_VALUE_AUDIT,
  OPTION_VALUE_EVENTS,
  OPTION_VALUE_RESOURCE,
  PRODUCT_AGGREGATE,
  PRODUCT_AUDIT,
  PRODUCT_EVENTS,
  PRODUCT_RESOURCE,
  SKU_AGGREGATE,
  SKU_AUDIT,
  SKU_EVENTS,
  SKU_OPTIONS_AUDIT,
  SKU_OPTIONS_EVENT,
  SKU_RESOURCE,
  optionEventPayload,
  optionValueEventPayload,
  productEventPayload,
  skuEventPayload,
} from './catalogue.events.js';
import {
  MAX_OPTIONS_PER_PRODUCT,
  MAX_VALUES_PER_OPTION,
  type CreateOptionRequest,
  type CreateOptionValueRequest,
  type CreateProductRequest,
  type CreateSkuRequest,
  type ReplaceSkuOptionsRequest,
  type UpdateOptionRequest,
  type UpdateOptionValueRequest,
  type UpdateProductRequest,
  type UpdateSkuRequest,
} from './dto.js';

/**
 * The catalogue module's write API.
 *
 * A factory taking explicit dependencies, matching every other service in the project. No
 * HTTP types cross this boundary — it takes validated data and a store id, and raises
 * `DomainError` subclasses the terminal middleware maps. That is what will let a bulk import
 * or a seed script create products without going through Express.
 */

export type CatalogueService = ReturnType<typeof createCatalogueService>;

/** A product already occupies this slug in this store. */
export class ProductSlugTaken extends Conflict {
  override readonly code = 'PRODUCT_SLUG_TAKEN';

  constructor() {
    /**
     * No slug in the message. Unlike a registration conflict — where the caller already knows
     * the address they sent — echoing input back into a response body is a reflection surface,
     * and the field is named in `details` by the validation layer when it matters.
     */
    super('A product with this slug already exists.');
  }
}

/** A live SKU already occupies this merchant code in this store. */
export class SkuCodeTaken extends Conflict {
  override readonly code = 'SKU_CODE_TAKEN';

  constructor() {
    // Same reasoning as `ProductSlugTaken`: the code is not echoed back.
    super('A SKU with this code already exists.');
  }
}

/** This product already has an option with this name, compared case-insensitively. */
export class OptionNameTaken extends Conflict {
  override readonly code = 'OPTION_NAME_TAKEN';

  constructor() {
    super('An option with this name already exists on this product.');
  }
}

/** This option already has this value, compared case-insensitively. */
export class OptionValueTaken extends Conflict {
  override readonly code = 'OPTION_VALUE_TAKEN';

  constructor() {
    super('This option already has a value with this name.');
  }
}

/**
 * Another SKU of this product already has this exact combination.
 *
 * Raised only for `uq_sku_combination`. A duplicate option name and a duplicate SKU code are
 * different conflicts with their own codes, and reporting either of them here would send a
 * client looking for a variant clash that does not exist.
 */
export class SkuCombinationTaken extends Conflict {
  override readonly code = 'SKU_COMBINATION_TAKEN';

  constructor() {
    super('Another SKU of this product already has this option combination.');
  }
}

/**
 * A SKU was asked to carry two values of the same option.
 *
 * Its OWN code, not the generic `CONFLICT`. This is a different failure from a duplicate
 * combination and a client must be able to tell them apart: one is fixed by dropping a value,
 * the other by choosing a different variant. `uq_sov_sku_option` is the real enforcement;
 * this is the friendly error in front of it.
 */
export class SkuOptionConflict extends Conflict {
  override readonly code = 'SKU_OPTION_CONFLICT';

  constructor() {
    super('A SKU cannot carry two values of the same option.');
  }
}

/**
 * The option or value is still in use, so it cannot be retired.
 *
 * Deterministic, and it NAMES the SKU codes that block the deletion. A merchant told only
 * "in use" has to go hunting; the whole point of refusing rather than cascading is that the
 * merchant decides what to do with those SKUs, and they cannot decide without knowing which.
 *
 * The codes are safe to return: the caller is authenticated staff of the store that owns them,
 * and they asked about this exact resource.
 */
export class OptionInUse extends Conflict {
  override readonly code = 'OPTION_IN_USE';

  constructor(skuCodes: readonly string[]) {
    super(
      'This option or value is still used by active SKUs and cannot be deleted. Delete or re-assign those SKUs first.',
      { skuCodes: [...skuCodes] },
    );
  }
}

/**
 * Build a SKU's option signature.
 *
 * **The one place a signature is computed.** A second implementation is how a write and a
 * later verification end up disagreeing about what a SKU is.
 *
 * Sorted `product_option_value` ids joined with `,`. Sorting is what makes the combination
 * order-independent: `Red+Small` and `Small+Red` are the same variant and must collide on
 * `uq_sku_combination`. Ids rather than names, because renaming a value must not change what
 * combination a SKU represents nor make two SKUs collide.
 *
 * `[]` yields `''` — the empty combination, exempted from uniqueness by the index's
 * `option_signature <> ''` predicate, which is what lets Increment 24's option-less SKUs
 * continue to coexist.
 *
 * `localeCompare` is deliberately NOT used: it is locale-sensitive, so the same input could
 * sort differently on another machine and silently produce a second signature for one
 * combination. Default `Array.prototype.sort` compares UTF-16 code units, which for canonical
 * lowercase UUID text is a stable byte ordering everywhere.
 *
 * **Never change the ordering or the delimiter.** Every stored signature would be invalidated
 * with no error at the moment of the change, and the uniqueness guarantee built on them would
 * quietly stop holding. A test pins the exact output for a known pair of ids.
 */
export function buildOptionSignature(optionValueIds: readonly string[]): string {
  return [...optionValueIds].sort().join(',');
}

/**
 * The product lifecycle, as data.
 *
 * `publish` restores an archived product as well as publishing a draft; `archive` withdraws
 * only a live one. There is deliberately no transition back to `draft`: the action endpoints
 * cannot express one, so an unpublish is not merely rejected but unrepresentable.
 */
export const PRODUCT_TRANSITIONS = {
  publish: { from: ['draft', 'archived'] as const, to: 'active' },
  archive: { from: ['active'] as const, to: 'archived' },
} as const;

type ProductTransition = (typeof PRODUCT_TRANSITIONS)[keyof typeof PRODUCT_TRANSITIONS];

export function createCatalogueService(deps: {
  repository: CatalogueRepository;
  /**
   * Needed for `withTransaction`, which every mutation now opens.
   *
   * A single-statement write does not need a transaction of its own — but a write PLUS an
   * outbox event PLUS an audit entry does, and all three must land together or not at all.
   */
  db: Database;
  events: EventBus;
  audit: AuditTrail;
  logger: Logger;
}) {
  const { repository, db, events, audit, logger } = deps;

  /**
   * The store's currency, or a loud failure.
   *
   * A store configured with a currency this build does not know is an OPERATOR error, not a
   * client one, so it must not surface as a 400. Extracted because both SKU write paths need
   * it and duplicating the check is how the two would eventually disagree.
   */
  function requireCurrency(storeId: string, value: string): Currency {
    if (!isCurrency(value)) {
      throw new Error(`store ${storeId} has an unsupported currency: ${value}`);
    }
    return value;
  }

  /**
   * Record one option change, and one option-value change.
   *
   * Two functions rather than one with a discriminator, following the split between
   * `recordProductChange` and `recordSkuChange` and for the same reason: they write different
   * `aggregate_type` and `resource_type` values and carry different payloads, and a single
   * parameterised version would be shorter while making every call site harder to read.
   *
   * Both MUST be called inside a transaction — `emit` and `record` assert that themselves.
   */
  async function recordOptionChange(args: {
    storeId: string;
    actor: AuditActor;
    option: OptionRecord;
    eventName: string;
    auditAction: string;
    metadata?: JsonObject;
  }): Promise<void> {
    await events.emit({
      type: args.eventName,
      aggregateType: OPTION_AGGREGATE,
      aggregateId: args.option.id,
      storeId: args.storeId,
      payload: optionEventPayload(args.option),
    });

    await audit.record({
      action: args.auditAction,
      actor: args.actor,
      resourceType: OPTION_RESOURCE,
      resourceId: args.option.id,
      storeId: args.storeId,
      ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
    });
  }

  async function recordOptionValueChange(args: {
    storeId: string;
    actor: AuditActor;
    value: OptionValueRecord;
    eventName: string;
    auditAction: string;
    metadata?: JsonObject;
  }): Promise<void> {
    await events.emit({
      type: args.eventName,
      aggregateType: OPTION_VALUE_AGGREGATE,
      aggregateId: args.value.id,
      storeId: args.storeId,
      payload: optionValueEventPayload(args.value),
    });

    await audit.record({
      action: args.auditAction,
      actor: args.actor,
      resourceType: OPTION_VALUE_RESOURCE,
      resourceId: args.value.id,
      storeId: args.storeId,
      ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
    });
  }

  /**
   * Resolve a live option by id, or 404.
   *
   * Store-scoped in the QUERY, so "another store's option" and "no such option" are the same
   * answer — the §25 rule that ownership belongs in the predicate rather than in a comparison
   * afterwards, which is what stops a tenancy probe learning that an id exists elsewhere.
   */
  async function requireOption(storeId: string, id: string): Promise<OptionRecord> {
    const option = await repository.findOptionById({ storeId, id });
    if (!option) {
      logger.info({ storeId, optionId: id }, 'option_not_found');
      throw new NotFound('option');
    }
    return option;
  }

  /**
   * Refuse the deletion if any LIVE SKU still uses these values.
   *
   * The whole of decision A, in one place. Soft-deleting a value that a live SKU references
   * would leave that SKU's stored signature containing an id whose row is retired: the public
   * response would silently show a PARTIAL combination — "Red / Small" becoming "Small",
   * indistinguishable from a genuinely Size-only SKU — and re-creating "Red" would mint a new
   * id, so the "same" combination would get a different signature and `uq_sku_combination`
   * could no longer see the collision.
   *
   * Historical rows are unaffected: the guard asks only about SKUs with `deleted_at IS NULL`,
   * so a value used solely by already-deleted SKUs retires freely, and those rows keep
   * pointing at a value row that still exists because the deletion is SOFT.
   */
  async function refuseIfInUse(storeId: string, codes: readonly string[]): Promise<void> {
    if (codes.length > 0) {
      logger.info({ storeId, blockingSkuCount: codes.length }, 'option_delete_rejected_in_use');
      throw new OptionInUse(codes);
    }
  }

  /**
   * Record one SKU change: an event for the system, an audit entry for the auditor.
   *
   * The SKU counterpart of `recordProductChange`, and separate from it rather than
   * generalised: the two carry different payloads (a SKU event needs its price to be
   * actionable, a product event does not) and write different `aggregate_type` values. One
   * function taking a discriminator would be shorter and would make both harder to read.
   *
   * MUST be called inside a transaction — `emit` and `record` both assert that themselves.
   */
  async function recordSkuChange(args: {
    storeId: string;
    actor: AuditActor;
    sku: SkuRecord;
    eventName: string;
    auditAction: string;
    payloadExtra?: JsonObject;
    metadata?: JsonObject;
  }): Promise<void> {
    await events.emit({
      type: args.eventName,
      aggregateType: SKU_AGGREGATE,
      aggregateId: args.sku.id,
      storeId: args.storeId,
      payload: { ...skuEventPayload(args.sku), ...(args.payloadExtra ?? {}) },
    });

    await audit.record({
      action: args.auditAction,
      actor: args.actor,
      resourceType: SKU_RESOURCE,
      resourceId: args.sku.id,
      storeId: args.storeId,
      ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
    });
  }

  /**
   * Record one product change: an event for the system, an audit entry for the auditor.
   *
   * Both, always, from one place. Emitting in five separate methods is how one of them ends up
   * missing an event or attributing an action to nobody — and the two writes belong together
   * because every product mutation is simultaneously a fact other code reacts to and an act
   * some staff member performed.
   *
   * MUST be called inside a transaction. Both `emit` and `record` assert that themselves, so a
   * caller who forgets fails loudly at the first test rather than silently losing the trail.
   */
  async function recordProductChange(args: {
    storeId: string;
    actor: AuditActor;
    product: ProductRecord;
    eventName: string;
    auditAction: string;
    /** Extra event payload facts, e.g. which fields an update touched. */
    payloadExtra?: JsonObject;
    /** Extra audit metadata — the WHY, or a before/after diff. Never credential material. */
    metadata?: JsonObject;
  }): Promise<void> {
    await events.emit({
      type: args.eventName,
      aggregateType: PRODUCT_AGGREGATE,
      aggregateId: args.product.id,
      storeId: args.storeId,
      payload: { ...productEventPayload(args.product), ...(args.payloadExtra ?? {}) },
    });

    await audit.record({
      action: args.auditAction,
      actor: args.actor,
      resourceType: PRODUCT_RESOURCE,
      resourceId: args.product.id,
      storeId: args.storeId,
      ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
    });
  }

  /**
   * Apply a lifecycle transition, or explain why it could not happen.
   *
   * The update is attempted first and its predicate is the enforcement. Only when it matches
   * nothing does a second, STORE-SCOPED lookup run to tell the two failure modes apart:
   *
   *  - no row visible in this store  -> `NotFound` (404). Covers a slug that never existed, a
   *    product belonging to another store, and a soft-deleted one. They are indistinguishable
   *    on purpose: `NotFound`'s own contract is that ownership belongs in the query, so
   *    confirming a product exists elsewhere would leak across a tenant boundary.
   *  - a row exists but its status is not a permitted source -> `InvalidStateTransition` (409),
   *    naming the current and requested statuses.
   *
   * That second lookup costs one indexed read on the failure path only, and it cannot leak:
   * `findBySlug` is store-scoped, so a product in another store is invisible to it too.
   *
   * Reporting the current status is safe here in a way it would not be on the public read.
   * This endpoint already requires the `staff` scope, and a staff member is entitled to know
   * the state of their own store's catalogue.
   */
  async function transition(
    params: { storeId: string; slug: string; actor: AuditActor },
    rule: ProductTransition,
    names: { event: string; audit: string },
  ): Promise<ProductRecord> {
    const updated = await withTransaction(db, logger, async () => {
      const row = await repository.transitionStatus({
        storeId: params.storeId,
        slug: params.slug,
        from: rule.from,
        to: rule.to,
        at: new Date(),
      });

      if (!row) return undefined;

      /**
       * Inside the same transaction as the status change, so a published product always has a
       * `product.published` event and an audit entry naming who published it. Without this the
       * storefront cache could be invalidated for a change that rolled back.
       */
      await recordProductChange({
        storeId: params.storeId,
        actor: params.actor,
        product: row,
        eventName: names.event,
        auditAction: names.audit,
        payloadExtra: { from: rule.from.join(','), to: rule.to },
        metadata: { to: rule.to },
      });

      return row;
    });

    if (updated) {
      logger.info(
        { storeId: params.storeId, productId: updated.id, status: updated.status },
        'product_status_changed',
      );
      return updated;
    }

    const existing = await repository.findBySlug(params);
    if (!existing) {
      logger.info({ storeId: params.storeId, slug: params.slug }, 'product_not_found');
      throw new NotFound('product');
    }

    logger.info(
      { storeId: params.storeId, productId: existing.id, from: existing.status, to: rule.to },
      'product_transition_rejected',
    );
    throw new InvalidStateTransition({
      entity: 'Product',
      from: existing.status,
      to: rule.to,
    });
  }

  return {
    /**
     * Create a product in a store.
     *
     * `storeId` is a parameter, not a field of `input`: the DTO has no such field, so a
     * client that sends one gets a 400 rather than having it quietly ignored.
     *
     * No price and no currency. A product is not sellable and has no price — its SKUs do, and
     * they are created separately under `POST /admin/products/:slug/skus`. Creating a default
     * SKU here would guess a code the merchant has not chosen.
     */
    async createProduct(params: {
      storeId: string;
      /**
       * Who is creating this. Supplied by the route from the verified access token, never
       * from the request body — an audit trail a client can attribute to someone else is
       * worse than none.
       */
      actor: AuditActor;
      input: CreateProductRequest;
    }): Promise<ProductRecord> {
      const { storeId, actor, input } = params;

      /**
       * Pre-check for a friendly error. NOT the enforcement mechanism.
       *
       * Two concurrent creates of the same slug both reach this point and both see nothing, so
       * the unique index is what actually decides. The pre-check exists so the common,
       * sequential case gets a clean 409 rather than a translated constraint violation — and
       * the catch below covers the race the pre-check cannot.
       */
      const existing = await repository.findBySlug({ storeId, slug: input.slug });
      if (existing) {
        logger.info({ storeId }, 'product_create_rejected_slug_taken');
        throw new ProductSlugTaken();
      }

      try {
        /**
         * The insert, the event, and the audit entry in ONE transaction.
         *
         * The unique-violation catch stays OUTSIDE it deliberately: a failed statement poisons
         * the surrounding transaction, so the rollback has to complete before the error is
         * translated. Catching inside and continuing would leave a doomed transaction open.
         */
        const created = await withTransaction(db, logger, async () => {
          const row = await repository.insertProduct({
            id: newId(),
            storeId,
            slug: input.slug,
            name: input.name,
            description: input.description ?? '',
            // The column default is `draft`; naming it here keeps the decision visible at the
            // one place a product's initial visibility is chosen.
            status: input.status ?? 'draft',
          });

          await recordProductChange({
            storeId,
            actor,
            product: row,
            eventName: PRODUCT_EVENTS.created,
            auditAction: PRODUCT_AUDIT.created,
            /**
             * No price here any more. A product has none — its SKUs do, and a product is
             * created with none of them. The SKU's own `sku.created` entry records its price.
             */
            metadata: { status: row.status },
          });

          return row;
        });

        logger.info({ storeId, productId: created.id, status: created.status }, 'product_created');
        return created;
      } catch (err) {
        /**
         * The race the pre-check cannot cover: another request inserted the same slug between
         * the check and this insert. Translated to the same 409, so a client cannot tell which
         * path produced it.
         *
         * Any OTHER unique violation is rethrown untouched — reporting an unrelated constraint
         * failure as a slug conflict would hide a real bug.
         */
        if (uniqueViolationConstraint(err) === PRODUCT_SLUG_UNIQUE_CONSTRAINT) {
          logger.warn({ storeId }, 'product_create_slug_race');
          throw new ProductSlugTaken();
        }
        throw err;
      }
    },
    /**
     * Read a publicly visible product by slug.
     *
     * Every failure collapses to ONE `NotFound`. A nonexistent slug, a product belonging to
     * another store, a draft, an archived product, and a soft-deleted product are all
     * indistinguishable to an anonymous caller — same status, same code, same message.
     *
     * That is deliberate and it is the point of the increment. A distinct 403 for a draft
     * would confirm the product exists, so a competitor could enumerate an unreleased range
     * before launch by probing candidate slugs; a distinct 410 for an archived one would
     * reveal what a merchant had withdrawn. Neither is information a storefront visitor is
     * entitled to, and the cost of hiding it is nothing.
     *
     * The service does not filter. It asks the repository for a product the public may see and
     * translates absence — the visibility rule lives in the WHERE clause, so a draft is never
     * loaded into memory here at all.
     */
    async getPublicProduct(params: { storeId: string; slug: string }): Promise<ProductRecord> {
      const found = await repository.findPublicBySlug(params);

      if (!found) {
        /**
         * `info`, not `warn`. A 404 on a storefront is routine — a stale link, a crawler, a
         * customer editing a URL — and paging on it would train people to ignore the log.
         *
         * The slug IS logged, unlike an email on the auth paths. A slug is public by
         * construction: it appears in URLs, sitemaps, and search results, so recording it
         * discloses nothing while making "which links are broken" answerable.
         */
        logger.info({ storeId: params.storeId, slug: params.slug }, 'product_not_found');
        throw new NotFound('product');
      }

      return found;
    },
    /**
     * Publish a product: `draft` or `archived` becomes `active`.
     *
     * Archived products are restorable. Archiving is currently the only way to remove a product
     * from a storefront — there is no delete endpoint — so making it terminal would let one
     * mis-click destroy a listing with no recovery path in the API.
     */
    async publishProduct(params: {
      storeId: string;
      slug: string;
      actor: AuditActor;
    }): Promise<ProductRecord> {
      return transition(params, PRODUCT_TRANSITIONS.publish, {
        event: PRODUCT_EVENTS.published,
        audit: PRODUCT_AUDIT.published,
      });
    },

    /**
     * Archive a product: `active` becomes `archived`.
     *
     * A draft cannot be archived. It is already invisible to customers, so there is nothing to
     * withdraw, and supporting it would add a transition nothing has asked for.
     */
    async archiveProduct(params: {
      storeId: string;
      slug: string;
      actor: AuditActor;
    }): Promise<ProductRecord> {
      return transition(params, PRODUCT_TRANSITIONS.archive, {
        event: PRODUCT_EVENTS.archived,
        audit: PRODUCT_AUDIT.archived,
      });
    },
    /**
     * Read a product for a staff user, in any lifecycle status.
     *
     * Named for its audience rather than its predicate, so the call site says who may use it.
     * The storefront's counterpart is `getPublicProduct`, which filters on `active`; keeping
     * two methods means the visibility rule is chosen by picking a name, not by remembering to
     * pass a flag.
     *
     * Reuses `findBySlug` — already store-scoped and `deleted_at IS NULL`, with no status
     * filter — rather than adding a fourth near-identical query.
     *
     * A soft-deleted product and one belonging to another store are both simply absent from
     * that lookup, so they produce the same `NotFound` as a slug that never existed. The store
     * boundary is a tenant boundary: telling a staff user that a product exists in someone
     * else's catalogue would leak across it, and `NotFound`'s own contract is that ownership
     * belongs in the query rather than in a check afterwards.
     */
    async getProductForStaff(params: { storeId: string; slug: string }): Promise<ProductRecord> {
      const found = await repository.findBySlug(params);

      if (!found) {
        logger.info({ storeId: params.storeId, slug: params.slug }, 'product_not_found');
        throw new NotFound('product');
      }

      return found;
    },
    /**
     * List a store's products for a staff user, in any lifecycle status.
     *
     * Pagination bounds arrive already validated and defaulted by the DTO, so this method does
     * not re-clamp them: two places applying a ceiling is how they end up disagreeing. It
     * passes them through and returns them alongside the page, so the response states the
     * bounds that were actually used rather than the ones the client believes it sent.
     *
     * Visibility — this store, not soft-deleted, any status — belongs to the repository query
     * and is not duplicated here.
     */
    async getProductsForStaff(params: {
      storeId: string;
      limit: number;
      offset: number;
    }): Promise<{ items: ProductRecord[]; total: number; limit: number; offset: number }> {
      const { items, total } = await repository.listForStore(params);

      logger.info({ storeId: params.storeId, returned: items.length, total }, 'product_list_read');

      return { items, total, limit: params.limit, offset: params.offset };
    },
    /**
     * Update a product's editable data.
     *
     * Only the fields the caller supplied are written — an absent field is left untouched, which
     * is what makes this a PATCH rather than a replace. `status`, `slug`, and `storeId` are not
     * expressible in `EditableProductFields`, so they are preserved by construction rather than
     * by a check.
     *
     * A price is normalised through `Money` exactly as on create, so `19.9` and `19.9000` cannot
     * become two values that compare unequal as text.
     */
    async updateProduct(params: {
      storeId: string;
      slug: string;
      actor: AuditActor;
      input: UpdateProductRequest;
    }): Promise<ProductRecord> {
      const { storeId, slug, actor, input } = params;

      const fields: EditableProductFields = {};
      if (input.name !== undefined) fields.name = input.name;
      if (input.description !== undefined) fields.description = input.description;

      const changed = Object.keys(fields);

      const updated = await withTransaction(db, logger, async () => {
        const row = await repository.updateProductFields({
          storeId,
          slug,
          fields,
          at: new Date(),
        });

        if (!row) return undefined;

        await recordProductChange({
          storeId,
          actor,
          product: row,
          eventName: PRODUCT_EVENTS.updated,
          auditAction: PRODUCT_AUDIT.updated,
          // WHICH fields changed, so a handler can decide whether it cares — a name change
          // needs a search reindex, a description change may not.
          payloadExtra: { changedFields: changed },
          /**
           * The audit entry records the NEW values of the fields that changed, and only those.
           *
           * A full before/after diff would be more useful and needs a pre-read the update
           * itself does not perform; adding one would be a second query on every edit for a
           * capability nobody has asked for. The event carries the field names, the entry
           * carries what they became, and `updated_at` bounds when.
           */
          metadata: { changedFields: changed, ...fields },
        });

        return row;
      });

      if (!updated) {
        /**
         * Absent, in another store, or deleted — all the same 404. The update's own predicate
         * decided this; nothing is re-checked here, so there is no second place for the store
         * boundary to be got wrong.
         */
        logger.info({ storeId, slug }, 'product_not_found');
        throw new NotFound('product');
      }

      logger.info(
        { storeId, productId: updated.id, fields: Object.keys(fields) },
        'product_updated',
      );
      return updated;
    },
    /**
     * Soft-delete a product.
     *
     * A deleted product becomes indistinguishable from one that never existed — the same rule
     * every other catalogue read already follows, because all of them filter `deleted_at IS
     * NULL`. Nothing else has to change for that to hold; the row simply stops matching.
     *
     * **Deleting an already-deleted product is a 404, not a silent success.** That is the
     * catalogue's own convention rather than a fresh invention: a `GET` or `PATCH` on a deleted
     * product answers 404, so a `DELETE` answering 204 would contradict the very next request
     * about the same product. It deliberately differs from logout (§20), which is idempotent
     * because it must not disclose whether a session was still live — here there is no state to
     * hide from a caller who already holds the `staff` scope.
     *
     * The row is never physically removed. Order lines and invoices will reference products,
     * and a hard delete would either break those or force a cascade that rewrites history.
     */
    async deleteProduct(params: {
      storeId: string;
      slug: string;
      actor: AuditActor;
    }): Promise<void> {
      const deleted = await withTransaction(db, logger, async () => {
        const at = new Date();

        const row = await repository.softDeleteProduct({
          storeId: params.storeId,
          slug: params.slug,
          at,
        });

        if (!row) return undefined;

        /**
         * Cascade to the SKUs, in THIS transaction.
         *
         * Not a database `ON DELETE CASCADE`: products are soft-deleted, so there is no
         * `DELETE` for the database to cascade from — and the FK is `RESTRICT` precisely so a
         * hard delete cannot silently take sellable rows with it.
         *
         * It has to be the same transaction as the product's own deletion. A SKU left with
         * `is_active = true` and `deleted_at IS NULL` under a deleted product is a row that
         * looks sellable to every query reaching it by code rather than through its product —
         * including the SKU PATCH and DELETE endpoints, which look up by code alone.
         */
        const cascadedCodes = await repository.softDeleteSkusForProduct({
          storeId: params.storeId,
          productId: row.id,
          at,
        });

        /**
         * And on to the option grid, in the SAME transaction.
         *
         * Options and values outlive nothing here: a live option under a deleted product is
         * reachable by id through `PATCH /admin/options/:id`, exactly as a live SKU under a
         * deleted product was reachable by code before Increment 24 closed that gap.
         *
         * The delete guard is satisfied BY CONSTRUCTION rather than skipped: the SKUs were
         * soft-deleted two statements ago in this same transaction, so no live SKU remains to
         * block anything, and `refuseIfInUse` would find nothing if it ran. Ordering is
         * therefore load-bearing — options before SKUs would refuse the product's own deletion.
         *
         * `sku_option_value` rows are left ENTIRELY alone. They are the historical record of
         * what each SKU was, and every id in them still resolves because all three deletions
         * are soft.
         */
        const cascadedOptionNames = await repository.softDeleteOptionsForProduct({
          storeId: params.storeId,
          productId: row.id,
          at,
        });

        const cascadedValueCount = await repository.softDeleteValuesForProduct({
          storeId: params.storeId,
          productId: row.id,
          at,
        });

        /**
         * The audit entry that matters most in this module. A deletion removes a product from
         * every read path, so without an attributed record the only evidence left is a
         * `deleted_at` timestamp with no author.
         *
         * The slug is recorded in metadata because it is freed for reuse by the partial unique
         * index — so after a later product claims it, the resource id alone no longer tells an
         * auditor which listing this entry refers to. The cascaded SKU codes are recorded for
         * the same reason: their codes are freed too, so the trail must say what went with the
         * product rather than only that something did.
         */
        await recordProductChange({
          storeId: params.storeId,
          actor: params.actor,
          product: row,
          eventName: PRODUCT_EVENTS.deleted,
          auditAction: PRODUCT_AUDIT.deleted,
          payloadExtra: {
            cascadedSkuCount: cascadedCodes.length,
            cascadedOptionCount: cascadedOptionNames.length,
          },
          metadata: {
            slug: row.slug,
            name: row.name,
            statusAtDeletion: row.status,
            cascadedSkuCodes: cascadedCodes,
            /**
             * Option names, like the SKU codes beside them, are freed for reuse by the partial
             * unique indexes — so the trail must say what went with the product rather than
             * only that something did.
             */
            cascadedOptionNames,
            cascadedOptionValueCount: cascadedValueCount,
          },
        });

        return row;
      });

      if (!deleted) {
        /**
         * Absent, in another store, or already deleted — one 404 for all three. The update's own
         * predicate decided this, so there is no second place for the store boundary to be got
         * wrong.
         */
        logger.info({ storeId: params.storeId, slug: params.slug }, 'product_not_found');
        throw new NotFound('product');
      }

      logger.info(
        { storeId: params.storeId, productId: deleted.id, slug: deleted.slug },
        'product_deleted',
      );
    },
    /**
     * List published products for a storefront.
     *
     * Named for its audience beside `getProductsForStaff`, so a call site says who may use it.
     * Pagination bounds arrive validated and defaulted by the DTO and are passed through
     * unchanged; visibility belongs to the repository query and is not re-applied here.
     */
    async getPublicProducts(params: {
      storeId: string;
      limit: number;
      offset: number;
      /**
       * Optional storefront search term, already trimmed and length-checked by the DTO.
       *
       * Passed straight through. Escaping it for `LIKE` is the repository's job, because it is
       * a property of the query language rather than of the domain — a future caller reaching
       * the repository from a CLI command inherits it for free.
       */
      search?: string;
      /**
       * Optional INCLUSIVE price bounds, already validated by the DTO: non-negative decimal
       * strings of at most 4 places, and `priceMin <= priceMax` where both are present.
       *
       * Passed straight through, like `search`. There is no domain rule to apply — the store's
       * currency is implicit in the request, so a bound needs no conversion, and deliberately
       * NOT run through `money()`: that would need a currency and could raise a 500 for one
       * this build does not know. Comparing a decimal string against `numeric(19,4)` is the
       * repository's business.
       */
      priceMin?: string;
      priceMax?: string;
    }): Promise<{ items: ProductRecord[]; total: number; limit: number; offset: number }> {
      const { items, total } = await repository.listPublicForStore(params);

      logger.info(
        {
          storeId: params.storeId,
          returned: items.length,
          total,
          // Logged because a storefront's search terms are the most useful signal it produces —
          // what customers looked for and did not find. It is user input, not a credential.
          ...(params.search === undefined ? {} : { search: params.search }),
          // Same reasoning: which price bands shoppers filter to, and which come back empty,
          // is merchandising signal. Neither bound is sensitive.
          ...(params.priceMin === undefined ? {} : { priceMin: params.priceMin }),
          ...(params.priceMax === undefined ? {} : { priceMax: params.priceMax }),
        },
        'public_product_list_read',
      );

      return { items, total, limit: params.limit, offset: params.offset };
    },

    /* ── SKUs ──────────────────────────────────────────────────────────────── */

    /**
     * Create a SKU under a product.
     *
     * The parent is resolved by SLUG within the authenticated store — never by an id from the
     * request. That is what makes it impossible to attach a SKU to another merchant's product
     * or to a deleted one: `findProductRefBySlug` carries both predicates, and the store id
     * written onto the SKU comes from the PRODUCT ROW rather than from the caller's argument,
     * so the two cannot disagree even if a future caller passes the wrong one.
     */
    async createSku(params: {
      storeId: string;
      productSlug: string;
      currency: string;
      actor: AuditActor;
      input: CreateSkuRequest;
    }): Promise<SkuRecord> {
      const { storeId, productSlug, actor, input } = params;

      /**
       * Normalise the price through `Money` rather than trusting the validated string.
       *
       * Zod proved the SHAPE — digits, at most four decimal places. `money()` proves it is a
       * real decimal and `toDb()` renders it at the column's scale, so `19.9` and `19.9000`
       * become one canonical value instead of two rows that compare unequal as text.
       *
       * A store configured with a currency this build does not know is an operator error, not
       * a client error, so it surfaces as an `InvariantViolation` (500) rather than a 400.
       */
      const price = toDb(money(input.price, requireCurrency(storeId, params.currency)));

      const parent = await repository.findProductRefBySlug({ storeId, slug: productSlug });
      if (!parent) {
        /**
         * Absent, another store's, or deleted — one 404 for all three, matching every other
         * product lookup in this module (§25). A distinct "product is deleted" would tell a
         * caller which slugs had once existed.
         */
        logger.info({ storeId, slug: productSlug }, 'sku_create_product_not_found');
        throw new NotFound('product');
      }

      /**
       * Pre-check for a friendly error. NOT the enforcement mechanism — two concurrent creates
       * of the same code both reach this point and both see nothing, so the partial unique
       * index is what actually decides. The catch below covers the race.
       */
      const existing = await repository.findSkuByCode({ storeId, code: input.code });
      if (existing) {
        logger.info({ storeId }, 'sku_create_rejected_code_taken');
        throw new SkuCodeTaken();
      }

      try {
        return await withTransaction(db, logger, async () => {
          const row = await repository.insertSku({
            id: newId(),
            // From the PRODUCT row, not the caller's argument.
            storeId: parent.storeId,
            productId: parent.id,
            code: input.code,
            name: input.name ?? '',
            price,
            // The column default is `true`; naming it here keeps the decision visible at the
            // one place a SKU's initial sellability is chosen.
            isActive: input.isActive ?? true,
          });

          await recordSkuChange({
            storeId,
            actor,
            sku: row,
            eventName: SKU_EVENTS.created,
            auditAction: SKU_AUDIT.created,
            metadata: { price: row.price, isActive: row.isActive, productSlug },
          });

          return row;
        });
      } catch (err) {
        /**
         * The race the pre-check cannot cover. Translated to the same 409 so a client cannot
         * tell which path produced it. Any OTHER unique violation is rethrown untouched —
         * reporting an unrelated constraint failure as a code conflict would hide a real bug.
         */
        if (uniqueViolationConstraint(err) === SKU_CODE_UNIQUE_CONSTRAINT) {
          logger.warn({ storeId }, 'sku_create_code_race');
          throw new SkuCodeTaken();
        }
        throw err;
      }
    },

    /**
     * List a product's SKUs for staff — active and inactive alike.
     *
     * Resolves the product first so an unknown slug is a 404 rather than an empty list: those
     * mean different things to a merchant, and an empty array for a mistyped slug is the kind
     * of answer that sends someone looking for missing data.
     */
    async getSkusForStaff(params: { storeId: string; productSlug: string }): Promise<SkuRecord[]> {
      const parent = await repository.findProductRefBySlug({
        storeId: params.storeId,
        slug: params.productSlug,
      });

      if (!parent) {
        logger.info({ storeId: params.storeId, slug: params.productSlug }, 'product_not_found');
        throw new NotFound('product');
      }

      return repository.listSkusForProduct({
        storeId: params.storeId,
        productId: parent.id,
      });
    },

    /**
     * Update a SKU's editable fields.
     *
     * Looked up by `(storeId, code)`. The code identifies a SKU within a store because of the
     * partial unique index, so the product slug is not needed — and requiring it would let a
     * caller pass a mismatched pair whose behaviour would then have to be defined.
     */
    async updateSku(params: {
      storeId: string;
      code: string;
      currency: string;
      actor: AuditActor;
      input: UpdateSkuRequest;
    }): Promise<SkuRecord> {
      const { storeId, code, actor, input } = params;

      const fields: EditableSkuFields = {};
      if (input.name !== undefined) fields.name = input.name;
      if (input.isActive !== undefined) fields.isActive = input.isActive;
      if (input.price !== undefined) {
        fields.price = toDb(money(input.price, requireCurrency(storeId, params.currency)));
      }

      const changed = Object.keys(fields);

      const updated = await withTransaction(db, logger, async () => {
        const row = await repository.updateSkuFields({
          storeId,
          code,
          fields,
          at: new Date(),
        });

        if (!row) return undefined;

        await recordSkuChange({
          storeId,
          actor,
          sku: row,
          eventName: SKU_EVENTS.updated,
          auditAction: SKU_AUDIT.updated,
          payloadExtra: { changedFields: changed },
          metadata: { changedFields: changed, ...fields },
        });

        /**
         * Two extra audit entries, when they apply.
         *
         * A price change moves money and an activation change decides whether the thing can
         * be sold at all — the two SKU edits an auditor searches for by name. Recording them
         * only inside `sku.updated`'s metadata would mean finding them required a metadata
         * query, which is what a vocabulary exists to avoid. Both are in the same transaction
         * as the write, so a rollback takes all three with it.
         */
        if (fields.price !== undefined) {
          await audit.record({
            action: SKU_AUDIT.priceChanged,
            actor,
            resourceType: SKU_RESOURCE,
            resourceId: row.id,
            storeId,
            metadata: { code: row.code, price: row.price },
          });
        }

        if (fields.isActive !== undefined) {
          await audit.record({
            action: SKU_AUDIT.activationChanged,
            actor,
            resourceType: SKU_RESOURCE,
            resourceId: row.id,
            storeId,
            metadata: { code: row.code, isActive: row.isActive },
          });
        }

        return row;
      });

      if (!updated) {
        // Absent, another store's, or already deleted — one 404, decided by the update's own
        // predicate. There is no second place for the store boundary to be got wrong.
        logger.info({ storeId, code }, 'sku_not_found');
        throw new NotFound('sku');
      }

      logger.info({ storeId, skuId: updated.id, fields: changed }, 'sku_updated');
      return updated;
    },

    /**
     * Soft-delete a SKU.
     *
     * Deleting an already-deleted SKU is a 404, matching `deleteProduct` — a `GET` or `PATCH`
     * on a deleted SKU answers 404, so a `DELETE` answering 204 would contradict the very next
     * request about the same code.
     *
     * The row is never removed. Order lines will reference SKUs, and a hard delete would
     * either break those or force a cascade that rewrites history. Deleting frees the code for
     * reuse through the partial unique index.
     */
    async deleteSku(params: { storeId: string; code: string; actor: AuditActor }): Promise<void> {
      const deleted = await withTransaction(db, logger, async () => {
        const row = await repository.softDeleteSku({
          storeId: params.storeId,
          code: params.code,
          at: new Date(),
        });

        if (!row) return undefined;

        await recordSkuChange({
          storeId: params.storeId,
          actor: params.actor,
          sku: row,
          eventName: SKU_EVENTS.deleted,
          auditAction: SKU_AUDIT.deleted,
          // The code is freed for reuse, so the id alone will not identify this SKU to an
          // auditor once another claims the code.
          metadata: { code: row.code, price: row.price, name: row.name },
        });

        return row;
      });

      if (!deleted) {
        logger.info({ storeId: params.storeId, code: params.code }, 'sku_not_found');
        throw new NotFound('sku');
      }

      logger.info({ storeId: params.storeId, skuId: deleted.id }, 'sku_deleted');
    },

    /**
     * SKUs for a set of products, batched.
     *
     * The list endpoints' loader: one query for the whole page rather than one per product.
     * `activeOnly` picks the audience — a storefront must never see an inactive SKU, while the
     * admin view shows everything a merchant manages.
     */
    async getSkusForProducts(params: {
      storeId: string;
      productIds: readonly string[];
      activeOnly: boolean;
    }): Promise<SkuRecord[]> {
      return repository.listSkusForProducts(params);
    },

    /**
     * Combination rows for many SKUs, in one query.
     *
     * The batch loader every response path uses. A pass-through like `getSkusForProducts`:
     * there is no business rule here, and the repository query already carries the store scope
     * and the defence-in-depth filters on deleted options and values.
     */
    async getOptionsForSkus(params: {
      storeId: string;
      skuIds: readonly string[];
    }): Promise<SkuOptionRecord[]> {
      return repository.listSkuOptionsForSkus(params);
    },

    /* ── Options ─────────────────────────────────────────────────────────── */

    /**
     * Create an option on a product.
     *
     * `storeId` and `productId` come from the resolved PRODUCT row, never from the request —
     * the same rule `createSku` follows, and what guarantees the option lands in the product's
     * own store however the caller addressed it.
     */
    async createOption(params: {
      storeId: string;
      productSlug: string;
      actor: AuditActor;
      input: CreateOptionRequest;
    }): Promise<OptionRecord> {
      const { storeId, productSlug, actor, input } = params;

      const parent = await repository.findProductRefBySlug({ storeId, slug: productSlug });
      if (!parent) {
        logger.info({ storeId, slug: productSlug }, 'option_create_product_not_found');
        throw new NotFound('product');
      }

      /**
       * The grid-size cap. Operational hygiene, not a merchandising rule — it exists so an
       * absurd request is a clean 400 rather than a signature long enough to threaten the
       * B-tree entry limit that `uq_sku_combination` depends on.
       *
       * A 400 rather than a 409: the request itself is unacceptable, not in conflict with
       * another resource. Racing past it is harmless — the cap is a guard rail, and the two
       * requests that both squeeze in leave the product one option over a hygiene limit rather
       * than in an invalid state.
       */
      const existing = await repository.countOptionsForProduct({ storeId, productId: parent.id });
      if (existing >= MAX_OPTIONS_PER_PRODUCT) {
        logger.info({ storeId, productId: parent.id }, 'option_create_rejected_limit');
        throw new ValidationError({
          name: [`a product may have at most ${String(MAX_OPTIONS_PER_PRODUCT)} options`],
        });
      }

      try {
        return await withTransaction(db, logger, async () => {
          const row = await repository.insertOption({
            id: newId(),
            // From the PRODUCT row, not the caller's argument.
            storeId: parent.storeId,
            productId: parent.id,
            name: input.name,
            sortOrder: input.sortOrder ?? 0,
          });

          await recordOptionChange({
            storeId,
            actor,
            option: row,
            eventName: OPTION_EVENTS.created,
            auditAction: OPTION_AUDIT.created,
            metadata: { name: row.name, productSlug },
          });

          return row;
        });
      } catch (err) {
        /**
         * `lower(name)` in the index is the enforcement, so this catch covers both the race
         * and the plain duplicate — there is no pre-check to reach first. Only THIS constraint
         * is translated; any other unique violation is rethrown untouched, because reporting a
         * different constraint failure as a name clash would hide a real bug.
         */
        if (uniqueViolationConstraint(err) === OPTION_NAME_UNIQUE_CONSTRAINT) {
          logger.info({ storeId }, 'option_create_rejected_name_taken');
          throw new OptionNameTaken();
        }
        throw err;
      }
    },

    /**
     * A product's options with their values, for staff.
     *
     * Resolves the product first so an unknown slug is a 404 rather than an empty list — the
     * same judgement `getSkusForStaff` makes, because those mean different things to a
     * merchant. Values are batch-loaded for every option in one `inArray`.
     */
    async getOptionsForStaff(params: { storeId: string; productSlug: string }): Promise<{
      options: OptionRecord[];
      values: OptionValueRecord[];
    }> {
      const parent = await repository.findProductRefBySlug({
        storeId: params.storeId,
        slug: params.productSlug,
      });
      if (!parent) {
        logger.info({ storeId: params.storeId, slug: params.productSlug }, 'product_not_found');
        throw new NotFound('product');
      }

      const options = await repository.listOptionsForProduct({
        storeId: params.storeId,
        productId: parent.id,
      });

      const values = await repository.listValuesForOptions({
        storeId: params.storeId,
        optionIds: options.map((o) => o.id),
      });

      return { options, values };
    },

    async updateOption(params: {
      storeId: string;
      id: string;
      actor: AuditActor;
      input: UpdateOptionRequest;
    }): Promise<OptionRecord> {
      const { storeId, id, actor, input } = params;

      const fields: EditableOptionFields = {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      };

      try {
        const updated = await withTransaction(db, logger, async () => {
          const row = await repository.updateOptionFields({
            storeId,
            id,
            fields,
            at: new Date(),
          });

          if (!row) return undefined;

          await recordOptionChange({
            storeId,
            actor,
            option: row,
            eventName: OPTION_EVENTS.updated,
            auditAction: OPTION_AUDIT.updated,
            metadata: { changed: Object.keys(fields), name: row.name },
          });

          return row;
        });

        if (!updated) {
          logger.info({ storeId, optionId: id }, 'option_not_found');
          throw new NotFound('option');
        }

        return updated;
      } catch (err) {
        if (uniqueViolationConstraint(err) === OPTION_NAME_UNIQUE_CONSTRAINT) {
          logger.info({ storeId }, 'option_update_rejected_name_taken');
          throw new OptionNameTaken();
        }
        throw err;
      }
    },

    /**
     * Retire an option and its values.
     *
     * Refused while a live SKU uses any of its values — decision A. The guard runs INSIDE the
     * transaction, so it cannot be raced by a combination replacement that attaches one of
     * these values a moment later: that replacement's own inserts would have to serialise
     * against this transaction's updates to the same value rows.
     */
    async deleteOption(params: { storeId: string; id: string; actor: AuditActor }): Promise<void> {
      const { storeId, id, actor } = params;

      const deleted = await withTransaction(db, logger, async () => {
        const at = new Date();

        const blocking = await repository.liveSkuCodesUsingOption({ storeId, optionId: id });
        await refuseIfInUse(storeId, blocking);

        const row = await repository.softDeleteOption({ storeId, id, at });
        if (!row) return undefined;

        /**
         * Cascade to the option's values, in THIS transaction. An option with no live values
         * and live values with no option are both incoherent states; the only way neither
         * occurs is for both writes to share a transaction.
         */
        const cascadedValues = await repository.softDeleteValuesForOption({
          storeId,
          optionId: id,
          at,
        });

        await recordOptionChange({
          storeId,
          actor,
          option: row,
          eventName: OPTION_EVENTS.deleted,
          auditAction: OPTION_AUDIT.deleted,
          /**
           * The name and the cascaded values are recorded because deleting frees them for
           * reuse through the partial unique indexes — so once a later option claims the name,
           * the resource id alone no longer tells an auditor which option this entry meant.
           * The same reasoning as `cascadedSkuCodes` on a product deletion.
           */
          metadata: { name: row.name, cascadedValues },
        });

        return row;
      });

      if (!deleted) {
        logger.info({ storeId, optionId: id }, 'option_not_found');
        throw new NotFound('option');
      }

      logger.info({ storeId, optionId: id }, 'option_deleted');
    },

    /* ── Option values ───────────────────────────────────────────────────── */

    /**
     * Add a value to an option.
     *
     * `productId` is copied from the OPTION row, never from the request. That is what closes
     * `fk_pov_option_product`: a value whose product disagreed with its option's would be
     * rejected by the database, and taking it from the row means the application can never
     * even construct such a row.
     */
    async createOptionValue(params: {
      storeId: string;
      optionId: string;
      actor: AuditActor;
      input: CreateOptionValueRequest;
    }): Promise<OptionValueRecord> {
      const { storeId, optionId, actor, input } = params;

      const option = await requireOption(storeId, optionId);

      const existing = await repository.countValuesForOption({ storeId, optionId });
      if (existing >= MAX_VALUES_PER_OPTION) {
        logger.info({ storeId, optionId }, 'option_value_create_rejected_limit');
        throw new ValidationError({
          value: [`an option may have at most ${String(MAX_VALUES_PER_OPTION)} values`],
        });
      }

      try {
        return await withTransaction(db, logger, async () => {
          const row = await repository.insertOptionValue({
            id: newId(),
            storeId,
            optionId: option.id,
            // From the OPTION row. Half of `fk_pov_option_product`.
            productId: option.productId,
            value: input.value,
            sortOrder: input.sortOrder ?? 0,
          });

          await recordOptionValueChange({
            storeId,
            actor,
            value: row,
            eventName: OPTION_VALUE_EVENTS.created,
            auditAction: OPTION_VALUE_AUDIT.created,
            metadata: { value: row.value, optionName: option.name },
          });

          return row;
        });
      } catch (err) {
        if (uniqueViolationConstraint(err) === OPTION_VALUE_UNIQUE_CONSTRAINT) {
          logger.info({ storeId, optionId }, 'option_value_create_rejected_taken');
          throw new OptionValueTaken();
        }
        throw err;
      }
    },

    async updateOptionValue(params: {
      storeId: string;
      id: string;
      actor: AuditActor;
      input: UpdateOptionValueRequest;
    }): Promise<OptionValueRecord> {
      const { storeId, id, actor, input } = params;

      const fields: EditableOptionValueFields = {
        ...(input.value === undefined ? {} : { value: input.value }),
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      };

      try {
        const updated = await withTransaction(db, logger, async () => {
          const row = await repository.updateOptionValueFields({
            storeId,
            id,
            fields,
            at: new Date(),
          });

          if (!row) return undefined;

          /**
           * Renaming a value does NOT change any SKU's signature, and that is the point of
           * building the signature from ids rather than names: a merchant fixing a typo in
           * "Rde" must not silently redefine which variant every SKU using it represents, nor
           * make two SKUs suddenly collide.
           */
          await recordOptionValueChange({
            storeId,
            actor,
            value: row,
            eventName: OPTION_VALUE_EVENTS.updated,
            auditAction: OPTION_VALUE_AUDIT.updated,
            metadata: { changed: Object.keys(fields), value: row.value },
          });

          return row;
        });

        if (!updated) {
          logger.info({ storeId, optionValueId: id }, 'option_value_not_found');
          throw new NotFound('option value');
        }

        return updated;
      } catch (err) {
        if (uniqueViolationConstraint(err) === OPTION_VALUE_UNIQUE_CONSTRAINT) {
          logger.info({ storeId }, 'option_value_update_rejected_taken');
          throw new OptionValueTaken();
        }
        throw err;
      }
    },

    /** Retire one value. Refused while a live SKU uses it — decision A. */
    async deleteOptionValue(params: {
      storeId: string;
      id: string;
      actor: AuditActor;
    }): Promise<void> {
      const { storeId, id, actor } = params;

      const deleted = await withTransaction(db, logger, async () => {
        const blocking = await repository.liveSkuCodesUsingValues({
          storeId,
          optionValueIds: [id],
        });
        await refuseIfInUse(storeId, blocking);

        const row = await repository.softDeleteOptionValue({ storeId, id, at: new Date() });
        if (!row) return undefined;

        await recordOptionValueChange({
          storeId,
          actor,
          value: row,
          eventName: OPTION_VALUE_EVENTS.deleted,
          auditAction: OPTION_VALUE_AUDIT.deleted,
          metadata: { value: row.value },
        });

        return row;
      });

      if (!deleted) {
        logger.info({ storeId, optionValueId: id }, 'option_value_not_found');
        throw new NotFound('option value');
      }

      logger.info({ storeId, optionValueId: id }, 'option_value_deleted');
    },

    /* ── SKU combinations ────────────────────────────────────────────────── */

    /**
     * Replace a SKU's whole option combination.
     *
     * **The heart of the increment.** Everything that could leave `sku_option_value` and
     * `sku.option_signature` disagreeing happens inside ONE transaction: the superseded rows
     * are removed, the new ones inserted, and the signature recomputed and written. A rollback
     * discards all three, so the forbidden state is not reachable by a crash, a concurrent
     * write, or a rejected statement.
     *
     * The unique-violation catch is OUTSIDE that transaction, per the established rule: a
     * failed statement poisons the surrounding transaction, so the rollback must complete
     * before the error is translated.
     */
    async replaceSkuOptions(params: {
      storeId: string;
      code: string;
      actor: AuditActor;
      input: ReplaceSkuOptionsRequest;
    }): Promise<SkuRecord> {
      const { storeId, code, actor, input } = params;

      const target = await repository.findSkuByCode({ storeId, code });
      if (!target) {
        logger.info({ storeId, code }, 'sku_options_sku_not_found');
        throw new NotFound('sku');
      }

      /**
       * Resolve every id against this SKU's own product, store-scoped, live on both the value
       * and its option.
       *
       * The count check is what turns "unknown id", "another product's value", "another
       * store's value", "deleted value" and "value of a deleted option" into ONE rejection.
       * They are deliberately indistinguishable: telling a caller that an id exists but
       * belongs elsewhere would confirm the existence of another merchant's data.
       *
       * A 400 rather than a 404 — the SKU was found, so the request is not about a missing
       * resource; it carries a value the SKU cannot have.
       */
      const resolved = await repository.findSelectableOptionValues({
        storeId,
        productId: target.productId,
        ids: input.optionValueIds,
      });

      if (resolved.length !== input.optionValueIds.length) {
        const found = new Set(resolved.map((r) => r.id));
        const missing = input.optionValueIds.filter((id) => !found.has(id));
        logger.info({ storeId, code, missingCount: missing.length }, 'sku_options_invalid_values');
        throw new ValidationError({
          optionValueIds: missing.map(
            (id) => `${id} is not a selectable option value of this product`,
          ),
        });
      }

      /**
       * Two values of one option, caught before the database.
       *
       * `uq_sov_sku_option` is the real enforcement and would reject this anyway — this is the
       * friendly 409, and it is a 409 rather than a 400 because the request is well-formed and
       * every id in it is valid; what conflicts is the combination they describe.
       */
      const byOption = new Set(resolved.map((r) => r.optionId));
      if (byOption.size !== resolved.length) {
        logger.info({ storeId, code }, 'sku_options_rejected_duplicate_option');
        throw new SkuOptionConflict();
      }

      const signature = buildOptionSignature(resolved.map((r) => r.id));
      const before = await repository.listSkuOptionsForSkus({ storeId, skuIds: [target.id] });

      try {
        return await withTransaction(db, logger, async () => {
          const at = new Date();

          /**
           * Hard delete, then insert. `uq_sov_sku_option` rejects the new value of an option
           * while the superseded row exists, and the junction table has no `deleted_at` — see
           * its schema comment for why giving it one would make the current combination a
           * query rather than a fact. The before/after in the event below is the history.
           */
          await repository.clearSkuOptionValues({ storeId, skuId: target.id });

          await repository.insertSkuOptionValues(
            resolved.map((value) => ({
              skuId: target.id,
              optionValueId: value.id,
              optionId: value.optionId,
              // Both from resolved rows, so the composite keys cannot be given a false product.
              productId: target.productId,
              storeId,
            })),
          );

          /**
           * The signature, in the SAME transaction. `uq_sku_combination` fires HERE, which is
           * what makes the database the concurrency arbiter: two requests building the same
           * combination both reach this statement and exactly one survives.
           */
          await repository.updateSkuSignature({
            storeId,
            skuId: target.id,
            signature,
            at,
          });

          const row = await repository.findSkuByCode({ storeId, code });
          if (!row) {
            // Unreachable: the SKU was found above and this transaction only updated it.
            throw new Error(`sku ${code} vanished during combination replacement`);
          }

          const beforeCombination = before.map((r) => ({
            optionName: r.optionName,
            value: r.value,
          }));
          const afterCombination = resolved.map((r) => ({ optionValueId: r.id, value: r.value }));

          await recordSkuChange({
            storeId,
            actor,
            sku: row,
            eventName: SKU_OPTIONS_EVENT,
            auditAction: SKU_OPTIONS_AUDIT,
            /**
             * The before and after, in both the event and the audit metadata.
             *
             * Required rather than decorative: replacement hard-deletes the superseded junction
             * rows, so this is the ONLY surviving record that the SKU was ever Red.
             */
            payloadExtra: {
              optionSignature: signature,
              optionValueIds: resolved.map((r) => r.id),
            },
            metadata: { before: beforeCombination, after: afterCombination },
          });

          return row;
        });
      } catch (err) {
        /**
         * ONLY the combination index is translated. A different unique violation — a SKU code,
         * an option name, `uq_sov_sku_option` catching a duplicate the pre-check somehow
         * missed — is rethrown untouched, because telling a client their variant is a duplicate
         * when the real failure was something else sends them looking for a clash that does not
         * exist.
         */
        if (uniqueViolationConstraint(err) === SKU_COMBINATION_UNIQUE_CONSTRAINT) {
          logger.warn({ storeId, code }, 'sku_options_combination_race');
          throw new SkuCombinationTaken();
        }
        throw err;
      }
    },
  };
}
