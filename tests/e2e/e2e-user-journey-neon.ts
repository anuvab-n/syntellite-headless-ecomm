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
 * End-To-End E-Commerce Customer & Admin Journey Test Script
 * Target Database: Specific Neon PostgreSQL Instance
 */

const TARGET_DB_URL =
  process.env['DATABASE_URL'] ||
  'postgresql://neondb_owner:npg_HArnZm0au7xM@ep-bitter-lab-b583w2fo-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const printLine = (msg: string): void => process.stdout.write(`${msg}\n`);
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
    `[${statusStr}] Step ${formattedStep} | ${phase.padEnd(25)} | ${method.padEnd(6)} ${path.padEnd(52)} -> Status: ${status} (Expected: ${expectedStatus}) | ${details}`
  );
  if (!isPass) {
    throw new Error(
      `Step ${stepCount} failed: ${method} ${path} returned status ${status}, expected ${expectedStatus}. Context: ${details}`
    );
  }
}

async function runE2EUserJourney(): Promise<void> {
  printLine('========================================================================================');
  printLine('            STARTING FULL E-COMMERCE USER JOURNEY END-TO-END VERIFICATION             ');
  printLine('========================================================================================');
  printLine(`Target Database: ${TARGET_DB_URL.split('@')[1] || TARGET_DB_URL}`);
  printLine('----------------------------------------------------------------------------------------\n');

  // Override DATABASE_URL in process.env to strictly enforce target Neon DB connection
  process.env['DATABASE_URL'] = TARGET_DB_URL;

  const config = loadConfig();
  const logger = bootstrapLogger;
  const dbHandle = createDatabase(TARGET_DB_URL, config, logger, 'primary');
  const db = dbHandle.db;

  try {
    printLine('>>> PHASE 1: Database Warm-up & Default Store Verification');
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await db.execute('SELECT 1');
        printLine(`  [OK] Database connection warmed up successfully (Attempt ${attempt}).`);
        break;
      } catch (err) {
        printLine(`  [WARMUP ATTEMPT ${attempt} FAILED]: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt === 5) throw err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const storesRepo = createStoreRepository({ db });
    const { store: activeStore } = await seed({ db, config, logger });
    printLine(`  [OK] Active Store Loaded: Slug="${activeStore.slug}", StoreID="${activeStore.id}"\n`);

    // Initialize repositories and services
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
    const catalogue = createCatalogueService({ repository: createCatalogueRepository({ db }), db, events, audit, logger });
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

    // Mount Express Router
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
    const ADMIN_EMAIL = `admin.journey.${timeStamp}@example.com`;
    const CUSTOMER_EMAIL = `customer.journey.${timeStamp}@example.com`;
    const PASSWORD = 'StrongSecurePassword123!';

    printLine('>>> PHASE 2: Authentication Flow (Admin & Customer)');

    // 1. Register Admin
    const regAdminRes = await agent()
      .post('/api/v1/auth/register')
      .send({ email: ADMIN_EMAIL, password: PASSWORD, firstName: 'System', lastName: 'Admin' });
    logStep('Auth (Admin Reg)', 'POST', '/api/v1/auth/register', regAdminRes.status, 201, `Email: ${ADMIN_EMAIL}`);
    const adminUserId = regAdminRes.body.user.id as string;

    // Promote to Staff
    await db.update(appUser).set({ isStaff: true }).where(eq(appUser.id, adminUserId));

    // Admin Login
    const adminLoginRes = await agent().post('/api/v1/auth/login').send({ email: ADMIN_EMAIL, password: PASSWORD });
    logStep('Auth (Admin Login)', 'POST', '/api/v1/auth/login', adminLoginRes.status, 200, `Staff status confirmed`);
    const adminToken = adminLoginRes.body.accessToken as string;
    const authAdmin = () => ({ Authorization: `Bearer ${adminToken}` });

    // 2. Register Customer
    const regCustRes = await agent()
      .post('/api/v1/auth/register')
      .send({ email: CUSTOMER_EMAIL, password: PASSWORD, firstName: 'Jane', lastName: 'Customer' });
    logStep('Auth (Cust Reg)', 'POST', '/api/v1/auth/register', regCustRes.status, 201, `Email: ${CUSTOMER_EMAIL}`);

    // Customer Login
    const custLoginRes = await agent().post('/api/v1/auth/login').send({ email: CUSTOMER_EMAIL, password: PASSWORD });
    logStep('Auth (Cust Login)', 'POST', '/api/v1/auth/login', custLoginRes.status, 200, `Token issued`);
    let customerToken = custLoginRes.body.accessToken as string;
    const customerRefreshToken = custLoginRes.body.refreshToken as string;
    const authCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

    // Customer Token Refresh Test
    const refreshRes = await agent().post('/api/v1/auth/refresh').send({ refreshToken: customerRefreshToken });
    logStep('Auth (Token Refresh)', 'POST', '/api/v1/auth/refresh', refreshRes.status, 200, `New Access Token obtained`);
    customerToken = refreshRes.body.accessToken as string;

    printLine('\n>>> PHASE 3: Admin Catalogue & Inventory Management');

    const productSlug = `pro-wireless-headphone-${timeStamp}`;
    const skuCode = `SKU-HEADPHONE-${timeStamp}`;

    // Create Product
    const createProdRes = await agent()
      .post('/api/v1/admin/products')
      .set(authAdmin())
      .send({ slug: productSlug, name: 'Pro Wireless Headphones', status: 'active' });
    logStep('Admin Catalogue', 'POST', '/api/v1/admin/products', createProdRes.status, 201, `Slug: ${productSlug}`);

    // Create SKU
    const createSkuRes = await agent()
      .post(`/api/v1/admin/products/${productSlug}/skus`)
      .set(authAdmin())
      .send({ code: skuCode, price: '4999.0000' });
    logStep('Admin Catalogue', 'POST', `/api/v1/admin/products/${productSlug}/skus`, createSkuRes.status, 201, `SKU: ${skuCode}, Price: 4999.00`);

    // Adjust Inventory Stock (+100)
    const stockAdjRes = await agent()
      .post('/api/v1/admin/inventory/adjustments')
      .set(authAdmin())
      .send({ skuCode, delta: 100, reason: 'manual_increase', note: 'Initial warehouse stock' });
    logStep('Admin Inventory', 'POST', '/api/v1/admin/inventory/adjustments', stockAdjRes.status, 201, 'Added 100 units to stock');

    printLine('\n>>> PHASE 4: Customer Browsing & Cart Setup');

    // Customer searches product
    const searchProdRes = await agent().get('/api/v1/products').query({ q: 'Pro Wireless' });
    logStep('Public Catalogue', 'GET', '/api/v1/products?q=Pro+Wireless', searchProdRes.status, 200, `Found ${searchProdRes.body.products?.length || 0} matching items`);

    // Get Product Detail by Slug
    const prodDetailRes = await agent().get(`/api/v1/products/${productSlug}`);
    logStep('Public Catalogue', 'GET', `/api/v1/products/${productSlug}`, prodDetailRes.status, 200, `Name: ${prodDetailRes.body.product?.name}`);

    // Add Customer Delivery Address
    const addAddrRes = await agent()
      .post('/api/v1/users/me/addresses')
      .set(authCustomer())
      .send({
        label: 'Home Address',
        recipientName: 'Jane Customer',
        phone: '+91 9876543210',
        line1: '42 Commerce Street, Bandra East',
        city: 'Mumbai',
        state: 'Maharashtra',
        postalCode: '400051',
        countryCode: 'IN',
      });
    logStep('Customer Addresses', 'POST', '/api/v1/users/me/addresses', addAddrRes.status, 201, `Address ID: ${addAddrRes.body.address.id}`);
    const addressId = addAddrRes.body.address.id as string;

    // Add Item to Customer Cart (Quantity: 2)
    const addCartRes = await agent()
      .put(`/api/v1/users/me/cart/items/${skuCode}`)
      .set(authCustomer())
      .send({ quantity: 2 });
    logStep('Customer Cart', 'PUT', `/api/v1/users/me/cart/items/${skuCode}`, addCartRes.status, 200, `Quantity: 2, Subtotal: ${addCartRes.body.cart?.subtotal}`);

    printLine('\n>>> PHASE 5: Order #1 - Checkout, Payment & Fulfilment (Happy Path)');

    // Checkout Order #1
    const checkoutKey1 = `idem-checkout-1-${newId()}`;
    const checkoutRes1 = await agent()
      .post('/api/v1/users/me/checkout')
      .set(authCustomer())
      .set('idempotency-key', checkoutKey1)
      .send({ addressId });
    logStep('Checkout (Order #1)', 'POST', '/api/v1/users/me/checkout', checkoutRes1.status, 201, `OrderNumber: ${checkoutRes1.body.order.orderNumber}, Total: ${checkoutRes1.body.order.grandTotal}`);
    const orderNumber1 = checkoutRes1.body.order.orderNumber as string;

    // Pay for Order #1 (COD)
    const payKey1 = `idem-pay-1-${newId()}`;
    const payRes1 = await agent()
      .post(`/api/v1/users/me/orders/${orderNumber1}/payments`)
      .set(authCustomer())
      .set('idempotency-key', payKey1)
      .send({ method: 'cod' });
    logStep('Payments (Order #1)', 'POST', `/api/v1/users/me/orders/${orderNumber1}/payments`, payRes1.status, 201, `Payment Status: ${payRes1.body.payment.status}`);

    // Admin Views Order in Fulfilment Queue
    const fulfilQueueRes = await agent().get('/api/v1/admin/orders/fulfilment').set(authAdmin());
    const inQueue = fulfilQueueRes.body.orders?.some((o: { orderNumber: string }) => o.orderNumber === orderNumber1);
    logStep('Admin Fulfilment', 'GET', '/api/v1/admin/orders/fulfilment', fulfilQueueRes.status, 200, `Order #1 in queue: ${inQueue}`);

    // Admin Creates Shipment for Order #1
    const shipmentRes = await agent()
      .post(`/api/v1/admin/orders/${orderNumber1}/shipments`)
      .set(authAdmin())
      .send({ carrier: 'FastTrack Logistics', trackingNumber: `TRK-${timeStamp}-01` });
    logStep('Admin Fulfilment', 'POST', `/api/v1/admin/orders/${orderNumber1}/shipments`, shipmentRes.status, 201, `Shipment ID: ${shipmentRes.body.shipment.id}`);
    const shipmentId1 = shipmentRes.body.shipment.id as string;

    // Admin Marks Shipment as Shipped
    const shipRes = await agent().post(`/api/v1/admin/shipments/${shipmentId1}/ship`).set(authAdmin()).send({});
    logStep('Admin Fulfilment', 'POST', `/api/v1/admin/shipments/${shipmentId1}/ship`, shipRes.status, 200, `Status: Shipped`);

    // Admin Marks Shipment as Delivered
    const deliverRes = await agent().post(`/api/v1/admin/shipments/${shipmentId1}/deliver`).set(authAdmin()).send({});
    logStep('Admin Fulfilment', 'POST', `/api/v1/admin/shipments/${shipmentId1}/deliver`, deliverRes.status, 200, `Status: Delivered`);

    printLine('\n>>> PHASE 6: Invoice & Customer Order History');

    // Customer Fetches Invoice
    const invoiceRes = await agent().get(`/api/v1/users/me/orders/${orderNumber1}/invoice`).set(authCustomer());
    logStep('Customer Orders', 'GET', `/api/v1/users/me/orders/${orderNumber1}/invoice`, invoiceRes.status, 200, `Type: ${invoiceRes.headers['content-type']}, Size: ${invoiceRes.text?.length} bytes`);

    // Customer Lists All Past Orders
    const listOrdersRes = await agent().get('/api/v1/users/me/orders').set(authCustomer());
    logStep('Customer Orders', 'GET', '/api/v1/users/me/orders', listOrdersRes.status, 200, `Total Orders: ${listOrdersRes.body.orders?.length}`);

    printLine('\n>>> PHASE 7: Order #2 - Checkout & Cancellation Flow');

    // Put Item into Cart for Order #2
    await agent().put(`/api/v1/users/me/cart/items/${skuCode}`).set(authCustomer()).send({ quantity: 1 });

    // Checkout Order #2
    const checkoutKey2 = `idem-checkout-2-${newId()}`;
    const checkoutRes2 = await agent()
      .post('/api/v1/users/me/checkout')
      .set(authCustomer())
      .set('idempotency-key', checkoutKey2)
      .send({ addressId });
    logStep('Checkout (Order #2)', 'POST', '/api/v1/users/me/checkout', checkoutRes2.status, 201, `Order #2: ${checkoutRes2.body.order.orderNumber}`);
    const orderNumber2 = checkoutRes2.body.order.orderNumber as string;

    // Customer Cancels Order #2 Prior to Payment
    const cancelRes2 = await agent().post(`/api/v1/users/me/orders/${orderNumber2}/cancel`).set(authCustomer()).send({});
    logStep('Cancel Order #2', 'POST', `/api/v1/users/me/orders/${orderNumber2}/cancel`, cancelRes2.status, 200, `Status: ${cancelRes2.body.order.status} (Stock Reservation Released)`);

    printLine('\n>>> PHASE 8: Order #3 - Full Returns Processing Cycle');

    // Place Order #3 for Returns Test
    await agent().put(`/api/v1/users/me/cart/items/${skuCode}`).set(authCustomer()).send({ quantity: 1 });
    const checkoutKey3 = `idem-checkout-3-${newId()}`;
    const checkoutRes3 = await agent()
      .post('/api/v1/users/me/checkout')
      .set(authCustomer())
      .set('idempotency-key', checkoutKey3)
      .send({ addressId });
    const orderNumber3 = checkoutRes3.body.order.orderNumber as string;

    // Pay, Ship & Deliver Order #3
    await agent().post(`/api/v1/users/me/orders/${orderNumber3}/payments`).set(authCustomer()).set('idempotency-key', `idem-pay-3-${newId()}`).send({ method: 'cod' });
    const shipment3 = await agent().post(`/api/v1/admin/orders/${orderNumber3}/shipments`).set(authAdmin()).send({ carrier: 'Express', trackingNumber: `TRK3-${timeStamp}` });
    const shipId3 = shipment3.body.shipment.id as string;
    await agent().post(`/api/v1/admin/shipments/${shipId3}/ship`).set(authAdmin()).send({});
    await agent().post(`/api/v1/admin/shipments/${shipId3}/deliver`).set(authAdmin()).send({});

    // 1. Customer Requests Return for Order #3
    const returnReqRes = await agent()
      .post(`/api/v1/users/me/orders/${orderNumber3}/returns`)
      .set(authCustomer())
      .set('idempotency-key', `idem-return-${newId()}`)
      .send({
        reason: 'defective',
        customerNote: 'Right earbud sound distortion',
        lines: [{ skuCode, quantity: 1 }],
      });
    logStep('Customer Returns', 'POST', `/api/v1/users/me/orders/${orderNumber3}/returns`, returnReqRes.status, 201, `Return No: ${returnReqRes.body.return.returnNumber}`);
    const returnNumber = returnReqRes.body.return.returnNumber as string;

    // 2. Admin Approves Return
    const approveRetRes = await agent()
      .post(`/api/v1/admin/returns/${returnNumber}/approve`)
      .set(authAdmin())
      .send({ staffNote: 'Approved for return inspection' });
    logStep('Admin Returns', 'POST', `/api/v1/admin/returns/${returnNumber}/approve`, approveRetRes.status, 200, `Return Status: ${approveRetRes.body.return.status}`);

    // 3. Admin Receives Return at Warehouse
    const receiveRetRes = await agent()
      .post(`/api/v1/admin/returns/${returnNumber}/receive`)
      .set(authAdmin())
      .send({ staffNote: 'Parcel received at return centre' });
    logStep('Admin Returns', 'POST', `/api/v1/admin/returns/${returnNumber}/receive`, receiveRetRes.status, 200, `Return Status: ${receiveRetRes.body.return.status}`);

    // 4. Admin Inspects Return
    const inspectRetRes = await agent()
      .post(`/api/v1/admin/returns/${returnNumber}/inspect`)
      .set(authAdmin())
      .send({
        lines: [{ skuCode, restockQuantity: 1, writeOffQuantity: 0 }],
        staffNote: 'Inspected - Item passed quality check for restock',
      });
    logStep('Admin Returns', 'POST', `/api/v1/admin/returns/${returnNumber}/inspect`, inspectRetRes.status, 200, `Return Status: ${inspectRetRes.body.return.status}`);

    // 5. Admin Completes Return & Issues Refund Record
    const completeRetRes = await agent()
      .post(`/api/v1/admin/returns/${returnNumber}/complete`)
      .set(authAdmin())
      .send({ staffNote: 'Return complete and restocked' });
    logStep('Admin Returns', 'POST', `/api/v1/admin/returns/${returnNumber}/complete`, completeRetRes.status, 200, `Return Status: ${completeRetRes.body.return.status}, Refunds: ${completeRetRes.body.refunds?.length}`);

    printLine('\n>>> PHASE 9: Security & Integrity Guards Verification');

    // Test Guard: Paying on a cancelled order
    const payOnCancel = await agent()
      .post(`/api/v1/users/me/orders/${orderNumber2}/payments`)
      .set(authCustomer())
      .set('idempotency-key', `idem-pay-invalid-${newId()}`)
      .send({ method: 'cod' });
    logStep('Guard Check', 'POST', `/api/v1/users/me/orders/${orderNumber2}/payments`, payOnCancel.status, 422, 'Refused payment on cancelled order (ORDER_NOT_PAYABLE)');

    // Test Guard: Double payment attempt
    const doublePay = await agent()
      .post(`/api/v1/users/me/orders/${orderNumber1}/payments`)
      .set(authCustomer())
      .set('idempotency-key', `idem-pay-double-${newId()}`)
      .send({ method: 'cod' });
    logStep('Guard Check', 'POST', `/api/v1/users/me/orders/${orderNumber1}/payments`, doublePay.status, 409, 'Refused duplicate payment');

    // Test Guard: Cancelling paid/delivered order
    const cancelDelivered = await agent()
      .post(`/api/v1/users/me/orders/${orderNumber1}/cancel`)
      .set(authCustomer())
      .send({});
    logStep('Guard Check', 'POST', `/api/v1/users/me/orders/${orderNumber1}/cancel`, cancelDelivered.status, 409, 'Refused cancellation of delivered order');

    printLine('\n========================================================================================');
    printLine(` SUCCESS! All ${stepCount} E2E User Journey verification steps executed flawlessly! `);
    printLine('========================================================================================\n');
  } finally {
    await dbHandle.close();
  }
}

runE2EUserJourney().catch((error) => {
  printLine(`\n[CRITICAL FAILURE] E2E User Journey failed at Step ${stepCount}:`);
  printLine(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
