import { AsyncLocalStorage } from 'node:async_hooks';

import type { Logger } from '../shared/logger.js';
import type { Database } from './client.js';

/**
 * Transaction helpers.
 *
 * Two things live here:
 *
 *   withTransaction — runs a unit of work, and makes the ambient transaction discoverable
 *                     so nested service calls join it instead of opening a second one.
 *   onCommit        — defers a side effect until after COMMIT.
 *
 * On `onCommit` versus the outbox — this matters and is easy to get wrong:
 *
 *   `onCommit` runs in THIS process, immediately after the commit. If the process dies in
 *   that window, the callback is simply lost. That is acceptable for cache invalidation
 *   (the next read repopulates) and unacceptable for a confirmation email.
 *
 *   Anything a customer or an auditor would notice going missing uses the OUTBOX, which
 *   commits atomically with the business state and is drained with at-least-once
 *   delivery. When in doubt, use the outbox.
 */

/** The transaction handle Drizzle hands to a callback. Interchangeable with `Database`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Either a pooled connection or an open transaction. Services accept this. */
export type Executor = Database | Transaction;

type TransactionState = {
  tx: Transaction;
  afterCommit: Array<() => Promise<void>>;
  depth: number;
};

const store = new AsyncLocalStorage<TransactionState>();

/** The ambient transaction, if the caller is inside one. */
export function currentTransaction(): Transaction | undefined {
  return store.getStore()?.tx;
}

export function isInTransaction(): boolean {
  return store.getStore() !== undefined;
}

export type WithTransactionOptions = {
  /**
   * Force a genuinely new, independent transaction even when one is already open.
   *
   * Almost always wrong. The one legitimate case is writing a record that must survive
   * the rollback of the surrounding work — a failed-payment audit row, for instance.
   * Requires its own connection, so it cannot see uncommitted outer state.
   */
  independent?: boolean;
};

/**
 * Run `fn` inside a transaction.
 *
 * Re-entrant by default: a service that calls another service inside a transaction JOINS
 * it rather than opening a second one. Without this, `checkout.complete()` calling
 * `inventory.reserve()` would run in two separate transactions, and a later failure would
 * roll back the order while leaving the stock committed.
 *
 * A nested call adds a SAVEPOINT via Drizzle's nested `transaction()`, so an inner failure
 * that the caller catches does not poison the outer transaction.
 *
 * @param db The primary database. Never a replica — the callback may write and lock.
 */
export async function withTransaction<T>(
  db: Database,
  logger: Logger,
  fn: (tx: Transaction) => Promise<T>,
  options: WithTransactionOptions = {},
): Promise<T> {
  const existing = store.getStore();

  if (existing && !options.independent) {
    // Join the ambient transaction. `afterCommit` callbacks registered in here fire when
    // the OUTERMOST transaction commits, which is the only correct moment.
    return existing.tx.transaction(async (nested) =>
      store.run({ ...existing, tx: nested, depth: existing.depth + 1 }, () => fn(nested)),
    );
  }

  const afterCommit: Array<() => Promise<void>> = [];

  const result = await db.transaction(async (tx) =>
    store.run({ tx, afterCommit, depth: 0 }, () => fn(tx)),
  );

  // Only reached if the transaction COMMITTED — a throw propagates before this line.
  for (const callback of afterCommit) {
    try {
      await callback();
    } catch (err) {
      // A failed after-commit callback must never surface as a failed request: the
      // business state is already durably committed. Log it and move on.
      logger.error({ err }, 'after_commit_callback_failed');
    }
  }

  return result;
}

/**
 * Register a side effect to run after the outermost transaction commits.
 *
 * For LOSABLE effects only — cache invalidation, a metric, a debug log. Anything durable
 * belongs in the outbox. See the note at the top of this file.
 *
 * Throws outside a transaction, deliberately: silently running the callback immediately
 * would mean it fires before the write it depends on, which is the exact bug this exists
 * to prevent.
 */
export function onCommit(callback: () => Promise<void>): void {
  const state = store.getStore();
  if (!state) {
    throw new Error(
      'onCommit() called outside a transaction. Wrap the work in withTransaction(), ' +
        'or if the effect must not be lost, emit a domain event instead.',
    );
  }
  state.afterCommit.push(callback);
}

/**
 * The executor a repository or service should use: the ambient transaction if one is
 * open, otherwise the pool.
 *
 * This is what lets a selector be called both standalone and inside a checkout and see
 * the right data in each case — inside the transaction it sees the uncommitted writes it
 * is about to depend on.
 */
export function executor(db: Database): Executor {
  return currentTransaction() ?? db;
}
