const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildUserReservationHistory,
} = require("../reservationHistory");

function doc(id, data, exists = true) {
  return {
    id,
    exists,
    data: () => data,
  };
}

test("buildUserReservationHistory includes review metadata for reviewed reservations", () => {
  const history = buildUserReservationHistory({
    now: new Date("2026-05-20T12:00:00.000Z"),
    serviceDocs: [
      doc("premium", {
        name: "Lavagem Premium",
        durationMinutes: 45,
        passengerPriceCents: 3200,
        suvPriceCents: 3400,
      }),
    ],
    reservationDocs: [
      doc("reservation-1", {
        reservationCode: "SS-ABCDEFGH",
        serviceId: "premium",
        slotStart: "2026-05-18T10:00:00.000Z",
        slotEnd: "2026-05-18T10:45:00.000Z",
        status: "completed",
        vehicleType: "suv",
        userVehicleId: "vehicle-1",
      }),
      doc("reservation-2", {
        reservationCode: "SS-HGFEDCBA",
        serviceId: "premium",
        slotStart: "2026-05-21T10:00:00.000Z",
        slotEnd: "2026-05-21T10:45:00.000Z",
        status: "pending",
        vehicleType: "passageiros",
      }),
    ],
    reviewDocs: [
      doc("reservation-1_uid-1", {
        reservationId: "reservation-1",
        rating: 5,
        tags: ["Qualidade", "Rápido"],
        comment: "  Ficou impecável.  ",
      }),
    ],
  });

  assert.equal(history.reservations.length, 2);

  const reviewed = history.reservations.find((reservation) => reservation.id === "reservation-1");
  assert.equal(reviewed.reviewed, true);
  assert.equal(reviewed.userVehicleId, "vehicle-1");
  assert.equal(reviewed.reviewRating, 5);
  assert.deepEqual(reviewed.reviewTags, ["Qualidade", "Rápido"]);
  assert.equal(reviewed.reviewComment, "Ficou impecável.");

  const unreviewed = history.reservations.find((reservation) => reservation.id === "reservation-2");
  assert.equal(unreviewed.reviewed, false);
  assert.equal(unreviewed.reviewRating, null);
  assert.deepEqual(unreviewed.reviewTags, []);
  assert.equal(unreviewed.reviewComment, "");
});

test("buildUserReservationHistory prefers stored rewarded reservation price", () => {
  const history = buildUserReservationHistory({
    now: new Date("2026-05-20T12:00:00.000Z"),
    serviceDocs: [
      doc("premium", {
        name: "Lavagem Premium",
        durationMinutes: 45,
        passengerPriceCents: 3200,
        suvPriceCents: 3400,
      }),
    ],
    reservationDocs: [
      doc("reservation-1", {
        reservationCode: "SS-ABCDEFGH",
        serviceId: "premium",
        slotStart: "2026-05-21T10:00:00.000Z",
        slotEnd: "2026-05-21T10:45:00.000Z",
        status: "pending",
        vehicleType: "suv",
        loyaltyRewardApplied: true,
        paymentStatus: "covered_by_loyalty",
        priceCents: 0,
        discountCents: 3400,
      }),
    ],
  });

  assert.equal(history.reservations[0].priceCents, 0);
  assert.equal(history.reservations[0].paymentStatus, "covered_by_loyalty");
});

test("buildUserReservationHistory includes persisted extras and fallback price", () => {
  const history = buildUserReservationHistory({
    now: new Date("2026-05-20T12:00:00.000Z"),
    serviceDocs: [
      doc("premium", {
        name: "Lavagem Premium",
        durationMinutes: 45,
        passengerPriceCents: 3200,
        suvPriceCents: 3400,
      }),
    ],
    reservationDocs: [
      doc("reservation-1", {
        reservationCode: "SS-ABCDEFGH",
        serviceId: "premium",
        slotStart: "2026-05-21T10:00:00.000Z",
        slotEnd: "2026-05-21T10:45:00.000Z",
        status: "pending",
        vehicleType: "passageiros",
        extras: [
          {id: "wax", name: "Enceramento", priceCents: 1500},
          {id: "vacuum", name: "Aspiração Profunda", priceCents: 800},
        ],
      }),
    ],
  });

  assert.equal(history.reservations[0].priceCents, 5500);
  assert.deepEqual(history.reservations[0].extras, [
    {id: "wax", name: "Enceramento", priceCents: 1500},
    {id: "vacuum", name: "Aspiração Profunda", priceCents: 800},
  ]);
});

test("buildUserReservationHistory exposes normalized payment status", () => {
  const history = buildUserReservationHistory({
    now: new Date("2026-05-20T12:00:00.000Z"),
    serviceDocs: [
      doc("premium", {
        name: "Lavagem Premium",
        durationMinutes: 45,
        passengerPriceCents: 3200,
        suvPriceCents: 3400,
      }),
    ],
    reservationDocs: [
      doc("reservation-1", {
        reservationCode: "SS-ABCDEFGH",
        serviceId: "premium",
        slotStart: "2026-05-21T10:00:00.000Z",
        slotEnd: "2026-05-21T10:45:00.000Z",
        status: "pending",
        paymentStatus: "waiting-for-payment",
        vehicleType: "passageiros",
      }),
      doc("reservation-2", {
        reservationCode: "SS-HGFEDCBA",
        serviceId: "premium",
        slotStart: "2026-05-22T10:00:00.000Z",
        slotEnd: "2026-05-22T10:45:00.000Z",
        status: "pending",
        paymentStatus: "PAID",
        vehicleType: "passageiros",
      }),
    ],
  });

  assert.equal(history.reservations.find((item) => item.id === "reservation-1").paymentStatus, "pending");
  assert.equal(history.reservations.find((item) => item.id === "reservation-2").paymentStatus, "paid");
});

