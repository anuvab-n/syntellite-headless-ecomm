import { z } from 'zod';

/**
 * Pagination, defined once.
 *
 * Both of these had five byte-identical copies — one per module with a list endpoint. That is
 * the kind of duplication that stays harmless right up until somebody fixes a bug in one copy,
 * and it makes "do all our list endpoints behave the same?" a question you answer by reading
 * five files instead of one.
 *
 * In `shared/` because it is the bottom of the stack and every module's DTOs need it. It cannot
 * live in `http/validate.ts`, which would be the other natural home: `no-modules-to-http`
 * forbids a `dto.ts` from importing the HTTP layer, and rightly — a DTO that reached for
 * Express could not be reused by a CLI command or a job.
 *
 * `zod` is an npm import from `shared/`, which is consistent with `money.ts` importing
 * `decimal.js` and `id.ts` importing `uuid`. The layering rule bans `shared/` from importing
 * `http/`, `modules/`, `db/` and `redis/` — not from using a library.
 */

/**
 * The pagination block on every list response.
 *
 * `total` is the count of matching rows, independent of the page — a client needs it to render
 * "page 2 of 7", and computing it from a page length is only correct on the last page.
 */
export type PaginationResponse = {
  limit: number;
  offset: number;
  total: number;
};

/**
 * A bounded whole-number query parameter, with a default.
 *
 * Query strings are always strings, so this parses rather than coerces: `z.coerce.number()`
 * would accept `''` as `0`, `'  12  '` as `12`, and `'1e3'` as `1000`. The regex refuses all
 * three before any conversion happens, which is why a client sending `?limit=abc` gets a `400`
 * naming the field instead of a silently-defaulted page.
 *
 * `.optional().transform(...)` rather than `.default(...)`: the default has to be applied
 * AFTER the bounds check, so an absent value takes the default while a present-but-invalid one
 * is still rejected. Reversing those two lets `?limit=0` through as the default.
 *
 * @param opts.min Smallest accepted value. `1` for a limit, `0` for an offset.
 * @param opts.max Largest accepted value. Omitted for an offset, which has no useful ceiling.
 * @param opts.default Applied only when the parameter is absent entirely.
 */
export const boundedIntParam = (opts: { min: number; max?: number; default: number }) => {
  const bounds =
    opts.max === undefined
      ? z.number().int().min(opts.min)
      : z.number().int().min(opts.min).max(opts.max);

  return z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(bounds)
    .optional()
    .transform((value) => value ?? opts.default);
};
