import type { Logger } from '../../shared/logger.js';
import { exclusiveEndOfMillisecond } from '../../shared/time-bounds.js';

/**
 * The admin dashboard: one screen, composed from five modules that each own their own data.
 *
 * ## Why this module has no repository
 *
 * It never touches a table. Every figure below is computed by the module that owns the rows —
 * orders counts orders, catalogue counts products, identity counts customers, inventory reads
 * stock — and this service only asks, in parallel, and assembles the answers.
 *
 * That is the whole design. Increment 53 declined a single `/admin/dashboard/summary` precisely
 * because it would have needed a new module, a new port, or a cross-module import; its actual
 * principle was that **each module aggregates only the tables it owns**, and this composition
 * keeps that principle while paying the one cost that increment avoided. What changed is the
 * payload: three counts became seven widgets across four modules, and seven round trips to paint
 * one screen is a worse trade than one composition layer with no database of its own.
 *
 * ## What the date range does and does not touch
 *
 * The range is an ANALYTICS window. It governs revenue, order count, the series and the top
 * products, and nothing else. Product and customer counts, order status, low stock and recent
 * orders are "as of now" operational facts — a customer total narrowed to 30 days would be read
 * as a lifetime figure and quietly mislead.
 *
 * ## Money
 *
 * Every monetary value here arrives as a `NUMERIC(19,4)` string from the database and leaves as
 * the same string. Nothing in this file adds, compares or rounds money, so there is no place for
 * binary floating point to enter — `money.ts`'s rule, satisfied by not doing arithmetic at all.
 */

/* ── Ports ───────────────────────────────────────────────────────────────── */

/**
 * The order-side figures. Declared here, implemented by the orders module.
 *
 * All four take an already-resolved half-open window, because the decision about what an
 * inclusive `to` means belongs in one place — this module's request handling, next to
 * `exclusiveEndOfMillisecond` — rather than being re-made by every module that reads a date.
 */
export type DashboardOrders = {
  /** Billed value and order count, for the window and the one before it, in one statement. */
  revenue(params: {
    storeId: string;
    from: Date;
    toExclusive: Date;
    previousFrom: Date;
    previousToExclusive: Date;
  }): Promise<{
    revenue: string;
    orders: number;
    previousRevenue: string;
    previousOrders: number;
  }>;

  /** Revenue and order count per calendar bucket, truncated in the store's timezone. */
  series(params: {
    storeId: string;
    from: Date;
    toExclusive: Date;
    unit: DashboardInterval;
    timezone: string;
  }): Promise<readonly { bucket: string; revenue: string; orders: number }[]>;

  /** Best-selling SKUs of the window, by snapshotted identity. */
  topSkus(params: { storeId: string; from: Date; toExclusive: Date; limit: number }): Promise<
    readonly {
      skuCode: string;
      productName: string;
      skuName: string;
      quantity: number;
      revenue: string;
    }[]
  >;

  /** Orders by composed display status (§49). Every status present, including at zero. */
  statusCounts(params: { storeId: string }): Promise<Record<string, number>>;

  /** The newest orders, in the shape the admin order list already publishes. */
  recent(params: { storeId: string; limit: number }): Promise<readonly unknown[]>;
};

export type DashboardCatalogue = {
  countActiveProducts(params: { storeId: string }): Promise<number>;
};

export type DashboardCustomers = {
  countLiveCustomers(params: { storeId: string }): Promise<number>;
};

export type DashboardInventory = {
  lowStock(params: { storeId: string; limit: number }): Promise<
    readonly {
      skuCode: string;
      skuName: string;
      productName: string;
      onHand: number;
      reserved: number;
      available: number;
      threshold: number | null;
    }[]
  >;
};

/*
 * There is deliberately NO store port.
 *
 * The currency and the calendar timezone are store configuration, and `resolveStore` has already
 * read both onto the request before this route's guard runs. A port back to the store module
 * would be a second read of a row the request is holding, so the route passes them in instead.
 */

/* ── The window ──────────────────────────────────────────────────────────── */

export const DASHBOARD_INTERVALS = ['day', 'week', 'month'] as const;
export type DashboardInterval = (typeof DASHBOARD_INTERVALS)[number];

/** How far back the dashboard looks when the caller names no window. */
const DEFAULT_MONTHS_BACK = 12;

export type DashboardWindow = {
  readonly from: Date;
  readonly toExclusive: Date;
  /** The inclusive instant the caller asked for, echoed back. */
  readonly to: Date;
  readonly previousFrom: Date;
  readonly previousToExclusive: Date;
  readonly previousTo: Date;
};

