import { and, count, desc, eq, exists, gte, ilike, inArray, isNull, lte } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import {
  product,
  productOption,
  productOptionValue,
  sku,
  skuOptionValue,
} from '../../db/schema/catalogue.js';
import { executor, type Executor } from '../../db/transaction.js';

/**
 * Catalogue data access.
 *
 * Imports `product` from its schema module directly rather than through
 * `db/schema/index.ts`, per that barrel's own rule: it exists for drizzle-kit and the test
 * truncate helper, not as a general dependency. `dependency-cruiser` enforces that only
 * `*.repository.ts` may reach a table at all.
 *
 * **Every query here is scoped by `storeId`, in the WHERE clause.** Not by a check the
 * caller performs afterwards, and not by trusting that middleware got it right — the scope
 * is part of the query, so a future caller arriving from a CLI command or a background job
 * inherits the same isolation. `product` is tenant-owned, and a query that forgets the
 * scope returns another merchant's catalogue.
 */

/**
 * Re-exported so the rest of the module can name a status without importing a table.
 *
 * The list lives in the schema because the database CHECK constraint is its real enforcement
 * point, and `schema-only-in-repositories` means this file is the only one permitted to see it.
 * Re-exporting keeps one source of truth rather than a second copy in the DTO that could
 * silently drift from the constraint.
 */
export { PRODUCT_STATUSES, type ProductStatus } from '../../db/schema/catalogue.js';

/**
 * The product columns an edit may write, and the complete list of them.
 *
 * Deliberately NOT `Partial<InsertProductValues>`: that would admit `storeId`, `slug`, and
 * `status`, turning a compile-time guarantee into a runtime hope. Widening this type is the
 * only way to make another column editable, which is exactly the friction that decision
 * deserves.
 */
export type EditableProductFields = {
  name?: string;
  description?: string;
};

export type CatalogueRepository = ReturnType<typeof createCatalogueRepository>;

export type InsertProductValues = {
  id: string;
  storeId: string;
  slug: string;
  name: string;
  description: string;
  status: string;
};

/**
 * A product row as the rest of the system sees it.
 *
 * `storeId` and `deletedAt` are deliberately absent. Tenancy is an invariant of the query,
 * not a field for a caller to inspect and re-check, and echoing it back to a client would
 * publish an internal identifier that no consumer has any use for.
 */
export type ProductRecord = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

const RECORD_COLUMNS = {
  id: product.id,
  slug: product.slug,
  name: product.name,
  description: product.description,
  status: product.status,
  createdAt: product.createdAt,
  updatedAt: product.updatedAt,
} as const;

/* ── SKUs ────────────────────────────────────────────────────────────────── */

/**
 * The SKU columns an edit may write, and the complete list of them.
 *
 * Same discipline as `EditableProductFields`: NOT `Partial<InsertSkuValues>`, which would
 * admit `storeId`, `productId` and `code` and turn a compile-time guarantee into a runtime
 * hope. Widening this type is the only way to make another column editable.
 *
 * `code` is absent on purpose. It is the merchant's identifier for the thing, carried on
 * purchase orders and packing slips; renaming it in place would silently repoint whatever
 * already references it. A rename is a delete plus a create, which the partial unique index
 * already makes possible.
 */
export type EditableSkuFields = {
  name?: string;
  /** Already normalised to the column scale by the service. */
  price?: string;
  isActive?: boolean;
};

export type InsertSkuValues = {
  id: string;
  storeId: string;
  productId: string;
  code: string;
  name: string;
  /** Already normalised to the column's scale by the service. */
  price: string;
  isActive: boolean;
};

/**
 * A SKU row as the rest of the system sees it.
 *
 * `storeId` and `deletedAt` are absent for the same reasons they are absent from
 * `ProductRecord`. `productId` IS included: unlike the store, it is a relationship a client
 * legitimately needs in order to group SKUs under their product.
 */
