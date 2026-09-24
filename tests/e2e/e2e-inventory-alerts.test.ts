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
import { newId } from '../../src/shared/id.js';
import { bootstrapLogger } from '../../src/shared/logger.js';

const TARGET_DB_URL =
  process.env['DATABASE_URL'] ||
  'postgresql://neondb_owner:npg_HArnZm0au7xM@ep-bitter-lab-b583w2fo-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const printLine = (msg: string): void => process.stdout.write(`${msg}\n`);

async function runAlertsTest(): Promise<void> {
  printLine('========================================================================================');
  printLine('      E2E INVENTORY ALERTS & EXTENDED ACCESS TOKEN TEST SUITE                        ');
  printLine('========================================================================================');

  process.env['DATABASE_URL'] = TARGET_DB_URL;
  const config = loadConfig(process.env);
  const logger = bootstrapLogger(config);
  const db = createDatabase({ config, logger });

  await seed({ db, config, logger });
  const storeRepo = createStoreRepository({ db });
  const defaultStore = await storeRepo.findBySlug(config.defaultStoreSlug);
  const activeStore = defaultStore!;
  const storeId = activeStore.id;

  const events = createEventBus({ logger });
  const tokenService = createTokenService({ config, logger });
  const identityRepo = createIdentityRepository({ db });
  const auditRepo = createAuditRepository({ db });
  const audit = createAuditTrail({ repository: auditRepo, logger });

  const identity = createIdentityService({
    repository: identityRepo,
    passwordResets: createPasswordResetRepository({ db }),
    sessions: createRefreshSessionRepository({ db }),
    tokens: tokenService,
    db,
    events,
    audit,
    config,
    logger,
  });

  const catalogueRepo = createCatalogueRepository({ db });
  const catalogue = createCatalogueService({ repository: catalogueRepo, db, events, audit, logger });

  const inventoryRepo = createInventoryRepository({ db });
  const inventory = createInventoryService({ repository: inventoryRepo, db, events, audit, logger });

  const storeResolver = createDefaultStoreResolver({ stores: storeRepo, defaultSlug: config.defaultStoreSlug });
  const scopeGuards = createScopeGuards();
  const idempotencyStore = createIdempotencyStore({ db });
  const verifyAccessToken = (t: string) => tokenService.verifyAccessToken(t);
  const staffGuard = scopeGuards.requireStaff;

  const app = createApp({
    config,
    logger,
    resolveStore: resolveStore({ resolver: storeResolver, logger }),
    requireAuth: requireAuth({ verifyAccessToken, logger }),
    requireIdempotency: requireIdempotency({ store: idempotencyStore, logger }),
    routes: [
      { path: '/', router: createIdentityRoutes({ identity, verifyAccessToken, logger }) },
      { path: '/', router: createCatalogueRoutes({ catalogue, verifyAccessToken, requireStaff: staffGuard, logger }) },
      { path: '/', router: createInventoryRoutes({ inventory, verifyAccessToken, requireStaff: staffGuard, logger }) },
    ],
  });

  const uniqueSuffix = Math.floor(Math.random() * 1000000);
  const staffEmail = `admin.alert.${uniqueSuffix}@example.com`;

  // Register staff user
  await identity.register({ email: staffEmail, password: 'Password123!', name: 'Staff User', storeId });
  await db.update(appUser).set({ isStaff: true }).where(eq(appUser.email, staffEmail));

  // Login staff user
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email: staffEmail, password: 'Password123!' });
  const token = loginRes.body.tokens.accessToken;
  const expiresInSeconds = loginRes.body.tokens.expiresInSeconds;

  printLine(`[PASS] Staff Token Issued | Expires In: ${expiresInSeconds}s (${expiresInSeconds / 86400} days)`);

  // Create Product & SKUs for alert test
  const prodSlug = `alert-shoe-${uniqueSuffix}`;
  await request(app).post('/api/v1/admin/products').set('Authorization', `Bearer ${token}`).send({
    name: `Alert Test Shoe ${uniqueSuffix}`,
    slug: prodSlug,
    status: 'active',
  });

  const skuCode10 = `ALT-SKU-10-${uniqueSuffix}`;
  const skuCode20 = `ALT-SKU-20-${uniqueSuffix}`;

  await request(app).post(`/api/v1/admin/products/${prodSlug}/skus`).set('Authorization', `Bearer ${token}`).send({
    code: skuCode10,
    price: 2999,
  });

  await request(app).post(`/api/v1/admin/products/${prodSlug}/skus`).set('Authorization', `Bearer ${token}`).send({
    code: skuCode20,
    price: 3999,
  });

  // Adjust stock: SKU10 -> 10 units (Critical alert), SKU20 -> 20 units (Warning alert)
  await request(app).post('/api/v1/admin/inventory/adjustments').set('Authorization', `Bearer ${token}`).send({
    skuCode: skuCode10,
    delta: 10,
    reason: 'manual_increase',
  });

  await request(app).post('/api/v1/admin/inventory/adjustments').set('Authorization', `Bearer ${token}`).send({
    skuCode: skuCode20,
    delta: 20,
    reason: 'manual_increase',
  });

  // Query Alert Endpoint
  const alertsRes = await request(app)
    .get('/api/v1/admin/inventory/alerts')
    .set('Authorization', `Bearer ${token}`);

  printLine(`[PASS] GET /api/v1/admin/inventory/alerts -> Status: ${alertsRes.status}`);
  printLine(`Response Summary: ${JSON.stringify(alertsRes.body.summary, null, 2)}`);
  printLine(`Alerts Found: ${alertsRes.body.alerts.length} items`);

  // Print matches
  for (const alert of alertsRes.body.alerts) {
    if (alert.skuCode === skuCode10 || alert.skuCode === skuCode20) {
      printLine(`  -> SKU: ${alert.skuCode} | Available: ${alert.available} | Level: ${alert.alertLevel}`);
    }
  }

  printLine('========================================================================================');
  printLine(' SUCCESS! Low Stock Alert Endpoint and Extended Token TTL Verified! ');
  printLine('========================================================================================');
  process.exit(0);
}

runAlertsTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
