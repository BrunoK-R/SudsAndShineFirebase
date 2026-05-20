const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildUserReservationHistory,
  normalizeReservationDocument,
} = require("../reservationHistory");

function doc(id, data) {
  return {
    id,
    data: () => data,
  };
}

test("normalizes reservations with catalog price and upcoming bucket", () => {
  const item = normalizeReservationDocument(
    doc("reservation-1", {
      reservationCode: "SS-ABCDEFGH",
      serviceId: "premium",
      serviceName: "Lavagem Premium",
      slotStart: "2026-05-20T10:00:00.000Z",
      slotEnd: "2026-05-20T10:45:00.000Z",
      status: "pending",
      vehicleType: "suv",
      vehicleLabel: "BMW 320d",
    }),
    new Map([
      [
        "premium",
        {
          id: "premium",
          name: "Lavagem Premium",
          passengerPriceCents: 3200,
          suvPriceCents: 3400,
        },
      ],
    ]),
    new Date("2026-05-19T10:00:00.000Z"),
  );

  assert.equal(item.id, "reservation-1");
  assert.equal(item.reservationCode, "SS-ABCDEFGH");
  assert.equal(item.vehicleLabel, "BMW 320d");
  assert.equal(item.priceCents, 3400);
  assert.equal(item.upcoming, true);
});

test("buildUserReservationHistory merges defaults, sorts newest first, and marks past items completed", () => {
  const history = buildUserReservationHistory({
    reservationDocs: [
      doc("old", {
        reservationCode: "SS-OLD",
        serviceId: "standard",
        slotStart: "2026-05-18T10:00:00.000Z",
        slotEnd: "2026-05-18T10:30:00.000Z",
        status: "pending",
        vehicleType: "passageiros",
      }),
      doc("new", {
        reservationCode: "SS-NEW",
        serviceId: "premium",
        slotStart: "2026-05-21T10:00:00.000Z",
        slotEnd: "2026-05-21T10:45:00.000Z",
        status: "confirmed",
        vehicleType: "passageiros",
      }),
    ],
    serviceDocs: [],
    now: new Date("2026-05-20T09:00:00.000Z"),
  });

  assert.deepEqual(
    history.reservations.map((reservation) => reservation.id),
    ["new", "old"],
  );
  assert.equal(history.reservations[0].priceCents, 3200);
  assert.equal(history.reservations[0].upcoming, true);
  assert.equal(history.reservations[1].upcoming, false);
});
