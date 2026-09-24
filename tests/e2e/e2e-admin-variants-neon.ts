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
import { createScopeGuards } from '../../src/http/middleware/scope.js';
import { resolveStore } from '../../src/http/middleware/store.js';
import { createAddressesRepository } from '../../src/modules/addresses/addresses.repository.js';
import { createAddressesRoutes } from '../../src/modules/addresses/addresses.routes.js';
import { createAddressesService } from '../../src/modules/addresses/addresses.service.js';
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
import { bootstrapLogger } from '../../src/shared/logger.js';
import { createUnconfiguredMediaStorage } from '../../src/storage/media-storage.js';

/**
 * Admin E2E Multi-Variant Product Management Audit Script
 * Target Database: Specific Neon PostgreSQL Database Instance
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

async function runAdminVariantAudit(): Promise<void> {
  printLine('========================================================================================');
  printLine('       STARTING ADMIN MULTI-VARIANT PRODUCT MANAGEMENT END-TO-END AUDIT        ');
  printLine('========================================================================================');
  printLine(`Target Database: ${TARGET_DB_URL.split('@')[1] || TARGET_DB_URL}`);
  printLine('----------------------------------------------------------------------------------------\n');

  process.env['DATABASE_URL'] = TARGET_DB_URL;

  const config = loadConfig();
  const logger = bootstrapLogger;
  const dbHandle = createDatabase(TARGET_DB_URL, config, logger, 'primary');
  const db = dbHandle.db;

  try {
    printLine('>>> PHASE 1: System Warmup & Active Store Setup');
    await db.execute('SELECT 1');
    printLine('  [OK] Connected to Neon PostgreSQL DB.');

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

    const catalogue = createCatalogueService({
      repository: createCatalogueRepository({ db }),
      storage: createUnconfiguredMediaStorage({ logger }),
      db,
      events,
      audit,
      logger,
    });

    const inventory = createInventoryService({
      repository: createInventoryRepository({ db }),
      db,
      events,
      audit,
      logger,
    });

    const addresses = createAddressesService({ repository: createAddressesRepository({ db }), db, audit, logger });

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

    const app = createApp({ config, logger, healthChecks: [], apiRouter });
    const agent = () => request(app);

    const timeStamp = Date.now().toString().slice(-8);
    const ADMIN_EMAIL = `admin.variant.${timeStamp}@example.com`;
    const CUSTOMER_EMAIL = `cust.variant.${timeStamp}@example.com`;
    const PASSWORD = 'StrongAdminPassword123!';

    printLine('>>> PHASE 2: Authentication & Staff Privilege Setup');

    // Register & Login Admin
    const regAdmin = await agent()
      .post('/api/v1/auth/register')
      .send({ email: ADMIN_EMAIL, password: PASSWORD, firstName: 'Admin', lastName: 'Catalog' });
    logStep('Auth Setup', 'POST', '/api/v1/auth/register', regAdmin.status, 201, `Admin Email: ${ADMIN_EMAIL}`);
    const adminId = regAdmin.body.user.id as string;

    await db.update(appUser).set({ isStaff: true }).where(eq(appUser.id, adminId));

    const loginAdmin = await agent().post('/api/v1/auth/login').send({ email: ADMIN_EMAIL, password: PASSWORD });
    logStep('Auth Setup', 'POST', '/api/v1/auth/login', loginAdmin.status, 200, 'Staff Token issued');
    const adminToken = loginAdmin.body.accessToken as string;
    const authAdmin = () => ({ Authorization: `Bearer ${adminToken}` });

    // Register & Login Customer
    const regCust = await agent()
      .post('/api/v1/auth/register')
      .send({ email: CUSTOMER_EMAIL, password: PASSWORD, firstName: 'Shopper', lastName: 'User' });
    logStep('Auth Setup', 'POST', '/api/v1/auth/register', regCust.status, 201, `Customer Email: ${CUSTOMER_EMAIL}`);
    const loginCust = await agent().post('/api/v1/auth/login').send({ email: CUSTOMER_EMAIL, password: PASSWORD });
    const custToken = loginCust.body.accessToken as string;
    const authCust = () => ({ Authorization: `Bearer ${custToken}` });

    printLine('\n>>> PHASE 3: Product Creation');

    const productSlug = `tshirt-premium-cotton-${timeStamp}`;
    const createProd = await agent()
      .post('/api/v1/admin/products')
      .set(authAdmin())
      .send({ slug: productSlug, name: 'Premium Cotton T-Shirt', status: 'active' });
    logStep('Admin Catalogue', 'POST', '/api/v1/admin/products', createProd.status, 201, `Created Product Slug: ${productSlug}`);

    printLine('\n>>> PHASE 4: Variant Option Groups Creation (Color & Size)');

    // Create Option 1: Color
    const createColorOpt = await agent()
      .post(`/api/v1/admin/products/${productSlug}/options`)
      .set(authAdmin())
      .send({ name: 'Color' });
    logStep('Admin Option Group', 'POST', `/api/v1/admin/products/${productSlug}/options`, createColorOpt.status, 201, `Option: Color (ID: ${createColorOpt.body.option.id})`);
    const colorOptId = createColorOpt.body.option.id as string;

    // Create Option 2: Size
    const createSizeOpt = await agent()
      .post(`/api/v1/admin/products/${productSlug}/options`)
      .set(authAdmin())
      .send({ name: 'Size' });
    logStep('Admin Option Group', 'POST', `/api/v1/admin/products/${productSlug}/options`, createSizeOpt.status, 201, `Option: Size (ID: ${createSizeOpt.body.option.id})`);
    const sizeOptId = createSizeOpt.body.option.id as string;

    printLine('\n>>> PHASE 5: Variant Option Values Creation');

    // Add Color Values: Navy Blue, Crimson Red, Jet Black
    const valNavy = await agent()
      .post(`/api/v1/admin/options/${colorOptId}/values`)
      .set(authAdmin())
      .send({ value: 'Navy Blue' });
    logStep('Admin Option Value', 'POST', `/api/v1/admin/options/${colorOptId}/values`, valNavy.status, 201, `Color Value: Navy Blue (ID: ${valNavy.body.value.id})`);
    const navyValId = valNavy.body.value.id as string;

    const valRed = await agent()
      .post(`/api/v1/admin/options/${colorOptId}/values`)
      .set(authAdmin())
      .send({ value: 'Crimson Red' });
    logStep('Admin Option Value', 'POST', `/api/v1/admin/options/${colorOptId}/values`, valRed.status, 201, `Color Value: Crimson Red (ID: ${valRed.body.value.id})`);
    const redValId = valRed.body.value.id as string;

    const valBlack = await agent()
      .post(`/api/v1/admin/options/${colorOptId}/values`)
      .set(authAdmin())
      .send({ value: 'Jet Black' });
    logStep('Admin Option Value', 'POST', `/api/v1/admin/options/${colorOptId}/values`, valBlack.status, 201, `Color Value: Jet Black (ID: ${valBlack.body.value.id})`);
    const blackValId = valBlack.body.value.id as string;

    // Add Size Values: Small, Medium, Large
    const valSmall = await agent()
      .post(`/api/v1/admin/options/${sizeOptId}/values`)
      .set(authAdmin())
      .send({ value: 'Small' });
    logStep('Admin Option Value', 'POST', `/api/v1/admin/options/${sizeOptId}/values`, valSmall.status, 201, `Size Value: Small (ID: ${valSmall.body.value.id})`);
    const smallValId = valSmall.body.value.id as string;

    const valMed = await agent()
      .post(`/api/v1/admin/options/${sizeOptId}/values`)
      .set(authAdmin())
      .send({ value: 'Medium' });
    logStep('Admin Option Value', 'POST', `/api/v1/admin/options/${sizeOptId}/values`, valMed.status, 201, `Size Value: Medium (ID: ${valMed.body.value.id})`);
    const medValId = valMed.body.value.id as string;

    const valLarge = await agent()
      .post(`/api/v1/admin/options/${sizeOptId}/values`)
      .set(authAdmin())
      .send({ value: 'Large' });
    logStep('Admin Option Value', 'POST', `/api/v1/admin/options/${sizeOptId}/values`, valLarge.status, 201, `Size Value: Large (ID: ${valLarge.body.value.id})`);
    const largeValId = valLarge.body.value.id as string;

    // Fetch Options with Nested Values
    const getOptsRes = await agent().get(`/api/v1/admin/products/${productSlug}/options`).set(authAdmin());
    logStep('Admin Options View', 'GET', `/api/v1/admin/products/${productSlug}/options`, getOptsRes.status, 200, `Fetched ${getOptsRes.body.options?.length} option groups`);

    printLine('\n>>> PHASE 6: Product SKU / Variant Creation');

    const skuNavySmall = `TSHIRT-NVY-S-${timeStamp}`;
    const skuNavyMed = `TSHIRT-NVY-M-${timeStamp}`;
    const skuRedLarge = `TSHIRT-RED-L-${timeStamp}`;

    // Create SKU 1 (Navy / Small)
    const createSku1 = await agent()
      .post(`/api/v1/admin/products/${productSlug}/skus`)
      .set(authAdmin())
      .send({ code: skuNavySmall, name: 'Navy Blue / Small', price: '1499.0000' });
    logStep('Admin SKUs', 'POST', `/api/v1/admin/products/${productSlug}/skus`, createSku1.status, 201, `SKU: ${skuNavySmall}, Price: 1499.00`);

    // Create SKU 2 (Navy / Medium)
    const createSku2 = await agent()
      .post(`/api/v1/admin/products/${productSlug}/skus`)
      .set(authAdmin())
      .send({ code: skuNavyMed, name: 'Navy Blue / Medium', price: '1499.0000' });
    logStep('Admin SKUs', 'POST', `/api/v1/admin/products/${productSlug}/skus`, createSku2.status, 201, `SKU: ${skuNavyMed}, Price: 1499.00`);

    // Create SKU 3 (Crimson Red / Large)
    const createSku3 = await agent()
      .post(`/api/v1/admin/products/${productSlug}/skus`)
      .set(authAdmin())
      .send({ code: skuRedLarge, name: 'Crimson Red / Large', price: '1599.0000' });
    logStep('Admin SKUs', 'POST', `/api/v1/admin/products/${productSlug}/skus`, createSku3.status, 201, `SKU: ${skuRedLarge}, Price: 1599.00`);

    printLine('\n>>> PHASE 7: Assigning Option Combinations to Variants');

    // Associate Option Values to SKU 1 (Navy + Small)
    const assignOpt1 = await agent()
      .put(`/api/v1/admin/skus/${skuNavySmall}/options`)
      .set(authAdmin())
      .send({ optionValueIds: [navyValId, smallValId] });
    logStep('Variant Combination', 'PUT', `/api/v1/admin/skus/${skuNavySmall}/options`, assignOpt1.status, 200, `Associated [Navy Blue, Small]`);

    // Associate Option Values to SKU 2 (Navy + Medium)
    const assignOpt2 = await agent()
      .put(`/api/v1/admin/skus/${skuNavyMed}/options`)
      .set(authAdmin())
      .send({ optionValueIds: [navyValId, medValId] });
    logStep('Variant Combination', 'PUT', `/api/v1/admin/skus/${skuNavyMed}/options`, assignOpt2.status, 200, `Associated [Navy Blue, Medium]`);

    // Associate Option Values to SKU 3 (Crimson Red + Large)
    const assignOpt3 = await agent()
      .put(`/api/v1/admin/skus/${skuRedLarge}/options`)
      .set(authAdmin())
      .send({ optionValueIds: [redValId, largeValId] });
    logStep('Variant Combination', 'PUT', `/api/v1/admin/skus/${skuRedLarge}/options`, assignOpt3.status, 200, `Associated [Crimson Red, Large]`);

    printLine('\n>>> PHASE 8: Inventory Stock Management per Variant');

    // Stock for SKU 1: +45 units
    const stock1 = await agent()
      .post('/api/v1/admin/inventory/adjustments')
      .set(authAdmin())
      .send({ skuCode: skuNavySmall, delta: 45, reason: 'manual_increase', note: 'Navy Small Restock' });
    logStep('Variant Inventory', 'POST', '/api/v1/admin/inventory/adjustments', stock1.status, 201, `Adjusted stock for ${skuNavySmall} (+45)`);

    // Stock for SKU 2: +80 units
    const stock2 = await agent()
      .post('/api/v1/admin/inventory/adjustments')
      .set(authAdmin())
      .send({ skuCode: skuNavyMed, delta: 80, reason: 'manual_increase', note: 'Navy Medium Restock' });
    logStep('Variant Inventory', 'POST', '/api/v1/admin/inventory/adjustments', stock2.status, 201, `Adjusted stock for ${skuNavyMed} (+80)`);

    // Stock for SKU 3: +25 units
    const stock3 = await agent()
      .post('/api/v1/admin/inventory/adjustments')
      .set(authAdmin())
      .send({ skuCode: skuRedLarge, delta: 25, reason: 'manual_increase', note: 'Red Large Restock' });
    logStep('Variant Inventory', 'POST', '/api/v1/admin/inventory/adjustments', stock3.status, 201, `Adjusted stock for ${skuRedLarge} (+25)`);

    // Fetch Inventory History for SKU 2
    const invHistRes = await agent().get(`/api/v1/admin/inventory/${skuNavyMed}/history`).set(authAdmin());
    logStep('Variant Inventory History', 'GET', `/api/v1/admin/inventory/${skuNavyMed}/history`, invHistRes.status, 200, `History Entries: ${invHistRes.body.items?.length || invHistRes.body.entries?.length}`);

    printLine('\n>>> PHASE 9: Updates & Editing Variant Properties');

    // Rename Option Value: Jet Black -> Pitch Black
    const patchValRes = await agent()
      .patch(`/api/v1/admin/option-values/${blackValId}`)
      .set(authAdmin())
      .send({ value: 'Pitch Black' });
    logStep('Admin Edit Value', 'PATCH', `/api/v1/admin/option-values/${blackValId}`, patchValRes.status, 200, `Updated Value Name: ${patchValRes.body.value.value}`);

    // Update SKU Price: Crimson Red Large from 1599 to 1549
    const patchSkuRes = await agent()
      .patch(`/api/v1/admin/skus/${skuRedLarge}`)
      .set(authAdmin())
      .send({ price: '1549.0000' });
    logStep('Admin Edit SKU', 'PATCH', `/api/v1/admin/skus/${skuRedLarge}`, patchSkuRes.status, 200, `Updated Price: ${patchSkuRes.body.sku.price}`);

    // List all Product SKUs with variants attached
    const listSkusRes = await agent().get(`/api/v1/admin/products/${productSlug}/skus`).set(authAdmin());
    logStep('Admin SKUs List', 'GET', `/api/v1/admin/products/${productSlug}/skus`, listSkusRes.status, 200, `Total Product SKUs: ${listSkusRes.body.skus?.length}`);

    printLine('\n>>> PHASE 10: Public Customer Variant Visibility Check');

    // Search Product as Customer
    const custSearch = await agent().get('/api/v1/products').query({ q: 'Premium Cotton' });
    logStep('Customer Search', 'GET', '/api/v1/products?q=Premium+Cotton', custSearch.status, 200, `Found Products: ${custSearch.body.products?.length}`);

    // View Product Detail as Customer
    const custView = await agent().get(`/api/v1/products/${productSlug}`);
    logStep('Customer Product View', 'GET', `/api/v1/products/${productSlug}`, custView.status, 200, `Product: ${custView.body.product?.name}, SKUs: ${custView.body.product?.skus?.length}`);

    printLine('\n>>> PHASE 11: Validation & Business Rules Verification');

    // Guard 1: Duplicate Option Name on Same Product
    const dupOpt = await agent()
      .post(`/api/v1/admin/products/${productSlug}/options`)
      .set(authAdmin())
      .send({ name: 'Color' });
    logStep('Validation Guard', 'POST', `/api/v1/admin/products/${productSlug}/options`, dupOpt.status, 409, 'Refused duplicate option name (OPTION_NAME_TAKEN)');

    // Guard 2: Duplicate SKU Code
    const dupSku = await agent()
      .post(`/api/v1/admin/products/${productSlug}/skus`)
      .set(authAdmin())
      .send({ code: skuNavySmall, name: 'Duplicate SKU', price: '1000.0000' });
    logStep('Validation Guard', 'POST', `/api/v1/admin/products/${productSlug}/skus`, dupSku.status, 409, 'Refused duplicate SKU code (SKU_CODE_TAKEN)');

    // Guard 3: Duplicate Option Combination on Another SKU
    const dupComboSku = `TSHIRT-DUP-COMBO-${timeStamp}`;
    await agent()
      .post(`/api/v1/admin/products/${productSlug}/skus`)
      .set(authAdmin())
      .send({ code: dupComboSku, name: 'Duplicate Combination SKU', price: '1499.0000' });
    const dupComboRes = await agent()
      .put(`/api/v1/admin/skus/${dupComboSku}/options`)
      .set(authAdmin())
      .send({ optionValueIds: [navyValId, smallValId] });
    logStep('Validation Guard', 'PUT', `/api/v1/admin/skus/${dupComboSku}/options`, dupComboRes.status, 409, 'Refused duplicate variant combination (SKU_COMBINATION_TAKEN)');

    // Guard 4: Deleting Option Value Currently Used by a Live SKU
    const delValInUse = await agent().delete(`/api/v1/admin/option-values/${navyValId}`).set(authAdmin());
    logStep('Validation Guard', 'DELETE', `/api/v1/admin/option-values/${navyValId}`, delValInUse.status, 409, 'Refused deleting option value in use (OPTION_VALUE_IN_USE)');

    printLine('\n========================================================================================');
    printLine(` SUCCESS! All ${stepCount} Admin Multi-Variant Audit steps executed flawlessly! `);
    printLine('========================================================================================\n');
  } finally {
    await dbHandle.close();
  }
}

runAdminVariantAudit().catch((error) => {
  printLine(`\n[CRITICAL FAILURE] Admin Variant Audit failed at Step ${stepCount}:`);
  printLine(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
