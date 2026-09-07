import { Router } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import { AuthenticationRequired, ValidationError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import type { PaymentsService } from './payments.service.js';

/**
 * The provider webhook surface: one route.
 *
 * ## Why this is a separate router
 *
 * It is mounted by `app.ts` at `/api/v1/webhooks` with `express.raw`, **before**
 * `express.json()`, and that ordering is load-bearing rather than stylistic. Razorpay signs the
 * exact bytes it sent; re-serialising parsed JSON produces different bytes — key order,
 * whitespace, unicode escapes — and the HMAC would not match. `app.ts` documents the same thing
 * from its side: *"signature verification needs the exact bytes the provider signed."*
 *
 * ## What this router is NOT
 *
 * It is **not** on the API router, so `resolveStore` does not run — deliberately.
 * `container.ts` states that *"`resolveStore` applies to the API surface ONLY"*, and a webhook
 * has no client to resolve a store for. The tenant is resolved by the service from the payment
 * row that the verified provider reference names, never from the request. There is no header,
 * query or body field here that could carry a store, and nothing in this file reads one.
 *
 * There is also no `requireAuth`: a provider holds no access token. Authentication is the
 * signature, and it is checked before a single field of the body is trusted.
 *
 * ## Status codes, and why a gateway gets a 200 so often
 *
 * A `5xx` to a gateway means "try again". Answering that to a permanent condition — a duplicate,
 * an event we have no rule for, a reference we do not recognise, an event that conflicts with a
 * terminal state — turns one stray notification into an indefinite retry loop that no future
 * delivery can resolve. So every such outcome is a `200` carrying what was decided, and only a
 * failure of authentication or of well-formedness is an error.
 */

/** What the raw-body parser leaves on `req.body`. Empty when nothing was sent. */
function rawBodyOf(body: unknown): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.alloc(0);
}

export function createPaymentsWebhookRoutes(deps: {
  payments: PaymentsService;
  logger: Logger;
  // Annotated rather than inferred, matching every other routes file.
}): Router {
  const { payments, logger } = deps;

  const router = Router();

  /**
   * POST /api/v1/webhooks/razorpay
   *
   * Provider-specific by path, which the approved scope calls for: a second provider brings its
   * own signature scheme and its own event vocabulary, and one shared endpoint would have to
   * guess which to apply before it could authenticate anything.
   *
   * `200 {status}` for every outcome the provider cannot fix by retrying — `applied`,
   * `duplicate_event`, `unsupported_event`, `unknown_reference`, `already_terminal`,
   * `illegal_transition`, `ambiguous_reference`.
   * `401` for a missing or invalid signature. `400` for a body that is not well-formed enough to
   * act on. Both go through the standard error envelope, so a provider's failure log carries the
   * same shape as any other client's.
   */
  router.post(
    '/razorpay',
    asyncHandler(async (req, res) => {
      const result = await payments.handleProviderWebhook({
        rawBody: rawBodyOf(req.body),
        /*
         * Express lower-cases incoming header names, so this is already the shape the adapter
         * indexes into. Passed wholesale rather than picked apart here because WHICH headers
         * carry the signature and the event id is a provider detail, and this file is not
         * allowed to know it.
         */
        headers: req.headers as Readonly<Record<string, string | undefined>>,
      });

      if (result.outcome === 'invalid_signature') {
        /*
         * `401`, not `403`: the request failed to authenticate, it was not denied a permission.
         * The response says nothing about which part was wrong — a probe must not learn whether
         * the secret, the algorithm or the encoding was the problem.
         */
        throw new AuthenticationRequired('webhook signature verification failed');
      }

      if (result.outcome === 'malformed') {
        throw new ValidationError({
          body: ['is not a well-formed provider notification'],
        });
      }

      if (result.outcome === 'applied') {
        res.status(200).json({ status: 'applied', payment: { status: result.status } });
        return;
      }

      /*
       * Acknowledged and not acted on. The reason is returned because the provider's delivery
       * log is the first place an operator looks, and "we received it and chose not to act" is
       * a materially different fact from "we failed".
       */
      logger.info({ reason: result.reason }, 'payment_webhook_acknowledged_without_change');
      res.status(200).json({ status: 'ignored', reason: result.reason });
    }),
  );

  return router;
}
