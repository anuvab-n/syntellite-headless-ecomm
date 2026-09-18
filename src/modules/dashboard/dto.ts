import { z } from 'zod';

import { boundedIntParam } from '../../shared/pagination.js';
import { DASHBOARD_INTERVALS, type DashboardView } from './dashboard.service.js';

/**
 * The admin dashboard's request and response contract.
 *
 * ## What the request may contain
 *
 * Six parameters, and `strictObject` makes that enforceable rather than merely intended: an
 * unknown key is a `400` naming it. **`storeId` is not among them and never will be** — tenancy
 * comes from the verified staff token, and because the object is strict, supplying one is a
 * rejection rather than a silently ignored key.
 *
 * ## What the response may contain
 *
 * No internal identifiers. SKUs are addressed by their merchant `code`, orders by their
 * `orderNumber`, and there is no product id, SKU id, order id, user id or store id anywhere in
 * the payload. Money is a `NUMERIC(19,4)` decimal string throughout, never a JSON number.
 */

/* ── Request ─────────────────────────────────────────────────────────────── */

/**
 * An ISO-8601 instant WITH an offset, matching the admin order, payment and customer lists.
 *
 * The client owns the timezone, deliberately: a bare `YYYY-MM-DD` would force the server to pick
 * one to widen it into, and every choice is wrong for somebody — UTC misfiles the edges of an
 * Indian trading day, and the store's own zone surprises an operator working from another.
 */
const instantField = z.iso.datetime({ offset: true });

export const DASHBOARD_TOP_PRODUCTS_DEFAULT = 5;
export const DASHBOARD_LOW_STOCK_DEFAULT = 10;
export const DASHBOARD_RECENT_ORDERS_DEFAULT = 10;

export const DashboardQuerySchema = z.strictObject({
  /**
   * The analytics window. **Both bounds inclusive, at millisecond granularity.**
   *
   * Omitted, the window is the last twelve calendar months through now — the design's chart is
   * monthly, and a 30-day default would render one or two bars.
   */
  from: instantField.optional(),
  to: instantField.optional(),

  /** Calendar bucket for the sales series, truncated in the STORE's timezone. */
  interval: z.enum(DASHBOARD_INTERVALS).default('month'),

  topProductsLimit: boundedIntParam({ min: 1, max: 20, default: DASHBOARD_TOP_PRODUCTS_DEFAULT }),
  lowStockLimit: boundedIntParam({ min: 1, max: 50, default: DASHBOARD_LOW_STOCK_DEFAULT }),
  recentOrdersLimit: boundedIntParam({
    min: 1,
    max: 20,
    default: DASHBOARD_RECENT_ORDERS_DEFAULT,
  }),
});

export type DashboardQuery = z.infer<typeof DashboardQuerySchema>;

/* ── Response ────────────────────────────────────────────────────────────── */

export type DashboardKpiMoney = {
  value: string;
  currency: string;
  /** The equal-length window immediately before this one. */
  previous: string;
};

export type DashboardKpiCount = {
  value: number;
  /**
   * `null` for products and customers, deliberately.
   *
   * Both are cumulative "as of now" facts with no recorded history — there is no product status
   * history and no customer count snapshot — so a previous value could only be invented. `null`
   * says "no comparison exists", which a client can render differently from a zero delta.
   */
  previous: number | null;
};

export type DashboardResponse = {
  range: {
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
    timezone: string;
    interval: string;
  };
  kpis: {
    revenue: DashboardKpiMoney;
    orders: DashboardKpiCount;
    products: DashboardKpiCount;
    customers: DashboardKpiCount;
  };
  salesSeries: { bucket: string; revenue: string; orders: number }[];
  orderStatusCounts: Record<string, number>;
  topProducts: {
    skuCode: string;
    productName: string;
    skuName: string;
    quantitySold: number;
    revenue: string;
  }[];
  lowStock: {
    skuCode: string;
    productName: string;
    skuName: string;
    onHand: number;
    reserved: number;
    available: number;
    threshold: number;
  }[];
  /** The admin order list's own row shape, reused verbatim rather than restated here. */
  recentOrders: unknown[];
};

export function toDashboardResponse(view: DashboardView): DashboardResponse {
  return {
    range: {
      from: view.window.from.toISOString(),
      to: view.window.to.toISOString(),
      previousFrom: view.window.previousFrom.toISOString(),
      previousTo: view.window.previousTo.toISOString(),
      timezone: view.timezone,
      interval: view.interval,
    },
    kpis: {
      revenue: {
        value: view.revenue,
        currency: view.currency,
        previous: view.previousRevenue,
      },
      orders: { value: view.orders, previous: view.previousOrders },
      products: { value: view.products, previous: null },
      customers: { value: view.customers, previous: null },
    },
    salesSeries: view.series.map((point) => ({
      bucket: point.bucket,
      revenue: point.revenue,
      orders: point.orders,
    })),
    orderStatusCounts: view.statusCounts,
    topProducts: view.topProducts.map((row) => ({
      skuCode: row.skuCode,
      productName: row.productName,
      skuName: row.skuName,
      quantitySold: row.quantity,
      revenue: row.revenue,
    })),
    lowStock: view.lowStock.map((row) => ({
      skuCode: row.skuCode,
      productName: row.productName,
      skuName: row.skuName,
      onHand: row.onHand,
      reserved: row.reserved,
      available: row.available,
      /* Never null on a row the query returned — the predicate requires a configured threshold. */
      threshold: row.threshold ?? 0,
    })),
    recentOrders: [...view.recentOrders],
  };
}
