import { describe, expect, it } from 'vitest';

import {
  BusinessRuleViolation,
  Conflict,
  DomainError,
  IdempotencyConflict,
  IdempotencyKeyReuse,
  InvalidStateTransition,
  InvariantViolation,
  NotFound,
  PermissionDenied,
  ValidationError,
  invariant,
} from '../errors.js';

/**
 * The prototype-chain test.
 *
 * The terminal error middleware routes on `err instanceof DomainError`. If a subclass
 * loses its prototype chain — which is what happens when a constructor forgets
 * `Object.setPrototypeOf` after `super()` — every business error silently becomes an
 * opaque 500, and it looks like a working system right up until a customer sees
 * "unexpected error" instead of "out of stock".
 */
describe('error hierarchy', () => {
  const cases: Array<[string, DomainError]> = [
    ['ValidationError', new ValidationError({ email: ['required'] })],
    ['NotFound', new NotFound('order')],
    ['PermissionDenied', new PermissionDenied({ missing: ['orders:write'] })],
    ['Conflict', new Conflict('already exists')],
    ['InvalidStateTransition', new InvalidStateTransition({ entity: 'Order', from: 'a', to: 'b' })],
    ['IdempotencyConflict', new IdempotencyConflict()],
    ['BusinessRuleViolation', new BusinessRuleViolation('nope')],
    ['IdempotencyKeyReuse', new IdempotencyKeyReuse()],
  ];

  it.each(cases)('%s is instanceof DomainError and Error', (_name, error) => {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
  });

  it.each(cases)('%s reports its own class name', (name, error) => {
    expect(error.name).toBe(name);
  });

  it.each(cases)('%s carries a stable code and a 4xx/503 status', (_name, error) => {
    expect(error.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    expect(error.statusCode).toBeGreaterThanOrEqual(400);
    expect(error.statusCode).toBeLessThan(600);
  });

  it('preserves the subclass chain through two levels of inheritance', () => {
    // IdempotencyKeyReuse extends BusinessRuleViolation extends DomainError. A broken
    // prototype chain typically survives one level and fails at the second.
    const error = new IdempotencyKeyReuse();
    expect(error).toBeInstanceOf(IdempotencyKeyReuse);
    expect(error).toBeInstanceOf(BusinessRuleViolation);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe('IDEMPOTENCY_KEY_REUSE');
    expect(error.statusCode).toBe(422);
  });

  it('lets a subclass override the parent code', () => {
    const error = new InvalidStateTransition({ entity: 'Order', from: 'paid', to: 'pending' });
    expect(error).toBeInstanceOf(Conflict);
    expect(error.code).toBe('INVALID_STATE_TRANSITION');
    expect(error.statusCode).toBe(409);
  });

  it('has a usable stack trace that does not start inside the constructor', () => {
    const error = new NotFound('product');
    expect(error.stack).toBeDefined();
    expect(error.stack).not.toContain('at new NotFound');
  });
});

describe('error envelope', () => {
  it('serialises the documented shape', () => {
    const error = new NotFound('order');
    expect(error.toEnvelope('req-123')).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested order does not exist.',
        details: { resource: 'order' },
        requestId: 'req-123',
      },
    });
  });

  it('omits absent optional keys rather than emitting null', () => {
    // Clients destructure this; `field: null` and no `field` are different contracts.
    const envelope = new BusinessRuleViolation('nope').toEnvelope('req-1');
    expect('field' in envelope.error).toBe(false);
    expect('details' in envelope.error).toBe(false);
  });

  it('does not echo a resource id back to the caller', () => {
    // Confirming an id exists but belongs to someone else is an enumeration oracle.
    const message = new NotFound('order').message;
    expect(message).not.toMatch(/[0-9a-f]{8}-/);
  });
});

describe('invariant', () => {
  it('passes silently when the condition holds', () => {
    expect(() => invariant(true, 'fine')).not.toThrow();
  });

  it('throws InvariantViolation, which is NOT a DomainError', () => {
    // Deliberate: an invariant breach is a bug and deserves a 500, not a mapped 4xx.
    try {
      invariant(false, 'stock went negative');
      expect.unreachable('invariant should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvariantViolation);
      expect(err).not.toBeInstanceOf(DomainError);
      expect((err as Error).message).toContain('stock went negative');
    }
  });
});
