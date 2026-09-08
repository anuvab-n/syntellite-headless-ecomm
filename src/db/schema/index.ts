/**
 * The schema barrel.
 *
 * `drizzle-kit` reads this file to diff the schema and generate migrations, so a table
 * that is not exported here does not exist as far as migrations are concerned.
 *
 * Note what this barrel is NOT: it is not an invitation for any module to import any
 * table. `dependency-cruiser` restricts table imports to the owning module's repository
 * and service; everything else goes through that module's `index.ts`. The barrel exists
 * for the migration tool and for the test harness that truncates tables between cases.
 */

export * from './_shared.js';
export * from './store.js';
export * from './identity.js';
export * from './password-reset.js';
export * from './tax.js';
export * from './catalogue.js';
export * from './outbox.js';
export * from './idempotency.js';
export * from './inventory.js';
export * from './address.js';
export * from './cart.js';
export * from './promotions.js';
export * from './orders.js';
export * from './payments.js';
export * from './shipments.js';
