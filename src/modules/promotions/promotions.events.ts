/**
 * The promotions module's audit vocabulary.
 *
 * **Audit only — there are no promotion events.** The handler registry is empty, nothing
 * consumes a promotion change, and Increment 26 established that an event with no consumer is
 * a guess at one. A test asserts the outbox stays empty, so adding one later is a conscious
 * decision rather than an accident.
 *
 * Names live in constants because an audit action is read by humans in a filter box: it is a
 * vocabulary an auditor can be handed, not free text. A typo in an inline string produces an
 * entry nobody can find.
 */

/** `resource_type` for every entry here. Answers "what happened to this coupon?" as one query. */
export const PROMOTION_RESOURCE = 'promotion';

/**
 * Audit actions. Dotted, past tense, permanent.
 *
 * Only the three STAFF actions exist. A customer applying or removing a coupon on their own
 * cart is neither privileged nor security-relevant, and is frequent enough that an entry per
 * apply would bury the entries that matter — the same judgement §41 made for cart mutations.
 */
export const PROMOTION_AUDIT = {
  created: 'promotion.created',
  updated: 'promotion.updated',
  deleted: 'promotion.deleted',
} as const;