/**
 * Resolve the analytics window, and the equal-length window immediately before it.
 *
 * **Half-open, `[from, toExclusive)`.** The upper bound is the start of the millisecond AFTER the
 * one the caller named, via `exclusiveEndOfMillisecond` — the same helper the order, payment and
 * customer lists use. `placed_at` is microsecond-precise in PostgreSQL and millisecond-precise
 * everywhere in this API, so `<=` would drop a row whose stored microseconds were non-zero,
 * including the row whose own published timestamp the client had just used as the bound.
 *
 * **The previous window abuts, and never overlaps.** It ends exactly where the current one
 * begins — `previousToExclusive === from` — and is the same DURATION, not the same calendar
 * shape. Equal duration is what makes the comparison arithmetic honest; a "previous calendar
 * month" would compare 28 days against 31 and call the difference growth.
 *
 * The default window is the last twelve months through now, because the design's chart is
 * monthly and a 30-day default would render one or two bars.
 */
export function resolveWindow(params: { from?: Date; to?: Date; now: Date }): DashboardWindow {
  const to = params.to ?? params.now;

  const defaultFrom = new Date(to.getTime());
  defaultFrom.setUTCMonth(defaultFrom.getUTCMonth() - DEFAULT_MONTHS_BACK);
  const from = params.from ?? defaultFrom;

  const toExclusive = exclusiveEndOfMillisecond(to);
  const durationMs = toExclusive.getTime() - from.getTime();

  const previousToExclusive = new Date(from.getTime());
  const previousFrom = new Date(from.getTime() - durationMs);

  return {
    from,
    to,
    toExclusive,
    previousFrom,
    previousToExclusive,
    /* The inclusive instant one millisecond before the current window opens. */
    previousTo: new Date(previousToExclusive.getTime() - 1),
  };
}

/* ── The service ─────────────────────────────────────────────────────────── */

export type DashboardService = ReturnType<typeof createDashboardService>;

export type DashboardView = {
  window: DashboardWindow;
  interval: DashboardInterval;
  currency: string;
  timezone: string;
  revenue: string;
  previousRevenue: string;
  orders: number;
  previousOrders: number;
  products: number;
  customers: number;
  series: readonly { bucket: string; revenue: string; orders: number }[];
  statusCounts: Record<string, number>;
  topProducts: readonly {
    skuCode: string;
    productName: string;
    skuName: string;
    quantity: number;
    revenue: string;
  }[];
  lowStock: readonly {
    skuCode: string;
    skuName: string;
    productName: string;
    onHand: number;
    reserved: number;
    available: number;
    threshold: number | null;
  }[];
  recentOrders: readonly unknown[];
};

export function createDashboardService(deps: {
  orders: DashboardOrders;
  catalogue: DashboardCatalogue;
  customers: DashboardCustomers;
  inventory: DashboardInventory;
  logger: Logger;
}) {
  const { orders, catalogue, customers, inventory } = deps;

  return {
    /**
     * Every dashboard figure, in eight statements across four modules. Read-only throughout.
     *
     * All eight are independent and run CONCURRENTLY, so the dashboard costs roughly one round
     * trip plus the slowest aggregate rather than the sum of them. Every one is a bounded SQL
     * aggregate or an explicitly limited list: no order, order line, product or SKU set is ever
     * loaded into application memory, and nothing here reads per row.
     *
     * No write of any kind: no audit row, no event, no state change.
     */
    async overview(params: {
      storeId: string;
      window: DashboardWindow;
      interval: DashboardInterval;
      /**
       * The store's currency and calendar timezone, from the ALREADY-RESOLVED request store.
       *
       * Passed in rather than fetched: `resolveStore` read both before this route's guard ran,
       * so a port back to the store module would re-read a row the request is already holding.
       * The timezone is not cosmetic — bucketing a month in UTC misfiles every order placed
       * after 18:30 IST on the last day of the month.
       */
      currency: string;
      timezone: string;
      topProductsLimit: number;
      lowStockLimit: number;
      recentOrdersLimit: number;
    }): Promise<DashboardView> {
      const scoped = {
        storeId: params.storeId,
        from: params.window.from,
        toExclusive: params.window.toExclusive,
      };

      const [
        revenue,
        series,
        topProducts,
        statusCounts,
        products,
        customerCount,
        lowStock,
        recent,
      ] = await Promise.all([
        orders.revenue({
          ...scoped,
          previousFrom: params.window.previousFrom,
          previousToExclusive: params.window.previousToExclusive,
        }),
        orders.series({ ...scoped, unit: params.interval, timezone: params.timezone }),
        orders.topSkus({ ...scoped, limit: params.topProductsLimit }),
        orders.statusCounts({ storeId: params.storeId }),
        catalogue.countActiveProducts({ storeId: params.storeId }),
        customers.countLiveCustomers({ storeId: params.storeId }),
        inventory.lowStock({ storeId: params.storeId, limit: params.lowStockLimit }),
        orders.recent({ storeId: params.storeId, limit: params.recentOrdersLimit }),
      ]);

      return {
        window: params.window,
        interval: params.interval,
        currency: params.currency,
        timezone: params.timezone,
        revenue: revenue.revenue,
        previousRevenue: revenue.previousRevenue,
        orders: revenue.orders,
        previousOrders: revenue.previousOrders,
        products,
        customers: customerCount,
        series: fillBuckets({
          rows: series,
          window: params.window,
          interval: params.interval,
          timezone: params.timezone,
        }),
        statusCounts,
        topProducts,
        lowStock,
        recentOrders: recent,
      };
    },
  };
}

