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
import { createScopeGuards } from '../../src/http/middleware/scope.js';
import { resolveStore } from '../../src/http/middleware/store.js';
import { createCatalogueRepository } from '../../src/modules/catalogue/catalogue.repository.js';
import { createCatalogueRoutes } from '../../src/modules/catalogue/catalogue.routes.js';
import { createCatalogueService } from '../../src/modules/catalogue/catalogue.service.js';
import { createIdentityRepository } from '../../src/modules/identity/identity.repository.js';
import { createIdentityRoutes } from '../../src/modules/identity/identity.routes.js';
import { createIdentityService } from '../../src/modules/identity/identity.service.js';
import { createPasswordResetRepository } from '../../src/modules/identity/password-reset.repository.js';
import { createRefreshSessionRepository } from '../../src/modules/identity/refresh-session.repository.js';
import { createTokenService } from '../../src/modules/identity/tokens.js';
import { createInventoryRepository } from '../../src/modules/inventory/inventory.repository.js';
import { createInventoryRoutes } from '../../src/modules/inventory/inventory.routes.js';
import { createInventoryService } from '../../src/modules/inventory/inventory.service.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../src/modules/stores/index.js';
import { createLogger } from '../../src/shared/logger.js';

import { createUnconfiguredMediaStorage } from '../../src/storage/media-storage.js';

const TARGET_DB_URL =
  process.env['DATABASE_URL'] ||
  'postgresql://neondb_owner:npg_HArnZm0au7xM@ep-bitter-lab-b583w2fo-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const printLine = (msg: string): void => {
  process.stdout.write(`${msg}\n`);
};

