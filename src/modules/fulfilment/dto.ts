import { z } from 'zod';

import { boundedIntParam } from '../../shared/pagination.js';
import type { ShipmentRecord } from './fulfilment.repository.js';

/**
 * Fulfilment request and response shapes.
 *
 * Every request schema is a `strictObject`, so an unknown field is a `400` naming it rather than
 * being silently dropped. That matters most on the two bodiless action routes, where an
 * unexpected JSON body would otherwise reach `req.body` unvalidated — Increments 24, 26 and 27
 * each found a real escalation on exactly that shape.
 *
 * ## What is deliberately absent from every request
 *
 * `status`, `shippedAt`, `deliveredAt` — server-controlled. A client that could set a status
 * would bypass the transition table; one that could set a timestamp could claim goods shipped
 * before they were ordered.
 *
 * `orderId`, `storeId`, `userId`, `shipmentId` in a body — ownership and tenancy come from the
 * verified token and the path. Accepting any of them would be a mass-assignment hole across a
 * tenant boundary, which is the §24 rule.
 *
 * Inventory quantities and payment status — fulfilment reads both and neither is a client's to
 * assert.
 *
 * Each is UNREACHABLE rather than ignored: `strictObject` makes the field a 400.
 */

/** A tracking-number-ish string: trimmed, bounded, and never empty when present. */
const trackingField = z.string().trim().min(1).max(120);

const carrierField = z.string().trim().min(1).max(120);

/**
 * A URL a customer will click.
 *
 * **`.url()` alone is not enough, and a test proved it.** Zod's URL validator accepts any
 * well-formed URI, so `javascript:alert(1)` passes it — and this value is rendered as an `href`
 * in a customer-facing page, where that is the shape of a stored-XSS delivery. The invoice's
 * `esc()` does not help: escaping a href's text does not neuter its scheme.
 *
 * So the scheme is allow-listed to `http` and `https` explicitly. Two checks rather than one
 * regex: `.url()` rejects malformed input with a clear message, and the refine rejects the
 * schemes that are well-formed but dangerous.
 */
const trackingUrlField = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine(
    (value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === 'http:' || protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'must be an http or https URL' },
  );

/* ── POST /admin/orders/{orderNumber}/shipments ──────────────────────────── */

/**
 * Creating a shipment. Three optional fields, and nothing else.
 *
 * All three are optional because a shipment is routinely created before the courier is chosen —
 * that is what the `pending` state is for. `PATCH` corrects them later.
 */
export const CreateShipmentRequestSchema = z.strictObject({
  carrier: carrierField.optional(),
  trackingNumber: trackingField.optional(),
  trackingUrl: trackingUrlField.optional(),
});

export type CreateShipmentRequest = z.infer<typeof CreateShipmentRequestSchema>;

/* ── POST /admin/shipments/{id}/ship · /deliver ──────────────────────────── */

/**
 * The two transition bodies. One optional note, and that is all.
 *
 * The note exists because `shipment_event.note` exists and this is what fills it — "left with
 * neighbour", "second delivery attempt". It is deliberately NOT customer-visible: the customer
 * response has no note field, so an operator can write an internal remark without composing it
 * for an audience.
 */
export const ShipmentTransitionRequestSchema = z.strictObject({
  note: z.string().trim().min(1).max(500).optional(),
});

export type ShipmentTransitionRequest = z.infer<typeof ShipmentTransitionRequestSchema>;

/* ── PATCH /admin/shipments/{id} ─────────────────────────────────────────── */

/**
 * Correcting tracking facts. **Nullable, unlike creation.**
 *
 * `null` is meaningful here and absent is not: `{"trackingNumber": null}` clears a wrong number,
 * while omitting the field leaves it alone. Creation has no such distinction, which is why the
 * two schemas differ rather than sharing one.
 *
 * At least one field must be present — a PATCH that changes nothing is a request that means
 * nothing, and answering `200` to it would be a lie about work performed.
 */
export const UpdateTrackingRequestSchema = z
  .strictObject({
    carrier: carrierField.nullable().optional(),
    trackingNumber: trackingField.nullable().optional(),
    trackingUrl: trackingUrlField.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one of carrier, trackingNumber or trackingUrl must be supplied',
  });

