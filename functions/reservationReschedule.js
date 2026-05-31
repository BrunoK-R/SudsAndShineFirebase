const {HttpsError} = require("firebase-functions/v2/https");

const RESCHEDULABLE_STATUS_VALUES = [
  "pending",
  "confirmed",
  "novo",
  "confirmado",
];
const CLOSED_STATUS_VALUES = [
  "cancelled",
  "canceled",
  "cancelado",
  "completed",
  "complete",
  "concluido",
  "concluído",
  "done",
  "in_progress",
  "em_execucao",
];

function normalizeStatus(value) {
  return String(value || "pending").trim().toLowerCase();
}

function parseIsoDateTime(value, fieldName) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpsError("invalid-argument", `${fieldName} must be a valid ISO date string`);
  }
  return parsed;
}

function validateRescheduleReservationInput(data) {
  const reservationId = String(data?.reservationId || data?.id || "").trim();
  if (!reservationId || reservationId.includes("/") || reservationId.length > 160) {
    throw new HttpsError("invalid-argument", "reservationId is required");
  }

  const slotStart = parseIsoDateTime(data?.slotStart, "slotStart");
  const slotEnd = parseIsoDateTime(data?.slotEnd, "slotEnd");
  if (slotEnd <= slotStart) {
    throw new HttpsError("invalid-argument", "slotEnd must be after slotStart");
  }

  return {
    reservationId,
    slotStart,
    slotEnd,
    dateKey: slotStart.toISOString().slice(0, 10),
  };
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

function assertReservationReschedulable({
  reservationSnap,
  uid,
  email,
  newSlotStart,
  newSlotEnd,
  now = new Date(),
  bookingPolicy = null,
}) {
  if (!reservationSnap?.exists) {
    throw new HttpsError("not-found", "Reservation not found");
  }

  const data = reservationSnap.data() || {};
  if (!isOwnedReservation(data, uid, email)) {
    throw new HttpsError("permission-denied", "Reservation does not belong to this user");
  }

  const status = normalizeStatus(data.status);
  if (!RESCHEDULABLE_STATUS_VALUES.includes(status) || CLOSED_STATUS_VALUES.includes(status)) {
    throw new HttpsError("failed-precondition", "Reservation status cannot be rescheduled");
  }

  const currentSlotStart = new Date(String(data.slotStart || ""));
  const currentSlotEnd = new Date(String(data.slotEnd || ""));
  if (Number.isNaN(currentSlotStart.getTime()) || Number.isNaN(currentSlotEnd.getTime())) {
    throw new HttpsError("failed-precondition", "Reservation time is invalid");
  }
  if (cutoffBlocksAction(currentSlotStart, now, bookingPolicy?.rescheduleWindowMinutes)) {
    throw new HttpsError("failed-precondition", "Reservation can no longer be rescheduled");
  }
  if (newSlotStart <= now) {
    throw new HttpsError("failed-precondition", "New reservation time must be in the future");
  }

  const currentDurationMs = currentSlotEnd.getTime() - currentSlotStart.getTime();
  const newDurationMs = newSlotEnd.getTime() - newSlotStart.getTime();
  if (currentDurationMs <= 0 || newDurationMs !== currentDurationMs) {
    throw new HttpsError("invalid-argument", "New reservation duration must match the existing service");
  }

  return {
    currentSlotStart,
    currentSlotEnd,
    previousStatus: status,
  };
}

function docsExcludingReservation(docs, reservationId) {
  return (docs || []).filter((docSnap) => docSnap.id !== reservationId);
}

module.exports = {
  assertReservationReschedulable,
  docsExcludingReservation,
  validateRescheduleReservationInput,
};
