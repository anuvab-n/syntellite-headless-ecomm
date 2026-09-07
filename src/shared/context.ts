import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Ambient per-request / per-job context.
 *
 * Lives in `shared/` rather than `http/` deliberately: workers need it too. A BullMQ
 * job carries the originating `requestId` in its payload and re-enters this store via
 * {@link runWithContext}, so a background failure traces back to the request that
 * caused it.
 */
export type RequestContext = {
  readonly requestId: string;
  readonly storeId?: string;
  readonly userId?: string;
  readonly startedAt: number;
  /** Set on jobs so log lines distinguish a worker execution from the HTTP request. */
  readonly jobName?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Never throws — callers outside a request (startup, migrations) get `undefined`. */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function newRequestId(): string {
  return randomUUID();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Narrow an existing context with additional fields (e.g. `userId` once auth has run).
 * `AsyncLocalStorage` stores are immutable by convention here: replacing the store is
 * safer than mutating it, because a mutated store leaks across concurrent awaits.
 */
export function extendContext<T>(patch: Partial<RequestContext>, fn: () => T): T {
  const current = storage.getStore();
  if (!current) throw new Error('extendContext called outside a context');
  return storage.run({ ...current, ...patch }, fn);
}
