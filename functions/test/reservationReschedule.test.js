const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertReservationReschedulable,
  docsExcludingReservation,
  validateRescheduleReservationInput,
} = require("../reservationReschedule");

function doc(id, data, exists = true) {
  return {
    id,
    exists,
    data: () => data,
  };
}

test("validateRescheduleReservationInput sanitizes valid reservation changes", () => {
  const parsed = validateRescheduleReservationInput({
    reservationId: " reservation-1 ",
    slotStart: "2026-05-22T10:00:00.000Z",
    slotEnd: "2026-05-22T10:45:00.000Z",
  });

  assert.equal(parsed.reservationId, "reservation-1");
  assert.equal(parsed.dateKey, "2026-05-22");
  assert.equal(parsed.slotStart.toISOString(), "2026-05-22T10:00:00.000Z");
  assert.equal(parsed.slotEnd.toISOString(), "2026-05-22T10:45:00.000Z");
});

test("validateRescheduleReservationInput rejects path ids and invalid ranges", () => {
  assert.throws(() => {
    validateRescheduleReservationInput({
      reservationId: "reservations/other",
      slotStart: "2026-05-22T10:00:00.000Z",
      slotEnd: "2026-05-22T10:45:00.000Z",
    });
  }, /reservationId is required/);

  assert.throws(() => {
    validateRescheduleReservationInput({
      reservationId: "reservation-1",
      slotStart: "2026-05-22T10:45:00.000Z",
      slotEnd: "2026-05-22T10:00:00.000Z",
    });
  }, /slotEnd must be after slotStart/);
});

test("assertReservationReschedulable allows owned future pending reservation with same duration", () => {
  const result = assertReservationReschedulable({
    reservationSnap: doc("reservation-1", {
      customerUid: "uid-1",
      customerEmail: "other@example.com",
      slotStart: "2026-05-21T10:00:00.000Z",
      slotEnd: "2026-05-21T10:45:00.000Z",
      status: "pending",
    }),
    uid: "uid-1",
    email: "bruno@example.com",
    newSlotStart: new Date("2026-05-22T11:00:00.000Z"),
    newSlotEnd: new Date("2026-05-22T11:45:00.000Z"),
    now: new Date("2026-05-20T10:00:00.000Z"),
  });

  assert.equal(result.previousStatus, "pending");
  assert.equal(result.currentSlotStart.toISOString(), "2026-05-21T10:00:00.000Z");
});

test("assertReservationReschedulable honors configured reschedule cutoff", () => {
  assert.throws(() => {
    assertReservationReschedulable({
      reservationSnap: doc("reservation-1", {
        customerUid: "uid-1",
        slotStart: "2026-05-20T11:30:00.000Z",
        slotEnd: "2026-05-20T12:15:00.000Z",
        status: "pending",
      }),
      uid: "uid-1",
      email: "bruno@example.com",
      newSlotStart: new Date("2026-05-22T11:00:00.000Z"),
      newSlotEnd: new Date("2026-05-22T11:45:00.000Z"),
      now: new Date("2026-05-20T10:00:00.000Z"),
      bookingPolicy: {rescheduleWindowMinutes: 120},
    });
  }, /Reservation can no longer be rescheduled/);
});

test("assertReservationReschedulable rejects foreign past closed and duration-mutating updates", () => {
  const now = new Date("2026-05-20T10:00:00.000Z");

  assert.throws(() => {
    assertReservationReschedulable({
      reservationSnap: doc("reservation-1", {
        customerUid: "other",
        customerEmail: "other@example.com",
        slotStart: "2026-05-21T10:00:00.000Z",
        slotEnd: "2026-05-21T10:45:00.000Z",
        status: "pending",
      }),
      uid: "uid-1",
      email: "bruno@example.com",
      newSlotStart: new Date("2026-05-22T11:00:00.000Z"),
      newSlotEnd: new Date("2026-05-22T11:45:00.000Z"),
      now,
    });
  }, /Reservation does not belong to this user/);

  assert.throws(() => {
    assertReservationReschedulable({
      reservationSnap: doc("reservation-1", {
        customerUid: "uid-1",
        slotStart: "2026-05-19T10:00:00.000Z",
        slotEnd: "2026-05-19T10:45:00.000Z",
        status: "pending",
      }),
      uid: "uid-1",
      email: "bruno@example.com",
      newSlotStart: new Date("2026-05-22T11:00:00.000Z"),
      newSlotEnd: new Date("2026-05-22T11:45:00.000Z"),
      now,
    });
  }, /Reservation can no longer be rescheduled/);

  assert.throws(() => {
    assertReservationReschedulable({
      reservationSnap: doc("reservation-1", {
        customerUid: "uid-1",
        slotStart: "2026-05-21T10:00:00.000Z",
        slotEnd: "2026-05-21T10:45:00.000Z",
        status: "in_progress",
      }),
      uid: "uid-1",
      email: "bruno@example.com",
      newSlotStart: new Date("2026-05-22T11:00:00.000Z"),
      newSlotEnd: new Date("2026-05-22T11:45:00.000Z"),
      now,
    });
  }, /Reservation status cannot be rescheduled/);

  assert.throws(() => {
    assertReservationReschedulable({
      reservationSnap: doc("reservation-1", {
        customerUid: "uid-1",
        slotStart: "2026-05-21T10:00:00.000Z",
        slotEnd: "2026-05-21T10:45:00.000Z",
        status: "confirmed",
      }),
      uid: "uid-1",
      email: "bruno@example.com",
      newSlotStart: new Date("2026-05-22T11:00:00.000Z"),
      newSlotEnd: new Date("2026-05-22T12:00:00.000Z"),
      now,
    });
  }, /duration must match/);
});

test("docsExcludingReservation removes the current reservation from capacity checks", () => {
  const docs = [
    doc("reservation-1", {slotStart: "2026-05-22T10:00:00.000Z"}),
    doc("reservation-2", {slotStart: "2026-05-22T10:00:00.000Z"}),
  ];

  assert.deepEqual(
    docsExcludingReservation(docs, "reservation-1").map((item) => item.id),
    ["reservation-2"],
  );
});
