import { sql } from 'drizzle-orm';
import {
  char,
  check,
  foreignKey,
  index,
  pgTable,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { primaryId, softDelete, storeIdColumn, timestamps } from './_shared.js';
import { appUser } from './identity.js';
import { store } from './store.js';

/**
 * A customer's address book.
 *
 * ## Mutable customer data, NOT historical truth
 *
 * docs/DECISIONS.md §3 decision 9 is already settled: *"Historical orders snapshot product and
 * address data onto order lines."* So these rows are a convenience the customer edits freely,
 * and an order that ships to one of them will copy the values it used at the time.
 *
 * **Nothing may ever reference an address row for historical truth**, because the moment a past
 * invoice reads a live address, editing a typo rewrites history.
 *
 * Increment 30 added the first reference: `order.address_id`, a composite tenant key to
 * `(id, store_id)`. It does not weaken the rule above — the order carries its own full copy of
 * every delivery field and reads only that. The reference exists so an operator cannot hard-
 * delete an address a past order names, and so "which address was this?" remains answerable. A
 * customer editing or soft-deleting the row afterwards changes no order, which is asserted by
 * test rather than assumed.
 *
 * ## Ownership: the user, and the store through the user
 *
 * `app_user.store_id` is NOT NULL and there is no user/store join table, so a user belongs to
 * exactly one store and an address is store-scoped automatically. `store_id` is denormalised
 * here anyway — matching `sku`, `stock_item` and `stock_ledger` — because every repository
 * predicate in this codebase carries `store_id` in its own `WHERE`, and because it is half of
 * the composite foreign key below.
 *
 * ## What is deliberately absent
 *
 * No `is_default_shipping` / `is_default_billing`: nothing consumes a default until checkout
 * exists, and PostgreSQL's partial unique indexes cannot be deferred, which makes a concurrent
 * default swap needlessly awkward this early. Measured during the design review — the
 * one-statement swap `SET is_default = (id = $target)` fails with 23505 because a partial
 * unique index is checked row-by-row mid-statement.
 *
 * No `gstin`: seller GST identity already lives on `store` (`gstin`, `pan`, `legal_name`).
 * A CUSTOMER's GSTIN is customer tax identity, a separate future concern, and duplicating it
 * here would put tax registration in a delivery address.
 *
 * No `state_code`, no country list, no `district`, `company`, `email`, first/last name split,
 * geo-coordinates, verification flags, or external provider ids. Each is either a business rule
 * this increment was not given or a feature with no consumer.
 */
export const address = pgTable(
  'address',
  {
    id: primaryId(),

    /**
     * No single-column FK to `app_user`. The composite key below covers this reference AND the
     * store agreement in one constraint; a second, weaker FK to the same parent would be
     * redundant and would imply the composite one was optional.
     */
    userId: uuid('user_id').notNull(),

    storeId: storeIdColumn(() => store.id),

    /**
     * The customer's own name for this address — "Home", "Office". Not required to be unique:
     * two addresses called "Home" are a customer's business, not a constraint violation, and a
     * uniqueness rule here would have to define what soft delete does to it for no gain.
     */
    label: varchar('label', { length: 60 }).notNull(),

    /**
     * Who receives the parcel. ONE field, not a first/last split: the recipient is frequently
     * not the account holder, and Indian names do not divide reliably into two columns.
     */
    recipientName: varchar('recipient_name', { length: 300 }).notNull(),

    /**
     * The delivery contact. Deliberately NOT related to `app_user.phone` — that is an account
     * identifier with a per-store unique index, whereas this is whoever the courier should
     * call, which may be a neighbour or a building desk.
     */
    phone: varchar('phone', { length: 20 }).notNull(),

    line1: varchar('line1', { length: 300 }).notNull(),

    /**
     * Empty string rather than NULL, matching `product.description`: there is no useful
     * difference between "no second line" and "an empty second line", and a nullable column
     * would make every consumer handle both.
     */
    line2: varchar('line2', { length: 300 }).notNull().default(''),

    /** "Opposite the water tank." Ubiquitous in Indian addresses and useless to model further. */
    landmark: varchar('landmark', { length: 300 }).notNull().default(''),

    city: varchar('city', { length: 120 }).notNull(),

    /**
     * **Required, and free text.**
     *
     * Required because GST's CGST/SGST-versus-IGST split compares the customer's state to the
     * seller's — `store.registered_address` is documented as *"Drives the CGST/SGST vs IGST
     * split: same state as the customer means CGST+SGST, different means IGST."* An address
     * with no state cannot support that later.
     *
     * Free text, and no `state_code`, because a GST state code is a specific numeric catalogue
     * this increment was told not to invent. When tax arrives it may add a normalised code
     * alongside; it must not be guessed at now.
     */
    state: varchar('state', { length: 120 }).notNull(),

    /**
     * Wide enough for any national format. The Indian six-digit rule is enforced at the
     * validation boundary and only when the country is IN — a database CHECK would either
     * hard-code one country's rule or be useless, and foreign postal formats were not approved
     * for invention.
     */
    postalCode: varchar('postal_code', { length: 16 }).notNull(),

    /**
     * ISO-3166-1 alpha-2, uppercased at the validation boundary — the same
     * normalise-at-the-edge-and-enforce-in-the-database pattern `lower(email)` uses.
     *
     * The CHECK below constrains the SHAPE (two uppercase letters) and deliberately not the
     * VALUE: a 249-entry country list in a constraint is a migration every time the list
     * changes, and rejecting a legitimate country is a worse failure than storing an
     * implausible one.
     */
    countryCode: char('country_code', { length: 2 }).notNull().default('IN'),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /**
     * Ownership AND tenancy in one constraint: the address's user must exist, and its store
     * must be that user's store. A cross-store address row is unrepresentable rather than
     * merely rejected by application code.
     *
     * The target index `uq_app_user_id_store` is created by the same migration, BEFORE this
     * key — PostgreSQL requires a unique constraint on exactly the referenced columns, and
     * drizzle-kit emits foreign keys before the indexes they target, which is the ordering bug
     * Increment 25 hit and documented.
     *
     * `RESTRICT`, matching every other reference to `app_user`: users are soft-deleted, so a
     * hard delete that still has addresses attached is a bug and must fail loudly.
     */
    foreignKey({
      columns: [t.userId, t.storeId],
      foreignColumns: [appUser.id, appUser.storeId],
      name: 'fk_address_user_store',
    }).onDelete('restrict'),

    /**
     * FK-target index, added by Increment 30 so `order` can carry a composite tenant key to
     * `address(id, store_id)`.
     *
     * Adds no guarantee of its own — `id` is already the primary key — and exists solely
     * because PostgreSQL requires a unique constraint on exactly the referenced columns. It is
     * the fifth of its kind, after `uq_sku_id_store`, `uq_app_user_id_store`, `uq_cart_id_store`
     * and `uq_promotion_id_store`, and like all of them it must be created BEFORE the key that
     * references it.
     */
    uniqueIndex('uq_address_id_store').on(t.id, t.storeId),

    /**
     * The ONE read pattern: "this user's live addresses", for the list, and the same predicate
     * narrowed by id for every single-address operation.
     *
     * `user_id` leads because it is the selective column — `store_id` alone matches the whole
     * tenant. Partial on `deleted_at IS NULL` because no query ever wants deleted rows: there
     * is no restore endpoint and no history read, so indexing them would be dead weight.
     */
    index('ix_address_user_active')
      .on(t.userId, t.storeId)
      .where(sql`${t.deletedAt} IS NULL`),

    /**
     * Shape, not membership. Two uppercase ASCII letters — enough to reject `'in'`, `'IND'`
     * and `'1N'` in the database as well as at the boundary, without encoding a country
     * catalogue that would then need maintaining.
     *
     * Enforced here because the API is not the only writer: a bulk import or an operator
     * running SQL during an incident bypasses Zod entirely.
     */
    check('ck_address_country_code_shape', sql`${t.countryCode} ~ '^[A-Z]{2}$'`),

    /**
     * The fields a parcel cannot be delivered without must not be blank.
     *
     * `NOT NULL` alone would admit `''`, which is the same failure wearing a different hat —
     * an address with an empty city is not an address. `line2` and `landmark` are absent from
     * this list on purpose: they default to `''` and are genuinely optional.
     */
    check(
      'ck_address_required_not_blank',
      sql`length(btrim(${t.label})) > 0
          AND length(btrim(${t.recipientName})) > 0
          AND length(btrim(${t.phone})) > 0
          AND length(btrim(${t.line1})) > 0
          AND length(btrim(${t.city})) > 0
          AND length(btrim(${t.state})) > 0
          AND length(btrim(${t.postalCode})) > 0`,
    ),
  ],
);
