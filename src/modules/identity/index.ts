/**
 * The identity module's public surface.
 *
 * The composition root uses these; nothing else should. In particular the repository's
 * table imports, the Argon2 parameters, and the DTO internals are NOT exported — a caller
 * that needs a user should ask the service, not query `app_user` itself.
 *
 * `password.ts` helpers are exported because the login increment will need `verifyPassword`
 * and `needsRehash` from its own service, and because the unit tests assert the parameters.
 */

export {
  createIdentityService,
  EmailAlreadyRegistered,
  InvalidRefreshToken,
  PhoneAlreadyRegistered,
  REVOKED_REASON_LOGOUT,
  REVOKED_REASON_PASSWORD_CHANGE,
  REVOKED_REASON_ROTATION_REUSE,
  type IdentityService,
  type LoginAttemptTracker,
} from './identity.service.js';
export { createIdentityRepository, type IdentityRepository } from './identity.repository.js';
export { createIdentityRoutes } from './identity.routes.js';
export {
  RegisterRequestSchema,
  toUserResponse,
  type RegisterRequest,
  type UserResponse,
} from './dto.js';
export {
  hashPassword,
  needsRehash,
  passwordHashingParameters,
  verifyPassword,
  type PasswordHash,
} from './password.js';
export {
  createTokenService,
  InvalidAccessToken,
  TokenKeyUnusable,
  type AccessTokenSubject,
  type IssuedAccessToken,
  type TokenService,
  type VerifiedAccessToken,
} from './tokens.js';
export {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenHashesEqual,
  refreshTokenParameters,
  REFRESH_TOKEN_HASH_LENGTH,
  REFRESH_TOKEN_LENGTH,
  type RefreshToken,
  type RefreshTokenHash,
} from './refresh-token.js';
export {
  createRefreshSessionRepository,
  REFRESH_TOKEN_UNIQUE_CONSTRAINT,
  type InsertRefreshSessionValues,
  type RefreshSessionRecord,
  type RefreshSessionRepository,
} from './refresh-session.repository.js';
export {
  LoginRequestSchema,
  RefreshRequestSchema,
  toLoginResponse,
  type LoginRequest,
  type LoginResponse,
  type RefreshRequest,
} from './dto.js';
export { type UserCredentials, type UserSubject } from './identity.repository.js';
export {
  createPasswordResetRepository,
  type PasswordResetRepository,
} from './password-reset.repository.js';
export {
  PASSWORD_RESET_TTL_MINUTES,
  passwordResetTokenParameters,
} from './password-reset-token.js';
export { USER_EVENTS, USER_AGGREGATE, AUTH_AUDIT, USER_RESOURCE } from './identity.events.js';
