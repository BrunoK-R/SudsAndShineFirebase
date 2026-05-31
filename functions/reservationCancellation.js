const {HttpsError} = require("firebase-functions/v2/https");

const CANCELLABLE_STATUS_VALUES = [
  "pending",
  "confirmed",
  "novo",
  "confirmado",
];
const CANCELLED_STATUS_VALUES = [
  "cancelled",
  "canceled",
  "cancelado",
];
const CLOSED_STATUS_VALUES = [
  ...CANCELLED_STATUS_VALUES,
  "completed",
  "complete",
  "concluido",
  "concluído",
  "done",
  "in_progress",
  "em_execucao",
];

function assertReservationId(value) {
  const reservationId = String(value || "").trim();
  if (!reservationId || reservationId.includes("/") || reservationId.length > 160) {
    throw new HttpsError("invalid-argument", "reservationId is required");
  }
  return reservationId;
}

function normalizeStatus(value) {
  return String(value || "pending").trim().toLowerCase();
}

function isOwnedReservation(data, uid, email) {
  const customerUid = String(data.customerUid || "").trim();
  const customerEmail = String(data.customerEmail || "").trim().toLowerCase();

  return Boolean(customerUid && customerUid === uid) ||
    Boolean(email && customerEmail && customerEmail === email);
}

function cutoffBlocksAction(slotStart, now, cutoffMinutes) {
  const minutes = Number.isInteger(cutoffMinutes) ? cutoffMinutes : 0;
  if (minutes <= 0) return slotStart <= now;
  return slotStart.getTime() - now.getTime() <= minutes * 60 * 1000;
}

function assertReservationCancelable({reservationSnap, uid, email, now = new Date(), bookingPolicy = null}) {
  if (!reservationSnap?.exists) {
    throw new HttpsError("not-found", "Reservation not found");
  }

  const data = reservationSnap.data() || {};
  if (!isOwnedReservation(data, uid, email)) {
    throw new HttpsError("permission-denied", "Reservation does not belong to this user");
  }

  const status = normalizeStatus(data.status);
  if (CANCELLED_STATUS_VALUES.includes(status)) {
    return {
      alreadyCancelled: true,
      status: "cancelled",
    };
  }

  const slotStart = new Date(String(data.slotStart || ""));
  if (Number.isNaN(slotStart.getTime())) {
    throw new HttpsError("failed-precondition", "Reservation start time is invalid");
  }
  if (cutoffBlocksAction(slotStart, now, bookingPolicy?.cancellationWindowMinutes)) {
    throw new HttpsError("failed-precondition", "Reservation can no longer be cancelled");
  }

  if (!CANCELLABLE_STATUS_VALUES.includes(status) || CLOSED_STATUS_VALUES.includes(status)) {
    throw new HttpsError("failed-precondition", "Reservation status cannot be cancelled");
  }

  return {
    alreadyCancelled: false,
    status,
  };
}

module.exports = {
  assertReservationCancelable,
  assertReservationId,
};
