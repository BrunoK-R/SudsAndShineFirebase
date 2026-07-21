const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertAdminRole,
  buildAdminAcceptedReservations,
  buildAdminCompletableReservations,
  assertPendingReservationActionable,
  assertReservationCompletable,
  assertReservationStartable,
  buildAdminPendingReservations,
  completionPaymentStatus,
  normalizeRejectionReason,
  reservationEarnsLoyaltyStamp,
  validateAdminReservationActionInput,
} = require("../reservationAdmin");

function doc(id, data, exists = true) {
  return {
    id,
    exists,
    data: () => data,
  };
}

test("assertAdminRole accepts only admin role", () => {
  assert.doesNotThrow(() => assertAdminRole("admin"));
  assert.throws(() => assertAdminRole("employee"), /Admin role required/);
  assert.throws(() => assertAdminRole(null), /Admin role required/);
});

test("validateAdminReservationActionInput normalizes reservation id and optional reason", () => {
  const input = validateAdminReservationActionInput({
    reservationId: " reservation-1 ",
    reason: "  Fora   do horário disponível. ",
  });

  assert.equal(input.reservationId, "reservation-1");
  assert.equal(input.rejectionReason, "Fora do horário disponível.");
  assert.equal(normalizeRejectionReason(null), "");
});

test("buildAdminPendingReservations returns only active pending requests sorted by slot", () => {
  const requests = buildAdminPendingReservations({
    now: new Date("2026-05-20T10:00:00.000Z"),
    serviceDocs: [
      doc("premium", {
        name: "Lavagem Premium",
        passengerPriceCents: 3200,
        suvPriceCents: 3400,
      }),
    ],
    reservationDocs: [
      doc("later", {
        reservationCode: "SS-LATER",
        customerName: "Ana",
        customerEmail: "ana@example.com",
        customerPhone: "910000000",
        serviceId: "premium",
        slotStart: "2026-05-22T12:00:00.000Z",
        slotEnd: "2026-05-22T12:45:00.000Z",
        status: "pending",
        vehicleType: "suv",
        pendingExpiresAt: "2026-05-20T12:00:00.000Z",
        extras: [{id: "wax", name: "Enceramento", priceCents: 1500}],
        notes: "Portão lateral",
      }),
      doc("expired", {
        customerName: "Bruno",
        serviceId: "premium",
        slotStart: "2026-05-22T09:00:00.000Z",
        slotEnd: "2026-05-22T09:45:00.000Z",
        status: "pending",
        vehicleType: "passageiros",
        pendingExpiresAt: "2026-05-20T09:59:00.000Z",
      }),
      doc("earlier", {
        reservationCode: "SS-EARLIER",
        customerName: "Carla",
        customerEmail: "carla@example.com",
        serviceId: "premium",
        slotStart: "2026-05-22T10:00:00.000Z",
        slotEnd: "2026-05-22T10:45:00.000Z",
        status: "pending",
        vehicleType: "passageiros",
      }),
      doc("confirmed", {
        serviceId: "premium",
        slotStart: "2026-05-22T08:00:00.000Z",
        slotEnd: "2026-05-22T08:45:00.000Z",
        status: "confirmed",
        vehicleType: "passageiros",
      }),
    ],
  }).requests;

  assert.deepEqual(requests.map((item) => item.id), ["earlier", "later"]);
  assert.equal(requests[0].serviceName, "Lavagem Premium");
  assert.equal(requests[1].priceCents, 4900);
  assert.equal(requests[1].notes, "Portão lateral");
});

