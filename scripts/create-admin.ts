import { pathToFileURL } from 'node:url';

import { eq } from 'drizzle-orm';

import { loadConfig, type Config } from '../src/config.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { appUser } from '../src/db/schema/identity.js';
import { executor, withTransaction } from '../src/db/transaction.js';
import { RegisterRequestSchema } from '../src/modules/identity/dto.js';
import { createIdentityRepository } from '../src/modules/identity/identity.repository.js';
import { hashPassword } from '../src/modules/identity/password.js';
/**
 * Imported from `stores.repository.js` directly, NOT the module's `index.js` barrel.
 *
 * The barrel also re-exports `createDefaultStoreResolver`, which pulls in
 * `http/middleware/store.ts` and, through it, the `Express.Request` global augmentation
 * declared in `http/types.ts`. That augmentation is swept into the main app's compile only
 * because `tsconfig.json` includes all of `src/**\/*.ts` directly — nothing actually imports
 * it — so a standalone script compiled under `tsconfig.tools.json` (which includes only
 * `scripts/**\/*.ts` and whatever those files import) never sees it, and picking up the
 * resolver here would fail typecheck on an Express type this script has no use for.
 */
import { createStoreRepository } from '../src/modules/stores/stores.repository.js';
import { newId } from '../src/shared/id.js';
import { bootstrapLogger, type Logger } from '../src/shared/logger.js';

/**
 * Create (or promote) an email+password administrator, from the command line.
 *
 * **Why this exists instead of an HTTP endpoint.** `docs/DECISIONS.md` §22 records a
 * deliberate decision: no request body reaching the API can ever carry `isStaff` or
 * `isSuperuser`. `InsertUserValues` (`identity.repository.ts`) has no field for either, so
 * `POST /auth/register` cannot grant privilege no matter what a client sends — that is
 * enforced by the TYPE, not by a check someone could forget. Adding an HTTP "admin signup"
 * route would either reopen that hole or need its own invite-token/secret-key story on top
 * of it. A script that only a machine with database credentials can run is the boundary the
 * rest of this codebase already draws: `pnpm db:seed` creates the store the same way, and
 * every test walkthrough promotes its admin with exactly the same
 * `UPDATE app_user SET is_staff = true` this script performs.
 *
 * **What it is not.** Not a new authorization path, not a backdoor, not a second copy of
 * the password/email rules — it validates through the SAME `RegisterRequestSchema` the HTTP
 * route uses and hashes through the SAME `hashPassword` (Argon2id), so an admin account
 * satisfies every rule a customer account does. Login afterwards is the existing, unchanged
 * `POST /api/v1/auth/login` — email + password, identical for a customer and an admin. The
 * only difference between the two is the `is_staff` column, and this script is the one
 * place allowed to flip it outside a test.
 *
 * Usage:
 *
 *   pnpm admin:create --email owner@example.com --password "a long unique passphrase"
 *
 *   # promote an account that already exists, instead of creating a new one
 *   pnpm admin:create --email owner@example.com --promote
 *
 *   # against a non-default store
 *   pnpm admin:create --email owner@example.com --password "..." --store my-store-slug
 *
 * The password can also be supplied as `ADMIN_PASSWORD` in the environment (`--password`
 * takes precedence if both are given). Prefer the environment variable on a shared machine:
 * command-line arguments are visible to anyone who can run `ps`/`Get-Process`, and most
 * shells write full command lines to a history file.
 */

type ParsedArgs = {
  email?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  storeSlug?: string;
  promote: boolean;
  help: boolean;
};

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { promote: false, help: false };

  const flagMap: Record<string, keyof ParsedArgs> = {
    '--email': 'email',
    '--password': 'password',
    '--first-name': 'firstName',
    '--last-name': 'lastName',
    '--phone': 'phone',
    '--store': 'storeSlug',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === '--promote') {
      out.promote = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }

    const eq_ = token.indexOf('=');
    const [flag, inlineValue] =
      eq_ === -1 ? [token, undefined] : [token.slice(0, eq_), token.slice(eq_ + 1)];

    const key = flagMap[flag];
    if (key === undefined) {
      throw new Error(`unrecognised argument: ${token}\n\n${USAGE}`);
    }

    const value = inlineValue ?? argv[i + 1];
    if (value === undefined) {
      throw new Error(`${flag} requires a value\n\n${USAGE}`);
    }
    if (inlineValue === undefined) i += 1;

    (out[key] as string | undefined) = value;
  }

  return out;
}

const USAGE = `Usage:
  pnpm admin:create --email <email> --password <password> [options]
  pnpm admin:create --email <email> --promote                 (promote an existing account)

Options:
  --email <email>        required
  --password <password>  required unless --promote; falls back to $ADMIN_PASSWORD
  --first-name <name>    optional
  --last-name <name>     optional
  --phone <phone>        optional
  --store <slug>         defaults to $DEFAULT_STORE_SLUG / "default"
  --promote              grant staff to an account that already exists, rather than
                          creating one; --password is not required in this mode
  --help                 show this message`;

