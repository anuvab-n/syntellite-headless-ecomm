import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../../../container.js';
import { appUser } from '../../../db/schema/identity.js';
import { newId } from '../../../shared/id.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../../../tests/helpers/redis.ts';

describe('tax (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  let storeId = '';
  let staffToken = '';
  let customerToken = '';

  const PASSWORD = 'a-sufficiently-long-password';
  const SKU_CODE = 'TAX-SKU-1';
  const TAX_CLASS_CODE = 'GST_18';
  const SELLER_GSTIN = '29AABCE1234F1Z5';
  const CUSTOMER_GSTIN = '29AAACB1234C1ZX';

  const api = () => request(container.app);
  const db = () => container.db.db;

  const asStaff = (token = staffToken) => ({ Authorization: `Bearer ${token}` });
  const asCustomer = (token = customerToken) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
    container = buildContainer({
      role: 'api',
      config: buildTestConfig({
        databaseUrl: testDb.connectionUri,
        redisUrl: redis.url,
        extraEnv: {
          AUTH_RATE_LIMIT_IP_MAX: '2000',
          AUTH_RATE_LIMIT_EMAIL_MAX: '2000',
        },
      }),
      drainer: { pollIntervalMs: 50 },
    });

    storeId = (await seedTestStore({ ...testDb, config: container.config })).id;

    // Register staff user
    const staffEmail = `staff.tax.${newId()}@example.com`;
    const staffUser = await container.identity.registerCustomer({
      storeId,
      input: { email: staffEmail, password: PASSWORD, firstName: 'Ops', lastName: 'Staff' },
    });
    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, staffUser.id));

    const staffLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: PASSWORD });
    staffToken = staffLogin.body.accessToken as string;

    // Register customer user
    const customerEmail = `customer.tax.${newId()}@example.com`;
    await container.identity.registerCustomer({
      storeId,
      input: { email: customerEmail, password: PASSWORD, firstName: 'Alice', lastName: 'Smith' },
    });

    const customerLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: customerEmail, password: PASSWORD });
    customerToken = customerLogin.body.accessToken as string;

    // Seed product and SKU for tax classification
    const product = await api().post('/api/v1/admin/products').set(asStaff()).send({
      slug: 'tax-test-product',
      name: 'Tax Test Product',
      status: 'active',
    });
    expect(product.status).toBe(201);

    const createdSku = await api()
      .post('/api/v1/admin/products/tax-test-product/skus')
      .set(asStaff())
      .send({ code: SKU_CODE, price: '200.0000', name: SKU_CODE });
    expect(createdSku.status).toBe(201);
  }, 300_000);

  afterAll(async () => {
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  describe('authorization & access control', () => {
    it('requires authentication for all tax endpoints', async () => {
      expect((await api().get('/api/v1/admin/store/tax-profile')).status).toBe(401);
      expect((await api().put('/api/v1/admin/store/tax-profile')).status).toBe(401);
      expect((await api().get('/api/v1/admin/tax-classes')).status).toBe(401);
      expect((await api().post('/api/v1/admin/tax-classes')).status).toBe(401);
      expect((await api().patch('/api/v1/admin/tax-classes/GST5')).status).toBe(401);
      expect((await api().get('/api/v1/users/me/tax-identity')).status).toBe(401);
      expect((await api().put('/api/v1/users/me/tax-identity')).status).toBe(401);
      expect((await api().delete('/api/v1/users/me/tax-identity')).status).toBe(401);
    });

    it('refuses non-staff users from admin tax endpoints (403)', async () => {
      expect((await api().get('/api/v1/admin/store/tax-profile').set(asCustomer())).status).toBe(
        403,
      );
      expect((await api().put('/api/v1/admin/store/tax-profile').set(asCustomer())).status).toBe(
        403,
      );
      expect((await api().get('/api/v1/admin/tax-classes').set(asCustomer())).status).toBe(403);
      expect((await api().post('/api/v1/admin/tax-classes').set(asCustomer())).status).toBe(403);
      expect((await api().patch('/api/v1/admin/tax-classes/GST5').set(asCustomer())).status).toBe(
        403,
      );
      expect((await api().put(`/api/v1/admin/skus/${SKU_CODE}/tax`).set(asCustomer())).status).toBe(
        403,
      );
    });
  });

  describe('seller tax profile management', () => {
    it('returns unconfigured profile status initially', async () => {
      const res = await api().get('/api/v1/admin/store/tax-profile').set(asStaff());
      expect(res.status).toBe(200);
      expect(res.body.taxProfile.configured).toBe(false);
    });

    it('rejects malformed seller tax profile (bad GSTIN)', async () => {
      const res = await api().put('/api/v1/admin/store/tax-profile').set(asStaff()).send({
        legalName: 'Test Seller Inc',
        gstin: 'NOT_A_VALID_GSTIN',
        originLine1: '123 Tech Park',
        originCity: 'Bengaluru',
        originState: 'Karnataka',
        originPostalCode: '560001',
        originCountryCode: 'IN',
      });

      expect(res.status).toBe(400);
    });

    it('sets and retrieves seller tax profile', async () => {
      const putRes = await api().put('/api/v1/admin/store/tax-profile').set(asStaff()).send({
        legalName: 'Test Retail Pvt Ltd',
        gstin: SELLER_GSTIN,
        originLine1: '4th Floor, MG Road',
        originCity: 'Bengaluru',
        originState: 'Karnataka',
        originPostalCode: '560001',
        originCountryCode: 'IN',
      });

      expect(putRes.status).toBe(200);
      expect(putRes.body.taxProfile).toMatchObject({
        legalName: 'Test Retail Pvt Ltd',
        gstin: SELLER_GSTIN,
        origin: { state: 'Karnataka' },
        configured: true,
      });

      const getRes = await api().get('/api/v1/admin/store/tax-profile').set(asStaff());
      expect(getRes.status).toBe(200);
      expect(getRes.body.taxProfile.configured).toBe(true);
      expect(getRes.body.taxProfile.gstin).toBe(SELLER_GSTIN);
    });
  });

  describe('tax classes management', () => {
    it('creates a tax class', async () => {
      const res = await api().post('/api/v1/admin/tax-classes').set(asStaff()).send({
        code: TAX_CLASS_CODE,
        name: 'GST 18% Standard',
        isActive: true,
      });

      expect(res.status).toBe(201);
      expect(res.body.taxClass).toMatchObject({
        code: TAX_CLASS_CODE,
        name: 'GST 18% Standard',
        isActive: true,
      });
    });

    it('refuses duplicate tax class code creation (409)', async () => {
      const res = await api().post('/api/v1/admin/tax-classes').set(asStaff()).send({
        code: TAX_CLASS_CODE,
        name: 'Duplicate GST 18%',
      });

      expect(res.status).toBe(409);
    });

    it('lists tax classes for the store', async () => {
      const res = await api().get('/api/v1/admin/tax-classes').set(asStaff());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.taxClasses)).toBe(true);
      const found = (res.body.taxClasses as { code: string }[]).find(
        (tc) => tc.code === TAX_CLASS_CODE,
      );
      expect(found).toBeDefined();
    });

    it('patches a tax class name and active status', async () => {
      const res = await api()
        .patch(`/api/v1/admin/tax-classes/${TAX_CLASS_CODE}`)
        .set(asStaff())
        .send({
          name: 'GST 18% Standard (Updated)',
        });

      expect(res.status).toBe(200);
      expect(res.body.taxClass.name).toBe('GST 18% Standard (Updated)');
    });
  });

  describe('tax rates management', () => {
    it('adds an effective-dated tax rate to a tax class', async () => {
      const res = await api()
        .post(`/api/v1/admin/tax-classes/${TAX_CLASS_CODE}/rates`)
        .set(asStaff())
        .send({
          cgstRate: '9.0',
          sgstRate: '9.0',
          igstRate: '18.0',
          effectiveFrom: '2024-01-01T00:00:00.000Z',
        });

      expect(res.status).toBe(201);
      expect(res.body.taxRate).toMatchObject({
        cgstRate: '9.000000',
        sgstRate: '9.000000',
        igstRate: '18.000000',
      });
    });

    it('refuses overlapping tax rate windows (409)', async () => {
      const res = await api()
        .post(`/api/v1/admin/tax-classes/${TAX_CLASS_CODE}/rates`)
        .set(asStaff())
        .send({
          cgstRate: '9.0',
          sgstRate: '9.0',
          igstRate: '18.0',
          effectiveFrom: '2024-06-01T00:00:00.000Z',
        });

      expect(res.status).toBe(409);
    });

    it('lists tax rates for a tax class', async () => {
      const res = await api()
        .get(`/api/v1/admin/tax-classes/${TAX_CLASS_CODE}/rates`)
        .set(asStaff());

      expect(res.status).toBe(200);
      expect(res.body.taxClass.code).toBe(TAX_CLASS_CODE);
      expect(res.body.taxRates).toHaveLength(1);
    });
  });

  describe('SKU tax classification', () => {
    it('assigns a tax class and HSN code to a SKU', async () => {
      const res = await api().put(`/api/v1/admin/skus/${SKU_CODE}/tax`).set(asStaff()).send({
        taxClassCode: TAX_CLASS_CODE,
        hsnCode: '61091000',
      });

      expect(res.status).toBe(200);
      expect(res.body.skuTax).toMatchObject({
        skuCode: SKU_CODE,
        taxClassCode: TAX_CLASS_CODE,
        hsnCode: '61091000',
      });
    });

    it('404s SKU classification if SKU or tax class is unknown', async () => {
      const res1 = await api().put('/api/v1/admin/skus/NON_EXISTENT_SKU/tax').set(asStaff()).send({
        taxClassCode: TAX_CLASS_CODE,
        hsnCode: '61091000',
      });
      expect(res1.status).toBe(404);

      const res2 = await api().put(`/api/v1/admin/skus/${SKU_CODE}/tax`).set(asStaff()).send({
        taxClassCode: 'NON_EXISTENT_CLASS',
        hsnCode: '61091000',
      });
      expect(res2.status).toBe(404);
    });
  });

  describe('customer tax identity management', () => {
    it('returns 404 when customer has no saved tax identity', async () => {
      const res = await api().get('/api/v1/users/me/tax-identity').set(asCustomer());
      expect(res.status).toBe(404);
    });

    it('rejects invalid customer GSTIN (400)', async () => {
      const res = await api().put('/api/v1/users/me/tax-identity').set(asCustomer()).send({
        gstin: 'INVALID_GSTIN_FORMAT',
        legalName: 'Customer Business',
      });

      expect(res.status).toBe(400);
    });

    it('creates and reads customer tax identity', async () => {
      const putRes = await api().put('/api/v1/users/me/tax-identity').set(asCustomer()).send({
        gstin: CUSTOMER_GSTIN,
        legalName: 'Alice Tech LLP',
      });

      expect(putRes.status).toBe(200);
      expect(putRes.body.taxIdentity).toMatchObject({
        gstin: CUSTOMER_GSTIN,
        legalName: 'Alice Tech LLP',
      });

      const getRes = await api().get('/api/v1/users/me/tax-identity').set(asCustomer());
      expect(getRes.status).toBe(200);
      expect(getRes.body.taxIdentity.gstin).toBe(CUSTOMER_GSTIN);
    });

    it('deletes customer tax identity', async () => {
      const delRes = await api().delete('/api/v1/users/me/tax-identity').set(asCustomer());
      expect(delRes.status).toBe(204);

      const getRes = await api().get('/api/v1/users/me/tax-identity').set(asCustomer());
      expect(getRes.status).toBe(404);
    });

    it('returns 404 deleting non-existent customer tax identity', async () => {
      const delRes = await api().delete('/api/v1/users/me/tax-identity').set(asCustomer());
      expect(delRes.status).toBe(404);
    });
  });
});