/* ── Bucket filling ──────────────────────────────────────────────────────── */

/**
 * Emit every bucket the window spans, zero-filled where the database returned nothing.
 *
 * A `GROUP BY` can only report buckets that contain rows. A chart needs the empty ones too —
 * a month with no sales is a fact, and omitting it would draw a line straight from March to May.
 *
 * The bucket keys come back from PostgreSQL as `YYYY-MM-DD` local dates (the `date_trunc` ran
 * `AT TIME ZONE` the store's zone), so the calendar walk here is done on those same local dates
 * rather than on instants. That keeps one notion of "which bucket is this" instead of two that
 * could disagree at a boundary.
 */
function fillBuckets(params: {
  rows: readonly { bucket: string; revenue: string; orders: number }[];
  window: DashboardWindow;
  interval: DashboardInterval;
  timezone: string;
}): { bucket: string; revenue: string; orders: number }[] {
  const byBucket = new Map(params.rows.map((row) => [localDate(row.bucket), row]));

  const first = startOfBucket(localDateOf(params.window.from, params.timezone), params.interval);
  const last = startOfBucket(localDateOf(params.window.to, params.timezone), params.interval);

  const out: { bucket: string; revenue: string; orders: number }[] = [];
  let cursor = first;

  /*
   * Bounded by the window, and by a hard ceiling: a caller asking for five years of daily
   * buckets would otherwise build 1,800 objects. The validated `limit` on the request cannot
   * express that, so the guard lives here.
   */
  for (let guard = 0; cursor <= last && guard < MAX_BUCKETS; guard += 1) {
    const found = byBucket.get(cursor);
    out.push({
      bucket: cursor,
      revenue: found?.revenue ?? ZERO_MONEY,
      orders: found?.orders ?? 0,
    });
    cursor = nextBucket(cursor, params.interval);
  }

  return out;
}

/** The zero a bucket with no orders carries, at `NUMERIC(19,4)` scale. A STRING, never a number. */
const ZERO_MONEY = '0.0000';

/**
 * The most buckets any one response may contain.
 *
 * Roughly five years of days. A dashboard is a screen, not an export, and an unbounded series is
 * the one part of this response whose size a client controls.
 */
const MAX_BUCKETS = 1900;

/** `YYYY-MM-DD` from whatever shape the driver handed back for a `date_trunc` result. */
function localDate(value: string | Date): string {
  return value instanceof Date ? isoDate(value) : String(value).slice(0, 10);
}

/** The calendar date an instant falls on, in the given zone. */
function localDateOf(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * The first date of the bucket a local date belongs to.
 *
 * `week` truncates to MONDAY, matching PostgreSQL's `date_trunc('week', ...)` — ISO-8601 weeks.
 * Getting this wrong by a day would put the fill and the query in different weeks, and the chart
 * would show a duplicate bucket beside an empty one.
 */
function startOfBucket(date: string, interval: DashboardInterval): string {
  if (interval === 'day') return date;

  const at = new Date(`${date}T00:00:00Z`);
  if (interval === 'month') {
    at.setUTCDate(1);
    return isoDate(at);
  }

  /* Monday-based: getUTCDay() is 0 for Sunday, so Sunday steps back six days rather than none. */
  const weekday = at.getUTCDay();
  const stepBack = weekday === 0 ? 6 : weekday - 1;
  at.setUTCDate(at.getUTCDate() - stepBack);
  return isoDate(at);
}

function nextBucket(date: string, interval: DashboardInterval): string {
  const at = new Date(`${date}T00:00:00Z`);
  if (interval === 'day') at.setUTCDate(at.getUTCDate() + 1);
  else if (interval === 'week') at.setUTCDate(at.getUTCDate() + 7);
  else at.setUTCMonth(at.getUTCMonth() + 1);
  return isoDate(at);
}
