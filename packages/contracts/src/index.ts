/**
 * `@ecom/contracts` — the API surface, shared with the frontend.
 *
 * This package is the single reason the stack is TypeScript rather than Python (see
 * docs/DECISIONS.md). The frontend imports these Zod schemas and inferred types, so
 * renaming an API field becomes a frontend COMPILE ERROR instead of a runtime bug
 * discovered by a customer.
 *
 * What belongs here:
 *   - Zod request and response schemas for every public endpoint
 *   - The inferred TypeScript types
 *   - Shared enums the client must agree on (order status, payment status)
 *   - The error envelope shape and the error code union
 *
 * What must NEVER be here:
 *   - Database schemas or row types. The wire format and the storage format are allowed
 *     to differ, and coupling them means every column rename becomes a breaking API
 *     change.
 *   - Business logic, service functions, or anything that imports from `src/`.
 *   - Server-only dependencies. This package is bundled into a browser.
 *
 * Populated per phase as endpoints are built. Empty at Phase 0 by design — a contract for
 * an endpoint that does not exist yet is a guess.
 */

/** The money wire format: an exact decimal STRING, never a JSON number. */
export type MoneyDto = {
  amount: string;
  currency: string;
};

/** Every error response has this shape. Clients switch on `code`, never on `message`. */
export type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    field?: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
};
