import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { loadConfig } from '../../src/config.js';
import { createAuditRepository, createAuditTrail } from '../../src/db/audit/index.js';
import { createDatabase } from '../../src/db/client.js';
import { seed } from '../../src/db/seed.js';
import { createEventBus } from '../../src/db/outbox/event-bus.js';
import { createOutboxRepository } from '../../src/db/outbox/outbox.repository.js';
import { appUser } from '../../src/db/schema/identity.js';
import { createApp } from '../../src/http/app.js';
import { requireAuth } from '../../src/http/middleware/auth.js';
import { requireIdempotency } from '../../src/http/middleware/idempotency.js';
import { createScopeGuards } from '../../src/http/middleware/scope.js';
import { resolveStore } from '../../src/http/middleware/store.js';
import { createIdempotencyStore } from '../../src/db/idempotency/idempotency.repository.js';
import { createAddressesRepository } from '../../src/modules/addresses/addresses.repository.js';
import { createAddressesRoutes } from '../../src/modules/addresses/addresses.routes.js';
import { createAddressesService } from '../../src/modules/addresses/addresses.service.js';
import { createCartRepository } from '../../src/modules/cart/cart.repository.js';
import { createCartRoutes } from '../../src/modules/cart/cart.routes.js';
import { createCartService } from '../../src/modules/cart/cart.service.js';
import { createCatalogueRepository } from '../../src/modules/catalogue/catalogue.repository.js';
import { createCatalogueRoutes } from '../../src/modules/catalogue/catalogue.routes.js';
import { createCatalogueService } from '../../src/modules/catalogue/catalogue.service.js';
import { createFulfilmentRepository } from '../../src/modules/fulfilment/fulfilment.repository.js';
import { createFulfilmentRoutes } from '../../src/modules/fulfilment/fulfilment.routes.js';
import { createFulfilmentService } from '../../src/modules/fulfilment/fulfilment.service.js';
import { createIdentityRepository } from '../../src/modules/identity/identity.repository.js';
import { createIdentityRoutes } from '../../src/modules/identity/identity.routes.js';
import { createIdentityService } from '../../src/modules/identity/identity.service.js';
import { createPasswordResetRepository } from '../../src/modules/identity/password-reset.repository.js';
import { createRefreshSessionRepository } from '../../src/modules/identity/refresh-session.repository.js';
import { createTokenService } from '../../src/modules/identity/tokens.js';
import { createInventoryRepository } from '../../src/modules/inventory/inventory.repository.js';
import { createInventoryRoutes } from '../../src/modules/inventory/inventory.routes.js';
import { createInventoryService } from '../../src/modules/inventory/inventory.service.js';
import { createInvoicingRepository } from '../../src/modules/invoicing/invoicing.repository.js';
import { createInvoicingService } from '../../src/modules/invoicing/invoicing.service.js';
import { createOrdersRepository } from '../../src/modules/orders/orders.repository.js';
import { createOrdersRoutes } from '../../src/modules/orders/orders.routes.js';
import { createOrdersService } from '../../src/modules/orders/orders.service.js';
import { createPaymentsRepository, createRefundsRepository, createRefundsService } from '../../src/modules/payments/index.js';
import { createPaymentsRoutes } from '../../src/modules/payments/payments.routes.js';
import { createPaymentsService } from '../../src/modules/payments/payments.service.js';
import { createUnconfiguredGateway } from '../../src/razorpay/gateway.js';
import { createUnconfiguredMediaStorage } from '../../src/storage/media-storage.js';
import { createPromotionsRepository } from '../../src/modules/promotions/promotions.repository.js';
import { createPromotionsService } from '../../src/modules/promotions/promotions.service.js';
import { createReturnsRepository } from '../../src/modules/returns/returns.repository.js';
import { createReturnsRoutes } from '../../src/modules/returns/returns.routes.js';
import { createReturnsService } from '../../src/modules/returns/returns.service.js';
import { createTaxRepository } from '../../src/modules/tax/tax.repository.js';
import { createTaxService } from '../../src/modules/tax/tax.service.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../src/modules/stores/index.js';
import { NotFound } from '../../src/shared/errors.js';
import { newId } from '../../src/shared/id.js';
import { bootstrapLogger } from '../../src/shared/logger.js';