export type SkuRecord = {
  readonly id: string;
  readonly productId: string;
  readonly code: string;
  readonly name: string;
  readonly price: string;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

const SKU_COLUMNS = {
  id: sku.id,
  productId: sku.productId,
  code: sku.code,
  name: sku.name,
  price: sku.price,
  isActive: sku.isActive,
  createdAt: sku.createdAt,
  updatedAt: sku.updatedAt,
} as const;

/** The partial unique index on `(store_id, code) WHERE deleted_at IS NULL`. */
export const SKU_CODE_UNIQUE_CONSTRAINT = 'uq_sku_code_active';

/* ── Options ─────────────────────────────────────────────────────────────── */

/**
 * The option columns an edit may write.
 *
 * Same discipline as `EditableSkuFields`: NOT a `Partial<Insert…>`, which would admit
 * `storeId` and `productId` and let an edit move an option to another product or store.
 */
export type EditableOptionFields = {
  name?: string;
  sortOrder?: number;
};

export type EditableOptionValueFields = {
  value?: string;
  sortOrder?: number;
};

export type InsertOptionValues = {
  id: string;
  storeId: string;
  productId: string;
  name: string;
  sortOrder: number;
};

export type InsertOptionValueValues = {
  id: string;
  storeId: string;
  optionId: string;
  /** Copied from the OPTION row, never from a request — half of `fk_pov_option_product`. */
  productId: string;
  value: string;
  sortOrder: number;
};

/** One row of a SKU's combination. All five ids come from resolved rows, never from a body. */
export type InsertSkuOptionValueValues = {
  skuId: string;
  optionValueId: string;
  optionId: string;
  productId: string;
  storeId: string;
};

/**
 * An option as the rest of the system sees it.
 *
 * `storeId` and `deletedAt` are absent for the same reasons they are absent from
 * `ProductRecord`. `productId` IS present: a caller legitimately needs to know which product
 * an option belongs to, and the service needs it to copy onto the option's values.
 */
export type OptionRecord = {
  readonly id: string;
  readonly productId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type OptionValueRecord = {
  readonly id: string;
  readonly optionId: string;
  readonly value: string;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** The minimum a combination replacement needs about a value it is about to attach. */
export type SelectableOptionValue = {
  readonly id: string;
  readonly optionId: string;
  readonly value: string;
};

/** One (SKU, option, value) triple, flattened for the response mapper. */
export type SkuOptionRecord = {
  readonly skuId: string;
  readonly optionId: string;
  readonly optionName: string;
  readonly optionSortOrder: number;
  readonly valueId: string;
  readonly value: string;
  readonly valueSortOrder: number;
};

const OPTION_COLUMNS = {
  id: productOption.id,
  productId: productOption.productId,
  name: productOption.name,
  sortOrder: productOption.sortOrder,
  createdAt: productOption.createdAt,
  updatedAt: productOption.updatedAt,
} as const;

const OPTION_VALUE_COLUMNS = {
  id: productOptionValue.id,
  optionId: productOptionValue.optionId,
  value: productOptionValue.value,
  sortOrder: productOptionValue.sortOrder,
  createdAt: productOptionValue.createdAt,
  updatedAt: productOptionValue.updatedAt,
} as const;

/** The partial unique index on `(product_id, lower(name)) WHERE deleted_at IS NULL`. */
export const OPTION_NAME_UNIQUE_CONSTRAINT = 'uq_product_option_name_active';

/** The partial unique index on `(option_id, lower(value)) WHERE deleted_at IS NULL`. */
export const OPTION_VALUE_UNIQUE_CONSTRAINT = 'uq_product_option_value_active';

/**
 * The unique index that arbitrates duplicate combinations:
 * `(product_id, option_signature) WHERE option_signature <> '' AND deleted_at IS NULL`.
 *
 * Named here so the service can translate EXACTLY this violation to a combination conflict.
 * Comparing against the name rather than merely catching SQLSTATE 23505 is what stops an
 * unrelated constraint failure — a duplicate option name, a duplicate SKU code — from being
 * reported to a client as a duplicate variant.
 */
export const SKU_COMBINATION_UNIQUE_CONSTRAINT = 'uq_sku_combination';

/** One value per option per SKU. */
export const SKU_OPTION_UNIQUE_CONSTRAINT = 'uq_sov_sku_option';

/**
 * The only status a storefront may see.
 *
 * Named rather than inlined so the public visibility rule appears exactly once. A second
 * literal in a later read method is how two endpoints end up disagreeing about what
 * published means.
 */
export const PUBLIC_PRODUCT_STATUS = 'active';

/** The partial unique index on `(store_id, slug) WHERE deleted_at IS NULL`. */
export const PRODUCT_SLUG_UNIQUE_CONSTRAINT = 'uq_product_slug_active';

/**
 * "This product has a sellable SKU" — as a correlated `EXISTS`, never a join.
 *
 * ## Why EXISTS is not a style preference
 *
 * A product has 0..n SKUs. Joining them into the product query multiplies the product row by
 * the number of matching SKUs, which corrupts three things at once: the page repeats the
 * product, `pagination.total` counts SKUs instead of products, and pagination stops being
 * deterministic because `LIMIT` now slices SKU rows.
 *
 * Measured against real data during the design review: a price band matching two SKUs on each
 * of three products returned **6 rows** through a join and **3** through `EXISTS`. Adding a
 * `DISTINCT` would paper over the page but not the `COUNT`, and would need a second, divergent
 * predicate — the exact failure §28 built the single shared predicate to prevent.
 *
 * `EXISTS` stays a single boolean expression, so the page query and the `COUNT` continue to
 * use the identical `visible` predicate they always have.
 *
 * ## Why `store_id` appears in the subquery
 *
 * It is implied by `product_id` — a SKU's store always matches its product's. It is stated
 * anyway because every predicate in this file carries its own scope, so a reader never has to
 * trace tenancy through a relationship to be sure of it, and a future change to the join
 * condition cannot silently widen it.
 *
 * @param extra Additional per-SKU conditions, e.g. a price band. Absent means "any sellable
 *              SKU", which is the visibility test.
 */
function hasSellableSku(ex: Executor, storeId: string, extra?: ReturnType<typeof and>) {
  return exists(
    ex
      .select({ one: sku.id })
      .from(sku)
      .where(
        and(
          eq(sku.productId, product.id),
          eq(sku.storeId, storeId),
          eq(sku.isActive, true),
          isNull(sku.deletedAt),
          extra,
        ),
      ),
  );
}

/**
 * Escape the characters PostgreSQL treats as `LIKE` metacharacters.
 *
 * Parameterisation stops SQL injection; it does NOT stop this. `%` and `_` inside a BOUND
 * parameter are still wildcards, so an unescaped `?q=%` matches the entire catalogue and
 * `?q=%%%%%` is a cheap way to make the scan miserable. A user typing a percent sign means a
 * percent sign.
 *
 * One regex pass over all three characters, which sidesteps the ordering bug that a sequence of
 * `.replace()` calls invites: escaping `%` and `_` first, then `\`, would double-escape the
 * backslashes just inserted and turn `50%` into a search for `50\%`.
 *
 * Backslash is the escape character PostgreSQL's `LIKE` uses by default, so no `ESCAPE` clause
 * is needed. Asserted by test rather than assumed.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function createCatalogueRepository(deps: { db: Database }) {
  const { db } = deps;

  return {
    /**
     * Create a product.
     *
     * Uses {@link executor} so it joins an ambient transaction if one is open, matching every
     * other repository in the project.
     *
     * Lets a unique violation on the slug index propagate rather than swallowing it. The
     * service translates it — that is the only path that closes the race between two
     * concurrent creates of the same slug, which no pre-check can cover.
     */
    async insertProduct(values: InsertProductValues): Promise<ProductRecord> {
      const [row] = await executor(db).insert(product).values(values).returning(RECORD_COLUMNS);

      if (!row) {
        // Unreachable for `INSERT ... RETURNING`, but the array type admits it and a silent
        // `undefined` would surface later as a confusing mapper failure.
        throw new Error('insertProduct returned no row');
      }
      return row;
    },

    /**
     * Find a product by slug within a store, in ANY lifecycle status.
     *
     * Store-scoped AND `deleted_at IS NULL`, mirroring the partial unique index exactly. If
     * the predicate here disagreed with the index, the create pre-check would report a slug as
     * free that the constraint then rejects — a 500 where a 409 belongs.
     *
     * Status is deliberately NOT filtered, and three callers depend on that: the create path
     * (a draft's slug is taken), the lifecycle diagnosis (it must see the current status to
     * explain a rejected transition), and the staff read (an administrator may see their own
     * drafts). `findPublicBySlug` is the storefront's counterpart and filters on `active` —
     * the two must stay separate, because collapsing them would put the storefront one
     * argument away from serving unpublished products.
     */
    async findBySlug(params: {
      storeId: string;
      slug: string;
    }): Promise<ProductRecord | undefined> {
      const [row] = await executor(db)
        .select(RECORD_COLUMNS)
        .from(product)
        .where(
          and(
            eq(product.storeId, params.storeId),
            eq(product.slug, params.slug),
            isNull(product.deletedAt),
          ),
        )
        .limit(1);
      return row;
    },
    /**
     * Find a PUBLICLY VISIBLE product by slug within a store.
     *
     * All four visibility conditions are in the WHERE clause, not applied to a fetched row:
     * the store, the slug, `deleted_at IS NULL`, and `status = 'active'`.
     *
     * That placement is the security boundary, not a style preference. Fetching a product and
     * then deciding whether to return it means the row — a draft price, an archived name — is
     * in application memory, where it can be logged, serialised into an error payload, or
     * returned by a later refactor that forgets the check. A row the query never selected
     * cannot leak. It also lets PostgreSQL use `ix_product_store_status` rather than reading a
     * row it will discard.
     *
     * Deliberately SEPARATE from `findBySlug`, which the admin create path uses to detect a
     * slug conflict. Those two questions differ: a conflict must consider drafts and archived
     * products, because their slugs are taken, while a storefront must not see them at all.
     * One method with a boolean flag would put both behaviours one wrong argument apart.
     */
    async findPublicBySlug(params: {
      storeId: string;
      slug: string;
    }): Promise<ProductRecord | undefined> {
      const [row] = await executor(db)
        .select(RECORD_COLUMNS)
        .from(product)
        .where(
          and(
            eq(product.storeId, params.storeId),
            eq(product.slug, params.slug),
            isNull(product.deletedAt),
            eq(product.status, PUBLIC_PRODUCT_STATUS),
            /**
             * A published product with nothing sellable is not publicly readable.
             *
             * It collapses into the SAME 404 as an unknown slug, a draft, and another store's
             * product — the §25 rule that every public failure is indistinguishable. Without
             * this, a storefront could render a product page with no purchasable SKU on it.
             */
            hasSellableSku(executor(db), params.storeId),
          ),
        )
        .limit(1);
      return row;
    },
    /**
     * Move a product to a new status, but only from an allowed source status.
     *
     * ONE atomic statement. The transition precondition — `status IN (from)` — is part of the
     * `UPDATE` predicate, not a check performed beforehand. A read-then-write would let two
     * concurrent publishes both observe `draft` and both "succeed", so the endpoint would report
     * two independent state changes where only one occurred. Here PostgreSQL takes a row lock,
     * the second transaction re-evaluates the predicate after the first commits, and it matches
     * nothing.
     *
     * `store_id` and `deleted_at IS NULL` are in the same predicate. A staff user cannot reach
     * another store's product, and a soft-deleted product cannot be revived through a status
     * change — both enforced by the database rather than by a comparison the service performs
     * afterwards.
     *
     * Returns `undefined` for every failure: not found, wrong store, soft-deleted, or a source
     * status outside `from`. Distinguishing those is the service's job, using a store-scoped
     * lookup — see `docs/DECISIONS.md` §26.
     */
    async transitionStatus(params: {
      storeId: string;
      slug: string;
      /** Source statuses this transition may start from. */
      from: readonly string[];
      to: string;
      at: Date;
    }): Promise<ProductRecord | undefined> {
      const [row] = await executor(db)
        .update(product)
        .set({ status: params.to, updatedAt: params.at })
        .where(
          and(
            eq(product.storeId, params.storeId),
            eq(product.slug, params.slug),
            isNull(product.deletedAt),
            inArray(product.status, [...params.from]),
          ),
        )
        .returning(RECORD_COLUMNS);

      return row;
    },
    /**
     * List a store's products, newest first, in any lifecycle status.
     *
     * The visibility predicate is built ONCE and shared by both the page query and the count.
     * That is the point: the classic bug in a paginated endpoint is a total that counts rows
     * the page cannot show — another tenant's, or soft-deleted ones — and it happens because
     * the two queries are written separately and then drift. Here they cannot drift
     * independently, because there is only one predicate.
     *
     * `ORDER BY created_at DESC, id DESC`. Deterministic: `created_at` states the intent
     * ("newest first") and `id` breaks ties, so a row cannot appear on two pages or on none.
     * `id` alone would in fact suffice, since UUIDv7 is time-ordered — but naming `created_at`
     * survives a future change of id scheme, and does not require the reader to know that.
     *
     * Both existing indexes lead with `store_id`, so the filter is served as a prefix; neither
     * provides this sort order, so PostgreSQL sorts the store's rows. That is adequate at
     * catalogue sizes this endpoint will see for now, and a dedicated
     * `(store_id, created_at DESC, id DESC)` index is the obvious optimisation once there is
     * evidence it is needed — see `docs/DECISIONS.md` §28.
     */
    async listForStore(params: {
      storeId: string;
      limit: number;
      offset: number;
    }): Promise<{ items: ProductRecord[]; total: number }> {
      const visible = and(eq(product.storeId, params.storeId), isNull(product.deletedAt));

      const [items, [counted]] = await Promise.all([
        executor(db)
          .select(RECORD_COLUMNS)
          .from(product)
          .where(visible)
          .orderBy(desc(product.createdAt), desc(product.id))
          .limit(params.limit)
          .offset(params.offset),
        executor(db).select({ total: count() }).from(product).where(visible),
      ]);

      return { items, total: Number(counted?.total ?? 0) };
    },
    /**
     * Update a product's editable data fields.
     *
     * ONE atomic store-scoped statement. `store_id`, `slug`, and `deleted_at IS NULL` are in the
     * predicate, so a cross-store or deleted product matches nothing and the service reports it
     * as absent — the boundary is the database's, not a comparison performed afterwards.
     *
     * `EditableProductFields` names the three columns this can write. That type IS the guarantee
     * that a lifecycle status, a slug, or a store id cannot be changed here: passing one is a
     * compile error, not a runtime check somebody could forget. `status` in particular has its
     * own guarded transitions (§26), and a second unguarded path into the state machine would
     * let any status be set from any other.
     *
     * Returns the PERSISTED row, so the response reflects what the database now holds rather
     * than what the caller asked for. Those differ whenever a value is normalised — a price of
     * `19.9` is stored as `19.9000` — and echoing the request back would misreport it.
     */
    async updateProductFields(params: {
      storeId: string;
      slug: string;
      fields: EditableProductFields;
      at: Date;
    }): Promise<ProductRecord | undefined> {
      const [row] = await executor(db)
        .update(product)
        .set({ ...params.fields, updatedAt: params.at })
        .where(
          and(
            eq(product.storeId, params.storeId),
            eq(product.slug, params.slug),
            isNull(product.deletedAt),
          ),
        )
        .returning(RECORD_COLUMNS);

      return row;
    },
    /**
     * Soft-delete a product.
     *
     * The project's FIRST write to a `deleted_at` column — eight read predicates already filter
     * on one, but nothing had yet set one. The schema helper names this exact case: soft delete
     * is "for rows a merchant can delete but whose history must survive — a product that appears
     * on past invoices".
     *
     * ONE atomic store-scoped statement, with `deleted_at IS NULL` in the predicate. That last
     * clause is what makes a second delete match nothing rather than silently re-stamping the
     * timestamp and losing the original deletion time.
     *
     * `slug` is in the predicate and it is load-bearing: without it the statement matches every
     * non-deleted row the store owns, and deleting one product would erase the whole catalogue.
     *
     * `updated_at` is bumped alongside, per the timestamps convention that the application sets
     * it on every write.
     *
     * Returns the row so the service can distinguish "deleted it" from "there was nothing to
     * delete" without a second query.
     */
    async softDeleteProduct(params: {
      storeId: string;
      slug: string;
      at: Date;
    }): Promise<ProductRecord | undefined> {
      const [row] = await executor(db)
        .update(product)
        .set({ deletedAt: params.at, updatedAt: params.at })
        .where(
          and(
            eq(product.storeId, params.storeId),
            eq(product.slug, params.slug),
            isNull(product.deletedAt),
          ),
        )
        .returning(RECORD_COLUMNS);

      return row;
    },
    /**
     * List a store's PUBLISHED products, newest first.
     *
     * The storefront counterpart to `listForStore`. Same shape, same ordering, one extra
     * predicate — and kept as a separate method for the same reason `findPublicBySlug` is
     * separate from `findBySlug` (§25): a boolean flag would put "shows drafts" and "does not"
     * one wrong argument apart, on the query that faces anonymous callers.
     *
     * The visibility predicate is built ONCE and shared by the page and the count, per §28. A
     * total that counted drafts would tell a storefront there are 40 products while the pages
     * only ever yield 12.
     *
     * This predicate — `(store_id, status)` — is exactly `ix_product_store_status`, so unlike
     * the admin list PostgreSQL can satisfy the filter from the index rather than scanning the
     * store's rows. The sort still costs a pass; see §28 on why no dedicated index was added.
     */
    async listPublicForStore(params: {
      storeId: string;
      limit: number;
      offset: number;
      /** Optional substring match on the product NAME. Absent means no search. */
      search?: string;
      /**
       * Optional INCLUSIVE price bounds, as decimal strings already validated against
       * `priceField` — non-negative, at most 4 decimals, at most 15 integer digits.
       *
       * Strings, not `Money` and not numbers. PostgreSQL coerces the text parameter to
       * `numeric` itself, so `'10'` and `'10.0000'` select the same rows and no cast is
       * needed; going through `Money` would require a currency here for no gain (see the
       * comparator in `dto.ts`). The DTO has already rejected a reversed range, so this
       * method never has to decide what `min > max` means.
       */
      priceMin?: string;
      priceMax?: string;
    }): Promise<{ items: ProductRecord[]; total: number }> {
      /**
       * The search term and the price bounds join the SHARED predicate, so the page and the
       * COUNT cannot disagree about what matches. That is the whole reason this expression is
       * built once (§28): a filter applied to only one of them reports a total for a different
       * result set than the page it accompanies.
       *
       * `and()` drops `undefined` operands, so absent filters leave the query byte-for-byte
       * what it was before this increment.
       *
       * NAME only. Not description — with no relevance ranking, a product merely MENTIONING a
       * word would sort equal to one named after it, ordered by date. Not slug or status either:
       * a storefront searches what a customer can see on the page.
       *
       * The bounds are `gte`/`lte` — INCLUSIVE both ends. A shopper filtering "up to 2000"
       * means a product priced exactly 2000 is in range; excluding it is the kind of off-by-one
       * that hides a product from the only search that should have found it.
       *
       * Note that the bounds NARROW this expression and cannot widen it: store scoping,
       * `deleted_at IS NULL`, and `status = 'active'` are unconditional operands above.
       */
      /**
       * The price bounds moved from the product to its SKUs, so they are now conditions
       * INSIDE the same `EXISTS` that decides visibility rather than predicates on `product`.
       *
       * Both bounds go into ONE subquery, not two. `EXISTS(price >= min) AND EXISTS(price <=
       * max)` would be satisfied by a cheap SKU and a separate expensive one, matching a
       * product that has nothing in the requested band at all. One subquery means one SKU
       * must satisfy both ends — which is what "a product in this price range" means.
       */
      const priceBand =
        params.priceMin === undefined && params.priceMax === undefined
          ? undefined
          : and(
              params.priceMin === undefined ? undefined : gte(sku.price, params.priceMin),
              params.priceMax === undefined ? undefined : lte(sku.price, params.priceMax),
            );

      const visible = and(
        eq(product.storeId, params.storeId),
        isNull(product.deletedAt),
        eq(product.status, PUBLIC_PRODUCT_STATUS),
        params.search === undefined
          ? undefined
          : ilike(product.name, `%${escapeLikePattern(params.search)}%`),
        /**
         * One `EXISTS` serving two jobs: the product must have a sellable SKU at all, and —
         * when bounds were supplied — one that falls in the band. Collapsing them keeps the
         * shared predicate a single boolean expression, so the page and the `COUNT` cannot
         * diverge and a product with several matching SKUs still appears exactly once.
         */
        hasSellableSku(executor(db), params.storeId, priceBand),
      );

      const [items, [counted]] = await Promise.all([
        executor(db)
          .select(RECORD_COLUMNS)
          .from(product)
          .where(visible)
          .orderBy(desc(product.createdAt), desc(product.id))
          .limit(params.limit)
          .offset(params.offset),
        executor(db).select({ total: count() }).from(product).where(visible),
      ]);

      return { items, total: Number(counted?.total ?? 0) };
    },

    /* ── SKUs ──────────────────────────────────────────────────────────────── */

    async insertSku(values: InsertSkuValues): Promise<SkuRecord> {
      const [row] = await executor(db).insert(sku).values(values).returning(SKU_COLUMNS);
      // Drizzle returns exactly one row for a single-row insert; a failure throws.
      return row!;
    },

    /**
     * Find a live product to hang a SKU on.
     *
     * Store-scoped and `deleted_at IS NULL`, so a SKU can never be attached to another
     * merchant's product or to one that has been deleted. Returns the id and store rather
     * than a full record because that is all the SKU insert needs — and returning
     * `storeId` from the ROW rather than echoing the caller's argument is what guarantees
     * the SKU lands in the product's own store.
     */
    async findProductRefBySlug(params: {
      storeId: string;
      slug: string;
    }): Promise<{ id: string; storeId: string } | undefined> {
      const [row] = await executor(db)
        .select({ id: product.id, storeId: product.storeId })
        .from(product)
        .where(
          and(
            eq(product.storeId, params.storeId),
            eq(product.slug, params.slug),
            isNull(product.deletedAt),
          ),
        )
        .limit(1);
      return row;
    },

    /** One SKU by merchant code, store-scoped. Deleted SKUs are invisible. */
    async findSkuByCode(params: { storeId: string; code: string }): Promise<SkuRecord | undefined> {
      const [row] = await executor(db)
        .select(SKU_COLUMNS)
        .from(sku)
        .where(
          and(eq(sku.storeId, params.storeId), eq(sku.code, params.code), isNull(sku.deletedAt)),
        )
        .limit(1);
      return row;
    },

    /**
     * Every live SKU of one product, active and inactive alike.
     *
     * Unpaginated, deliberately: the number of SKUs under a product is bounded by the
     * variant grid a merchant can plausibly manage, and paginating it would make the admin
     * view of a single product's variants harder to use for no benefit. That is the same
     * judgement §28 made about categories, and it is not the judgement it made about
     * products, which are unbounded.
     *
     * Ordered by `code` so the admin list is stable across requests rather than reflecting
     * insertion order.
     */
    async listSkusForProduct(params: { storeId: string; productId: string }): Promise<SkuRecord[]> {
      return executor(db)
        .select(SKU_COLUMNS)
        .from(sku)
        .where(
          and(
            eq(sku.storeId, params.storeId),
            eq(sku.productId, params.productId),
            isNull(sku.deletedAt),
          ),
        )
        .orderBy(sku.code);
    },

    /**
     * SKUs for MANY products in one query — the batch loader for product lists.
     *
     * `inArray` rather than a query per product: a 20-item page would otherwise cost 21
     * round trips, and the N+1 would only be visible under load. Returns a flat list for the
     * caller to group, because grouping in SQL would mean either a join (which duplicates
     * products, see `hasSellableSku`) or JSON aggregation that the mapper would immediately
     * take apart again.
     *
     * `activeOnly` distinguishes the two audiences: a storefront must not see an inactive
     * SKU, while the admin list shows everything a merchant manages. A boolean here rather
     * than two methods because — unlike `findBySlug` versus `findPublicBySlug` (§25) — this
     * one never decides whether a PRODUCT is visible, only which of an already-visible
     * product's SKUs are shown.
     */
    async listSkusForProducts(params: {
      storeId: string;
      productIds: readonly string[];
      activeOnly: boolean;
    }): Promise<SkuRecord[]> {
      if (params.productIds.length === 0) return [];

      return executor(db)
        .select(SKU_COLUMNS)
        .from(sku)
        .where(
          and(
            eq(sku.storeId, params.storeId),
            inArray(sku.productId, [...params.productIds]),
            isNull(sku.deletedAt),
            params.activeOnly ? eq(sku.isActive, true) : undefined,
          ),
        )
        .orderBy(sku.code);
    },

    /**
     * Update a SKU's editable fields.
     *
     * ONE atomic store-scoped statement, and `code` is in the predicate because it is the
     * identifier the caller supplied. Both are load-bearing: without `code` the statement
     * rewrites every SKU the store owns, which is precisely the blast-radius mutation that
     * survived §29's first test suite because every test kept a single row.
     */
    async updateSkuFields(params: {
      storeId: string;
      code: string;
      fields: EditableSkuFields;
      at: Date;
    }): Promise<SkuRecord | undefined> {
      const [row] = await executor(db)
        .update(sku)
        .set({ ...params.fields, updatedAt: params.at })
        .where(
          and(eq(sku.storeId, params.storeId), eq(sku.code, params.code), isNull(sku.deletedAt)),
        )
        .returning(SKU_COLUMNS);

      return row;
    },

    /**
     * Soft-delete one SKU by code.
     *
     * `deleted_at IS NULL` in the predicate makes a second delete match nothing rather than
     * re-stamping the timestamp and losing the original deletion time — the same rule
     * `softDeleteProduct` follows, and what lets the route answer 404 the second time.
     *
     * Deleting frees the code for reuse through the partial unique index.
     */
    async softDeleteSku(params: {
      storeId: string;
      code: string;
      at: Date;
    }): Promise<SkuRecord | undefined> {
      const [row] = await executor(db)
        .update(sku)
        .set({ deletedAt: params.at, updatedAt: params.at })
        .where(
          and(eq(sku.storeId, params.storeId), eq(sku.code, params.code), isNull(sku.deletedAt)),
        )
        .returning(SKU_COLUMNS);

      return row;
    },

    /**
     * Soft-delete every live SKU of one product — the deletion cascade.
     *
     * Called by the service INSIDE the same transaction as the product's own soft delete.
     * Not a database `ON DELETE CASCADE`, because products are soft-deleted: there is no
     * `DELETE` for the database to cascade from. Leaving it to the database would also mean
     * a hard delete silently removing sellable rows, which is why the FK is `RESTRICT`.
     *
     * Without this, a deleted product's SKUs stay `is_active = true` and
     * `deleted_at IS NULL` — rows that look sellable to every future query that reaches
     * them by code rather than through the product.
     *
     * Returns the affected codes for the audit entry, so the trail records what went with
     * the product rather than only that something did.
     */
    async softDeleteSkusForProduct(params: {
      storeId: string;
      productId: string;
      at: Date;
    }): Promise<string[]> {
      const rows = await executor(db)
        .update(sku)
        .set({ deletedAt: params.at, updatedAt: params.at })
        .where(
          and(
            eq(sku.storeId, params.storeId),
            eq(sku.productId, params.productId),
            isNull(sku.deletedAt),
          ),
        )
        .returning({ code: sku.code });

      return rows.map((r) => r.code);
    },

    /* ── Options ─────────────────────────────────────────────────────────── */

    async insertOption(values: InsertOptionValues): Promise<OptionRecord> {
      const [row] = await executor(db)
        .insert(productOption)
        .values(values)
        .returning(OPTION_COLUMNS);
      return row!;
    },

    /**
     * One option by id, store-scoped. Deleted options are invisible.
     *
     * Returns `productId` because every option mutation needs to know which product it belongs
     * to — for the cap check, for the audit metadata, and because the value insert must copy
     * the product from the ROW rather than trust a caller.
     */
    async findOptionById(params: {
      storeId: string;
      id: string;
    }): Promise<OptionRecord | undefined> {
      const [row] = await executor(db)
        .select(OPTION_COLUMNS)
        .from(productOption)
        .where(
          and(
            eq(productOption.storeId, params.storeId),
            eq(productOption.id, params.id),
            isNull(productOption.deletedAt),
          ),
        )
        .limit(1);
      return row;
    },

    /** A product's live options, in display order. Ties broken by id so the order is total. */
    async listOptionsForProduct(params: {
      storeId: string;
      productId: string;
    }): Promise<OptionRecord[]> {
      return executor(db)
        .select(OPTION_COLUMNS)
        .from(productOption)
        .where(
          and(
            eq(productOption.storeId, params.storeId),
            eq(productOption.productId, params.productId),
            isNull(productOption.deletedAt),
          ),
        )
        .orderBy(productOption.sortOrder, productOption.id);
    },

    /** How many live options this product already has — the cap check. */
    async countOptionsForProduct(params: { storeId: string; productId: string }): Promise<number> {
      const [row] = await executor(db)
        .select({ total: count() })
        .from(productOption)
        .where(
          and(
            eq(productOption.storeId, params.storeId),
            eq(productOption.productId, params.productId),
            isNull(productOption.deletedAt),
          ),
        );
      return Number(row?.total ?? 0);
    },

    /**
     * Update an option's editable fields.
     *
     * ONE atomic store-scoped statement, with `id` and `deleted_at IS NULL` in the predicate.
     * Without `id` the statement rewrites every option the store owns — the same blast-radius
     * mutation `updateSkuFields` guards against.
     */
    async updateOptionFields(params: {
      storeId: string;
      id: string;
      fields: EditableOptionFields;
      at: Date;
    }): Promise<OptionRecord | undefined> {
      const [row] = await executor(db)
        .update(productOption)
        .set({ ...params.fields, updatedAt: params.at })
        .where(
          and(
            eq(productOption.storeId, params.storeId),
            eq(productOption.id, params.id),
            isNull(productOption.deletedAt),
          ),
        )
        .returning(OPTION_COLUMNS);
      return row;
    },

    async softDeleteOption(params: {
      storeId: string;
      id: string;
      at: Date;
    }): Promise<OptionRecord | undefined> {
      const [row] = await executor(db)
        .update(productOption)
        .set({ deletedAt: params.at, updatedAt: params.at })
        .where(
          and(
            eq(productOption.storeId, params.storeId),
            eq(productOption.id, params.id),
            isNull(productOption.deletedAt),
          ),
        )
        .returning(OPTION_COLUMNS);
      return row;
    },

    /** Cascade: every live option of a product. Returns the names for the audit trail. */
    async softDeleteOptionsForProduct(params: {
      storeId: string;
      productId: string;
      at: Date;
    }): Promise<string[]> {
      const rows = await executor(db)
        .update(productOption)
        .set({ deletedAt: params.at, updatedAt: params.at })
        .where(
          and(
            eq(productOption.storeId, params.storeId),
            eq(productOption.productId, params.productId),
            isNull(productOption.deletedAt),
          ),
        )
        .returning({ name: productOption.name });
      return rows.map((r) => r.name);
    },

    /* ── Option values ───────────────────────────────────────────────────── */

    async insertOptionValue(values: InsertOptionValueValues): Promise<OptionValueRecord> {
      const [row] = await executor(db)
        .insert(productOptionValue)
        .values(values)
        .returning(OPTION_VALUE_COLUMNS);
      return row!;
    },

    async findOptionValueById(params: {
      storeId: string;
      id: string;
    }): Promise<OptionValueRecord | undefined> {
      const [row] = await executor(db)
        .select(OPTION_VALUE_COLUMNS)
        .from(productOptionValue)
        .where(
          and(
            eq(productOptionValue.storeId, params.storeId),
            eq(productOptionValue.id, params.id),
            isNull(productOptionValue.deletedAt),
          ),
        )
        .limit(1);
      return row;
    },

    /**
     * Values for MANY options in one query — the batch loader for the option list.
     *
     * `inArray` rather than a query per option, for the same reason `listSkusForProducts`
     * batches: a product with eight options would otherwise cost nine round trips.
     */
    async listValuesForOptions(params: {
      storeId: string;
      optionIds: readonly string[];
    }): Promise<OptionValueRecord[]> {
      if (params.optionIds.length === 0) return [];

      return executor(db)
        .select(OPTION_VALUE_COLUMNS)
        .from(productOptionValue)
        .where(
          and(
            eq(productOptionValue.storeId, params.storeId),
            inArray(productOptionValue.optionId, [...params.optionIds]),
            isNull(productOptionValue.deletedAt),
          ),
        )
        .orderBy(productOptionValue.sortOrder, productOptionValue.id);
    },

    /** How many live values this option already has — the cap check. */
    async countValuesForOption(params: { storeId: string; optionId: string }): Promise<number> {
      const [row] = await executor(db)
        .select({ total: count() })
        .from(productOptionValue)
        .where(
          and(
            eq(productOptionValue.storeId, params.storeId),
            eq(productOptionValue.optionId, params.optionId),
            isNull(productOptionValue.deletedAt),
          ),
        );
      return Number(row?.total ?? 0);
    },

    /**
     * Resolve option value ids for a combination replacement.
     *
     * Store-scoped, product-scoped, and live on BOTH sides — the value itself and its parent
     * option — via an inner join to `product_option`. A deleted option makes its values
     * unselectable even if the values were never individually deleted, which is what "a
     * deleted option/value must not become publicly sellable" requires.
     *
     * The product scope is what turns "a value from another product" into "not found": the
     * caller cannot distinguish it from an id that never existed, and no comparison happens
     * after the query where it could be forgotten. The composite foreign keys would reject
     * such a row anyway; this is the friendly error in front of them.
     */
    async findSelectableOptionValues(params: {
      storeId: string;
      productId: string;
      ids: readonly string[];
    }): Promise<SelectableOptionValue[]> {
      if (params.ids.length === 0) return [];

      return executor(db)
        .select({
          id: productOptionValue.id,
          optionId: productOptionValue.optionId,
          value: productOptionValue.value,
        })
        .from(productOptionValue)
        .innerJoin(productOption, eq(productOption.id, productOptionValue.optionId))
        .where(
          and(
            eq(productOptionValue.storeId, params.storeId),
            eq(productOptionValue.productId, params.productId),
            inArray(productOptionValue.id, [...params.ids]),
            isNull(productOptionValue.deletedAt),
            isNull(productOption.deletedAt),
          ),
        );
    },

    async updateOptionValueFields(params: {
      storeId: string;
      id: string;
      fields: EditableOptionValueFields;
      at: Date;
    }): Promise<OptionValueRecord | undefined> {
      const [row] = await executor(db)
        .update(productOptionValue)
        .set({ ...params.fields, updatedAt: params.at })
        .where(
          and(
            eq(productOptionValue.storeId, params.storeId),
            eq(productOptionValue.id, params.id),
            isNull(productOptionValue.deletedAt),
          ),
        )
        .returning(OPTION_VALUE_COLUMNS);
      return row;
    },

    async softDeleteOptionValue(params: {
      storeId: string;
      id: string;
      at: Date;
    }): Promise<OptionValueRecord | undefined> {
      const [row] = await executor(db)
        .update(productOptionValue)
        .set({ deletedAt: params.at, updatedAt: params.at })
        .where(
          and(
            eq(productOptionValue.storeId, params.storeId),
            eq(productOptionValue.id, params.id),
            isNull(productOptionValue.deletedAt),
          ),
        )
        .returning(OPTION_VALUE_COLUMNS);
      return row;
    },

    /** Cascade: every live value of one option. Returns the values for the audit trail. */
    async softDeleteValuesForOption(params: {
      storeId: string;
      optionId: string;
      at: Date;
    }): Promise<string[]> {
      const rows = await executor(db)
        .update(productOptionValue)
        .set({ deletedAt: params.at, updatedAt: params.at })
        .where(
          and(
            eq(productOptionValue.storeId, params.storeId),
            eq(productOptionValue.optionId, params.optionId),
            isNull(productOptionValue.deletedAt),
          ),
        )
        .returning({ value: productOptionValue.value });
      return rows.map((r) => r.value);
    },

    /** Cascade: every live value of a product, in the product-deletion transaction. */
    async softDeleteValuesForProduct(params: {
      storeId: string;
      productId: string;
      at: Date;
    }): Promise<number> {
      const rows = await executor(db)
        .update(productOptionValue)
        .set({ deletedAt: params.at, updatedAt: params.at })
        .where(
          and(
            eq(productOptionValue.storeId, params.storeId),
            eq(productOptionValue.productId, params.productId),
            isNull(productOptionValue.deletedAt),
          ),
        )
        .returning({ id: productOptionValue.id });
      return rows.length;
    },

    /* ── SKU combinations ────────────────────────────────────────────────── */

    /**
     * The option combinations of MANY SKUs, joined to their option and value rows.
     *
     * The batch loader that keeps the product list at a fixed number of queries. A 20-product
     * page can carry 100 SKUs; loading each SKU's options separately would be 100 round trips
     * and would only be visible under load.
     *
     * A join is correct HERE, unlike in the visibility predicate: these rows genuinely are one
     * per (SKU, option), so multiplying is the intent rather than a bug. Nothing is being
     * counted or paginated.
     *
     * Both `deleted_at IS NULL` filters are DEFENCE IN DEPTH. A live SKU cannot reference a
     * deleted option or value, because deletion is refused while a live SKU uses it — but this
     * mapper is what a storefront sees, and it must not surface a retired value if a bad
     * import or a future bug ever creates that state.
     */
    async listSkuOptionsForSkus(params: {
      storeId: string;
      skuIds: readonly string[];
    }): Promise<SkuOptionRecord[]> {
      if (params.skuIds.length === 0) return [];

      return executor(db)
        .select({
          skuId: skuOptionValue.skuId,
          optionId: productOption.id,
          optionName: productOption.name,
          optionSortOrder: productOption.sortOrder,
          valueId: productOptionValue.id,
          value: productOptionValue.value,
          valueSortOrder: productOptionValue.sortOrder,
        })
        .from(skuOptionValue)
        .innerJoin(productOptionValue, eq(productOptionValue.id, skuOptionValue.optionValueId))
        .innerJoin(productOption, eq(productOption.id, skuOptionValue.optionId))
        .where(
          and(
            eq(skuOptionValue.storeId, params.storeId),
            inArray(skuOptionValue.skuId, [...params.skuIds]),
            isNull(productOptionValue.deletedAt),
            isNull(productOption.deletedAt),
          ),
        )
        .orderBy(productOption.sortOrder, productOption.id);
    },

    /**
     * Remove a SKU's current combination rows.
     *
     * A HARD delete, and the only one in this module. `uq_sov_sku_option` rejects the
     * replacement row while the superseded one exists, and the junction table deliberately has
     * no `deleted_at` — giving it one would force that unique index to become partial, and a
     * SKU's current combination would become a query over surviving rows rather than a fact.
     *
     * The history of the EDIT lives in the `sku.options_updated` event and its audit entry,
     * which carry the before and after combinations. Deleting a SKU or a product still deletes
     * nothing from this table.
     */
    async clearSkuOptionValues(params: { storeId: string; skuId: string }): Promise<void> {
      await executor(db)
        .delete(skuOptionValue)
        .where(
          and(eq(skuOptionValue.storeId, params.storeId), eq(skuOptionValue.skuId, params.skuId)),
        );
    },

    async insertSkuOptionValues(values: readonly InsertSkuOptionValueValues[]): Promise<void> {
      if (values.length === 0) return;
      await executor(db)
        .insert(skuOptionValue)
        .values([...values]);
    },

    /**
     * Write the materialised signature.
     *
     * Called by the same transaction that has just rewritten the junction rows, never
     * separately. `uq_sku_combination` fires here, which is why the caller's unique-violation
     * catch must sit outside the transaction.
     */
    async updateSkuSignature(params: {
      storeId: string;
      skuId: string;
      signature: string;
      at: Date;
    }): Promise<void> {
      await executor(db)
        .update(sku)
        .set({ optionSignature: params.signature, updatedAt: params.at })
        .where(and(eq(sku.storeId, params.storeId), eq(sku.id, params.skuId)));
    },

    /**
     * The DELETE GUARD: which LIVE SKUs still use any of these option values?
     *
     * Returns codes rather than a boolean so the 409 can name what blocks the deletion — a
     * merchant told only "in use" has to go looking. `ix_sov_option_value` exists for this
     * query; without it every option and value deletion scans the junction table.
     *
     * "Live" means `deleted_at IS NULL` on the SKU. A soft-deleted SKU's rows are history and
     * must never block a merchant from retiring an option — which is exactly what makes
     * soft-deleting the value safe: those historical rows keep pointing at a row that exists.
     */
    async liveSkuCodesUsingValues(params: {
      storeId: string;
      optionValueIds: readonly string[];
    }): Promise<string[]> {
      if (params.optionValueIds.length === 0) return [];

      const rows = await executor(db)
        .selectDistinct({ code: sku.code })
        .from(skuOptionValue)
        .innerJoin(sku, eq(sku.id, skuOptionValue.skuId))
        .where(
          and(
            eq(skuOptionValue.storeId, params.storeId),
            inArray(skuOptionValue.optionValueId, [...params.optionValueIds]),
            isNull(sku.deletedAt),
          ),
        )
        .orderBy(sku.code);

      return rows.map((r) => r.code);
    },

    /** The same guard for a whole option, without first listing its values. */
    async liveSkuCodesUsingOption(params: {
      storeId: string;
      optionId: string;
    }): Promise<string[]> {
      const rows = await executor(db)
        .selectDistinct({ code: sku.code })
        .from(skuOptionValue)
        .innerJoin(sku, eq(sku.id, skuOptionValue.skuId))
        .where(
          and(
            eq(skuOptionValue.storeId, params.storeId),
            eq(skuOptionValue.optionId, params.optionId),
            isNull(sku.deletedAt),
          ),
        )
        .orderBy(sku.code);

      return rows.map((r) => r.code);
    },
  };
}
