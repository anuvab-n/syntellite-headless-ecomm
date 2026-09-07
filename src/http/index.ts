/**
 * The HTTP layer's public surface.
 *
 * The composition root builds an app from these; nothing below the HTTP layer imports from
 * here. Note the direction: `http/` imports from `shared/` and receives infrastructure
 * probes as functions, but no domain or infrastructure module imports `http/`. That is what
 * keeps Express out of the domain.
 */

export { createApp, type CreateAppOptions } from './app.js';
export { createHttpServer, type HttpServerHandle } from './server.js';
export { asyncHandler } from './async-handler.js';
export {
  validate,
  validatedBody,
  validatedParams,
  validatedQuery,
  type ValidationSchemas,
} from './validate.js';
export {
  createHealthRouter,
  postgresCheck,
  redisCheck,
  type HealthCheck,
  type ReadinessBody,
} from './routes/health.js';
export { contextMiddleware, REQUEST_ID_HEADER } from './middleware/context.js';
export { errorMiddleware } from './middleware/error.js';
export { notFoundHandler } from './middleware/not-found.js';
export { requestLogger } from './middleware/request-logger.js';
export { requireAuth, requireUser } from './middleware/auth.js';
export {
  createScopeGuards,
  deriveScopes,
  type AuthorizationSubject,
  type AuthorizationSubjectLoader,
  type Scope,
} from './middleware/scope.js';
export type { AuthenticatedUser, ValidatedInput } from './types.js';
