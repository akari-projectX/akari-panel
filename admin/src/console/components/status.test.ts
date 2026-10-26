// Order state from the refund request (billing audit P2-4): a refund the
// provider confirmed but the panel could not record is its own state, with
// the confirmed amount; recording it (refunded_at) ends it.
import { expect, test } from "vitest";
import { confirmedRefundCents, orderState } from "./status";

const paid = { status: "paid", amount_cents: 5000, fulfilled_at: "2026-10-01T00:00:00Z", refunded_at: null };

test("a confirmed original-route refund waits to be recorded", () => {
  const o = { ...paid, refund_request: { state: "confirmed", cents: 3000 } };
  expect(confirmedRefundCents(o)).toBe(3000);
  expect(orderState(o)).toBe("refund_unrecorded");
});

test("pending, failed and done requests are not the confirmed state", () => {
  for (const state of ["pending", "failed", "done"]) {
    const o = { ...paid, refund_request: { state, cents: 3000 } };
    expect(confirmedRefundCents(o)).toBeNull();
  }
  expect(orderState({ ...paid, refund_request: { state: "pending", cents: 3000 } })).toBe("refunding");
  expect(orderState({ ...paid, refund_request: { state: "failed", cents: 3000 } })).toBe("completed");
  expect(orderState({ ...paid, refund_request: null })).toBe("completed");
});

test("once the refund is recorded the order is refunded", () => {
  const o = {
    ...paid,
    refunded_at: "2026-10-02T00:00:00Z",
    refund_cents: 3000,
    refund_request: { state: "done", cents: 3000 },
  };
  expect(confirmedRefundCents({ ...o, refund_request: { state: "confirmed", cents: 3000 } })).toBeNull();
  expect(orderState(o)).toBe("partial_refund");
});