/**
 * Creates a brand-new admin account, or promotes an existing customer to staff.
 *
 * Both paths run inside ONE transaction. For creation, that matters for the same reason
 * `identity.service.ts registerCustomer` uses one: a process crash between "insert the row"
 * and "flip is_staff" must never leave a plain, unprivileged customer behind under an email
 * an operator believes is an administrator — Postgres either commits both statements or
 * neither.
 */
export async function createOrPromoteAdmin(
  deps: { db: Database; config: Config; logger: Logger },
  args: ParsedArgs,
): Promise<{ userId: string; email: string; created: boolean }> {
  const { db, config, logger } = deps;

  if (args.email === undefined) {
    throw new Error(`--email is required\n\n${USAGE}`);
  }

  const stores = createStoreRepository({ db });
  const identityRepository = createIdentityRepository({ db });

  const storeSlug = args.storeSlug ?? config.defaultStoreSlug;
  const store = await stores.findActiveBySlug(storeSlug);
  if (store === undefined) {
    throw new Error(
      `no active store with slug "${storeSlug}" — run "pnpm db:seed" first, or pass --store`,
    );
  }

  const existing = await identityRepository.findActiveByEmail({
    storeId: store.id,
    email: args.email.trim().toLowerCase(),
  });

  if (args.promote) {
    if (existing === undefined) {
      throw new Error(
        `no account found for "${args.email}" in store "${storeSlug}" — omit --promote to create one`,
      );
    }

    const [row] = await db
      .select({ isStaff: appUser.isStaff })
      .from(appUser)
      .where(eq(appUser.id, existing.id))
      .limit(1);

    if (row?.isStaff === true) {
      logger.info({ userId: existing.id }, 'admin_already_staff');
      return { userId: existing.id, email: existing.email, created: false };
    }

    await db.update(appUser).set({ isStaff: true }).where(eq(appUser.id, existing.id));
    logger.info({ userId: existing.id }, 'admin_promoted');
    return { userId: existing.id, email: existing.email, created: false };
  }

  if (existing !== undefined) {
    throw new Error(
      `an account for "${args.email}" already exists in store "${storeSlug}" — pass --promote to grant it staff instead`,
    );
  }

  const password = args.password ?? process.env['ADMIN_PASSWORD'];
  if (password === undefined) {
    throw new Error(`--password is required to create a new account\n\n${USAGE}`);
  }

  /**
   * The SAME schema `POST /auth/register` validates against — an admin account is held to
   * exactly the password-length and email-shape rules a customer account is, never a
   * looser set slipped in because this is "just a script".
   */
  const input = RegisterRequestSchema.parse({
    email: args.email,
    password,
    firstName: args.firstName,
    lastName: args.lastName,
    phone: args.phone,
  });

  const passwordHash = await hashPassword(input.password);

  const userId = await withTransaction(db, logger, async () => {
    const row = await identityRepository.insertUser({
      id: newId(),
      storeId: store.id,
      email: input.email,
      passwordHash,
      firstName: input.firstName ?? '',
      lastName: input.lastName ?? '',
      phone: input.phone ?? null,
      acceptsMarketing: false,
    });

    // The ONE place outside a test permitted to do this. `insertUser` cannot — see the note
    // on `InsertUserValues` in identity.repository.ts — so the promotion is this deliberate,
    // separate, logged statement rather than a hidden side effect of registration.
    await executor(db).update(appUser).set({ isStaff: true }).where(eq(appUser.id, row.id));

    return row.id;
  });

  logger.info({ userId, storeId: store.id }, 'admin_created');
  return { userId, email: input.email, created: true };
}

/* ── CLI entry point ─────────────────────────────────────────────────────── */

/**
 * `pathToFileURL`, not a `file://${argv[1]}` template — same fix `seed.ts` documents: on
 * Windows `argv[1]` is `C:\path\to\create-admin.ts` while `import.meta.url` is
 * `file:///C:/path/to/create-admin.ts`, and the naive comparison never matches.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const logger = bootstrapLogger;

  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }

    const config = loadConfig();
    const handle = createDatabase(config.databaseUrl, config, logger, 'primary');

    try {
      const result = await createOrPromoteAdmin({ db: handle.db, config, logger }, args);
      process.stdout.write(
        `${result.created ? 'created' : 'promoted'} admin: ${result.email} (${result.userId})\n`,
      );
      process.stdout.write(
        'sign in the usual way: POST /api/v1/auth/login with this email + password\n',
      );
    } finally {
      await handle.close();
    }
  } catch (err) {
    logger.fatal({ err }, 'admin_create_failed');
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
