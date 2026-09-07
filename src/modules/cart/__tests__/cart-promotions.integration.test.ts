import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cart } from '../../../db/schema/cart.js';
import { product, sku } from '../../../db/schema/catalogue.js';
import { auditLog } from '../../../db/schema/identity.js';
import { stockItem } from '../../../db/schema/inventory.js';
import { outboxEvent } from '../../../db/schema/outbox.js';
import { cartPromotion, promotion } from '../../../db/schema/promotions.js';
import { store } from '../../../db/schema/store.js';
import { createApp } from '../../../http/app.js';
import { resolveStore } from '../../../http/middleware/store.js';
import {
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { giveSku } from '../../../../tests/helpers/catalogue.ts';
import { testRecorders } from '../../../../tests/helpers/recording.ts';
import { newId } from '../../../shared/id.js';
import { createIdentityRepository } from '../../identity/identity.repository.js';
import { createIdentityRoutes } from '../../identity/identity.routes.js';
import { createIdentityService } from '../../identity/identity.service.js';
import { createRefreshSessionRepository } from '../../identity/refresh-session.repository.js';
import { createPasswordResetRepository } from '../../identity/password-reset.repository.js';
import { createTokenService } from '../../identity/tokens.js';
import { createPromotionsRepository } from '../../promotions/promotions.repository.js';
import { createPromotionsService } from '../../promotions/promotions.service.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createCartRepository } from '../cart.repository.js';
import { createCartRoutes } from '../cart.routes.js';
import { createCartService } from '../cart.service.js';

/**
 * Coupons on a cart — against real PostgreSQL, with the REAL promotions service behind the
 * port rather than a stub. A stub would let a broken port pass: the cart would compose totals
 * from whatever the double returned, and a wrong predicate in the promotions repository would
 * go unnoticed.
 *
 * Six properties carry this suite:
 *
 *  1. **`subtotal - discountTotal = cartTotal`, on every response.** Asserted arithmetically
 *     rather than by example, because that identity is the whole contract of the Increment 29
 *     response change — and `cartTotal` changed meaning, which is a breaking change that
 *     deserves a regression test rather than a changelog line.
 *
 *  2. **One promotion per cart, and a second code REPLACES the first.** Under genuine
 *     concurrency too. `pk_cart_promotion` is the mechanism; these tests exist to prove it is
 *     load-bearing rather than decorative.
 *
 *  3. **The discount is derived on every read, never stored.** A coupon that expires while a
 *     basket sits untouched stops applying; one blocked by a minimum starts applying again when
 *     the cart qualifies; a merchant's price change moves the discount with it.
 *
 *  4. **Money is exact.** Decimal strings through `shared/money.ts`, never a JS number,
 *     including the case where a fixed discount exceeds the cart.
 *
 *  5. **Applying a coupon consumes nothing.** No redemption, no usage counter, no inventory.
 *
 *  6. **The database enforces tenancy.** Both composite foreign keys asserted by NAME from
 *     direct SQL, because a test that only speaks HTTP cannot tell an application check from a
 *     database one.
 */
describe('cart promotions (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';
  const CODE = 'SHIRT-BLUE-M';
  const COUPON = 'SAVE10';

  beforeAll(async () => {
    testDb = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  beforeEach(async () => {
    await testDb.truncate();
    storeId = (await seedTestStore(testDb)).id;
  });

  const db = () => testDb.handle.db;

  function build(slug = testDb.config.defaultStoreSlug) {
    const identityRepository = createIdentityRepository({ db: db() });
    const tokens = createTokenService({ config: testDb.config, logger: silentLogger });
    const cartRepository = createCartRepository({ db: db() });

    const identity = createIdentityService({
      repository: identityRepository,
      sessions: createRefreshSessionRepository({ db: db() }),
      passwordResets: createPasswordResetRepository({ db: db() }),
      tokens,
      db: db(),
      config: testDb.config,
      logger: silentLogger,
      ...testRecorders(db()),
    });

    const promotions = createPromotionsService({
      repository: createPromotionsRepository({ db: db() }),
      db: db(),
      audit: testRecorders(db()).audit,
      logger: silentLogger,
    });

    /**
     * The port, wired exactly as `container.ts` wires it.
     *
     * Written out here rather than importing a shared helper so that a change to the real
     * composition root which this suite does not mirror shows up as a type error.
     */
    const cartService = createCartService({
      repository: cartRepository,
      promotions: {
        findApplicable: (input) => promotions.findApplicable(input),
        evaluateApplied: (input) => promotions.evaluateApplied(input),
      },
      db: db(),
      logger: silentLogger,
    });

    const apiRouter = Router();
    apiRouter.use(
      resolveStore({
        resolver: createDefaultStoreResolver({
          repository: createStoreRepository({ db: db() }),
          slug,
          logger: silentLogger,
          cacheTtlMs: 0,
        }),
        logger: silentLogger,
      }),
    );
    apiRouter.use(createIdentityRoutes({ identity, tokens, logger: silentLogger }));
    apiRouter.use(
      createCartRoutes({
        cart: cartService,
        verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
        logger: silentLogger,
      }),
    );

    return {
      app: createApp({ config: testDb.config, logger: silentLogger, healthChecks: [], apiRouter }),
      identity,
      promotions,
      cart: cartService,
    };
  }

  type App = ReturnType<typeof build>['app'];
  type Identity = ReturnType<typeof build>['identity'];

  async function signIn(
    app: App,
    identity: Identity,
    options: { email?: string; storeId?: string } = {},
  ): Promise<{ token: string; userId: string }> {
    const email = options.email ?? 'ada@example.com';
    const user = await identity.registerCustomer({
      storeId: options.storeId ?? storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(response.status).toBe(200);
    return { token: response.body.accessToken as string, userId: user.id };
  }

  /* ── Fixtures ──────────────────────────────────────────────────────────── */

  /** A purchasable SKU at a known price, under a published product. */
  async function givenSku(
    overrides: { code?: string; price?: string; storeId?: string; productSlug?: string } = {},
  ) {
    const owningStore = overrides.storeId ?? storeId;
    const parent = {
      id: newId(),
      storeId: owningStore,
      slug: overrides.productSlug ?? `p-${(overrides.code ?? CODE).toLowerCase()}`,
      name: 'Blue Cotton Shirt',
      description: '',
      status: 'active',
    };
    await db().insert(product).values(parent);
    const created = await giveSku(db(), parent, {
      code: overrides.code ?? CODE,
      price: overrides.price ?? '1000.0000',
      deletedAt: null,
    });
    return { ...created, storeId: owningStore, productId: parent.id };
  }

  /** A promotion, inserted directly: this suite tests the CART, not the admin API. */
  async function givenPromotion(
    overrides: {
      code?: string;
      discountType?: string;
      percentRate?: string | null;
      amount?: string | null;
      minSubtotal?: string | null;
      startsAt?: Date | null;
      endsAt?: Date | null;
      isActive?: boolean;
      deletedAt?: Date | null;
      storeId?: string;
    } = {},
  ) {
    const values = {
      id: newId(),
      storeId: overrides.storeId ?? storeId,
      code: overrides.code ?? COUPON,
      name: 'Festive offer',
      discountType: overrides.discountType ?? 'percentage',
      percentRate:
        overrides.percentRate === undefined
          ? overrides.discountType === 'fixed_amount'
            ? null
            : '10'
          : overrides.percentRate,
      amount: overrides.amount ?? null,
      minSubtotal: overrides.minSubtotal ?? null,
      startsAt: overrides.startsAt ?? null,
      endsAt: overrides.endsAt ?? null,
      isActive: overrides.isActive ?? true,
      deletedAt: overrides.deletedAt ?? null,
    };
    await db().insert(promotion).values(values);
    return values;
  }

  /* ── Request helpers ───────────────────────────────────────────────────── */

  const getCart = (app: App, token?: string) => {
    const req = request(app).get('/api/v1/users/me/cart');
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const putItem = (app: App, code: string, quantity: number, token: string) =>
    request(app)
      .put(`/api/v1/users/me/cart/items/${code}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ quantity });

  const applyCoupon = (app: App, body: unknown, token?: string) => {
    const req = request(app).put('/api/v1/users/me/cart/promotion');
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send(
      body as object,
    );
  };

  const removeCoupon = (app: App, token?: string) => {
    const req = request(app).delete('/api/v1/users/me/cart/promotion');
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const clearCart = (app: App, token: string) =>
    request(app).delete('/api/v1/users/me/cart').set('Authorization', `Bearer ${token}`);

  /* ── Assertions ────────────────────────────────────────────────────────── */

  type CartBody = {
    cart: {
      subtotal: string;
      discountTotal: string;
      cartTotal: string;
      promotion: { code: string; name: string; discountTotal: string } | null;
    };
  };

  /**
   * The identity that defines the new response contract.
   *
   * Computed with exact decimal arithmetic on the strings the API returned, not with
   * `Number()` — a float comparison here would pass even if the server had drifted.
   */
  function expectTotalsConsistent(body: CartBody): void {
    const paise = (v: string) => BigInt(v.replace('.', ''));
    expect(paise(body.cart.subtotal) - paise(body.cart.discountTotal)).toBe(
      paise(body.cart.cartTotal),
    );
    // And the promotion's own figure agrees with the cart's.
    if (body.cart.promotion !== null) {
      expect(body.cart.promotion.discountTotal).toBe(body.cart.discountTotal);
    } else {
      expect(body.cart.discountTotal).toBe('0.0000');
    }
  }

  const promotionRows = async () => db().select().from(cartPromotion);

  async function expectConstraint(work: Promise<unknown>, constraint: string): Promise<void> {
    let caught: unknown;
    try {
      await work;
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected the write to be refused').toBeDefined();
    const chain = [caught, (caught as { cause?: unknown }).cause]
      .map((e) => (e instanceof Error ? e.message : ''))
      .join(' | ');
    expect(chain).toContain(constraint);
  }

  /** A cart holding `quantity` of a 1000.0000 SKU, plus a signed-in customer. */
  async function cartWith(quantity: number, options: { price?: string } = {}) {
    await givenSku(options.price === undefined ? {} : { price: options.price });
    const built = build();
    const auth = await signIn(built.app, built.identity);
    await putItem(built.app, CODE, quantity, auth.token);
    return { ...built, ...auth };
  }

  /* ── The response contract ─────────────────────────────────────────────── */

  describe('response contract', () => {
    it('reports subtotal, a zero discount and an equal cartTotal with no promotion', async () => {
      const { app, token } = await cartWith(2);

      const response = await getCart(app, token);

      /**
       * **The regression test for the meaning change.** Before promotions, `cartTotal` WAS this
       * number. It still is when nothing is applied — so an existing client reading `cartTotal`
       * on a cart with no coupon sees exactly what it saw before, and only a discounted cart
       * differs.
       */
      expect(response.body.cart.subtotal).toBe('2000.0000');
      expect(response.body.cart.discountTotal).toBe('0.0000');
      expect(response.body.cart.cartTotal).toBe('2000.0000');
      expect(response.body.cart.promotion).toBeNull();
      expectTotalsConsistent(response.body as CartBody);
    });

    it('reports all three totals as STRINGS, never JSON numbers', async () => {
      const { app, token } = await cartWith(1);
      await givenPromotion();
      await applyCoupon(app, { code: COUPON }, token);

      const { cart: body } = (await getCart(app, token)).body as CartBody['cart'] extends never
        ? never
        : CartBody;

      for (const value of [body.subtotal, body.discountTotal, body.cartTotal]) {
        expect(typeof value).toBe('string');
      }
      expect(typeof body.promotion?.discountTotal).toBe('string');
    });

    it('exposes exactly three promotion fields, and no internal id', async () => {
      const { app, token } = await cartWith(1);
      await givenPromotion();

      const response = await applyCoupon(app, { code: COUPON }, token);

      expect(Object.keys(response.body.cart.promotion).sort()).toEqual([
        'code',
        'discountTotal',
        'name',
      ]);
      /**
       * A customer needs to know which coupon is applied and what it saved them, not how the
       * merchant configured it. No id, no type, no rate, no minimum, no window.
       */
      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain('promotionId');
      expect(serialised).not.toContain('percentRate');
      expect(serialised).not.toContain('minSubtotal');
      expect(serialised).not.toContain('discountType');
      expect(serialised).not.toContain('storeId');
      expect(serialised).not.toContain('rejectionReason');
    });

    it('keeps the identity on every route that returns a cart', async () => {
      const { app, token } = await cartWith(3);
      await givenPromotion({ percentRate: '33.333333' });

      for (const body of [
        (await applyCoupon(app, { code: COUPON }, token)).body,
        (await getCart(app, token)).body,
        (await putItem(app, CODE, 5, token)).body,
      ]) {
        expectTotalsConsistent(body as CartBody);
      }
    });
  });

  /* ── Applying ──────────────────────────────────────────────────────────── */

  describe('apply', () => {
    it('applies a percentage discount', async () => {
      const { app, token } = await cartWith(2);
      await givenPromotion({ percentRate: '10' });

      const response = await applyCoupon(app, { code: COUPON }, token);

      expect(response.status).toBe(200);
      expect(response.body.cart.subtotal).toBe('2000.0000');
      expect(response.body.cart.discountTotal).toBe('200.0000');
      expect(response.body.cart.cartTotal).toBe('1800.0000');
      expect(response.body.cart.promotion.code).toBe(COUPON);
      expect(response.body.cart.promotion.name).toBe('Festive offer');
      expect(await promotionRows()).toHaveLength(1);
    });

    it('applies a fixed-amount discount', async () => {
      const { app, token } = await cartWith(2);
      await givenPromotion({ discountType: 'fixed_amount', amount: '250.0000' });

      const response = await applyCoupon(app, { code: COUPON }, token);

      expect(response.body.cart.discountTotal).toBe('250.0000');
      expect(response.body.cart.cartTotal).toBe('1750.0000');
    });

    it('matches the code case-insensitively', async () => {
      const { app, token } = await cartWith(1);
      await givenPromotion({ code: 'Diwali_2026' });

      for (const typed of ['Diwali_2026', 'diwali_2026', 'DIWALI_2026']) {
        const response = await applyCoupon(app, { code: typed }, token);
        expect(response.status, typed).toBe(200);
        // The stored case comes back, not what the customer typed.
        expect(response.body.cart.promotion.code).toBe('Diwali_2026');
      }
    });

    it('trims the submitted code', async () => {
      const { app, token } = await cartWith(1);
      await givenPromotion();

      expect((await applyCoupon(app, { code: `  ${COUPON}  ` }, token)).status).toBe(200);
    });

    it('is retry-safe: the identical apply changes nothing', async () => {
      const { app, token } = await cartWith(2);
      await givenPromotion();

      const first = await applyCoupon(app, { code: COUPON }, token);
      const retry = await applyCoupon(app, { code: COUPON }, token);

      /**
       * The reason no `Idempotency-Key` middleware is mounted. The write is an upsert keyed on
       * the cart, so a client retrying after a timeout cannot apply anything twice — and there
       * is nothing to double anyway, because applying consumes nothing.
       */
      expect(retry.status).toBe(200);
      expect(retry.body.cart.discountTotal).toBe(first.body.cart.discountTotal);
      expect(await promotionRows()).toHaveLength(1);
    });

    it('creates the cart if the customer has none, then refuses on the empty cart', async () => {
      await givenSku();
      const built = build();
      const { token } = await signIn(built.app, built.identity);
      await givenPromotion();

      const response = await applyCoupon(built.app, { code: COUPON }, token);

      // The cart came into existence — implicit creation is unchanged — but no association row
      // was written against it.
      expect(response.status).toBe(422);
      expect(await db().select().from(cart)).toHaveLength(1);
      expect(await promotionRows()).toEqual([]);
    });
  });

  /* ── Replacement ───────────────────────────────────────────────────────── */

  describe('replacement', () => {
    it('REPLACES the applied promotion, in one request', async () => {
      const { app, token } = await cartWith(2);
      await givenPromotion({ code: 'TEN', percentRate: '10' });
      await givenPromotion({ code: 'TWENTY', percentRate: '20' });

      await applyCoupon(app, { code: 'TEN' }, token);
      const response = await applyCoupon(app, { code: 'TWENTY' }, token);

      /**
       * No `DELETE` first. Requiring one would be a rule the customer never agreed to, and
       * would leave their cart briefly with no promotion at all.
       */
      expect(response.status).toBe(200);
      expect(response.body.cart.promotion.code).toBe('TWENTY');
      expect(response.body.cart.discountTotal).toBe('400.0000');
      // Exactly one row, ever.
      expect(await promotionRows()).toHaveLength(1);
    });

    it('cannot hold two promotions even when one is applied twice over', async () => {
      const { app, token } = await cartWith(1);
      for (const code of ['A1', 'B1', 'C1']) {
        await givenPromotion({ code, percentRate: '5' });
      }

      for (const code of ['A1', 'B1', 'C1', 'A1']) {
        await applyCoupon(app, { code }, token);
      }

      const rows = await promotionRows();
      expect(rows).toHaveLength(1);
      expect((await getCart(app, token)).body.cart.promotion.code).toBe('A1');
    });

    it('refuses a replacement that is itself ineligible, keeping the original', async () => {
      const { app, token } = await cartWith(1); // subtotal 1000
      await givenPromotion({ code: 'TEN', percentRate: '10' });
      await givenPromotion({ code: 'BIG', percentRate: '50', minSubtotal: '5000.0000' });

      await applyCoupon(app, { code: 'TEN' }, token);
      expect((await applyCoupon(app, { code: 'BIG' }, token)).status).toBe(422);

      // The failed apply must not have discarded the working coupon.
      const after = await getCart(app, token);
      expect(after.body.cart.promotion.code).toBe('TEN');
      expect(after.body.cart.discountTotal).toBe('100.0000');
    });
  });

  /* ── Removal ───────────────────────────────────────────────────────────── */

  describe('remove', () => {
    it('removes the association and 404s a repeated remove', async () => {
      const { app, token } = await cartWith(2);
      await givenPromotion();
      await applyCoupon(app, { code: COUPON }, token);

      expect((await removeCoupon(app, token)).status).toBe(204);
      expect((await removeCoupon(app, token)).status).toBe(404);

      const after = await getCart(app, token);
      expect(after.body.cart.promotion).toBeNull();
      expect(after.body.cart.cartTotal).toBe('2000.0000');
      expect(await promotionRows()).toEqual([]);
    });

    it('404s when no promotion is applied', async () => {
      const { app, token } = await cartWith(1);

      expect((await removeCoupon(app, token)).status).toBe(404);
    });

    it('never deletes the PROMOTION itself', async () => {
      const { app, token } = await cartWith(1);
      await givenPromotion();
      await applyCoupon(app, { code: COUPON }, token);

      await removeCoupon(app, token);

      // A customer discarding a coupon must not affect the merchant's configuration or any
      // other customer's cart.
      const stored = await db().select().from(promotion);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.deletedAt).toBeNull();
    });

    it('removes an EXPIRED promotion, which is exactly when a customer wants to', async () => {
      const { app, token } = await cartWith(1);
      const promo = await givenPromotion();
      await applyCoupon(app, { code: COUPON }, token);

      await db()
        .update(promotion)
        .set({ endsAt: new Date(Date.now() - 60_000) })
        .where(eq(promotion.id, promo.id));

      // The row is what is being removed, and the remove does not care whether it still
      // discounts anything — otherwise a customer would be stuck with a dead coupon attached.
      expect((await removeCoupon(app, token)).status).toBe(204);
      expect(await promotionRows()).toEqual([]);
    });
  });

  /* ── Rejection ─────────────────────────────────────────────────────────── */

  describe('rejection', () => {
    it('404s unknown, inactive, deleted, expired and not-yet-started codes alike', async () => {
      const { app, token } = await cartWith(2);
      const hour = 3_600_000;
      await givenPromotion({ code: 'OFF1', isActive: false });
      await givenPromotion({ code: 'GONE1', deletedAt: new Date() });
      await givenPromotion({ code: 'PAST1', endsAt: new Date(Date.now() - hour) });
      await givenPromotion({ code: 'SOON1', startsAt: new Date(Date.now() + hour) });

      for (const code of ['NOSUCH1', 'OFF1', 'GONE1', 'PAST1', 'SOON1']) {
        const response = await applyCoupon(app, { code }, token);
        expect(response.status, code).toBe(404);
        expect(response.body.error.code).toBe('NOT_FOUND');
        // The message must not distinguish them, or the endpoint becomes an oracle for
        // discovering which coupons exist.
        expect(response.body.error.message).toBe(
          (await applyCoupon(app, { code: 'NOSUCH1' }, token)).body.error.message,
        );
      }
      expect(await promotionRows()).toEqual([]);
    });

    it('does not echo the submitted code back in the error', async () => {
      const { app, token } = await cartWith(1);

      const response = await applyCoupon(app, { code: 'SECRETCODE' }, token);

      expect(JSON.stringify(response.body)).not.toContain('SECRETCODE');
    });

    it('422s a subtotal below the minimum, naming the threshold', async () => {
      const { app, token } = await cartWith(1); // subtotal 1000
      await givenPromotion({ minSubtotal: '1500.0000' });

      const response = await applyCoupon(app, { code: COUPON }, token);

      /**
       * The ONE apply failure distinguished from a 404, and it leaks nothing worth having: the
       * customer has already proved they know the code, and "spend ₹500 more" is the entire
       * point of a minimum.
       */
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('PROMOTION_MINIMUM_SUBTOTAL');
      expect(response.body.error.details.minSubtotal).toBe('1500.0000');
      expect(response.body.error.details.subtotal).toBe('1000.0000');
      expect(await promotionRows()).toEqual([]);
    });

    it('treats the minimum as INCLUSIVE', async () => {
      const { app, token } = await cartWith(1); // subtotal exactly 1000
      await givenPromotion({ minSubtotal: '1000.0000' });

      // Equality qualifies: the reading a merchant writing "on orders of ₹1000 or more"
      // expects, and the only one with no dead value sitting exactly on the line.
      expect((await applyCoupon(app, { code: COUPON }, token)).status).toBe(200);
    });

    it('rejects one paisa below the minimum', async () => {
      const { app, token } = await cartWith(1, { price: '999.9999' });
      await givenPromotion({ minSubtotal: '1000.0000' });

      expect((await applyCoupon(app, { code: COUPON }, token)).status).toBe(422);
    });

    it('422s an empty cart', async () => {
      await givenSku();
      const built = build();
      const { token } = await signIn(built.app, built.identity);
      await givenPromotion();

      const response = await applyCoupon(built.app, { code: COUPON }, token);

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('PROMOTION_REQUIRES_ITEMS');
      expect(await promotionRows()).toEqual([]);
    });

    it('says the cart is EMPTY, not that the minimum is unmet', async () => {
      await givenSku();
      const built = build();
      const { token } = await signIn(built.app, built.identity);
      await givenPromotion({ minSubtotal: '500.0000' });

      const response = await applyCoupon(built.app, { code: COUPON }, token);

      /**
       * Both conditions hold — the cart is empty AND a zero subtotal is below the minimum — and
       * the emptiness answer is the useful one: "add something to your basket" is actionable,
       * while "spend at least ₹500" on an empty cart reads as a broken coupon.
       *
       * This case was added after a mutation probe: disabling the service's emptiness check
       * SURVIVED, because the database guard on the write refuses an empty-cart apply anyway
       * and reports the same error. The one behaviour that check still decides on its own is
       * WHICH 422 a customer sees when the coupon also has a minimum — so that is what is
       * pinned here.
       */
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('PROMOTION_REQUIRES_ITEMS');
    });

    it('422s a cart emptied of its last line', async () => {
      const { app, token } = await cartWith(1);
      await givenPromotion();
      await request(app)
        .delete(`/api/v1/users/me/cart/items/${CODE}`)
        .set('Authorization', `Bearer ${token}`);

      expect((await applyCoupon(app, { code: COUPON }, token)).status).toBe(422);
    });

    it('400s a malformed or missing code and any unknown field', async () => {
      const { app, token } = await cartWith(1);
      await givenPromotion();

      const bodies: unknown[] = [
        {},
        { code: '' },
        { code: '  ' },
        { code: '-leading' },
        { code: 'has space' },
        { code: 'a'.repeat(65) },
        { code: 123 },
        { code: null },
        { code: COUPON, quantity: 1 },
        { promotionCode: COUPON },
      ];

      for (const body of bodies) {
        const response = await applyCoupon(app, body, token);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(await promotionRows()).toEqual([]);
    });

    it('accepts a code the promotions module would accept', async () => {
      /**
       * The code pattern is restated in the cart's DTO because `no-cross-module-imports`
       * forbids importing the promotions module's copy. This asserts the two have not drifted —
       * a divergence would mean a coupon a merchant could create was unusable.
       */
      const { app, token } = await cartWith(1);
      await givenPromotion({ code: 'a.b_C9/x-1' });

      expect((await applyCoupon(app, { code: 'a.b_C9/x-1' }, token)).status).toBe(200);
    });
  });

  /* ── The discount is derived, never stored ─────────────────────────────── */

  describe('derived on every read', () => {
    it('stops discounting when the promotion is deactivated, keeping the row', async () => {
      const { app, token } = await cartWith(2);
      const promo = await givenPromotion();
      await applyCoupon(app, { code: COUPON }, token);

      await db().update(promotion).set({ isActive: false }).where(eq(promotion.id, promo.id));

      const after = await getCart(app, token);
      /**
       * `GET` never returns a discount for a promotion that is no longer live, and it never
       * writes: the association survives, so the customer can remove it deliberately — and if
       * the merchant re-enables the coupon it starts working again with no action at all.
       */
      expect(after.body.cart.promotion).toBeNull();
      expect(after.body.cart.discountTotal).toBe('0.0000');
      expect(after.body.cart.cartTotal).toBe('2000.0000');
      expect(await promotionRows()).toHaveLength(1);
    });

    it('stops discounting when the promotion expires', async () => {
      const { app, token } = await cartWith(2);
      const promo = await givenPromotion();
      await applyCoupon(app, { code: COUPON }, token);

      await db()
        .update(promotion)
        .set({ endsAt: new Date(Date.now() - 60_000) })
        .where(eq(promotion.id, promo.id));

      expect((await getCart(app, token)).body.cart.promotion).toBeNull();
    });

    it('stops discounting when the promotion is soft-deleted', async () => {
      const { app, token } = await cartWith(2);
      const promo = await givenPromotion();
      await applyCoupon(app, { code: COUPON }, token);

      await db().update(promotion).set({ deletedAt: new Date() }).where(eq(promotion.id, promo.id));

      // The RESTRICT foreign key is why a soft delete is safe here: the row survives, so the
      // customer's cart is intact and only the discount goes away.
      expect((await getCart(app, token)).body.cart.promotion).toBeNull();
      expect(await promotionRows()).toHaveLength(1);
    });

    it('starts discounting again when the cart rises back over the minimum', async () => {
      const { app, token } = await cartWith(2); // subtotal 2000
      await givenPromotion({ minSubtotal: '1500.0000' });
      await applyCoupon(app, { code: COUPON }, token);
      expect((await getCart(app, token)).body.cart.discountTotal).toBe('200.0000');

      // Down to 1000: below the minimum.
      const reduced = await putItem(app, CODE, 1, token);
      expect(reduced.body.cart.promotion).toBeNull();
      expect(reduced.body.cart.discountTotal).toBe('0.0000');
      expectTotalsConsistent(reduced.body as CartBody);

      /**
       * Back up to 3000, and the coupon works again — with no write, no sweeper and no
       * re-typing. That is the whole reason the association row is a declaration of intent
       * rather than a stored discount.
       */
      const restored = await putItem(app, CODE, 3, token);
      expect(restored.body.cart.promotion.code).toBe(COUPON);
      expect(restored.body.cart.discountTotal).toBe('300.0000');
    });

    it('moves the discount with a SKU price change', async () => {
      const created = await givenSku({ price: '1000.0000' });
      const built = build();
      const auth = await signIn(built.app, built.identity);
      await putItem(built.app, CODE, 2, auth.token);
      await givenPromotion({ percentRate: '10' });
      await applyCoupon(built.app, { code: COUPON }, auth.token);

      await db().update(sku).set({ price: '1500.0000' }).where(eq(sku.id, created.id));

      // Increment 28 stores no price and Increment 29 stores no discount, so a merchant's
      // price change needs no reconciliation on either.
      const after = await getCart(built.app, auth.token);
      expect(after.body.cart.subtotal).toBe('3000.0000');
      expect(after.body.cart.discountTotal).toBe('300.0000');
      expect(after.body.cart.cartTotal).toBe('2700.0000');
    });

    it('follows a merchant changing the promotion rate', async () => {
      const { app, token } = await cartWith(2);
      const promo = await givenPromotion({ percentRate: '10' });
      await applyCoupon(app, { code: COUPON }, token);

      await db().update(promotion).set({ percentRate: '25' }).where(eq(promotion.id, promo.id));

      expect((await getCart(app, token)).body.cart.discountTotal).toBe('500.0000');
    });

    it('survives a merchant renaming the CODE, because the cart holds the id', async () => {
      const { app, token } = await cartWith(2);
      const promo = await givenPromotion();
      await applyCoupon(app, { code: COUPON }, token);

      await db().update(promotion).set({ code: 'RENAMED' }).where(eq(promotion.id, promo.id));

      // A merchant editing a coupon's code has not handed the customer a different coupon.
      const after = await getCart(app, token);
      expect(after.body.cart.promotion.code).toBe('RENAMED');
      expect(after.body.cart.discountTotal).toBe('200.0000');
    });

    it('stores no discount, and no price, on the association row', async () => {
      const { app, token } = await cartWith(2);
      await givenPromotion();
      await applyCoupon(app, { code: COUPON }, token);

      const [row] = await promotionRows();
      expect(Object.keys(row ?? {}).sort()).toEqual([
        'cartId',
        'createdAt',
        'promotionId',
        'storeId',
        'updatedAt',
      ]);
    });
  });

  /* ── Unpurchasable lines ───────────────────────────────────────────────── */

  describe('unpurchasable lines', () => {
    it('keeps counting a deactivated SKU toward the subtotal and the discount', async () => {
      const created = await givenSku({ price: '1000.0000' });
      const built = build();
      const auth = await signIn(built.app, built.identity);
      await putItem(built.app, CODE, 2, auth.token);
      await givenPromotion({ percentRate: '10' });
      await applyCoupon(built.app, { code: COUPON }, auth.token);

      await db().update(sku).set({ isActive: false }).where(eq(sku.id, created.id));

      /**
       * Increment 28 keeps such a line and flags it. Excluding it from the subtotal here would
       * make the customer's discount change because a merchant edited a listing, with no action
       * by the customer — so the promotion is evaluated against the same subtotal the cart
       * already reports.
       */
      const after = await getCart(built.app, auth.token);
      expect(after.body.cart.items[0].isPurchasable).toBe(false);
      expect(after.body.cart.subtotal).toBe('2000.0000');
      expect(after.body.cart.discountTotal).toBe('200.0000');
      expect(after.body.cart.cartTotal).toBe('1800.0000');
    });

    it('still counts a cart of only unpurchasable lines as non-empty for apply', async () => {
      const created = await givenSku();
      const built = build();
      const auth = await signIn(built.app, built.identity);
      await putItem(built.app, CODE, 1, auth.token);
      await db().update(sku).set({ isActive: false }).where(eq(sku.id, created.id));
      await givenPromotion();

      // The lines are still there, so the cart is not empty. Consistent with the subtotal it
      // reports; anything else would need two definitions of "empty".
      expect((await applyCoupon(built.app, { code: COUPON }, auth.token)).status).toBe(200);
    });
  });

  /* ── Money ─────────────────────────────────────────────────────────────── */

  describe('money', () => {
    it('caps a fixed discount at the subtotal, never going negative', async () => {
      const { app, token } = await cartWith(1, { price: '200.0000' });
      await givenPromotion({ discountType: 'fixed_amount', amount: '500.0000' });

      const response = await applyCoupon(app, { code: COUPON }, token);

      /**
       * A ₹500 coupon on a ₹200 cart takes ₹200, not ₹500. The alternative is a negative total,
       * which is the system paying the customer to shop.
       */
      expect(response.body.cart.discountTotal).toBe('200.0000');
      expect(response.body.cart.cartTotal).toBe('0.0000');
      expect((response.body.cart.cartTotal as string).startsWith('-')).toBe(false);
      expectTotalsConsistent(response.body as CartBody);
    });

    it('takes exactly the whole cart at 100 percent', async () => {
      const { app, token } = await cartWith(3, { price: '19.9900' });
      await givenPromotion({ percentRate: '100' });

      const response = await applyCoupon(app, { code: COUPON }, token);

      // `ck_promotion_percent_range` bounds the rate at 100, so a percentage can reach zero but
      // never pass it — no application-side cap is needed or tested for.
      expect(response.body.cart.subtotal).toBe('59.9700');
      expect(response.body.cart.discountTotal).toBe('59.9700');
      expect(response.body.cart.cartTotal).toBe('0.0000');
    });

    it('computes a fractional percentage exactly', async () => {
      const { app, token } = await cartWith(3, { price: '19.9900' });
      await givenPromotion({ percentRate: '12.5' });

      const response = await applyCoupon(app, { code: COUPON }, token);

      // 59.97 x 12.5% = 7.49625, exact at the storage scale.
      expect(response.body.cart.subtotal).toBe('59.9700');
      expect(response.body.cart.discountTotal).toBe('7.4963');
      expect(response.body.cart.cartTotal).toBe('52.4737');
      expectTotalsConsistent(response.body as CartBody);
    });

    it('computes the discount ONCE on the subtotal, not per line', async () => {
      await givenSku({ code: 'A1', price: '1.0001', productSlug: 'p-a' });
      await givenSku({ code: 'B2', price: '1.0001', productSlug: 'p-b' });
      const built = build();
      const auth = await signIn(built.app, built.identity);
      await putItem(built.app, 'A1', 1, auth.token);
      await putItem(built.app, 'B2', 1, auth.token);
      await givenPromotion({ percentRate: '50' });

      const response = await applyCoupon(built.app, { code: COUPON }, auth.token);

      /**
       * **Data chosen so the two forms genuinely disagree**, which the first attempt at this
       * test did not do — 19.99×3 plus 0.0001×7 at a third off gives the same answer either
       * way, so it proved nothing. Measured against this build's money module:
       *
       *   once on the subtotal: 50% of 2.0002          -> 1.0001
       *   summed per line:      50% of 1.0001, twice   -> 1.0002
       *
       * Every money operation rounds to the storage scale, so two lines each landing on a
       * half-paisa boundary both round UP, while their combined subtotal rounds once and lands
       * lower. A per-line implementation would over-discount by a hundredth of a paisa here and
       * by more as lines multiply — and, worse, the answer would depend on how the customer
       * happened to split their basket.
       */
      expect(response.body.cart.subtotal).toBe('2.0002');
      expect(response.body.cart.discountTotal).toBe('1.0001');
      expect(response.body.cart.cartTotal).toBe('1.0001');
      expectTotalsConsistent(response.body as CartBody);
    });

    it('gives the same discount however the basket is split into lines', async () => {
      await givenSku({ code: 'ONE1', price: '1000.0000', productSlug: 'p-one' });
      await givenSku({ code: 'HALF1', price: '500.0000', productSlug: 'p-half-a' });
      await givenSku({ code: 'HALF2', price: '500.0000', productSlug: 'p-half-b' });
      const built = build();
      const auth = await signIn(built.app, built.identity);
      await givenPromotion({ percentRate: '33.333333' });

      await putItem(built.app, 'ONE1', 1, auth.token);
      const oneLine = await applyCoupon(built.app, { code: COUPON }, auth.token);

      await request(built.app)
        .delete('/api/v1/users/me/cart/items/ONE1')
        .set('Authorization', `Bearer ${auth.token}`);
      await putItem(built.app, 'HALF1', 1, auth.token);
      await putItem(built.app, 'HALF2', 1, auth.token);
      const twoLines = await getCart(built.app, auth.token);

      // Same subtotal, same discount — the property a per-line implementation would break.
      expect(twoLines.body.cart.subtotal).toBe(oneLine.body.cart.subtotal);
      expect(twoLines.body.cart.discountTotal).toBe(oneLine.body.cart.discountTotal);
    });

    it('never produces float drift', async () => {
      const { app, token } = await cartWith(3, { price: '0.1000' });
      await givenPromotion({ percentRate: '10' });

      const response = await applyCoupon(app, { code: COUPON }, token);

      expect(response.body.cart.subtotal).toBe('0.3000');
      expect(response.body.cart.discountTotal).toBe('0.0300');
      expect(response.body.cart.cartTotal).toBe('0.2700');
      expect(JSON.stringify(response.body)).not.toContain('0.30000000000000004');
    });

    it('reports the discount at four decimals, not rounded to paise', async () => {
      const { app, token } = await cartWith(1, { price: '1.0001' });
      await givenPromotion({ percentRate: '50' });

      const response = await applyCoupon(app, { code: COUPON }, token);

      /**
       * 0.50005 rounds HALF_UP to 0.5001 at the storage scale — NOT to 0.50, which is what
       * `roundToMinorUnits` or `allocate` would have produced. The cart deliberately does
       * neither: rounding to a chargeable amount is a payment-boundary act, and doing it here
       * would put a second rounding step between the cart and checkout.
       */
      expect(response.body.cart.discountTotal).toBe('0.5001');
      expect(response.body.cart.cartTotal).toBe('0.5000');
    });
  });

  /* ── Clear ─────────────────────────────────────────────────────────────── */

  describe('clear', () => {
    it('removes the lines AND the promotion, keeping the cart', async () => {
      const { app, token } = await cartWith(2);
      await givenPromotion();
      const cartId = (await applyCoupon(app, { code: COUPON }, token)).body.cart.id as string;

      expect((await clearCart(app, token)).status).toBe(204);

      const after = await getCart(app, token);
      expect(after.body.cart.id).toBe(cartId);
      expect(after.body.cart.items).toEqual([]);
      expect(after.body.cart.subtotal).toBe('0.0000');
      expect(after.body.cart.discountTotal).toBe('0.0000');
      expect(after.body.cart.cartTotal).toBe('0.0000');
      expect(after.body.cart.promotion).toBeNull();
      expect(after.body.cart.status).toBe('active');
      expect(await promotionRows()).toEqual([]);
    });

    it('does not let the next added item revive a cleared coupon', async () => {
      const { app, token } = await cartWith(2);
      await givenPromotion();
      await applyCoupon(app, { code: COUPON }, token);
      await clearCart(app, token);

      const response = await putItem(app, CODE, 1, token);

      // The association is gone, so the coupon must be re-applied deliberately.
      expect(response.body.cart.promotion).toBeNull();
      expect(response.body.cart.discountTotal).toBe('0.0000');
    });

    it('clears idempotently with a promotion applied', async () => {
      const { app, token } = await cartWith(1);
      await givenPromotion();
      await applyCoupon(app, { code: COUPON }, token);

      expect((await clearCart(app, token)).status).toBe(204);
      expect((await clearCart(app, token)).status).toBe(204);
    });

    it('carries no promotion into the new cart after checkout', async () => {
      const { app, token } = await cartWith(2);
      await givenPromotion();
      const first = (await applyCoupon(app, { code: COUPON }, token)).body.cart.id as string;

      // Checkout does not exist yet, so the transition is made directly; the point is the
      // LIFECYCLE. `cart_promotion` is keyed to the OLD cart, so the new one starts clean.
      await db().update(cart).set({ status: 'checked_out' }).where(eq(cart.id, first));

      const second = await getCart(app, token);
      expect(second.body.cart.id).not.toBe(first);
      expect(second.body.cart.promotion).toBeNull();
      // And the old association survives with the old cart, as history rather than as a leak.
      expect(await promotionRows()).toHaveLength(1);
    });
  });

  /* ── Security ──────────────────────────────────────────────────────────── */

  describe('security', () => {
    it('rejects unauthenticated requests on both routes', async () => {
      const { app } = build();

      expect((await applyCoupon(app, { code: COUPON })).status).toBe(401);
      expect((await removeCoupon(app)).status).toBe(401);
      expect(await promotionRows()).toEqual([]);
    });

    it('rejects every forgeable field on apply, one at a time', async () => {
      const { app, token } = await cartWith(1);
      await givenPromotion();

      for (const extra of [
        { userId: newId() },
        { storeId: newId() },
        { cartId: newId() },
        { promotionId: newId() },
        { actorUserId: newId() },
        { discountTotal: '9999.0000' },
        { subtotal: '1.0000' },
        { cartTotal: '0.0000' },
      ]) {
        const response = await applyCoupon(app, { code: COUPON, ...extra }, token);
        expect(response.status, Object.keys(extra)[0]).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(await promotionRows()).toEqual([]);
    });

    it('ignores a body on the bodiless DELETE', async () => {
      await givenSku();
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const { app } = built;
      await putItem(app, CODE, 1, ada.token);
      await givenPromotion();
      const adaCartId = (await applyCoupon(app, { code: COUPON }, ada.token)).body.cart
        .id as string;

      /**
       * `DELETE` validates nothing — it has no body to describe — so an unexpected JSON body
       * reaches `req.body` UNVALIDATED. Increments 24, 26, 27 and 28 each probed this shape.
       */
      const forged = { userId: ada.userId, storeId, cartId: adaCartId, promotionId: newId() };
      expect((await removeCoupon(app, grace.token).send(forged)).status).toBe(404);

      // Ada's coupon is untouched.
      expect((await getCart(app, ada.token)).body.cart.promotion.code).toBe(COUPON);
      expect(await promotionRows()).toHaveLength(1);
    });

    it('isolates two customers in the same store', async () => {
      await givenSku();
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const { app } = built;
      await putItem(app, CODE, 2, ada.token);
      await putItem(app, CODE, 1, grace.token);
      await givenPromotion();

      await applyCoupon(app, { code: COUPON }, ada.token);

      // Grace shares the coupon but not the application of it: unlimited promotions are usable
      // by everyone, and each cart carries its own association.
      expect((await getCart(app, grace.token)).body.cart.promotion).toBeNull();
      expect((await removeCoupon(app, grace.token)).status).toBe(404);
      expect((await getCart(app, ada.token)).body.cart.promotion.code).toBe(COUPON);

      await applyCoupon(app, { code: COUPON }, grace.token);
      expect(await promotionRows()).toHaveLength(2);
    });

    it('refuses another STORE’s coupon with the same 404', async () => {
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      await givenPromotion({ code: 'THEIRS1', storeId: otherStoreId });

      const { app, token } = await cartWith(1);

      const response = await applyCoupon(app, { code: 'THEIRS1' }, token);

      // Indistinguishable from an unknown code, so the endpoint cannot be used to discover a
      // competitor's coupons either.
      expect(response.status).toBe(404);
      expect(await promotionRows()).toEqual([]);
    });

    it('has no customer route that lists or discovers promotions', async () => {
      const { app, token } = await cartWith(1);
      await givenPromotion();

      for (const path of [
        '/api/v1/promotions',
        '/api/v1/users/me/promotions',
        '/api/v1/users/me/cart/promotions',
      ]) {
        const response = await request(app).get(path).set('Authorization', `Bearer ${token}`);
        expect(response.status, path).toBe(404);
      }
    });
  });

  /* ── Nothing is consumed ───────────────────────────────────────────────── */

  describe('no consumption', () => {
    it('leaves the promotion row untouched by an apply', async () => {
      const { app, token } = await cartWith(1);
      const promo = await givenPromotion();
      const before = (await db().select().from(promotion).where(eq(promotion.id, promo.id)))[0];

      await applyCoupon(app, { code: COUPON }, token);

      const after = (await db().select().from(promotion).where(eq(promotion.id, promo.id)))[0];
      // No counter, no `updated_at` bump, nothing. Applying a coupon is not redeeming it, and
      // an abandoned cart must not burn one.
      expect(after).toEqual(before);
    });

    it('has no usage or redemption table at all', async () => {
      const { rows } = await db().execute(
        sql`select table_name from information_schema.tables
             where table_schema = 'public'
               and table_name in ('promotion_redemption', 'promotion_usage', 'promotion_target', 'promotion_rule')`,
      );

      // Deferred entirely: redemption belongs to the increment that has orders, and a table
      // created now would sit permanently empty.
      expect(rows).toEqual([]);
    });

    it('has no usage-limit columns on promotion', async () => {
      const { rows } = await db().execute(
        sql`select column_name from information_schema.columns
             where table_name = 'promotion'
               and column_name in ('max_redemptions', 'redeemed_count', 'per_user_limit', 'usage_limit')`,
      );

      expect(rows).toEqual([]);
    });

    it('touches no inventory', async () => {
      const created = await givenSku();
      await db().insert(stockItem).values({ skuId: created.id, storeId, onHand: 5, reserved: 0 });
      const built = build();
      const auth = await signIn(built.app, built.identity);
      await putItem(built.app, CODE, 2, auth.token);
      await givenPromotion();

      await applyCoupon(built.app, { code: COUPON }, auth.token);
      await removeCoupon(built.app, auth.token);

      const [stock] = await db().select().from(stockItem).where(eq(stockItem.skuId, created.id));
      expect(stock?.onHand).toBe(5);
      expect(stock?.reserved).toBe(0);
    });

    it('writes NO audit row and NO event for a customer apply or remove', async () => {
      const { app, token } = await cartWith(2);
      await givenPromotion();

      await applyCoupon(app, { code: COUPON }, token);
      await getCart(app, token);
      await removeCoupon(app, token);
      await applyCoupon(app, { code: COUPON }, token);
      await clearCart(app, token);

      /**
       * Deliberate, and asserted so that adding either later is a conscious decision. A
       * customer adjusting their own basket is neither privileged nor security-relevant; the
       * staff member who CREATED the coupon is audited instead.
       */
      const audit = await db().select().from(auditLog);
      expect(audit.filter((r) => r.resourceType === 'cart')).toEqual([]);
      expect(audit.filter((r) => r.action.startsWith('cart.'))).toEqual([]);
      expect(audit.filter((r) => r.action.startsWith('promotion.'))).toEqual([]);

      const events = await db().select().from(outboxEvent);
      expect(events.filter((e) => e.aggregateType === 'promotion')).toEqual([]);
      expect(events.filter((e) => e.eventName.startsWith('promotion.'))).toEqual([]);
      expect(events.filter((e) => e.eventName.startsWith('cart.'))).toEqual([]);
    });
  });

  /* ── Concurrency ───────────────────────────────────────────────────────── */

  describe('concurrency', () => {
    /**
     * Every case runs through `Promise.all`. `DATABASE_POOL_MAX` is 5 in tests and each
     * statement takes its own connection, so these are genuinely concurrent database
     * operations rather than sequential awaits dressed up as parallel ones.
     */
    it('produces ONE row when the same coupon is applied concurrently', async () => {
      const { app, token } = await cartWith(2);
      await givenPromotion();

      const results = await Promise.all([
        applyCoupon(app, { code: COUPON }, token),
        applyCoupon(app, { code: COUPON }, token),
        applyCoupon(app, { code: COUPON }, token),
      ]);

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await promotionRows()).toHaveLength(1);
    });

    it('produces ONE row when DIFFERENT coupons race on one cart', async () => {
      const { app, token } = await cartWith(2);
      await givenPromotion({ code: 'TEN', percentRate: '10' });
      await givenPromotion({ code: 'TWENTY', percentRate: '20' });

      const results = await Promise.all([
        applyCoupon(app, { code: 'TEN' }, token),
        applyCoupon(app, { code: 'TWENTY' }, token),
      ]);

      /**
       * Both succeed and the surviving promotion is one of the two. `pk_cart_promotion` is the
       * whole mechanism: last writer wins, and two promotions on one cart is not a state the
       * database can hold. Which one wins is NOT asserted — claiming more than the database
       * provides would be manufacturing a guarantee.
       */
      expect(results.every((r) => r.status === 200)).toBe(true);
      const rows = await promotionRows();
      expect(rows).toHaveLength(1);

      const applied = (await getCart(app, token)).body.cart.promotion.code;
      expect(['TEN', 'TWENTY']).toContain(applied);
      expect((await getCart(app, token)).body.cart.discountTotal).toBe(
        applied === 'TEN' ? '200.0000' : '400.0000',
      );
    });

    it('leaves a consistent state when apply races remove', async () => {
      const { app, token } = await cartWith(2);
      await givenPromotion();
      await applyCoupon(app, { code: COUPON }, token);

      const [applied, removed] = await Promise.all([
        applyCoupon(app, { code: COUPON }, token),
        removeCoupon(app, token),
      ]);

      /**
       * Both orderings are legal and both are observable: either the remove lands first and the
       * apply re-creates the row, or the apply lands first and the remove takes it away. What
       * must never happen is two rows, or a cart whose reported discount disagrees with its
       * totals.
       */
      expect(applied.status).toBe(200);
      expect([204, 404]).toContain(removed.status);
      const rows = await promotionRows();
      expect(rows.length).toBeLessThanOrEqual(1);
      expectTotalsConsistent((await getCart(app, token)).body as CartBody);
    });

    it('lets two customers apply the same unlimited coupon concurrently', async () => {
      await givenSku();
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const { app } = built;
      await putItem(app, CODE, 2, ada.token);
      await putItem(app, CODE, 1, grace.token);
      await givenPromotion();

      const results = await Promise.all([
        applyCoupon(app, { code: COUPON }, ada.token),
        applyCoupon(app, { code: COUPON }, grace.token),
      ]);

      // No usage limits exist, so there is nothing to contend over: two carts, two rows, both
      // discounted.
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await promotionRows()).toHaveLength(2);
      expect(results[0]?.body.cart.discountTotal).toBe('200.0000');
      expect(results[1]?.body.cart.discountTotal).toBe('100.0000');
    });

    it('leaves no partial state when a clear races an apply', async () => {
      const { app, token } = await cartWith(2);
      await givenPromotion();
      await applyCoupon(app, { code: COUPON }, token);

      const [cleared, applied] = await Promise.all([
        clearCart(app, token),
        applyCoupon(app, { code: COUPON }, token),
      ]);

      /**
       * The clear's two deletes share a transaction, so a cart with a promotion and no items is
       * not observable as a committed state. The apply may land either side of it, so both
       * outcomes are legal — what matters is that the final read is self-consistent.
       */
      expect(cleared.status).toBe(204);
      expect([200, 422]).toContain(applied.status);

      const final = await getCart(app, token);
      expectTotalsConsistent(final.body as CartBody);

      /**
       * **A coupon on an empty cart must be unreachable, not merely unlikely.**
       *
       * This assertion FAILED when the emptiness check lived in JavaScript: the apply read a
       * non-empty cart, priced the coupon, and wrote its association after the clear had
       * committed. The guard now sits in the WHERE clause of the insert, so the losing apply
       * writes nothing and answers 422 — which is also the sequential answer.
       */
      if (final.body.cart.items.length === 0) {
        expect(final.body.cart.promotion).toBeNull();
        expect(await promotionRows()).toEqual([]);
        expect(applied.status).toBe(422);
      }
    });
  });

  /* ── Database constraints ──────────────────────────────────────────────── */

  describe('database constraints', () => {
    /**
     * These distinguish a DATABASE guarantee from an application check. Each writes with direct
     * SQL, bypassing the service entirely, and asserts the NAMED constraint that refuses it.
     */
    async function appliedCart() {
      const built = await cartWith(1);
      const promo = await givenPromotion();
      await applyCoupon(built.app, { code: COUPON }, built.token);
      const cartId = (await promotionRows())[0]!.cartId;
      return { ...built, promo, cartId };
    }

    it('refuses a SECOND promotion on one cart', async () => {
      const { cartId } = await appliedCart();
      const other = await givenPromotion({ code: 'OTHER1' });

      // `pk_cart_promotion` is where "no stacking" lives: not a service check, a primary key.
      await expectConstraint(
        db().insert(cartPromotion).values({ cartId, promotionId: other.id, storeId }),
        'pk_cart_promotion',
      );
    });

    it('refuses an association whose store disagrees with its CART', async () => {
      const { cartId, promo } = await appliedCart();
      await db().delete(cartPromotion).where(eq(cartPromotion.cartId, cartId));
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });

      await expectConstraint(
        db().insert(cartPromotion).values({ cartId, promotionId: promo.id, storeId: otherStoreId }),
        'fk_cart_promotion_cart_store',
      );
    });

    it('refuses an association holding ANOTHER STORE’s promotion', async () => {
      const { cartId } = await appliedCart();
      await db().delete(cartPromotion).where(eq(cartPromotion.cartId, cartId));

      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      const theirs = await givenPromotion({ code: 'THEIRS1', storeId: otherStoreId });

      /**
       * The pair of composite keys makes cross-store contamination UNREPRESENTABLE: both pin
       * the same `store_id` column, so naming our store fails the promotion key and naming
       * theirs fails the cart key. Either way the row cannot exist.
       */
      await expectConstraint(
        db().insert(cartPromotion).values({ cartId, promotionId: theirs.id, storeId }),
        'fk_cart_promotion_promotion_store',
      );
    });

    it('refuses a HARD delete of a promotion that is applied to a cart', async () => {
      const { promo } = await appliedCart();

      // RESTRICT: a customer's cart is not something to break on a merchant's mistake. Retiring
      // a coupon is a soft delete, which this key does not obstruct.
      await expectConstraint(
        db().delete(promotion).where(eq(promotion.id, promo.id)),
        'fk_cart_promotion_promotion_store',
      );
    });

    it('CASCADES the association when a cart row is hard-deleted', async () => {
      const { cartId } = await appliedCart();
      expect(await promotionRows()).toHaveLength(1);

      /**
       * The application never hard-deletes a cart, so this fires only for an operator or a
       * future purge — where taking the association along is exactly right, because it has no
       * meaning without its cart.
       */
      await db().delete(cart).where(eq(cart.id, cartId));
      expect(await promotionRows()).toEqual([]);
    });

    it('permits a SOFT delete of an applied promotion', async () => {
      const { promo, app, token } = await appliedCart();

      await db().update(promotion).set({ deletedAt: new Date() }).where(eq(promotion.id, promo.id));

      // The row survives, so the foreign key stays satisfied and the cart is intact — only the
      // discount stops.
      expect((await getCart(app, token)).body.cart.promotion).toBeNull();
      expect(await promotionRows()).toHaveLength(1);
    });
  });
});
