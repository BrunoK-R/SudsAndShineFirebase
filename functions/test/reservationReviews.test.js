const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertReservationReviewable,
  buildReservationReviewDocument,
  buildReservationReviewId,
  validateReservationReviewInput,
} = require("../reservationReviews");

function doc(data, exists = true) {
  return {
    exists,
    data: () => data,
  };
}

test("validateReservationReviewInput sanitizes tags and comment", () => {
  const parsed = validateReservationReviewInput({
    reservationId: " reservation-1 ",
    rating: 5,
    tags: [" Rápido ", "rápido", "Qualidade", "", "Simpático"],
    comment: "  Ficou impecável.  ",
  });

  assert.equal(parsed.reservationId, "reservation-1");
  assert.equal(parsed.rating, 5);
  assert.deepEqual(parsed.tags, ["Rápido", "Qualidade", "Simpático"]);
  assert.equal(parsed.comment, "Ficou impecável.");
});

test("validateReservationReviewInput rejects invalid reservations and ratings", () => {
  assert.throws(() => {
    validateReservationReviewInput({reservationId: "reservations/other", rating: 5});
  }, /reservationId is required/);

  assert.throws(() => {
    validateReservationReviewInput({reservationId: "reservation-1", rating: 6});
  }, /rating must be between 1 and 5/);
});

test("assertReservationReviewable allows owned past reservations by uid or email", () => {
  const reservation = doc({
    customerUid: "uid-1",
    customerEmail: "other@example.com",
    slotEnd: "2026-05-19T10:45:00.000Z",
    status: "completed",
  });

  assert.doesNotThrow(() => {
    assertReservationReviewable({
      reservationSnap: reservation,
      uid: "uid-1",
      email: "bruno@example.com",
      now: new Date("2026-05-20T10:00:00.000Z"),
    });
  });

  assert.doesNotThrow(() => {
    assertReservationReviewable({
      reservationSnap: doc({
        customerEmail: "bruno@example.com",
        slotEnd: "2026-05-19T10:45:00.000Z",
      }),
      uid: "uid-2",
      email: "bruno@example.com",
      now: new Date("2026-05-20T10:00:00.000Z"),
    });
  });
});

test("assertReservationReviewable rejects foreign future and cancelled reservations", () => {
  assert.throws(() => {
    assertReservationReviewable({
      reservationSnap: doc({
        customerUid: "other",
        customerEmail: "other@example.com",
        slotEnd: "2026-05-19T10:45:00.000Z",
      }),
      uid: "uid-1",
      email: "bruno@example.com",
      now: new Date("2026-05-20T10:00:00.000Z"),
    });
  }, /Reservation does not belong to this user/);

  assert.throws(() => {
    assertReservationReviewable({
      reservationSnap: doc({
        customerUid: "uid-1",
        slotEnd: "2026-05-21T10:45:00.000Z",
      }),
      uid: "uid-1",
      email: "bruno@example.com",
      now: new Date("2026-05-20T10:00:00.000Z"),
    });
  }, /Reservation is not ready for review/);

  assert.throws(() => {
    assertReservationReviewable({
      reservationSnap: doc({
        customerUid: "uid-1",
        slotEnd: "2026-05-19T10:45:00.000Z",
        status: "cancelled",
      }),
      uid: "uid-1",
      email: "bruno@example.com",
      now: new Date("2026-05-20T10:00:00.000Z"),
    });
  }, /Cancelled reservations cannot be reviewed/);
});

test("buildReservationReviewDocument keeps review data user scoped", () => {
  const review = validateReservationReviewInput({
    reservationId: "reservation-1",
    rating: 4,
    tags: ["Qualidade"],
    comment: "Muito bom.",
  });
  const document = buildReservationReviewDocument({
    review,
    reservationData: {
      reservationCode: "SS-ABCDEFGH",
      serviceId: "premium",
      serviceName: "Lavagem Premium",
    },
    uid: "uid-1",
    email: "bruno@example.com",
  });

  assert.equal(buildReservationReviewId("reservation-1", "uid/1"), "reservation-1_uid_1");
  assert.deepEqual(document, {
    reservationId: "reservation-1",
    reservationCode: "SS-ABCDEFGH",
    customerUid: "uid-1",
    customerEmail: "bruno@example.com",
    serviceId: "premium",
    serviceName: "Lavagem Premium",
    rating: 4,
    tags: ["Qualidade"],
    comment: "Muito bom.",
    source: "mobile-rating",
    visibility: "internal",
  });
});