test("buildAdminAcceptedReservations returns accepted jobs sorted by slot", () => {
  const requests = buildAdminAcceptedReservations({
    now: new Date("2026-05-20T12:00:00.000Z"),
    serviceDocs: [
      doc("premium", {
        name: "Lavagem Premium",
        passengerPriceCents: 3200,
        suvPriceCents: 3400,
      }),
    ],
    reservationDocs: [
      doc("future", {
        reservationCode: "SS-FUTURE",
        customerName: "Ana",
        serviceId: "premium",
        slotStart: "2026-05-20T12:30:00.000Z",
        slotEnd: "2026-05-20T13:15:00.000Z",
        status: "confirmed",
        vehicleType: "passageiros",
      }),
      doc("later", {
        reservationCode: "SS-LATER",
        customerName: "Bruno",
        serviceId: "premium",
        slotStart: "2026-05-20T10:00:00.000Z",
        slotEnd: "2026-05-20T10:45:00.000Z",
        status: "in_progress",
        vehicleType: "suv",
        extras: [{id: "wax", name: "Enceramento", priceCents: 1500}],
        acceptedAt: "2026-05-19T18:30:00.000Z",
        acceptedByUid: " admin-uid ",
      }),
      doc("earlier", {
        reservationCode: "SS-EARLIER",
        customerName: "Carla",
        serviceId: "premium",
        slotStart: "2026-05-20T08:00:00.000Z",
        slotEnd: "2026-05-20T08:45:00.000Z",
        status: "confirmed",
        vehicleType: "passageiros",
      }),
      doc("pending", {
        serviceId: "premium",
        slotStart: "2026-05-20T07:00:00.000Z",
        slotEnd: "2026-05-20T07:45:00.000Z",
        status: "pending",
        vehicleType: "passageiros",
      }),
    ],
  }).requests;

  assert.deepEqual(requests.map((item) => item.id), ["earlier", "later", "future"]);
  assert.equal(requests[0].status, "confirmed");
  assert.equal(requests[0].canStart, true);
  assert.equal(requests[0].canComplete, false);
  assert.equal(requests[1].status, "in_progress");
  assert.equal(requests[1].canStart, false);
  assert.equal(requests[1].canComplete, true);
  assert.equal(requests[1].priceCents, 4900);
  assert.equal(requests[1].acceptedAt, "2026-05-19T18:30:00.000Z");
  assert.equal(requests[1].acceptedByUid, "admin-uid");
  assert.equal(requests[2].status, "confirmed");
  assert.equal(requests[2].canStart, true);
  assert.equal(requests[2].canComplete, false);
});

test("buildAdminCompletableReservations returns accepted jobs for legacy callers", () => {
  const requests = buildAdminCompletableReservations({
    now: new Date("2026-05-20T12:00:00.000Z"),
    serviceDocs: [],
    reservationDocs: [
      doc("future", {
        serviceId: "premium",
        slotStart: "2026-05-20T12:30:00.000Z",
        slotEnd: "2026-05-20T13:15:00.000Z",
        status: "confirmed",
        vehicleType: "passageiros",
      }),
    ],
  }).requests;

  assert.deepEqual(requests.map((item) => item.id), ["future"]);
  assert.equal(requests[0].canComplete, false);
});

test("assertPendingReservationActionable rejects expired and non-pending requests", () => {
  const now = new Date("2026-05-20T10:00:00.000Z");

  assert.doesNotThrow(() => assertPendingReservationActionable({
    now,
    reservationSnap: doc("pending", {
      status: "pending",
      pendingExpiresAt: "2026-05-20T10:01:00.000Z",
    }),
  }));
  assert.throws(() => assertPendingReservationActionable({
    now,
    reservationSnap: doc("expired", {
      status: "pending",
      pendingExpiresAt: "2026-05-20T09:59:00.000Z",
    }),
  }), /expired/);
  assert.throws(() => assertPendingReservationActionable({
    now,
    reservationSnap: doc("confirmed", {status: "confirmed"}),
  }), /not pending/);
});

test("assertReservationStartable allows confirmed reservations only", () => {
  const reservation = assertReservationStartable({
    reservationSnap: doc("confirmed", {status: "confirmed"}),
  });

  assert.equal(reservation.status, "confirmed");
  assert.throws(() => assertReservationStartable({
    reservationSnap: doc("progress", {status: "in_progress"}),
  }), /cannot be started/);
  assert.throws(() => assertReservationStartable({
    reservationSnap: doc("completed", {status: "completed"}),
  }), /already completed/);
});

test("assertReservationCompletable allows in-progress reservations only", () => {
  assert.doesNotThrow(() => assertReservationCompletable({
    reservationSnap: doc("legacy", {
      status: "em_execucao",
      slotEnd: "2026-05-20T10:00:00.000Z",
    }),
  }));
  assert.throws(() => assertReservationCompletable({
    reservationSnap: doc("confirmed", {
      status: "confirmed",
    }),
  }), /cannot be completed/);
  assert.throws(() => assertReservationCompletable({
    reservationSnap: doc("pending", {
      status: "pending",
    }),
  }), /cannot be completed/);
  assert.throws(() => assertReservationCompletable({
    reservationSnap: doc("completed", {
      status: "completed",
    }),
  }), /already completed/);
});

test("completion payment and loyalty rules distinguish paid and reward washes", () => {
  assert.equal(completionPaymentStatus({priceCents: 3200}), "paid");
  assert.equal(completionPaymentStatus({priceCents: 0, loyaltyRewardApplied: true}), "covered_by_loyalty");
  assert.equal(reservationEarnsLoyaltyStamp({priceCents: 3200}), true);
  assert.equal(reservationEarnsLoyaltyStamp({priceCents: 0}), false);
  assert.equal(reservationEarnsLoyaltyStamp({priceCents: 0, loyaltyRewardApplied: true}), false);
});
