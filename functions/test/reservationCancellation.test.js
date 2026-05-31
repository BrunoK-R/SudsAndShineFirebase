const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertReservationCancelable,
  assertReservationId,
} = require("../reservationCancellation");

function doc(data, exists = true) {
  return {
    exists,
    data: () => data,
  };
}

test("assertReservationId sanitizes valid reservation ids", () => {
  assert.equal(assertReservationId(" reservation-1 "), "reservation-1");
});

test("assertReservationId rejects missing path-like ids", () => {
  assert.throws(() => {
    assertReservationId("reservations/other");
  }, /reservationId is required/);
});

test("assertReservationCancelable allows owned future reservations by uid or email", () => {
  const now = new Date("2026-05-20T10:00:00.000Z");

  assert.deepEqual(
    assertReservationCancelable({
      reservationSnap: doc({
        customerUid: "uid-1",
        customerEmail: "other@example.com",
        slotStart: "2026-05-21T10:00:00.000Z",
        status: "pending",
      }),
      uid: "uid-1",
      email: "bruno@example.com",
      now,
    }),
    {alreadyCancelled: false, status: "pending"},
  );

  assert.deepEqual(
    assertReservationCancelable({
      reservationSnap: doc({
        customerEmail: "bruno@example.com",
        slotStart: "2026-05-21T10:00:00.000Z",
        status: "confirmado",
      }),
      uid: "uid-2",
      email: "bruno@example.com",
      now,
    }),
    {alreadyCancelled: false, status: "confirmado"},
  );
});

test("assertReservationCancelable treats already cancelled owned reservations as idempotent", () => {
  const result = assertReservationCancelable({
    reservationSnap: doc({
      customerUid: "uid-1",
      slotStart: "2026-05-21T10:00:00.000Z",
      status: "cancelado",
    }),
    uid: "uid-1",
    email: "bruno@example.com",
    now: new Date("2026-05-20T10:00:00.000Z"),
  });

  assert.deepEqual(result, {alreadyCancelled: true, status: "cancelled"});
});

test("assertReservationCancelable honors configured cancellation cutoff", () => {
  const now = new Date("2026-05-20T10:00:00.000Z");

  assert.throws(() => {
    assertReservationCancelable({
      reservationSnap: doc({
        customerUid: "uid-1",
        slotStart: "2026-05-20T11:30:00.000Z",
        status: "pending",
      }),
      uid: "uid-1",
      email: "bruno@example.com",
      now,
      bookingPolicy: {cancellationWindowMinutes: 120},
    });
  }, /Reservation can no longer be cancelled/);

  assert.deepEqual(
    assertReservationCancelable({
      reservationSnap: doc({
        customerUid: "uid-1",
        slotStart: "2026-05-20T12:01:00.000Z",
        status: "pending",
      }),
      uid: "uid-1",
      email: "bruno@example.com",
      now,
      bookingPolicy: {cancellationWindowMinutes: 120},
    }),
    {alreadyCancelled: false, status: "pending"},
  );
});

test("assertReservationCancelable rejects foreign past and closed reservations", () => {
  const now = new Date("2026-05-20T10:00:00.000Z");

  assert.throws(() => {
    assertReservationCancelable({
      reservationSnap: doc({
        customerUid: "other",
        customerEmail: "other@example.com",
        slotStart: "2026-05-21T10:00:00.000Z",
        status: "pending",
      }),
      uid: "uid-1",
      email: "bruno@example.com",
      now,
    });
  }, /Reservation does not belong to this user/);

  assert.throws(() => {
    assertReservationCancelable({
      reservationSnap: doc({
        customerUid: "uid-1",
        slotStart: "2026-05-19T10:00:00.000Z",
        status: "pending",
      }),
      uid: "uid-1",
      email: "bruno@example.com",
      now,
    });
  }, /Reservation can no longer be cancelled/);

  assert.throws(() => {
    assertReservationCancelable({
      reservationSnap: doc({
        customerUid: "uid-1",
        slotStart: "2026-05-21T10:00:00.000Z",
        status: "in_progress",
      }),
      uid: "uid-1",
      email: "bruno@example.com",
      now,
    });
  }, /Reservation status cannot be cancelled/);
});