test("buildUserReservationHistory exposes owner-visible lifecycle and loyalty audit", () => {
  const history = buildUserReservationHistory({
    now: new Date("2026-05-20T12:00:00.000Z"),
    serviceDocs: [],
    reservationDocs: [
      doc("reservation-1", {
        reservationCode: "SS-ABCDEFGH",
        serviceId: "standard",
        serviceName: "Lavagem Standard",
        slotStart: "2026-05-19T10:00:00.000Z",
        slotEnd: "2026-05-19T10:30:00.000Z",
        status: "completed",
        paymentStatus: "covered_by_loyalty",
        vehicleType: "passageiros",
        acceptedAt: "2026-05-18T09:00:00.000Z",
        startedAt: "2026-05-19T10:02:00.000Z",
        completedAt: "2026-05-19T10:28:00.000Z",
        paymentConfirmedAt: "2026-05-19T10:28:00.000Z",
        loyaltyRewardApplied: true,
        loyaltyRewardCode: " SS-FREE-0001 ",
        loyaltyRewardDescription: " 1 lavagem grátis ",
        loyaltyStampGranted: false,
      }),
    ],
  });

  const reservation = history.reservations[0];
  assert.equal(reservation.startedAt, "2026-05-19T10:02:00.000Z");
  assert.equal(reservation.completedAt, "2026-05-19T10:28:00.000Z");
  assert.equal(reservation.paymentConfirmedAt, "2026-05-19T10:28:00.000Z");
  assert.equal(reservation.loyaltyRewardApplied, true);
  assert.equal(reservation.loyaltyRewardCode, "SS-FREE-0001");
  assert.equal(reservation.loyaltyRewardDescription, "1 lavagem grátis");
  assert.equal(reservation.loyaltyStampGranted, false);
});

test("buildUserReservationHistory exposes reservation change audit metadata", () => {
  const history = buildUserReservationHistory({
    now: new Date("2026-05-20T12:00:00.000Z"),
    serviceDocs: [
      doc("premium", {
        name: "Lavagem Premium",
        durationMinutes: 45,
        passengerPriceCents: 3200,
        suvPriceCents: 3400,
      }),
    ],
    reservationDocs: [
      doc("reservation-1", {
        reservationCode: "SS-ABCDEFGH",
        serviceId: "premium",
        slotStart: "2026-05-22T11:00:00.000Z",
        slotEnd: "2026-05-22T11:45:00.000Z",
        status: "pending",
        vehicleType: "suv",
        createdAt: {seconds: 1779271200, nanoseconds: 250000000},
        updatedAt: "2026-05-20T10:30:00.000Z",
        rescheduledAt: {toDate: () => new Date("2026-05-20T10:30:00.000Z")},
        previousSlotStart: "2026-05-21T10:00:00.000Z",
        previousSlotEnd: "2026-05-21T10:45:00.000Z",
        rescheduleCount: "2",
      }),
      doc("reservation-2", {
        reservationCode: "SS-HGFEDCBA",
        serviceId: "premium",
        slotStart: "2026-05-18T10:00:00.000Z",
        slotEnd: "2026-05-18T10:45:00.000Z",
        status: "cancelled",
        vehicleType: "passageiros",
        cancelledAt: new Date("2026-05-17T16:30:00.000Z"),
      }),
    ],
  });

  const rescheduled = history.reservations.find((item) => item.id === "reservation-1");
  assert.equal(rescheduled.createdAt, "2026-05-20T10:00:00.250Z");
  assert.equal(rescheduled.updatedAt, "2026-05-20T10:30:00.000Z");
  assert.equal(rescheduled.rescheduledAt, "2026-05-20T10:30:00.000Z");
  assert.equal(rescheduled.previousSlotStart, "2026-05-21T10:00:00.000Z");
  assert.equal(rescheduled.previousSlotEnd, "2026-05-21T10:45:00.000Z");
  assert.equal(rescheduled.rescheduleCount, 2);

  const cancelled = history.reservations.find((item) => item.id === "reservation-2");
  assert.equal(cancelled.cancelledAt, "2026-05-17T16:30:00.000Z");
});

test("buildUserReservationHistory exposes validation outcomes for owners", () => {
  const history = buildUserReservationHistory({
    now: new Date("2026-05-20T12:00:00.000Z"),
    serviceDocs: [],
    reservationDocs: [
      doc("rejected-1", {
        reservationCode: "SS-REJECT",
        serviceId: "standard",
        slotStart: "2026-05-22T11:00:00.000Z",
        slotEnd: "2026-05-22T11:30:00.000Z",
        status: "rejected",
        vehicleType: "passageiros",
        rejectedAt: "2026-05-20T10:00:00.000Z",
        rejectionReason: "Horário indisponível.",
      }),
      doc("expired-1", {
        reservationCode: "SS-EXPIRE",
        serviceId: "standard",
        slotStart: "2026-05-23T11:00:00.000Z",
        slotEnd: "2026-05-23T11:30:00.000Z",
        status: "expired",
        vehicleType: "passageiros",
        pendingExpiresAt: "2026-05-21T09:00:00.000Z",
      }),
    ],
  });

  const rejected = history.reservations.find((item) => item.id === "rejected-1");
  assert.equal(rejected.upcoming, false);
  assert.equal(rejected.rejectedAt, "2026-05-20T10:00:00.000Z");
  assert.equal(rejected.rejectionReason, "Horário indisponível.");

  const expired = history.reservations.find((item) => item.id === "expired-1");
  assert.equal(expired.upcoming, false);
  assert.equal(expired.pendingExpiresAt, "2026-05-21T09:00:00.000Z");
});
