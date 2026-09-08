/**
 * The tax module's public surface.
 *
 * Everything another module or the composition root may name. The determination types are
 * exported because `container.ts` adapts this service onto the port ORDERS declares — orders
 * never imports this module, and this module never imports orders.
 *
 * Deliberately absent: the repository's table imports, the column maps, and every DTO mapper.
 * Nothing outside this module needs to know how a rate is stored or serialised — and nothing
 * outside it should be able to construct a tax figure at all.
 */

export {
  createTaxService,
  TaxClassAlreadyExists,
  TaxNotDeterminable,
  TaxRateOverlap,
  type TaxableLine,
  type TaxDetermination,
  type TaxedLine,
  type TaxService,
} from './tax.service.js';

export {
  createTaxRepository,
  CUSTOMER_TAX_CATEGORIES,
  MAX_TAX_RATE_PERCENT,
  PLACE_OF_SUPPLY_BASES,
  SUPPLY_TYPES,
  type CustomerTaxCategory,
  type CustomerTaxIdentityRecord,
  type PlaceOfSupplyBasis,
  type StoreTaxProfileRecord,
  type SupplyType,
  type TaxClassRecord,
  type TaxRateRecord,
  type TaxRepository,
} from './tax.repository.js';

export {
  calculateLineTax,
  grandTotalOf,
  normaliseStateName,
  resolveCustomerTaxCategory,
  resolvePlaceOfSupply,
  resolveSupplyType,
  sumLineTax,
  untaxedLine,
  type LineTax,
  type PlaceOfSupply,
  type ResolvedRates,
} from './tax.calculator.js';

export { createTaxRoutes } from './tax.routes.js';

export {
  SKU_TAX_RESOURCE,
  TAX_AUDIT,
  TAX_CLASS_RESOURCE,
  TAX_PROFILE_RESOURCE,
  TAX_RATE_RESOURCE,
} from './tax.events.js';
