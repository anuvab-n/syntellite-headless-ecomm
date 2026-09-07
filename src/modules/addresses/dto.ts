import { z } from 'zod';

import type { AddressRecord } from './addresses.repository.js';

/**
 * The addresses module's wire contracts.
 *
 * Same two jobs as every other DTO file here, and both are security boundaries: decide exactly
 * what a client may send, and exactly what leaves the system.
 */

/* ── Field primitives ────────────────────────────────────────────────────── */

/**
 * A delivery phone number.
 *
 * **A verbatim restatement of `phoneField` in `modules/identity/dto.ts`**, whose comment reads:
 * *"Kept permissive on purpose: real customer phone formats vary more than any regex we would
 * write here, and the column is only 20 characters wide."* That judgement applies identically
 * here, and a stricter rule would reject `+91 98765 43210` or `(080) 2345-6789`.
 *
 * Restated rather than imported because `no-cross-module-imports` forbids
 * `modules/addresses` reaching into `modules/identity` — the same narrow duplication inventory
 * made of `skuCodeField`. A test asserts the two accept and reject the same inputs, so the copy
 * cannot drift silently.
 */
const phoneField = z
  .string()
  .trim()
  .min(5)
  .max(20)
  .regex(/^\+?[0-9\s()-]+$/, 'must be a valid phone number');

/**
 * A free-text address line.
 *
 * Trimmed and length-bounded, and that is ALL. There is deliberately no character allowlist:
 * any regex worth writing would reject legitimate Indian addresses, which routinely contain
 * `#`, `/`, `,`, `-`, `&`, and text in Devanagari, Tamil, Bengali or Kannada. A validation
 * layer that cannot express a customer's own address is worse than one that stores something
 * unusual.
 *
 * `.min(1)` after `.trim()` is load-bearing: it rejects `'   '`, which would otherwise satisfy
 * a bare length bound and store a blank required field. The database's
 * `ck_address_required_not_blank` refuses the same thing for any other writer.
 */
const textField = (max: number) => z.string().trim().min(1).max(max);

/**
 * ISO-3166-1 alpha-2, **uppercased at the boundary**.
 *
 * `.toUpperCase()` runs before the pattern check, so `'in'` becomes `'IN'` and is accepted
 * rather than rejected for a case the caller plainly did not mean as a different country — the
 * same normalise-then-validate order `slugField` uses for lowercasing.
 *
 * The pattern constrains SHAPE, not membership. No 249-entry country list: it would be a
 * migration every time the list changes, and rejecting a legitimate country is a worse failure
 * than storing an implausible one. `ck_address_country_code_shape` enforces the same shape in
 * the database for writers that bypass Zod.
 */
const countryCodeField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'must be a two-letter ISO country code');

/** Bounded before the country-conditional rule below narrows it further. */
const postalCodeField = z.string().trim().min(1).max(16);

/**
 * The Indian PIN rule, applied ONLY when the country is India.
 *
 * `^[1-9][0-9]{5}$` — six digits, never starting with zero, because no Indian PIN does. It is a
 * `.superRefine` on the whole object rather than a field rule because it is conditional on
 * `countryCode`, and a field cannot see its siblings.
 *
 * For every other country the generic bound applies unchanged: this increment was not asked to
 * invent foreign postal formats, and a wrong guess would lock a customer out of their own
 * address.
 */
const IN_PIN = /^[1-9][0-9]{5}$/;

function checkIndianPin(
  // `| undefined` is explicit because `exactOptionalPropertyTypes` is on: an optional property
  // and a property that may hold `undefined` are different types under it, and a Zod-inferred
  // body supplies the latter.
  value: { countryCode: string | undefined; postalCode: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.countryCode !== 'IN') return;
  if (value.postalCode === undefined) return;
  if (IN_PIN.test(value.postalCode)) return;

  ctx.addIssue({
    code: 'custom',
    path: ['postalCode'],
    message: 'must be a six-digit Indian PIN code not starting with zero',
  });
}

/* ── POST /users/me/addresses ────────────────────────────────────────────── */

/**
 * `strictObject`, so an unknown field is a 400 rather than being silently dropped.
 *
 * Note what is absent and therefore **unreachable rather than ignored**:
 *
 *  - `userId`, `storeId` — ownership and tenancy. Both come from the verified access token, so
 *    accepting either would be a mass-assignment hole that let one customer write into
 *    another's address book, or across a tenant boundary.
 *  - `actorUserId` / `actorId` — the audit trail's author. Accepting one would let a caller
 *    forge attribution for their own change.
 *  - `id` — server-owned, from `newId()`. A client-chosen id is a way to probe or collide.
 *  - `createdAt`, `updatedAt`, `deletedAt` — server-owned. A client-supplied `deletedAt` would
 *    be a delete disguised as a create.
 *
 * Each produces a 400 naming the field, which is the right answer to what is either a probe or
 * a badly confused integration.
 */
