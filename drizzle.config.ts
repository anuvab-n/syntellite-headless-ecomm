import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration.
 *
 * The workflow, and the one rule that matters:
 *
 *   1. Edit `src/db/schema/*.ts`
 *   2. `pnpm db:generate`
 *   3. **READ THE GENERATED SQL. Every time. Line by line.**
 *   4. Commit the schema change and the migration together
 *
 * Step 3 is not optional and not a formality. `drizzle-kit` infers intent from a diff, and
 * a diff cannot distinguish a rename from a drop-and-add. Renaming a column can generate
 * `DROP COLUMN` + `ADD COLUMN`, which passes CI against an empty test database and
 * destroys a production column. It has happened to other teams; reading the SQL is what
 * prevents it.
 *
 * `push` is deliberately never used outside a scratch database — it applies a diff with no
 * migration file, so there is no artifact to review, replay, or roll back.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: {
    // Read directly rather than through config.ts: the CLI must work without the full
    // application environment (JWT keys, S3 credentials) being present.
    url: process.env['DATABASE_URL'] ?? 'postgres://ecom:ecom@localhost:5432/ecom',
  },
  // Emit one file per change with a readable name.
  migrations: {
    prefix: 'timestamp',
  },
  verbose: true,
  // Prompt before anything destructive rather than assuming the diff is right.
  strict: true,
});
