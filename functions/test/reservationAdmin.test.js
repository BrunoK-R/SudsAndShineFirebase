const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertAdminRole,
  buildAdminCompletableReservations,
  assertPendingReservationActionable,
  assertReservationCompletable,
  buildAdminPendingReservations,
  normalizeRejectionReason,
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

test("buildAdminCompletableReservations returns past confirmed jobs sorted by slot", () => {
  const requests = buildAdminCompletableReservations({
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

  assert.deepEqual(requests.map((item) => item.id), ["earlier", "later"]);
  assert.equal(requests[0].status, "confirmed");
  assert.equal(requests[1].status, "in_progress");
  assert.equal(requests[1].priceCents, 4900);
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

test("assertReservationCompletable allows finished confirmed reservations only", () => {
  const now = new Date("2026-05-20T12:00:00.000Z");

  const reservation = assertReservationCompletable({
    now,
    reservationSnap: doc("confirmed", {
      status: "confirmed",
      slotEnd: "2026-05-20T11:59:00.000Z",
    }),
  });

  assert.equal(reservation.status, "confirmed");
  assert.doesNotThrow(() => assertReservationCompletable({
    now,
    reservationSnap: doc("legacy", {
      status: "em_execucao",
      slotEnd: "2026-05-20T10:00:00.000Z",
    }),
  }));
  assert.throws(() => assertReservationCompletable({
    now,
    reservationSnap: doc("future", {
      status: "confirmed",
      slotEnd: "2026-05-20T12:01:00.000Z",
    }),
  }), /before its scheduled end/);
  assert.throws(() => assertReservationCompletable({
    now,
    reservationSnap: doc("pending", {
      status: "pending",
      slotEnd: "2026-05-20T10:00:00.000Z",
    }),
  }), /cannot be completed/);
  assert.throws(() => assertReservationCompletable({
    now,
    reservationSnap: doc("completed", {
      status: "completed",
      slotEnd: "2026-05-20T10:00:00.000Z",
    }),
  }), /already completed/);
  assert.throws(() => assertReservationCompletable({
    now,
    reservationSnap: doc("broken", {
      status: "confirmed",
      slotEnd: "not-a-date",
    }),
  }), /slot is incomplete/);
});