export const CreateAddressRequestSchema = z
  .strictObject({
    label: textField(60),
    recipientName: textField(300),
    phone: phoneField,
    line1: textField(300),
    /** Optional. Absent becomes the column default of an empty string, never NULL. */
    line2: z.string().trim().max(300).optional(),
    landmark: z.string().trim().max(300).optional(),
    city: textField(120),
    /**
     * REQUIRED, and free text.
     *
     * Required because GST's CGST/SGST-versus-IGST split will compare this to the seller's
     * state — `store.registered_address` is documented as driving exactly that. Free text, and
     * no `stateCode`, because a GST state-code catalogue is not this increment's to invent.
     */
    state: textField(120),
    postalCode: postalCodeField,
    /** Optional. Absent becomes the column default `'IN'`. */
    countryCode: countryCodeField.optional(),
  })
  .superRefine((value, ctx) => {
    // `countryCode` may be absent, in which case the column default 'IN' applies — so the
    // Indian rule must be checked against the EFFECTIVE country, not the supplied one.
    checkIndianPin({ countryCode: value.countryCode ?? 'IN', postalCode: value.postalCode }, ctx);
  });

export type CreateAddressRequest = z.infer<typeof CreateAddressRequestSchema>;

/* ── PATCH /users/me/addresses/:id ───────────────────────────────────────── */

/**
 * The editable address fields.
 *
 * Every field optional, but **at least one required** — an empty PATCH would bump `updated_at`,
 * return 200, and leave a caller believing something changed (§29). The same `strictObject`
 * exclusions as the create apply, for the same reasons.
 *
 * `line2` and `landmark` accept `''` here and that is meaningful: it CLEARS the line. `null` is
 * not accepted, because the columns are `NOT NULL` with an empty-string default and admitting
 * both spellings of "nothing" would make every consumer handle two.
 */
export const UpdateAddressRequestSchema = z
  .strictObject({
    label: textField(60).optional(),
    recipientName: textField(300).optional(),
    phone: phoneField.optional(),
    line1: textField(300).optional(),
    line2: z.string().trim().max(300).optional(),
    landmark: z.string().trim().max(300).optional(),
    city: textField(120).optional(),
    state: textField(120).optional(),
    postalCode: postalCodeField.optional(),
    countryCode: countryCodeField.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one address field must be provided',
  })
  .superRefine((value, ctx) => {
    /**
     * Only checkable when BOTH arrive together.
     *
     * A PATCH that sends only `postalCode` cannot be validated against the country without
     * reading the stored row, and doing that in a Zod schema would put a database call in the
     * validation layer. The service does not re-check either: the honest consequence is that
     * changing a country and a PIN in separate requests can leave an Indian address with a
     * non-Indian PIN. Recorded as a known limitation rather than hidden — closing it needs a
     * read-then-validate step whose failure mode (a 400 that depends on stored state) is worth
     * deciding deliberately.
     */
    if (value.countryCode === undefined || value.postalCode === undefined) return;
    // Destructured rather than passed whole: under `exactOptionalPropertyTypes` an object with
    // OPTIONAL properties is not assignable to one whose properties are required-but-nullable,
    // even after the guard above has narrowed both.
    checkIndianPin({ countryCode: value.countryCode, postalCode: value.postalCode }, ctx);
  });

export type UpdateAddressRequest = z.infer<typeof UpdateAddressRequestSchema>;

/* ── Path parameters ─────────────────────────────────────────────────────── */

/**
 * The address id.
 *
 * A UUID, validated here, so a malformed id is a 400 from the validation layer rather than a
 * `22P02` invalid-input-syntax error surfacing from PostgreSQL as a 500 — the same reason
 * Increment 25 introduced `OptionIdParamsSchema`.
 */
export const AddressIdParamsSchema = z.object({ id: z.uuid() });

export type AddressIdParams = z.infer<typeof AddressIdParamsSchema>;

/* ── Responses ───────────────────────────────────────────────────────────── */

/**
 * The public shape of an address.
 *
 * An allowlist, built field by field, like every other response in this project. Spreading the
 * row and deleting the private fields inverts the safety: every column added in a later
 * increment would be published by default, and the one that eventually leaks is the column
 * nobody thought about.
 *
 * `userId`, `storeId` and `deletedAt` never appear. Ownership and tenancy are invariants of the
 * query, not fields for a client to inspect, and a deleted address is not returned at all — so
 * publishing any of the three would only hand a client something it must not act on.
 */
export type AddressResponse = {
  id: string;
  label: string;
  recipientName: string;
  phone: string;
  line1: string;
  line2: string;
  landmark: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
  createdAt: string;
  updatedAt: string;
};

export function toAddressResponse(record: AddressRecord): AddressResponse {
  return {
    id: record.id,
    label: record.label,
    recipientName: record.recipientName,
    phone: record.phone,
    line1: record.line1,
    line2: record.line2,
    landmark: record.landmark,
    city: record.city,
    state: record.state,
    postalCode: record.postalCode,
    countryCode: record.countryCode,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
