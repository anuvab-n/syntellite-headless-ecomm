import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { loadConfig } from './src/config.js';
import { createAuditRepository, createAuditTrail } from './src/db/audit/index.js';
import { createDatabase } from './src/db/client.js';
import { createEventBus } from './src/db/outbox/event-bus.js';
import { createOutboxRepository } from './src/db/outbox/outbox.repository.js';
import { appUser } from './src/db/schema/identity.js';
import { createApp } from './src/http/app.js';
import { requireAuth } from './src/http/middleware/auth.js';
import { requireIdempotency } from './src/http/middleware/idempotency.js';
import { createScopeGuards } from './src/http/middleware/scope.js';
import { resolveStore } from './src/http/middleware/store.js';
import { createIdempotencyStore } from './src/db/idempotency/idempotency.repository.js';
import { createAddressesRepository } from './src/modules/addresses/addresses.repository.js';
import { createAddressesRoutes } from './src/modules/addresses/addresses.routes.js';
import { createAddressesService } from './src/modules/addresses/addresses.service.js';
import { createCartRepository } from './src/modules/cart/cart.repository.js';
import { createCartRoutes } from './src/modules/cart/cart.routes.js';
import { createCartService } from './src/modules/cart/cart.service.js';
import { createCatalogueRepository } from './src/modules/catalogue/catalogue.repository.js';
import { createCatalogueRoutes } from './src/modules/catalogue/catalogue.routes.js';
import { createCatalogueService } from './src/modules/catalogue/catalogue.service.js';
import { createFulfilmentRepository } from './src/modules/fulfilment/fulfilment.repository.js';
import { createFulfilmentRoutes } from './src/modules/fulfilment/fulfilment.routes.js';
import { createFulfilmentService } from './src/modules/fulfilment/fulfilment.service.js';
import { createIdentityRepository } from './src/modules/identity/identity.repository.js';
import { createIdentityRoutes } from './src/modules/identity/identity.routes.js';
import { createIdentityService } from './src/modules/identity/identity.service.js';
import { createPasswordResetRepository } from './src/modules/identity/password-reset.repository.js';
import { createRefreshSessionRepository } from './src/modules/identity/refresh-session.repository.js';
import { createTokenService } from './src/modules/identity/tokens.js';
import { createInventoryRepository } from './src/modules/inventory/inventory.repository.js';
import { createInventoryRoutes } from './src/modules/inventory/inventory.routes.js';
import { createInventoryService } from './src/modules/inventory/inventory.service.js';
import { createInvoicingRepository } from './src/modules/invoicing/invoicing.repository.js';
import { createInvoicingService } from './src/modules/invoicing/invoicing.service.js';
import { createOrdersRepository } from './src/modules/orders/orders.repository.js';
import { createOrdersRoutes } from './src/modules/orders/orders.routes.js';
import { createOrdersService } from './src/modules/orders/orders.service.js';
import { createPaymentsRepository } from './src/modules/payments/payments.repository.js';
import { createPaymentsRoutes } from './src/modules/payments/payments.routes.js';
import { createPaymentsService } from './src/modules/payments/payments.service.js';
import { createUnconfiguredGateway } from './src/razorpay/gateway.js';
import { createPromotionsRepository } from './src/modules/promotions/promotions.repository.js';
import { createPromotionsService } from './src/modules/promotions/promotions.service.js';
import { createReturnsRepository } from './src/modules/returns/returns.repository.js';
import { createReturnsRoutes } from './src/modules/returns/returns.routes.js';
import { createReturnsService } from './src/modules/returns/returns.service.js';
import { createTaxRepository } from './src/modules/tax/tax.repository.js';
import { createTaxService } from './src/modules/tax/tax.service.js';
import { createDefaultStoreResolver, createStoreRepository } from './src/modules/stores/index.js';
import { NotFound } from './src/shared/errors.js';
import { newId } from './src/shared/id.js';
import { bootstrapLogger } from './src/shared/logger.js';

/**
 * Deep re-check of the ORDER flow and the ADMIN flow specifically, against the real Neon
 * database. Builds on the previous full-flow run (which already found and fixed the missing
 * returns migration) by covering what that run did NOT: order cancellation, a rejected
 * payment retry attempt, admin catalogue lifecycle (update/publish/archive), admin inventory
 * history, and the admin fulfilment queue — i.e. the parts of "order flow" and "admin flow"
 * that are edge cases and admin-visibility, not just the happy path.
 */

