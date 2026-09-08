/**
 * The tax module's audit vocabulary. **Audit actions only — no domain events.**
 *
 * §39's rule has held for nine increments and holds here: an event with no consumer is a
 * guess at one. `tax.rate_changed` is the obvious candidate — it is the kind of thing a
 * reporting pipeline would want — and that is exactly why it must not be published
 * speculatively: the consumer is a later increment, and the payload should be designed
 * against a real reader.
 *
 * The outbox handler registry still has exactly one consumer, and a test asserts no `tax.*`
 * event reaches it.
 */

/**
 * Two resource types, because they are addressed differently and reviewed differently.
 *
 * A rate change is the entry an auditor looks for — it changes what every future customer
 * pays — so it gets its own type rather than being buried among class renames.
 */
export const TAX_CLASS_RESOURCE = 'tax_class';
export const TAX_RATE_RESOURCE = 'tax_rate';

/**
 * The store's own GST identity. Its own type because it is the GST on/off switch: an auditor
 * looking for "when did this store start charging tax, and who decided" must be able to filter
 * to exactly that entry rather than sift it out of class renames.
 */
export const TAX_PROFILE_RESOURCE = 'store_tax_profile';

/**
 * A SKU's classification. Its own type, and addressed by SKU CODE rather than by the store id:
 * "which SKU was reclassified" is the question an audit of this action is always asking.
 */
export const SKU_TAX_RESOURCE = 'sku_tax';

/**
 * The customer's own registration. Present for completeness and deliberately UNUSED: a
 * customer maintaining their own tax identity is self-service, not a privileged act, and
 * §42's reasoning for the cart applies — an audit row per edit buries the entries that matter.
 * The value that an audit actually needs is the one snapshotted onto the order.
 */
export const TAX_IDENTITY_RESOURCE = 'customer_tax_identity';

/**
 * Staff actions worth recording.
 *
 * All four change what customers are charged, which is the bar promotions set for auditing
 * configuration: *"a coupon changes what every customer pays, so who created or edited one is
 * worth recording."* A tax rate changes it for every customer at once.
 */
export const TAX_AUDIT = {
  /** The seller's own GST identity and origin address. Also the GST on/off switch. */
  profileUpdated: 'tax.profile_updated',
  classCreated: 'tax.class_created',
  classUpdated: 'tax.class_updated',
  rateCreated: 'tax.rate_created',
  /** Attaching or clearing a SKU's classification: it decides whether the SKU can be sold. */
  skuClassified: 'tax.sku_classified',
} as const;
