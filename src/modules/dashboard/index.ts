/**
 * The dashboard module's public surface.
 *
 * Composition only: ports, a service and a router. **No repository, and no table import
 * anywhere in this module** — every figure is computed by whichever module owns the rows.
 */
export {
  createDashboardService,
  resolveWindow,
  DASHBOARD_INTERVALS,
  type DashboardService,
  type DashboardInterval,
  type DashboardWindow,
  type DashboardView,
  type DashboardOrders,
  type DashboardCatalogue,
  type DashboardCustomers,
  type DashboardInventory,
} from './dashboard.service.js';
export { createDashboardRoutes } from './dashboard.routes.js';
export {
  DashboardQuerySchema,
  toDashboardResponse,
  type DashboardQuery,
  type DashboardResponse,
} from './dto.js';