/**
 * End-To-End Test: Multi-Variant Pricing, Cart Selection, Checkout & Payment
 * Target Database: Specific Neon PostgreSQL Instance
 */

const TARGET_DB_URL =
  process.env['DATABASE_URL'] ||
  'postgresql://neondb_owner:npg_HArnZm0au7xM@ep-bitter-lab-b583w2fo-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const printLine = (msg: string): void => {
  process.stdout.write(`${msg}\n`);
};
let stepCount = 0;

function logStep(
  phase: string,
  method: string,
  path: string,
  status: number,
  expectedStatus: number,
  details: string
): void {
  stepCount += 1;
  const isPass = status === expectedStatus;
  const statusStr = isPass ? 'PASS' : 'FAIL';
  const formattedStep = String(stepCount).padStart(2, '0');
  printLine(
    `[${statusStr}] Step ${formattedStep} | ${phase.padEnd(28)} | ${method.padEnd(6)} ${path.padEnd(58)} -> Status: ${status} (Expected: ${expectedStatus}) | ${details}`
  );
  if (!isPass) {
    throw new Error(
      `Step ${stepCount} failed: ${method} ${path} returned status ${status}, expected ${expectedStatus}. Context: ${details}`
    );
  }
}

async function runVariantCheckoutPaymentJourney(): Promise<void> {
  printLine('========================================================================================');
  printLine('      E2E MULTI-VARIANT PRICING, CART SELECTION, CHECKOUT & PAYMENT TEST SUITE      ');
  printLine('========================================================================================');
  printLine(`Target Database: ${TARGET_DB_URL.split('@')[1] || TARGET_DB_URL}`);
  printLine('----------------------------------------------------------------------------------------\n');

  process.env['DATABASE_URL'] = TARGET_DB_URL;

  const config = loadConfig();
  const logger = bootstrapLogger;
  const dbHandle = createDatabase(TARGET_DB_URL, config, logger, 'primary');
  const db = dbHandle.db;

  try {
    printLine('>>> PHASE 1: Connection Warmup & Active Store Setup');
    await db.execute('SELECT 1');
    printLine('  [OK] Database connection active.');

    const storesRepo = createStoreRepository({ db });
    const { store: activeStore } = await seed({ db, config, logger });
    printLine(`  [OK] Active Store Loaded: Slug="${activeStore.slug}", StoreID="${activeStore.id}"\n`);

    const audit = createAuditTrail({ repository: createAuditRepository({ db }), logger });
    const events = createEventBus({ repository: createOutboxRepository({ db }), logger });

    const identityRepository = createIdentityRepository({ db });
    const tokens = createTokenService({ config, logger });
    const identity = createIdentityService({
      repository: identityRepository,
      sessions: createRefreshSessionRepository({ db }),
      passwordResets: createPasswordResetRepository({ db }),
      tokens,
      db,
      config,
      logger,
      events,
      audit,
    });

    const scopeGuards = createScopeGuards({
      loadSubject: async ({ storeId, userId }) => identityRepository.findSubjectById({ storeId, userId }),
      logger,
    });
    const requireStaff = scopeGuards.requireScope('staff');
    const verifyAccessToken = (t: string) => tokens.verifyAccessToken(t);

    const addresses = createAddressesService({ repository: createAddressesRepository({ db }), db, audit, logger });
    const catalogue = createCatalogueService({ repository: createCatalogueRepository({ db }), storage: createUnconfiguredMediaStorage({ logger }), db, events, audit, logger });
    const inventory = createInventoryService({ repository: createInventoryRepository({ db }), db, events, audit, logger });
    const promotions = createPromotionsService({ repository: createPromotionsRepository({ db }), db, audit, logger });
    const tax = createTaxService({ repository: createTaxRepository({ db }), db, audit, logger });

    const cart = createCartService({
      repository: createCartRepository({ db }),
      promotions: {
        findApplicable: (i) => promotions.findApplicable(i),
        evaluateApplied: (i) => promotions.evaluateApplied(i),
      },
      db,
      logger,
    });

    const invoicing = createInvoicingService({ repository: createInvoicingRepository({ db }), db, audit, logger });
    const idempotency = createIdempotencyStore({ db, logger });
    const idemGuard = requireIdempotency({ store: idempotency, logger });

    let ordersRef: ReturnType<typeof createOrdersService>;
    let paymentsRef: ReturnType<typeof createPaymentsService>;
    let fulfilmentRef: ReturnType<typeof createFulfilmentService>;

    const orders = createOrdersService({
      repository: createOrdersRepository({ db }),
      cart: {
        lockCartForCheckout: (i) => cart.lockCartForCheckout(i),
        markCheckedOut: (i) => cart.markCheckedOut(i),
      },
      promotions: { evaluateApplied: (i) => promotions.evaluateApplied(i) },
      idempotency: {
        complete: (i) =>
          idempotency.complete({
            storeId: i.storeId,
            userId: i.userId,
            key: i.key,
            endpoint: i.endpoint,
            status: i.status,
            ...(i.body === undefined ? {} : { body: i.body as never }),
          }),
      },
      payments: { stateForOrder: (i) => paymentsRef.stateForOrder(i) },
      reservations: {
        reserve: (i) => inventory.reserveForOrder(i),
        releaseForOrder: (i) => inventory.releaseForOrder(i),
      },
      tax: { determineForCheckout: (i) => tax.determineForCheckout(i) },
      invoicing: { issueForOrder: (i) => invoicing.issueForOrder(i), findForOrder: (i) => invoicing.findForOrder(i) },
      fulfilment: { hasBlockingShipment: (i) => fulfilmentRef.hasBlockingShipment(i) },
      db,
      audit,
      logger,
    });
    ordersRef = orders;

    const payments = createPaymentsService({
      repository: createPaymentsRepository({ db }),
      orders: {
        findPayable: async (i) => {
          try {
            const view = await orders.getOrder({ userId: i.userId, storeId: i.storeId, orderNumber: i.orderNumber });
            return {
              id: view.order.id,
              orderNumber: view.order.orderNumber,
              status: view.order.status,
              currency: view.order.currency,
              payableTotal: view.order.grandTotal,
            };
          } catch (err) {
            if (err instanceof NotFound) return null;
            throw err;
          }
        },
        lockForExpiry: (i) => orders.lockOrderForExpiry(i),
      },
      gateway: createUnconfiguredGateway({ logger }),
      idempotency: {
        complete: (i) =>
          idempotency.complete({
            storeId: i.storeId,
            userId: i.userId,
            key: i.key,
            endpoint: i.endpoint,
            status: i.status,
            ...(i.body === undefined ? {} : { body: i.body as never }),
          }),
      },
      reservations: {
        commitForOrder: (i) => inventory.commitForOrder(i),
        releaseForOrder: (i) => inventory.releaseForOrder(i),
      },
      expiryMinutes: config.paymentExpiryMinutes,
      db,
      audit,
      logger,
    });
    paymentsRef = payments;

    const fulfilment = createFulfilmentService({
      repository: createFulfilmentRepository({ db }),
      orders: {
        lockByNumber: (i) => orders.lockForFulfilmentByNumber(i),
        lockById: (i) => orders.lockForFulfilmentById(i),
      },
      payments: { stateForOrder: (i) => payments.stateForOrder(i) },
      inventory: { fulfilForOrder: (i) => inventory.fulfilForOrder(i) },
      db,
      audit,
      logger,
    });
    fulfilmentRef = fulfilment;

    const gateway = createUnconfiguredGateway({ logger });
    const refunds = createRefundsService({
      repository: createRefundsRepository({ db }),
      executor: {
        provider: gateway.provider,
        execute: (input) =>
          gateway.refund({
            providerTransactionId: input.providerTransactionId,
            amountMinor: input.amountMinor,
            reference: input.reference,
          }),
      },
      delivery: {
        deliveredAtForOrder: (input) => fulfilment.deliveredAtForOrder(input),
      },
      db,
      audit,
      logger,
    });

    const returns = createReturnsService({
      repository: createReturnsRepository({ db }),
      orders: { lockOwnedOrderForReturn: (i) => orders.lockOwnedOrderForReturn(i) },
      fulfilment: { deliveredAtForOrder: (i) => fulfilment.deliveredAtForOrder(i) },
      idempotency: {
        complete: (i) =>
          idempotency.complete({
            storeId: i.storeId,
            userId: i.userId,
            key: i.key,
            endpoint: i.endpoint,
            status: i.status,
            ...(i.body === undefined ? {} : { body: i.body as never }),
          }),
      },
      refunds: {
        refundForReturn: async (input) => {
          const record = await refunds.refundForReturn(input);
          return {
            refundNumber: record.refundNumber,
            status: record.status,
            mode: record.mode,
            amount: record.amount,
            currency: record.currency,
            failureCode: record.failureCode,
          };
        },
        listForReturn: (input) => refunds.listForReturn(input),
      },
      inventory: {
        restockForReturn: (input) => inventory.restockForReturn(input),
      },
      db,
      audit,
      logger,
    });

    // Mount Router
    const apiRouter = Router();
    apiRouter.use(
      resolveStore({
        resolver: createDefaultStoreResolver({ repository: storesRepo, slug: config.defaultStoreSlug, logger, cacheTtlMs: 0 }),
        logger,
      })
    );
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
    const agent = () => request(app);

    const timeStamp = Date.now().toString().slice(-8);
    const ADMIN_EMAIL = `admin.varcheckout.${timeStamp}@example.com`;
    const CUSTOMER_EMAIL = `cust.varcheckout.${timeStamp}@example.com`;
    const PASSWORD = 'StrongPassword123!';

    printLine('>>> PHASE 2: Authentication & Staff Credentials Setup');

    // Admin Account
    const regAdmin = await agent().post('/api/v1/auth/register').send({ email: ADMIN_EMAIL, password: PASSWORD, firstName: 'Admin', lastName: 'Store' });
    logStep('Auth Setup', 'POST', '/api/v1/auth/register', regAdmin.status, 201, `Admin Email: ${ADMIN_EMAIL}`);
    const adminId = regAdmin.body.user.id as string;
    await db.update(appUser).set({ isStaff: true }).where(eq(appUser.id, adminId));

    const loginAdmin = await agent().post('/api/v1/auth/login').send({ email: ADMIN_EMAIL, password: PASSWORD });
    logStep('Auth Setup', 'POST', '/api/v1/auth/login', loginAdmin.status, 200, 'Staff Access Token issued');
    const adminToken = loginAdmin.body.accessToken as string;
    const authAdmin = () => ({ Authorization: `Bearer ${adminToken}` });

    // Customer Account
    const regCust = await agent().post('/api/v1/auth/register').send({ email: CUSTOMER_EMAIL, password: PASSWORD, firstName: 'Customer', lastName: 'Buyer' });
    logStep('Auth Setup', 'POST', '/api/v1/auth/register', regCust.status, 201, `Customer Email: ${CUSTOMER_EMAIL}`);

    const loginCust = await agent().post('/api/v1/auth/login').send({ email: CUSTOMER_EMAIL, password: PASSWORD });
    logStep('Auth Setup', 'POST', '/api/v1/auth/login', loginCust.status, 200, 'Customer Access Token issued');
    const custToken = loginCust.body.accessToken as string;
    const authCust = () => ({ Authorization: `Bearer ${custToken}` });

    printLine('\n>>> PHASE 3: Product Setup (Sneakers Pro Max)');

    const prodSlug = `sneakers-pro-max-${timeStamp}`;
    const createProd = await agent()
      .post('/api/v1/admin/products')
      .set(authAdmin())
      .send({ slug: prodSlug, name: 'Sneakers Pro Max Running Shoes', status: 'active' });
    logStep('Admin Catalogue', 'POST', '/api/v1/admin/products', createProd.status, 201, `Product Slug: ${prodSlug}`);

    printLine('\n>>> PHASE 4: Create Variant Options (Color & Size)');

    // Color Option
    const optColor = await agent().post(`/api/v1/admin/products/${prodSlug}/options`).set(authAdmin()).send({ name: 'Color' });
    logStep('Admin Option', 'POST', `/api/v1/admin/products/${prodSlug}/options`, optColor.status, 201, 'Created Option: Color');
    const colorOptId = optColor.body.option.id as string;

    // Size Option
    const optSize = await agent().post(`/api/v1/admin/products/${prodSlug}/options`).set(authAdmin()).send({ name: 'Size' });
    logStep('Admin Option', 'POST', `/api/v1/admin/products/${prodSlug}/options`, optSize.status, 201, 'Created Option: Size');
    const sizeOptId = optSize.body.option.id as string;

    // Add Color Values: Black, White
    const valBlack = await agent().post(`/api/v1/admin/options/${colorOptId}/values`).set(authAdmin()).send({ value: 'Black' });
    logStep('Admin Option Value', 'POST', `/api/v1/admin/options/${colorOptId}/values`, valBlack.status, 201, 'Color Value: Black');
    const blackValId = valBlack.body.value.id as string;

    const valWhite = await agent().post(`/api/v1/admin/options/${colorOptId}/values`).set(authAdmin()).send({ value: 'White' });
    logStep('Admin Option Value', 'POST', `/api/v1/admin/options/${colorOptId}/values`, valWhite.status, 201, 'Color Value: White');
    const whiteValId = valWhite.body.value.id as string;

    // Add Size Values: US 8, US 10
    const valSize8 = await agent().post(`/api/v1/admin/options/${sizeOptId}/values`).set(authAdmin()).send({ value: 'US 8' });
    logStep('Admin Option Value', 'POST', `/api/v1/admin/options/${sizeOptId}/values`, valSize8.status, 201, 'Size Value: US 8');
    const size8ValId = valSize8.body.value.id as string;

    const valSize10 = await agent().post(`/api/v1/admin/options/${sizeOptId}/values`).set(authAdmin()).send({ value: 'US 10' });
    logStep('Admin Option Value', 'POST', `/api/v1/admin/options/${sizeOptId}/values`, valSize10.status, 201, 'Size Value: US 10');
    const size10ValId = valSize10.body.value.id as string;

    printLine('\n>>> PHASE 5: Create 4 Variants with DIFFERENT PRICING');

    const skuBlk8 = `SNK-BLK-8-${timeStamp}`;
    const skuBlk10 = `SNK-BLK-10-${timeStamp}`;
    const skuWht8 = `SNK-WHT-8-${timeStamp}`;
    const skuWht10 = `SNK-WHT-10-${timeStamp}`;

    // Variant 1: Black / US 8 -> Price 3499.00
    const createSku1 = await agent().post(`/api/v1/admin/products/${prodSlug}/skus`).set(authAdmin()).send({ code: skuBlk8, name: 'Black / US 8', price: '3499.0000' });
    logStep('Admin SKU', 'POST', `/api/v1/admin/products/${prodSlug}/skus`, createSku1.status, 201, `SKU: ${skuBlk8} | Price: 3499.00`);
    await agent().put(`/api/v1/admin/skus/${skuBlk8}/options`).set(authAdmin()).send({ optionValueIds: [blackValId, size8ValId] });

    // Variant 2: Black / US 10 -> Price 3799.00
    const createSku2 = await agent().post(`/api/v1/admin/products/${prodSlug}/skus`).set(authAdmin()).send({ code: skuBlk10, name: 'Black / US 10', price: '3799.0000' });
    logStep('Admin SKU', 'POST', `/api/v1/admin/products/${prodSlug}/skus`, createSku2.status, 201, `SKU: ${skuBlk10} | Price: 3799.00`);
    await agent().put(`/api/v1/admin/skus/${skuBlk10}/options`).set(authAdmin()).send({ optionValueIds: [blackValId, size10ValId] });

    // Variant 3: White / US 8 -> Price 3599.00
    const createSku3 = await agent().post(`/api/v1/admin/products/${prodSlug}/skus`).set(authAdmin()).send({ code: skuWht8, name: 'White / US 8', price: '3599.0000' });
    logStep('Admin SKU', 'POST', `/api/v1/admin/products/${prodSlug}/skus`, createSku3.status, 201, `SKU: ${skuWht8} | Price: 3599.00`);
    await agent().put(`/api/v1/admin/skus/${skuWht8}/options`).set(authAdmin()).send({ optionValueIds: [whiteValId, size8ValId] });

    // Variant 4: White / US 10 -> Price 3899.00
    const createSku4 = await agent().post(`/api/v1/admin/products/${prodSlug}/skus`).set(authAdmin()).send({ code: skuWht10, name: 'White / US 10', price: '3899.0000' });
    logStep('Admin SKU', 'POST', `/api/v1/admin/products/${prodSlug}/skus`, createSku4.status, 201, `SKU: ${skuWht10} | Price: 3899.00`);
    await agent().put(`/api/v1/admin/skus/${skuWht10}/options`).set(authAdmin()).send({ optionValueIds: [whiteValId, size10ValId] });

    printLine('\n>>> PHASE 6: Variant Stock Adjustments');

    await agent().post('/api/v1/admin/inventory/adjustments').set(authAdmin()).send({ skuCode: skuBlk8, delta: 50, reason: 'manual_increase', note: 'Stock' });
    await agent().post('/api/v1/admin/inventory/adjustments').set(authAdmin()).send({ skuCode: skuBlk10, delta: 50, reason: 'manual_increase', note: 'Stock' });
    await agent().post('/api/v1/admin/inventory/adjustments').set(authAdmin()).send({ skuCode: skuWht8, delta: 50, reason: 'manual_increase', note: 'Stock' });
    await agent().post('/api/v1/admin/inventory/adjustments').set(authAdmin()).send({ skuCode: skuWht10, delta: 50, reason: 'manual_increase', note: 'Stock' });
    logStep('Inventory Setup', 'POST', '/api/v1/admin/inventory/adjustments', 201, 201, 'Added 50 units stock for all 4 variants');

    printLine('\n>>> PHASE 7: Customer Browsing & Address Book');

    const searchRes = await agent().get('/api/v1/products').query({ q: 'Sneakers Pro Max' });
    logStep('Public Catalogue', 'GET', '/api/v1/products?q=Sneakers', searchRes.status, 200, `Found product: ${searchRes.body.products?.[0]?.name}`);

    const prodDetailRes = await agent().get(`/api/v1/products/${prodSlug}`);
    logStep('Public Catalogue', 'GET', `/api/v1/products/${prodSlug}`, prodDetailRes.status, 200, `Product details loaded with ${prodDetailRes.body.product?.skus?.length} selectable variants`);

    // Add Customer Delivery Address
    const addAddrRes = await agent().post('/api/v1/users/me/addresses').set(authCust()).send({
      label: 'Home',
      recipientName: 'Customer Buyer',
      phone: '+91 9999988888',
      line1: '100 Innovation Park',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
      countryCode: 'IN',
    });
    logStep('Customer Addresses', 'POST', '/api/v1/users/me/addresses', addAddrRes.status, 201, `Address ID: ${addAddrRes.body.address.id}`);
    const addressId = addAddrRes.body.address.id as string;

    printLine('\n>>> PHASE 8: Customer Selects Specific Variants into Cart');

    // Customer selects:
    // 1x Black / US 10 (Price: 3799.00)
    const addCart1 = await agent().put(`/api/v1/users/me/cart/items/${skuBlk10}`).set(authCust()).send({ quantity: 1 });
    logStep('Customer Cart', 'PUT', `/api/v1/users/me/cart/items/${skuBlk10}`, addCart1.status, 200, `Added 1x Black/US 10 (@ 3799.00). Subtotal: ${addCart1.body.cart?.subtotal}`);

    // 1x White / US 8 (Price: 3599.00)
    const addCart2 = await agent().put(`/api/v1/users/me/cart/items/${skuWht8}`).set(authCust()).send({ quantity: 1 });
    logStep('Customer Cart', 'PUT', `/api/v1/users/me/cart/items/${skuWht8}`, addCart2.status, 200, `Added 1x White/US 8 (@ 3599.00). Cart Subtotal: ${addCart2.body.cart?.subtotal} (3799 + 3599 = 7398)`);

    printLine('\n>>> PHASE 9: Checkout Order Creation & Total Verification');

    const checkoutRes = await agent()
      .post('/api/v1/users/me/checkout')
      .set(authCust())
      .set('idempotency-key', `idem-chk-variant-${newId()}`)
      .send({ addressId });
    logStep('Customer Checkout', 'POST', '/api/v1/users/me/checkout', checkoutRes.status, 201, `Order Created: ${checkoutRes.body.order.orderNumber}, Grand Total: ${checkoutRes.body.order.grandTotal}`);
    const orderNumber = checkoutRes.body.order.orderNumber as string;

    printLine('\n>>> PHASE 10: Payment Processing');

    const payRes = await agent()
      .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
      .set(authCust())
      .set('idempotency-key', `idem-pay-variant-${newId()}`)
      .send({ method: 'cod' });
    logStep('Payment Processing', 'POST', `/api/v1/users/me/orders/${orderNumber}/payments`, payRes.status, 201, `Payment Status: ${payRes.body.payment.status}, Payable: ${payRes.body.payment.payableTotal}`);

    printLine('\n>>> PHASE 11: Admin Fulfilment & Delivery');

    const shipment = await agent().post(`/api/v1/admin/orders/${orderNumber}/shipments`).set(authAdmin()).send({ carrier: 'Express Shipping', trackingNumber: `TRK-VAR-${timeStamp}` });
    const shipId = shipment.body.shipment.id as string;
    logStep('Admin Fulfilment', 'POST', `/api/v1/admin/orders/${orderNumber}/shipments`, shipment.status, 201, `Shipment Created ID: ${shipId}`);

    const shipRes = await agent().post(`/api/v1/admin/shipments/${shipId}/ship`).set(authAdmin()).send({});
    logStep('Admin Fulfilment', 'POST', `/api/v1/admin/shipments/${shipId}/ship`, shipRes.status, 200, 'Status: Shipped');

    const deliverRes = await agent().post(`/api/v1/admin/shipments/${shipId}/deliver`).set(authAdmin()).send({});
    logStep('Admin Fulfilment', 'POST', `/api/v1/admin/shipments/${shipId}/deliver`, deliverRes.status, 200, 'Status: Delivered (Inventory Stock Committed)');

    printLine('\n>>> PHASE 12: Customer Order & Invoice Verification');

    const getOrderRes = await agent().get(`/api/v1/users/me/orders/${orderNumber}`).set(authCust());
    logStep('Customer Orders', 'GET', `/api/v1/users/me/orders/${orderNumber}`, getOrderRes.status, 200, `Order Status: ${getOrderRes.body.order?.status}, Items Count: ${getOrderRes.body.order?.lines?.length}`);

    const invoiceRes = await agent().get(`/api/v1/users/me/orders/${orderNumber}/invoice`).set(authCust());
    logStep('Customer Invoice', 'GET', `/api/v1/users/me/orders/${orderNumber}/invoice`, invoiceRes.status, 200, `Format: ${invoiceRes.headers['content-type']}, Size: ${invoiceRes.text?.length} bytes`);

    printLine('\n========================================================================================');
    printLine(` SUCCESS! All ${stepCount} Variant Selection, Checkout & Payment steps executed flawlessly! `);
    printLine('========================================================================================\n');
  } finally {
    await dbHandle.close();
  }
}

runVariantCheckoutPaymentJourney().catch((error) => {
  printLine(`\n[CRITICAL FAILURE] Variant Checkout & Payment Journey failed at Step ${stepCount}:`);
  printLine(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
