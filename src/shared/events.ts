/**
 * Domain event contracts.
 *
 * Types only — no I/O, no imports from `db/`. That is what lets domain code declare
 * "this happened" without depending on how, or whether, anybody listens.
 *
 * Why events at all: without them, `completeCheckout()` grows a line for every feature
 * the business adds — email, analytics, search reindex, loyalty points, webhooks — and the
 * most dangerous function in the system becomes the most frequently edited one. With them,
 * checkout announces `order.placed` and never changes again.
 *
 * Payload rule: carry IDS AND FACTS, never entities. A payload holding a serialised order
 * is already stale by the time a handler runs — that is the definition of async. Carry
 * `orderId` plus whatever was true at emission (`total`, `currency`), and let the handler
 * re-read what it needs.
 */

/**
 * An event as the emitter declares it.
 *
 * `type` says what happened; `aggregateType` + `aggregateId` say what it happened to.
 * Both halves are persisted, because during an incident the question is almost never
 * "show me every order.placed" — it is "show me everything that happened to THIS order".
 */
export type DomainEvent<TPayload extends JsonObject = JsonObject> = {
  /**
   * What happened. Dotted, past tense, and permanent: `order.placed`, `stock.reserved`.
   * Persisted in `outbox_event.event_name` and matched against the handler registry, so
   * renaming one orphans every unpublished row already in the table. Add a new type.
   */
  readonly type: string;
  /** What it happened TO: `order`, `payment`, `stock_item`. */
  readonly aggregateType: string;
  /** Which one. */
  readonly aggregateId: string;
  readonly payload: TPayload;
  /**
   * The tenant this event belongs to. Omitted only for genuinely platform-level events
   * emitted before a store is resolved.
   */
  readonly storeId?: string;
  /**
   * When the business fact happened, if it differs from "now". Defaults to the emission
   * time. Set it explicitly when replaying or backfilling, so ordering stays truthful.
   */
  readonly occurredAt?: Date;
  /**
   * Delay first publication until this time. For "release the reservation in 15 minutes"
   * style scheduling, without a separate timer table.
   */
  readonly availableAt?: Date;
};

/* ── JSON typing ─────────────────────────────────────────────────────────── */

/**
 * Payloads must be genuinely JSON-serialisable, because they round-trip through a `jsonb`
 * column. Typing this properly means a `Date`, a `Map`, or a `Money` in a payload is a
 * compile error rather than a `{}` discovered by a handler at 3 a.m.
 *
 * Serialise deliberately: dates as ISO strings, money as `{ amount, currency }`.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/* ── The bus ─────────────────────────────────────────────────────────────── */

/**
 * The only sanctioned way to announce that something happened.
 *
 * `emit` does NOT enqueue a job. It writes a row to `outbox_event` using the CALLER'S open
 * transaction, so the event and the business change commit together or not at all. A
 * separate drainer publishes it afterwards.
 *
 * A lint rule bans `queue.add` outside the outbox module for exactly this reason:
 * enqueueing inside a transaction lets a worker read uncommitted data, and enqueueing
 * after it loses the job if the process dies in between.
 */
export type EventBus = {
  emit(event: DomainEvent, options?: EmitOptions): Promise<EmittedEvent>;
  /** Emit several events atomically. One INSERT, one round trip. */
  emitAll(events: readonly DomainEvent[], options?: EmitOptions): Promise<EmittedEvent[]>;
};

export type EmitOptions = {
  /**
   * Permit emission with no open transaction.
   *
   * Off by default, and the default is the point. An `emit()` with no ambient transaction
   * is usually a caller who *believes* the event is atomic with a business write that
   * actually committed separately — the exact bug the outbox exists to prevent, wearing a
   * disguise. Failing loudly beats a silent non-guarantee.
   *
   * Legitimate uses: a scheduled job whose only output IS the event, and tests.
   */
  allowOutsideTransaction?: boolean;
};

/** What `emit` returns: enough to assert on in a test, or to log. */
export type EmittedEvent = {
  readonly id: string;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
};

/* ── Handlers ────────────────────────────────────────────────────────────── */

/**
 * A subscriber.
 *
 * MUST be idempotent. Outbox delivery is at-least-once, not exactly-once: a worker that
 * crashes between performing the side effect and acking the job will be handed the same
 * event again. For effects that are not naturally idempotent, claim a `processed_event`
 * row first — see `claimForHandler` in the outbox module.
 */
export type EventHandler = (event: DeliveredEvent) => Promise<void>;

/** An event as a handler receives it, with the persisted identity attached. */
export type DeliveredEvent = {
  readonly id: string;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: JsonObject;
  readonly storeId: string | null;
  readonly occurredAt: Date;
  readonly attempts: number;
  /** The request that caused this, for log correlation across the async boundary. */
  readonly requestId: string | null;
};
