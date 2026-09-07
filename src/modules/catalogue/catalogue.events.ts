import type { JsonObject } from '../../shared/events.js';

/**
 * The catalogue's event and audit vocabulary.
 *
 * Names live in constants rather than inline strings for one concrete reason: an event name
 * is persisted in `outbox_event.event_name` and matched against the handler registry, so a
 * typo does not fail — it produces an event nothing ever handles, silently. A constant makes
 * that a compile error.
 *
 * The same applies to audit actions, which are read by humans in a filter box. `PRODUCT_AUDIT`
 * is the vocabulary an auditor can be handed.
 */

/** `aggregate_type` for every event here. Answers "what happened to product X?" as one query. */
export const PRODUCT_AGGREGATE = 'product';

/**
 * Event names. Dotted, past tense, permanent.
 *
 * Renaming one orphans every unpublished row already in `outbox_event` — the drainer would
 * hand the old name to a registry that no longer knows it. Add a new name instead.
 */
export const PRODUCT_EVENTS = {
  created: 'product.created',
  updated: 'product.updated',
  published: 'product.published',
  archived: 'product.archived',
  deleted: 'product.deleted',
} as const;

/**
 * Audit actions, deliberately parallel to the events but not derived from them.
 *
 * They answer different questions (§ see `shared/audit.ts`), and coupling the two strings
 * would mean renaming an audit action to add an event, or vice versa.
 */
export const PRODUCT_AUDIT = {
  created: 'product.created',
  updated: 'product.updated',
  published: 'product.published',
  archived: 'product.archived',
  deleted: 'product.deleted',
} as const;

/** The `resource_type` recorded on every catalogue audit entry. */
export const PRODUCT_RESOURCE = 'product';

/**
 * Build the payload shared by every product event.
 *
 * IDS AND FACTS, never the entity — the rule from `shared/events.ts`. A payload carrying a
 * serialised product is already stale by the time a handler runs, which is the definition of
 * asynchronous. `slug` and `status` are included because they were true at emission and a
 * handler routinely needs them to act (invalidate a URL, decide whether to reindex) without a
 * second read.
 *
 * `price` is deliberately ABSENT from the common payload. It is emitted only by
 * `product.updated`, where the change is the fact worth carrying; on the other events it
 * would be a value nobody asked for that becomes wrong on the next edit.
 */
export function productEventPayload(product: {
  id: string;
  slug: string;
  status: string;
}): JsonObject {
  return {
    productId: product.id,
    slug: product.slug,
    status: product.status,
  };
}

/* ── SKUs ────────────────────────────────────────────────────────────────── */

/** `aggregate_type` for SKU events. Answers "what happened to SKU X?" as one query. */
export const SKU_AGGREGATE = 'sku';

export const SKU_EVENTS = {
  created: 'sku.created',
  updated: 'sku.updated',
  deleted: 'sku.deleted',
} as const;

/**
 * Audit actions.
 *
 * `priceChanged` and `activationChanged` are separate from the general `updated` because they
 * are the two SKU edits an auditor actually looks for — one moves money, the other decides
 * whether a thing can be sold at all. Folding them into `sku.updated` would mean filtering on
 * metadata to find them, which is the kind of query an audit vocabulary exists to avoid.
 *
 * A single PATCH that changes a price AND deactivates the SKU writes both, plus `updated` for
 * any other field it touched. That is deliberate: an audit trail records what happened, and
 * two things happened.
 */
export const SKU_AUDIT = {
  created: 'sku.created',
  updated: 'sku.updated',
  priceChanged: 'sku.price_changed',
  activationChanged: 'sku.activation_changed',
  deleted: 'sku.deleted',
} as const;

/** The `resource_type` recorded on every SKU audit entry. */
export const SKU_RESOURCE = 'sku';

/**
 * The payload shared by every SKU event.
 *
 * Ids and facts, per `shared/events.ts`. `productId` is included because a handler almost
 * always needs it — a search reindex or a cache invalidation works on the product, not the
 * SKU — and re-reading it would race the deletion cascade.
 *
 * `price` IS carried here, unlike the product events, because it is the fact that makes a SKU
 * event actionable: a pricing consumer cannot do anything with a bare id.
 */
export function skuEventPayload(record: {
  id: string;
  productId: string;
  code: string;
  price: string;
  isActive: boolean;
}): JsonObject {
  return {
    skuId: record.id,
    productId: record.productId,
    code: record.code,
    price: record.price,
    isActive: record.isActive,
  };
}

/* ── Options ─────────────────────────────────────────────────────────────── */

/** `aggregate_type` for option events. */
export const OPTION_AGGREGATE = 'product_option';

export const OPTION_EVENTS = {
  created: 'product_option.created',
  updated: 'product_option.updated',
  deleted: 'product_option.deleted',
} as const;

export const OPTION_AUDIT = {
  created: 'product_option.created',
  updated: 'product_option.updated',
  deleted: 'product_option.deleted',
} as const;

export const OPTION_RESOURCE = 'product_option';

/**
 * The payload shared by every option event.
 *
 * `productId` is carried for the same reason it is on SKU events: a consumer reindexing or
 * invalidating a cache works on the product, and re-reading it would race the deletion
 * cascade. The NAME is carried too — unlike most payloads, which are ids and facts only —
 * because deleting an option frees its name for reuse through the partial unique index, so
 * after a later option claims it the id alone no longer tells a consumer which option this was.
 */
export function optionEventPayload(record: {
  id: string;
  productId: string;
  name: string;
}): JsonObject {
  return {
    optionId: record.id,
    productId: record.productId,
    name: record.name,
  };
}

/* ── Option values ───────────────────────────────────────────────────────── */

export const OPTION_VALUE_AGGREGATE = 'product_option_value';

export const OPTION_VALUE_EVENTS = {
  created: 'product_option_value.created',
  updated: 'product_option_value.updated',
  deleted: 'product_option_value.deleted',
} as const;

export const OPTION_VALUE_AUDIT = {
  created: 'product_option_value.created',
  updated: 'product_option_value.updated',
  deleted: 'product_option_value.deleted',
} as const;

export const OPTION_VALUE_RESOURCE = 'product_option_value';

export function optionValueEventPayload(record: {
  id: string;
  optionId: string;
  value: string;
}): JsonObject {
  return {
    optionValueId: record.id,
    optionId: record.optionId,
    value: record.value,
  };
}

/* ── SKU combinations ────────────────────────────────────────────────────── */

/**
 * A SKU's combination changed.
 *
 * Deliberately NOT folded into `sku.updated`. It is the one SKU mutation that rewrites rows in
 * another table, and it is the edit that decides what the SKU actually IS — a consumer
 * rebuilding a variant picker cares about this and not about a name change.
 *
 * It carries more than a bare id on purpose. Combination replacement HARD-deletes the
 * superseded `sku_option_value` rows, because `uq_sov_sku_option` cannot admit both the old
 * and new value of one option. This event and its audit entry are therefore the only surviving
 * record that the SKU was ever Red — which makes the before/after here a requirement rather
 * than a nicety.
 */
export const SKU_OPTIONS_EVENT = 'sku.options_updated';

/** The matching audit action, beside `sku.price_changed` for the same reason. */
export const SKU_OPTIONS_AUDIT = 'sku.options_updated';