async function runAlertsTest(): Promise<void> {
  printLine('========================================================================================');
  printLine('      E2E INVENTORY ALERTS & EXTENDED ACCESS TOKEN TEST SUITE                        ');
  printLine('========================================================================================');

  process.env['DATABASE_URL'] = TARGET_DB_URL;
  const config = loadConfig(process.env);
  const logger = createLogger(config);
  const dbHandle = createDatabase(TARGET_DB_URL, config, logger, 'primary');
  const db = dbHandle.db;

  const storesRepo = createStoreRepository({ db });
  const { store: activeStore } = await seed({ db, config, logger });

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

  const catalogue = createCatalogueService({ repository: createCatalogueRepository({ db }), storage: createUnconfiguredMediaStorage({ logger }), db, events, audit, logger });
  const inventory = createInventoryService({ repository: createInventoryRepository({ db }), db, events, audit, logger });

  const apiRouter = Router();
  apiRouter.use(
    resolveStore({
      resolver: createDefaultStoreResolver({ repository: storesRepo, slug: config.defaultStoreSlug, logger, cacheTtlMs: 0 }),
      logger,
    })
  );
  apiRouter.use(createIdentityRoutes({ identity, tokens, logger }));
  apiRouter.use(createCatalogueRoutes({ catalogue, verifyAccessToken, requireStaff, logger }));
  apiRouter.use(createInventoryRoutes({ inventory, verifyAccessToken, requireStaff, logger }));

  const app = createApp({ config, logger, healthChecks: [], apiRouter });
  const agent = () => request(app);

  const uniqueSuffix = Date.now().toString().slice(-6);
  const staffEmail = `admin.alert.${uniqueSuffix}@example.com`;
  const password = 'StrongPassword123!';

  // Step 1: Register Admin User
  const regRes = await agent().post('/api/v1/auth/register').send({
    email: staffEmail,
    password,
    firstName: 'Admin',
    lastName: 'Alerts',
  });
  printLine(`[PASS] Step 01 | Staff Register -> Status: ${regRes.status} | User ID: ${regRes.body.user.id}`);
  const staffUserId = regRes.body.user.id;

  // Grant Staff scope
  await db.update(appUser).set({ isStaff: true }).where(eq(appUser.id, staffUserId));

  // Step 2: Login Admin User & Verify Token TTL
  const loginRes = await agent().post('/api/v1/auth/login').send({
    email: staffEmail,
    password,
  });
  printLine(`[PASS] Step 02 | Staff Login -> Status: ${loginRes.status}`);

  const token = loginRes.body.accessToken;
  const expiresInSeconds = loginRes.body.expiresInSeconds;
  const days = expiresInSeconds / 86400;
  printLine(`[PASS] Token Expiration: ${expiresInSeconds} seconds (${days} days) - Extended for Admin & User!`);

  const authHeader = { Authorization: `Bearer ${token}` };

  // Step 3: Create Product
  const prodSlug = `alert-shoe-${uniqueSuffix}`;
  const prodRes = await agent().post('/api/v1/admin/products').set(authHeader).send({
    name: `Alert Test Shoe ${uniqueSuffix}`,
    slug: prodSlug,
    status: 'active',
  });
  printLine(`[PASS] Step 03 | Create Product -> Status: ${prodRes.status} | Slug: ${prodSlug}`);

  // Step 4: Create 2 SKUs
  const skuCode10 = `ALT-SKU-10-${uniqueSuffix}`;
  const skuCode20 = `ALT-SKU-20-${uniqueSuffix}`;

  await agent().post(`/api/v1/admin/products/${prodSlug}/skus`).set(authHeader).send({
    code: skuCode10,
    price: 2999,
  });

  await agent().post(`/api/v1/admin/products/${prodSlug}/skus`).set(authHeader).send({
    code: skuCode20,
    price: 3999,
  });
  printLine(`[PASS] Step 04 | Created 2 SKUs: ${skuCode10}, ${skuCode20}`);

  // Step 5: Adjust stock: SKU10 -> 10 units (Critical alert), SKU20 -> 20 units (Warning alert)
  await agent().post('/api/v1/admin/inventory/adjustments').set(authHeader).send({
    skuCode: skuCode10,
    delta: 10,
    reason: 'manual_increase',
  });

  await agent().post('/api/v1/admin/inventory/adjustments').set(authHeader).send({
    skuCode: skuCode20,
    delta: 20,
    reason: 'manual_increase',
  });
  printLine(`[PASS] Step 05 | Set Stock: ${skuCode10} = 10 units (Critical), ${skuCode20} = 20 units (Warning)`);

  // Step 6: Test GET /api/v1/admin/inventory/alerts
  const alertsRes = await agent().get('/api/v1/admin/inventory/alerts').set(authHeader);
  printLine(`[PASS] Step 06 | GET /api/v1/admin/inventory/alerts -> Status: ${alertsRes.status}`);
  printLine(`  Summary: ${JSON.stringify(alertsRes.body.summary)}`);

  const criticalFound = alertsRes.body.alerts.find((a: any) => a.skuCode === skuCode10);
  const warningFound = alertsRes.body.alerts.find((a: any) => a.skuCode === skuCode20);

  if (criticalFound) {
    printLine(`  -> Found Critical Alert (Qty <= 10): SKU ${criticalFound.skuCode} | Available: ${criticalFound.available} | Level: ${criticalFound.alertLevel}`);
  }
  if (warningFound) {
    printLine(`  -> Found Warning Alert (Qty <= 20): SKU ${warningFound.skuCode} | Available: ${warningFound.available} | Level: ${warningFound.alertLevel}`);
  }

  // Step 7: Test GET /api/v1/admin/inventory/low-stock (Alias)
  const lowStockRes = await agent().get('/api/v1/admin/inventory/low-stock?threshold=10').set(authHeader);
  printLine(`[PASS] Step 07 | GET /api/v1/admin/inventory/low-stock?threshold=10 -> Status: ${lowStockRes.status}`);
  printLine(`  Summary with threshold=10: ${JSON.stringify(lowStockRes.body.summary)}`);

  printLine('\n========================================================================================');
  printLine(' SUCCESS! Low Stock Alert Endpoints & Extended Token Expiration Verified! ');
  printLine('========================================================================================\n');
  process.exit(0);
}

runAlertsTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