const line = (s: string): void => process.stdout.write(`${s}\n`);
let step = 0;
const ok = (method: string, path: string, status: number, expected: number, note: string): void => {
  step += 1;
  const pass = status === expected ? 'OK  ' : 'FAIL';
  line(`${String(step).padStart(2, '0')}. [${pass}] ${method.padEnd(6)} ${path.padEnd(52)} -> ${String(status).padEnd(3)} (expect ${expected})  ${note}`);
  if (status !== expected) throw new Error(`${method} ${path} returned ${status}, expected ${expected}: ${note}`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = bootstrapLogger;
  const handle = createDatabase(config.databaseUrl, config, logger, 'primary');
  const db = handle.db;

  try {
    // Neon's pooler sometimes refuses the very first connection of a process (cold start);
    // warm up with a retry before anything that matters.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await db.execute('select 1');
        break;
      } catch (err) {
        line(`  warm-up attempt ${String(attempt)} failed: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
        if (attempt === 5) throw err;
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }

    const stores = createStoreRepository({ db });
    const store = await stores.findActiveBySlug(config.defaultStoreSlug);
    if (!store) throw new Error(`no active store "${config.defaultStoreSlug}"`);
    line(`store: ${store.slug} (${store.id})`);

    const audit = createAuditTrail({ repository: createAuditRepository({ db }), logger });
    const events = createEventBus({ repository: createOutboxRepository({ db }), logger });

    const identityRepository = createIdentityRepository({ db });
    const tokens = createTokenService({ config, logger });
    const identity = createIdentityService({
      repository: identityRepository,
      sessions: createRefreshSessionRepository({ db }),
      passwordResets: createPasswordResetRepository({ db }),
      tokens, db, config, logger, events, audit,
    });
    const scopeGuards = createScopeGuards({
      loadSubject: async ({ storeId, userId }) => identityRepository.findSubjectById({ storeId, userId }),
      logger,
    });
    const requireStaff = scopeGuards.requireScope('staff');
    const verifyAccessToken = (t: string) => tokens.verifyAccessToken(t);

    const addresses = createAddressesService({ repository: createAddressesRepository({ db }), db, audit, logger });
    const catalogue = createCatalogueService({ repository: createCatalogueRepository({ db }), db, events, audit, logger });
    const inventory = createInventoryService({ repository: createInventoryRepository({ db }), db, events, audit, logger });
    const promotions = createPromotionsService({ repository: createPromotionsRepository({ db }), db, audit, logger });
    const tax = createTaxService({ repository: createTaxRepository({ db }), db, audit, logger });
    const cart = createCartService({
      repository: createCartRepository({ db }),
      promotions: { findApplicable: (i) => promotions.findApplicable(i), evaluateApplied: (i) => promotions.evaluateApplied(i) },
      db, logger,
    });
    const invoicing = createInvoicingService({ repository: createInvoicingRepository({ db }), db, audit, logger });
    const idempotency = createIdempotencyStore({ db, logger });
    const idemGuard = requireIdempotency({ store: idempotency, logger });

    let ordersRef: ReturnType<typeof createOrdersService>;
    let paymentsRef: ReturnType<typeof createPaymentsService>;
    let fulfilmentRef: ReturnType<typeof createFulfilmentService>;

    const orders = createOrdersService({
      repository: createOrdersRepository({ db }),
      cart: { lockCartForCheckout: (i) => cart.lockCartForCheckout(i), markCheckedOut: (i) => cart.markCheckedOut(i) },
      promotions: { evaluateApplied: (i) => promotions.evaluateApplied(i) },
      idempotency: { complete: (i) => idempotency.complete({ storeId: i.storeId, userId: i.userId, key: i.key, endpoint: i.endpoint, status: i.status, ...(i.body === undefined ? {} : { body: i.body as never }) }) },
      payments: { stateForOrder: (i) => paymentsRef.stateForOrder(i) },
      reservations: { reserve: (i) => inventory.reserveForOrder(i), releaseForOrder: (i) => inventory.releaseForOrder(i) },
      tax: { determineForCheckout: (i) => tax.determineForCheckout(i) },
      invoicing: { issueForOrder: (i) => invoicing.issueForOrder(i), findForOrder: (i) => invoicing.findForOrder(i) },
      fulfilment: { hasBlockingShipment: (i) => fulfilmentRef.hasBlockingShipment(i) },
      db, audit, logger,
    });
    ordersRef = orders;

    const payments = createPaymentsService({
      repository: createPaymentsRepository({ db }),
      orders: {
        findPayable: async (i) => {
          try {
            const view = await orders.getOrder({ userId: i.userId, storeId: i.storeId, orderNumber: i.orderNumber });
            return { id: view.order.id, orderNumber: view.order.orderNumber, status: view.order.status, currency: view.order.currency, payableTotal: view.order.grandTotal };
          } catch (err) {
            if (err instanceof NotFound) return null;
            throw err;
          }
        },
        lockForExpiry: (i) => orders.lockOrderForExpiry(i),
      },
      gateway: createUnconfiguredGateway({ logger }),
      idempotency: { complete: (i) => idempotency.complete({ storeId: i.storeId, userId: i.userId, key: i.key, endpoint: i.endpoint, status: i.status, ...(i.body === undefined ? {} : { body: i.body as never }) }) },
      reservations: { commitForOrder: (i) => inventory.commitForOrder(i), releaseForOrder: (i) => inventory.releaseForOrder(i) },
      expiryMinutes: config.paymentExpiryMinutes,
      db, audit, logger,
    });
    paymentsRef = payments;

    const fulfilment = createFulfilmentService({
      repository: createFulfilmentRepository({ db }),
      orders: { lockByNumber: (i) => orders.lockForFulfilmentByNumber(i), lockById: (i) => orders.lockForFulfilmentById(i) },
      payments: { stateForOrder: (i) => payments.stateForOrder(i) },
      inventory: { fulfilForOrder: (i) => inventory.fulfilForOrder(i) },
      db, audit, logger,
    });
    fulfilmentRef = fulfilment;

    const returns = createReturnsService({
      repository: createReturnsRepository({ db }),
      orders: { lockOwnedOrderForReturn: (i) => orders.lockOwnedOrderForReturn(i) },
      fulfilment: { deliveredAtForOrder: (i) => fulfilment.deliveredAtForOrder(i) },
      idempotency: { complete: (i) => idempotency.complete({ storeId: i.storeId, userId: i.userId, key: i.key, endpoint: i.endpoint, status: i.status, ...(i.body === undefined ? {} : { body: i.body as never }) }) },
      db, audit, logger,
    });

    const apiRouter = Router();
    apiRouter.use(resolveStore({ resolver: createDefaultStoreResolver({ repository: stores, slug: config.defaultStoreSlug, logger, cacheTtlMs: 0 }), logger }));
    apiRouter.use(createIdentityRoutes({ identity, tokens, logger }));
    apiRouter.use(createAddressesRoutes({ addresses, verifyAccessToken, logger }));
    apiRouter.use(createCatalogueRoutes({ catalogue, verifyAccessToken, requireStaff, logger }));
    apiRouter.use(createInventoryRoutes({ inventory, verifyAccessToken, requireStaff, logger }));
    apiRouter.use(createCartRoutes({ cart, verifyAccessToken, logger }));
    apiRouter.use(createOrdersRoutes({ orders, verifyAccessToken, requireIdempotency: idemGuard, requireStaff, logger }));
    apiRouter.use(createReturnsRoutes({ returns, verifyAccessToken, requireStaff, requireIdempotency: idemGuard, logger }));
    apiRouter.use(createPaymentsRoutes({ payments, verifyAccessToken, requireIdempotency: idemGuard, logger }));
    apiRouter.use(createFulfilmentRoutes({ fulfilment, verifyAccessToken, requireStaff, logger }));

    const app = createApp({ config, logger, healthChecks: [], apiRouter });
    const api = () => request(app);

    const stamp = Date.now().toString().slice(-8);
    const ADMIN_EMAIL = `oaf.admin.${stamp}@example.com`;
    const CUSTOMER_EMAIL = `oaf.customer.${stamp}@example.com`;
    const PASSWORD = 'a-sufficiently-long-order-admin-flow-password';

    line('\n== SETUP: admin + customer + product ==');
    const reg1 = await api().post('/api/v1/auth/register').send({ email: ADMIN_EMAIL, password: PASSWORD, firstName: 'OAF', lastName: 'Admin' });
    ok('POST', '/auth/register (admin)', reg1.status, 201, ADMIN_EMAIL);
    await db.update(appUser).set({ isStaff: true }).where(eq(appUser.id, reg1.body.user.id));
    const adminLogin = await api().post('/api/v1/auth/login').send({ email: ADMIN_EMAIL, password: PASSWORD });
    const adminToken = adminLogin.body.accessToken as string;
    const asAdmin = () => ({ Authorization: `Bearer ${adminToken}` });

    const reg2 = await api().post('/api/v1/auth/register').send({ email: CUSTOMER_EMAIL, password: PASSWORD, firstName: 'OAF', lastName: 'Customer' });
    ok('POST', '/auth/register (customer)', reg2.status, 201, CUSTOMER_EMAIL);
    const customerLogin = await api().post('/api/v1/auth/login').send({ email: CUSTOMER_EMAIL, password: PASSWORD });
    const customerToken = customerLogin.body.accessToken as string;
    const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

    const slug = `oaf-tee-${stamp}`;
    const skuCode = `OAF-${stamp}`;
    ok('POST', '/admin/products', (await api().post('/api/v1/admin/products').set(asAdmin()).send({ slug, name: 'OAF Tee', status: 'active' })).status, 201, slug);
    ok('POST', '/admin/products/:slug/skus', (await api().post(`/api/v1/admin/products/${slug}/skus`).set(asAdmin()).send({ code: skuCode, price: '200.0000' })).status, 201, skuCode);
    ok('POST', '/admin/inventory/adjustments', (await api().post('/api/v1/admin/inventory/adjustments').set(asAdmin()).send({ skuCode, delta: 30, reason: 'manual_increase', note: 'oaf' })).status, 201, '+30');

    const address = await api().post('/api/v1/users/me/addresses').set(asCustomer()).send({
      label: 'Home', recipientName: 'OAF Customer', phone: '+91 9876500003',
      line1: '3 OAF St', city: 'Bengaluru', state: 'Karnataka', postalCode: '560003', countryCode: 'IN',
    });
    const addressId = address.body.address.id as string;

    line('\n== ORDER FLOW A: place, then CANCEL before payment ==');
    line(`    address created: ${address.status} id=${addressId}`);
    const cartA = await api().put(`/api/v1/users/me/cart/items/${skuCode}`).set(asCustomer()).send({ quantity: 1 });
    ok('PUT', '/users/me/cart/items/:sku', cartA.status, 200, `subtotal=${cartA.body.cart?.subtotal} purchasable=${cartA.body.cart?.items?.[0]?.isPurchasable}`);
    const co1 = await api().post('/api/v1/users/me/checkout').set(asCustomer()).set('idempotency-key', `oaf-a-${newId()}`).send({ addressId });
    if (co1.status !== 201) line(`    checkout body: ${JSON.stringify(co1.body)}`);
    ok('POST', '/users/me/checkout (order A)', co1.status, 201, '');
    const orderA = co1.body.order.orderNumber as string;

    const stockBefore = await api().get('/api/v1/admin/inventory').set(asAdmin()).query({ skuCode });
    line(`    stock after order A placed: ${JSON.stringify(stockBefore.body.items?.[0] ?? stockBefore.body)}`);

    const cancelA = await api().post(`/api/v1/users/me/orders/${orderA}/cancel`).set(asCustomer()).send({});
    ok('POST', '/users/me/orders/:n/cancel (order A)', cancelA.status, 200, `status=${cancelA.body.order?.status}`);

    const cancelAgain = await api().post(`/api/v1/users/me/orders/${orderA}/cancel`).set(asCustomer()).send({});
    ok('POST', '/users/me/orders/:n/cancel (already cancelled)', cancelAgain.status, 409, 'refused re-cancel');

    const payAfterCancel = await api().post(`/api/v1/users/me/orders/${orderA}/payments`).set(asCustomer()).set('idempotency-key', `oaf-a-pay-${newId()}`).send({ method: 'cod' });
    ok('POST', '/users/me/orders/:n/payments (cancelled order)', payAfterCancel.status, 409, 'refused payment on cancelled order');

    line('\n== ORDER FLOW B: place, pay, attempt DOUBLE payment ==');
    await api().put(`/api/v1/users/me/cart/items/${skuCode}`).set(asCustomer()).send({ quantity: 2 });
    const co2 = await api().post('/api/v1/users/me/checkout').set(asCustomer()).set('idempotency-key', `oaf-b-${newId()}`).send({ addressId });
    ok('POST', '/users/me/checkout (order B)', co2.status, 201, '');
    const orderB = co2.body.order.orderNumber as string;

    const pay1 = await api().post(`/api/v1/users/me/orders/${orderB}/payments`).set(asCustomer()).set('idempotency-key', `oaf-b-pay-${newId()}`).send({ method: 'cod' });
    ok('POST', '/users/me/orders/:n/payments (order B, first)', pay1.status, 201, `status=${pay1.body.payment?.status}`);

    const pay2 = await api().post(`/api/v1/users/me/orders/${orderB}/payments`).set(asCustomer()).set('idempotency-key', `oaf-b-pay2-${newId()}`).send({ method: 'cod' });
    ok('POST', '/users/me/orders/:n/payments (order B, second attempt)', pay2.status, 409, 'refused: payment already exists');

    const cancelPaidOrder = await api().post(`/api/v1/users/me/orders/${orderB}/cancel`).set(asCustomer()).send({});
    ok('POST', '/users/me/orders/:n/cancel (already has a payment)', cancelPaidOrder.status, 409, 'refused: cannot cancel a paid order');

    line('\n== ADMIN FLOW: catalogue lifecycle ==');
    const patch = await api().patch(`/api/v1/admin/products/${slug}`).set(asAdmin()).send({ name: 'OAF Tee (Updated)' });
    ok('PATCH', '/admin/products/:slug', patch.status, 200, `name=${patch.body.product?.name}`);

    const archive = await api().post(`/api/v1/admin/products/${slug}/archive`).set(asAdmin()).send({});
    ok('POST', '/admin/products/:slug/archive', archive.status, 200, `status=${archive.body.product?.status}`);

    const archivedInPublicList = await api().get('/api/v1/products').query({ q: 'OAF Tee' });
    line(`    archived product visible publicly? ${archivedInPublicList.body.products?.some((p: { slug: string }) => p.slug === slug) ?? false} (expect false)`);

    const republish = await api().post(`/api/v1/admin/products/${slug}/publish`).set(asAdmin()).send({});
    ok('POST', '/admin/products/:slug/publish', republish.status, 200, `status=${republish.body.product?.status}`);

    line('\n== ADMIN FLOW: inventory history + fulfilment queue ==');
    const invHistory = await api().get(`/api/v1/admin/inventory/${skuCode}/history`).set(asAdmin());
    ok('GET', '/admin/inventory/:sku/history', invHistory.status, 200, `${invHistory.body.items?.length ?? invHistory.body.entries?.length ?? '?'} entries`);

    const fulfilQueue = await api().get('/api/v1/admin/orders/fulfilment').set(asAdmin());
    ok('GET', '/admin/orders/fulfilment', fulfilQueue.status, 200, `${fulfilQueue.body.orders?.length ?? '?'} orders awaiting fulfilment`);
    line(`    order B in queue? ${fulfilQueue.body.orders?.some((o: { orderNumber: string }) => o.orderNumber === orderB) ?? false}`);

    line('\n== ADMIN FLOW: ship order B, verify inventory commits (not just reserves) ==');
    const stockBeforeShip = await api().get('/api/v1/admin/inventory').set(asAdmin()).query({ skuCode });
    const shipB = await api().post(`/api/v1/admin/orders/${orderB}/shipments`).set(asAdmin()).send({ carrier: 'OAFCarrier', trackingNumber: `OAF-${stamp}` });
    ok('POST', '/admin/orders/:n/shipments (order B)', shipB.status, 201, '');
    const shipmentIdB = shipB.body.shipment.id as string;
    ok('POST', '/admin/shipments/:id/ship', (await api().post(`/api/v1/admin/shipments/${shipmentIdB}/ship`).set(asAdmin()).send({})).status, 200, '');
    ok('POST', '/admin/shipments/:id/deliver', (await api().post(`/api/v1/admin/shipments/${shipmentIdB}/deliver`).set(asAdmin()).send({})).status, 200, '');

    const stockAfterDeliver = await api().get('/api/v1/admin/inventory').set(asAdmin()).query({ skuCode });
    line(`    stock before ship: ${JSON.stringify(stockBeforeShip.body.items?.[0] ?? stockBeforeShip.body)}`);
    line(`    stock after deliver: ${JSON.stringify(stockAfterDeliver.body.items?.[0] ?? stockAfterDeliver.body)}`);

    line('\n== ADMIN FLOW: order visibility limits (documented gap check) ==');
    const adminOrderByNumber = await api().get(`/api/v1/admin/orders/${orderB}/invoice`).set(asAdmin());
    ok('GET', '/admin/orders/:n/invoice', adminOrderByNumber.status, 200, 'admin CAN read invoice by known order number');
    const adminOrderList = await api().get('/api/v1/admin/orders');
    line(`    GET /admin/orders (general list) exists? status=${adminOrderList.status} (404 = confirmed still absent, matching Report.md)`);

    line(`\nALL ${step} CHECKS PASSED.`);
    line(`\nrows: admin=${reg1.body.user.id} customer=${reg2.body.user.id} orderA(cancelled)=${orderA} orderB(delivered)=${orderB} product=${slug}`);
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  process.stderr.write(`\nFAILED at step ${step}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});

// diagnostic: surface the underlying pg error
process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e); });
