import { DependencyUnavailable } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';

/**
 * Object storage for product imagery.
 *
 * ## Why this file exists and what is NOT in it
 *
 * The catalogue declares a `MediaStorage` port and never learns which vendor holds the bytes.
 * This is where an S3-compatible implementation would live, beside `razorpay/` — the same shape
 * the payment gateway uses: one adapter per external system, outside every domain module, wired
 * by the composition root.
 *
 * **There is no S3 implementation yet, and this file does not fake one.** Generating a
 * pre-signed `PUT` requires an AWS SigV4 signer; this project has no S3 SDK in its dependencies
 * and adding one is a decision with its own review. Until that decision is made, the honest
 * behaviour is the unconfigured adapter below: it refuses with `503 DEPENDENCY_UNAVAILABLE`, the
 * same answer an unconfigured payment gateway gives, rather than returning a URL that cannot
 * work.
 *
 * Everything around the upload is complete and exercised: the `product_media` table, the
 * registration, the gallery, ordering, the primary flag, deletion, tenancy, and the URL
 * composition below. What is blocked is the signing step alone.
 *
 * ## What a real adapter must do
 *
 *  - Sign a `PUT` for `storageKey`, bounded by the declared `contentType` and `byteSize`, with a
 *    short expiry. An unbounded pre-signed URL is an open upload endpoint for anyone holding it.
 *  - Place the object under this store's prefix, so a key cannot address another tenant's data.
 *  - Leave the row alone. Registration is the catalogue's job; storage returns a key and a URL.
 */

/**
 * Where a client should send an image's bytes. Mirrors `MediaUploadTarget` in the catalogue.
 *
 * Restated structurally rather than imported, so this file depends on no domain module —
 * `no-cross-module-imports` is satisfied by construction, and the compiler still checks the two
 * agree where `container.ts` joins them. The same technique `RazorpayGateway` uses.
 */
export type MediaUploadTarget = {
  readonly uploadUrl: string;
  readonly storageKey: string;
  readonly expiresAt: Date;
  readonly requiredHeaders: Readonly<Record<string, string>>;
};

export type MediaStorageAdapter = {
  createUploadTarget(params: {
    storeId: string;
    productId: string;
    contentType: string;
    byteSize: number;
  }): Promise<MediaUploadTarget>;
  publicUrl(storageKey: string): string | null;
};

/**
 * Compose the delivery URL for an object key.
 *
 * Separate from the signer because the two are independently configurable and independently
 * useful: a deployment may serve images from a CDN it does not upload through, and the read path
 * must keep working whether or not uploads are available.
 *
 * Returns `null` when no delivery host is configured. That is an ordinary state, not an error —
 * the media row is still a valid reference, it simply cannot be displayed from this deployment
 * yet, and the response says so with an explicit `null` rather than a broken URL.
 */
function composePublicUrl(baseUrl: string | undefined, storageKey: string): string | null {
  if (baseUrl === undefined || baseUrl.length === 0) return null;
  return `${baseUrl.replace(/\/+$/u, '')}/${storageKey}`;
}

/**
 * The adapter a deployment gets when object storage is not configured for uploads.
 *
 * Reads keep working — `publicUrl` still composes a URL when a delivery host is set, because
 * serving existing images does not need a signer. Only the upload target refuses, and it refuses
 * loudly: `503`, logged at `error`, naming the missing configuration rather than pretending.
 */
export function createUnconfiguredMediaStorage(deps: {
  logger: Logger;
  publicBaseUrl?: string;
}): MediaStorageAdapter {
  const { logger } = deps;

  return {
    createUploadTarget() {
      logger.error({ storage: 's3' }, 'media_storage_not_configured');
      return Promise.reject(new DependencyUnavailable('object storage'));
    },
    publicUrl(storageKey) {
      return composePublicUrl(deps.publicBaseUrl, storageKey);
    },
  };
}
