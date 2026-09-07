import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

import { ValidationError } from '../shared/errors.js';
import type { ValidatedInput } from './types.js';

/**
 * Zod validation at the HTTP boundary.
 *
 * This is the only place untrusted input becomes typed data. Two rules govern it:
 *
 *  1. **Never mutate `req.body` in place.** The parsed result goes on `req.validated`. If
 *     validated data overwrote the raw input, then half the codebase would read `req.body`
 *     and be right while the other half read it and be wrong, with nothing at the call
 *     site to tell them apart. A handler reading `req.validated.body` is provably reading
 *     something a schema approved.
 *  2. **Never leak Zod's error object.** A `ZodError` carries the schema's shape — union
 *     branches, internal field names, discriminators. That is a description of our
 *     internals handed to an attacker. Only `{ field: [messages] }` crosses the boundary.
 */

export type ValidationSchemas = {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
  /**
   * Headers are lowercased by Node before they reach here, so schema keys must be
   * lowercase. Use `.passthrough()`-style permissive objects: a strict schema on headers
   * will reject every real browser request, which sends a dozen you did not think about.
   */
  headers?: ZodType;
};

const SOURCES = ['body', 'query', 'params', 'headers'] as const;

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    const validated: ValidatedInput = {};
    /**
     * Accumulated across ALL sources before failing, so a request with a bad param and a
     * bad body reports both. Failing on the first means the client fixes one thing, retries,
     * and discovers the next — a slow round-trip per mistake.
     */
    const fieldErrors: Record<string, string[]> = {};

    for (const source of SOURCES) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);

      if (result.success) {
        validated[source] = result.data;
        continue;
      }

      for (const issue of result.error.issues) {
        // Prefix with the source so `body.email` and `query.email` stay distinguishable.
        // An issue at the root of a source has an empty path — name it after the source.
        const path = issue.path.map((segment) => String(segment)).join('.');
        const key = path === '' ? source : `${source}.${path}`;
        (fieldErrors[key] ??= []).push(issue.message);
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      // A DomainError, so the terminal middleware renders it in the standard envelope with
      // no special case. Only messages and field names cross the boundary.
      return next(new ValidationError(fieldErrors));
    }

    req.validated = validated;
    next();
  };
}

/**
 * Typed accessors.
 *
 * `req.validated` is optional on the Request type, because most routes do not run
 * `validate()`. These helpers turn "I ran the middleware, so this exists" into one narrow
 * assertion instead of a non-null assertion scattered through every handler — and they
 * throw a diagnosable error rather than yielding `undefined` if the middleware was
 * forgotten.
 */
function requireValidated(
  validated: ValidatedInput | undefined,
  source: keyof ValidatedInput,
): unknown {
  if (!validated || !(source in validated)) {
    throw new Error(
      `validated ${source} was read but no validate({ ${source} }) middleware ran on this route`,
    );
  }
  return validated[source];
}

export function validatedBody<T>(req: { validated?: ValidatedInput }): T {
  return requireValidated(req.validated, 'body') as T;
}

export function validatedQuery<T>(req: { validated?: ValidatedInput }): T {
  return requireValidated(req.validated, 'query') as T;
}

export function validatedParams<T>(req: { validated?: ValidatedInput }): T {
  return requireValidated(req.validated, 'params') as T;
}
