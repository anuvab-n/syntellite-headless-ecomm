import { z } from 'zod';

import type { StoreBusinessProfile } from './stores.repository.js';

/**
 * The business profile on the wire.
 *
 * No `id`: the store is implied by the authenticated token, and publishing its UUID would be
 * the one internal identifier this API exposes. `slug` and `currency` are read-only — see the
 * repository type for why neither is a setting.
 */
export type BusinessProfileResponse = {
  slug: string;
  name: string;
  domain: string | null;
  currency: string;
  defaultLocale: string;
  timezone: string;
  isActive: boolean;
};

export function toBusinessProfileResponse(profile: StoreBusinessProfile): BusinessProfileResponse {
  return {
    slug: profile.slug,
    name: profile.name,
    domain: profile.domain,
    currency: profile.currency,
    defaultLocale: profile.defaultLocale,
    timezone: profile.timezone,
    isActive: profile.isActive,
  };
}

/**
 * An IANA timezone name, checked against the runtime's own database.
 *
 * `Intl.DateTimeFormat` is the authority Node already uses, and it is the same authority the
 * invoice renderer will format against — so a value this accepts is one the rest of the system
 * can actually use. A regex would admit `Asia/Atlantis`, which would then fail at invoice time
 * on an order that had already been placed.
 */
const timezoneField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be a valid IANA timezone name' },
  );

/**
 * The business profile PATCH body.
 *
 * `strictObject`, so `gstin`, `legalName`, `pan`, `slug`, `currency` and `isActive` are each a
 * `400` naming the field rather than a silently ignored write. The first three belong to the
 * tax profile, which validates them properly; the rest are not settings.
 *
 * Every key is optional and absent means "leave it alone" — a PATCH, not a PUT. `domain` is
 * nullable because clearing a custom domain is a real operation, distinct from omitting it.
 */
export const UpdateBusinessProfileRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    /*
     * A hostname, not a URL: no scheme, no path, no port. Lower-cased at the boundary so two
     * spellings of one domain cannot be stored as two different values.
     */
    domain: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(255)
      .regex(
        /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/u,
        'must be a bare hostname, without a scheme or path',
      )
      .nullable(),
    defaultLocale: z
      .string()
      .trim()
      .min(2)
      .max(10)
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/u, 'must be a BCP-47 language tag such as en-IN'),
    timezone: timezoneField,
  })
  .partial();

export type UpdateBusinessProfileRequest = z.infer<typeof UpdateBusinessProfileRequestSchema>;