export type UpdateTrackingRequest = z.infer<typeof UpdateTrackingRequestSchema>;

/* ── Path params ─────────────────────────────────────────────────────────── */

/** A shipment id in the path. UUID-shaped, so a malformed id is a 400 and never a query. */
export const ShipmentIdParamsSchema = z.strictObject({ id: z.uuid() });
export type ShipmentIdParams = z.infer<typeof ShipmentIdParamsSchema>;

/* ── GET /admin/orders/fulfilment ────────────────────────────────────────── */

export const FULFILMENT_QUEUE_DEFAULT_LIMIT = 20;
export const FULFILMENT_QUEUE_MAX_LIMIT = 100;

/**
 * The queue query. A bounded limit and an opaque cursor.
 *
 * Keyset rather than offset, because a queue is worked from the front while rows leave it:
 * `OFFSET 20` would skip orders as earlier ones are shipped, which in a fulfilment queue means
 * an order nobody ever sees. The cursor is opaque so its shape can change without a client
 * depending on it.
 *
 * There is deliberately no status filter, no date range, no customer field and no free text.
 * Every one of those would turn this into the general-purpose admin order search this project
 * has repeatedly declined, and `strictObject` makes each of them a 400 rather than a silently
 * ignored parameter.
 */
export const FulfilmentQueueQuerySchema = z.strictObject({
  limit: boundedIntParam({
    min: 1,
    max: FULFILMENT_QUEUE_MAX_LIMIT,
    default: FULFILMENT_QUEUE_DEFAULT_LIMIT,
  }),
  cursor: z.string().trim().min(1).max(200).optional(),
});

export type FulfilmentQueueQuery = z.infer<typeof FulfilmentQueueQuerySchema>;

/* ── Responses ───────────────────────────────────────────────────────────── */

/**
 * What a CUSTOMER may see. Five fields, and the omissions are the design.
 *
 * No `id` — an internal identifier a customer cannot use for anything, and one more thing to
 * guess at. No `orderId`, no `storeId`, no `updatedAt`, no note, and nothing about inventory.
 * The customer gets exactly the facts needed to find their parcel.
 *
 * Built by an explicit mapper rather than by spreading the record, so a column added to
 * `shipment` later cannot reach a customer response by default — the same reason
 * `SHIPMENT_COLUMNS` is an explicit list.
 */
export type CustomerShipmentResponse = {
  readonly status: string;
  readonly carrier: string | null;
  readonly trackingNumber: string | null;
  readonly trackingUrl: string | null;
  readonly shippedAt: string | null;
  readonly deliveredAt: string | null;
};

export function toCustomerShipmentResponse(row: ShipmentRecord): CustomerShipmentResponse {
  return {
    status: row.status,
    carrier: row.carrier,
    trackingNumber: row.trackingNumber,
    trackingUrl: row.trackingUrl,
    shippedAt: row.shippedAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
  };
}

/**
 * What STAFF see: the customer view plus the identifier they need in order to act.
 *
 * `id` is here and not in the customer response because staff address shipments by it — the
 * transition routes take it in the path. `createdAt` is here because "when was this shipment
 * raised" is an operational question, and it is not a customer's.
 */
export type StaffShipmentResponse = CustomerShipmentResponse & {
  readonly id: string;
  readonly createdAt: string;
};

export function toStaffShipmentResponse(row: ShipmentRecord): StaffShipmentResponse {
  return {
    ...toCustomerShipmentResponse(row),
    id: row.id,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * One row of the fulfilment queue.
 *
 * Just enough to decide what to pick and pack: which order, when it was placed, who it goes to,
 * and where. Deliberately no money, no line items, no customer contact details and no payment
 * state — a queue is a worklist, and every extra field here is a step toward the admin order
 * surface this endpoint is not.
 */
export type FulfilmentQueueRow = {
  readonly orderNumber: string;
  readonly placedAt: string;
  readonly recipientName: string;
  readonly city: string;
  readonly postalCode: string;
  readonly shipmentStatus: string | null;
};
