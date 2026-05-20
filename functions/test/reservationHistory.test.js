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
      }),
    ],
  });

  assert.equal(history.reservations.length, 2);

  const reviewed = history.reservations.find((reservation) => reservation.id === "reservation-1");
  assert.equal(reviewed.reviewed, true);
  assert.equal(reviewed.reviewRating, 5);
  assert.deepEqual(reviewed.reviewTags, ["Qualidade", "Rápido"]);

  const unreviewed = history.reservations.find((reservation) => reservation.id === "reservation-2");
  assert.equal(unreviewed.reviewed, false);
  assert.equal(unreviewed.reviewRating, null);
  assert.deepEqual(unreviewed.reviewTags, []);
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
        priceCents: 0,
        discountCents: 3400,
      }),
    ],
  });

  assert.equal(history.reservations[0].priceCents, 0);
});
