import { generateKeyPairSync } from 'node:crypto';

/**
 * Generate the RS256 keypair used to sign access tokens.
 *
 * RS256 rather than HS256 so that anything needing to VERIFY a token (a future extracted
 * service, an edge worker) can hold only the public key. With a shared HMAC secret,
 * every verifier can also mint tokens.
 *
 * Prints the two variables in the escaped single-line form `.env` requires. Rotating the
 * pair invalidates every access token in flight; refresh sessions survive, because they
 * live in PostgreSQL rather than in the token.
 *
 *   pnpm keys:generate >> .env
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** `.env` parsers do not interpret escapes inside quotes, so config.ts unescapes `\n`. */
const escape = (pem: string): string => pem.trimEnd().replace(/\n/g, '\\n');

process.stdout.write(`JWT_PRIVATE_KEY="${escape(privateKey)}"\n`);
process.stdout.write(`JWT_PUBLIC_KEY="${escape(publicKey)}"\n`);
