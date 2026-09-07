/**
 * The error hierarchy.
 *
 * Two categories exist, and the distinction drives alerting:
 *
 *   DomainError — an EXPECTED business outcome. "Out of stock", "coupon expired",
 *                 "minimum order value not met". Logged at info. Never pages anyone.
 *                 Carries a stable machine-readable `code` that clients switch on.
 *
 *   everything else — a bug or an infrastructure failure. Logged at error, captured,
 *                 and returned to the client as an opaque 500. Internals never leak.
 *
 * Adding a new failure mode means adding a DomainError subclass and an entry in the
 * error catalog (docs/ERROR_CATALOG.md). A service that returns `null` for failure, or
 * a tuple, is a review rejection: the caller cannot tell why it failed and the HTTP
 * layer cannot map it to a status code.
 */

export type ErrorDetails = Record<string, unknown>;

export type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    field?: string;
    details?: ErrorDetails;
    requestId: string;
  };
};

export abstract class DomainError extends Error {
  /** Stable, screaming-snake, never renamed once published. Clients switch on it. */
  abstract readonly code: string;
  /** HTTP status this maps to. 4xx/503 only — a DomainError is never an unexpected 500. */
  abstract readonly statusCode: number;
  /** Request field this concerns, when the error is attributable to one. */
  readonly field?: string;
  /** Machine-readable context. Must contain nothing secret — it reaches the client. */
  readonly details?: ErrorDetails;

  protected constructor(message: string, opts: { field?: string; details?: ErrorDetails } = {}) {
    super(message);
    // Required for `instanceof` to hold across the class hierarchy and for the concrete
    // class name to appear in stack traces. Asserted by src/shared/__tests__/errors.test.ts
    // so a future refactor cannot quietly break error mapping.
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
    if (opts.field !== undefined) this.field = opts.field;
    if (opts.details !== undefined) this.details = opts.details;
    Error.captureStackTrace?.(this, new.target);
  }

  /** The shape the terminal error middleware serialises. */
  toEnvelope(requestId: string): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.field !== undefined ? { field: this.field } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
        requestId,
      },
    };
  }
}

/* ── 400 ─────────────────────────────────────────────────────────────────── */

/** Zod boundary failure. The request never reached a service. */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
  readonly statusCode = 400;

  constructor(fields: Record<string, string[] | undefined>) {
    super('The request payload is invalid.', { details: { fields } });
  }
}

/* ── 401 / 403 ───────────────────────────────────────────────────────────── */

export class AuthenticationRequired extends DomainError {
  readonly code = 'AUTHENTICATION_REQUIRED';
  readonly statusCode = 401;

  constructor(message = 'Authentication is required for this operation.') {
    super(message);
  }
}

export class InvalidCredentials extends DomainError {
  readonly code = 'INVALID_CREDENTIALS';
  readonly statusCode = 401;

  // Deliberately does not distinguish "no such user" from "wrong password" — that
  // distinction is a user-enumeration oracle.
  constructor() {
    super('Email or password is incorrect.');
  }
}

export class PermissionDenied extends DomainError {
  readonly code = 'PERMISSION_DENIED';
  readonly statusCode = 403;

  constructor(args?: { missing?: readonly string[] }) {
    super(
      'You do not have permission to perform this operation.',
      args?.missing ? { details: { missing: [...args.missing] } } : {},
    );
  }
}

/* ── 404 ─────────────────────────────────────────────────────────────────── */

export class NotFound extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly statusCode = 404;

  /**
   * The message does NOT echo the resource id. Confirming that an id exists but belongs
   * to someone else is an information leak; ownership belongs in the query, not in a
   * check afterwards.
   */
  constructor(resource: string) {
    super(`The requested ${resource} does not exist.`, { details: { resource } });
  }
}

/* ── 409 ─────────────────────────────────────────────────────────────────── */

export class Conflict extends DomainError {
  readonly code: string = 'CONFLICT';
  readonly statusCode = 409;

  constructor(message: string, details?: ErrorDetails) {
    super(message, details ? { details } : {});
  }
}

export class InvalidStateTransition extends Conflict {
  override readonly code = 'INVALID_STATE_TRANSITION';

  constructor(args: { entity: string; from: string; to: string }) {
    super(`${args.entity} cannot move from ${args.from} to ${args.to}.`, args);
  }
}

/** An idempotent request is still executing. The client must retry, not duplicate. */
export class IdempotencyConflict extends Conflict {
  override readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor() {
    super('A request with this Idempotency-Key is already in flight. Retry shortly.');
  }
}

/* ── 422 ─────────────────────────────────────────────────────────────────── */

/** The request was well-formed but the business rules say no. */
export class BusinessRuleViolation extends DomainError {
  readonly code: string = 'BUSINESS_RULE_VIOLATION';
  readonly statusCode = 422;

  constructor(message: string, details?: ErrorDetails) {
    super(message, details ? { details } : {});
  }
}

/** Same key, different payload — the client has a bug and must not be served a replay. */
export class IdempotencyKeyReuse extends BusinessRuleViolation {
  override readonly code = 'IDEMPOTENCY_KEY_REUSE';

  constructor() {
    super('This Idempotency-Key was already used with a different request body.');
  }
}

/* ── 429 ─────────────────────────────────────────────────────────────────── */

export class RateLimited extends DomainError {
  readonly code = 'RATE_LIMITED';
  readonly statusCode = 429;

  constructor(retryAfterSeconds: number) {
    super('Too many requests. Please retry later.', { details: { retryAfterSeconds } });
  }
}

/* ── 503 ─────────────────────────────────────────────────────────────────── */

/**
 * A dependency the operation cannot proceed without is unavailable.
 *
 * Used to FAIL CLOSED. Per the degradation policy: anything touching money or stock
 * fails closed (lock store down → reject checkout), anything cosmetic fails open
 * (cache down → query Postgres). Overselling is worse than downtime.
 */
export class DependencyUnavailable extends DomainError {
  readonly code = 'DEPENDENCY_UNAVAILABLE';
  readonly statusCode = 503;

  constructor(dependency: string) {
    // The dependency name is a subsystem label, not a host or credential, so it is
    // safe to return.
    super('This operation is temporarily unavailable. Please try again.', {
      details: { dependency },
    });
  }
}

/* ── Infrastructure faults — deliberately NOT DomainErrors ───────────────── */

/**
 * A programming invariant was violated. Never caught, never mapped to a 4xx.
 * Reaching one of these means a bug, and the request deserves a 500.
 */
export class InvariantViolation extends Error {
  constructor(message: string) {
    super(`Invariant violated: ${message}`);
    this.name = 'InvariantViolation';
  }
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantViolation(message);
}
