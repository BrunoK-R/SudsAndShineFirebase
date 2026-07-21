const {HttpsError} = require("firebase-functions/v2/https");
const {buildServiceCatalog} = require("./serviceCatalog");
const {
  isPendingReservationStatus,
  isExpiredPendingReservation,
  reservationHoldsCapacity,
} = require("./createReservation");
const {timestampToIso} = require("./reservationHistory");

const ADMIN_PENDING_RESERVATION_LIMIT = 100;
const ADMIN_ACCEPTED_RESERVATION_LIMIT = 100;
const ADMIN_COMPLETABLE_RESERVATION_LIMIT = ADMIN_ACCEPTED_RESERVATION_LIMIT;
const MAX_REJECTION_REASON_LENGTH = 500;
const ACCEPTED_RESERVATION_STATUS_VALUES = [
  "confirmed",
  "confirmado",
  "in_progress",
  "em_execucao",
  "em execução",
];
const STARTABLE_RESERVATION_STATUS_VALUES = [
  "confirmed",
  "confirmado",
];
const COMPLETABLE_RESERVATION_STATUS_VALUES = [
  "in_progress",
  "em_execucao",
  "em execução",
];
const COMPLETED_RESERVATION_STATUS_VALUES = [
  "completed",
  "complete",
  "concluido",
  "concluído",
  "done",
];

function assertAdminRole(role) {
  if (role !== "admin") {
    throw new HttpsError("permission-denied", "Admin role required");
  }
}

function assertReservationId(value) {
  const reservationId = String(value || "").trim();
  if (!reservationId || reservationId.includes("/") || reservationId.length > 160) {
    throw new HttpsError("invalid-argument", "reservationId is required");
  }
  return reservationId;
}

function normalizeRejectionReason(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_REJECTION_REASON_LENGTH);
}

function validateAdminReservationActionInput(data = {}) {
  return {
    reservationId: assertReservationId(data.reservationId || data.id),
    rejectionReason: normalizeRejectionReason(data.reason || data.rejectionReason),
  };
}

function normalizeReservationStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function parseReservationSlotEnd(data) {
  const rawSlotEnd = String(data?.slotEnd || data?.endTime || data?.end_time || "").trim();
  if (!rawSlotEnd) return null;
  const slotEnd = new Date(rawSlotEnd);
  return Number.isNaN(slotEnd.getTime()) ? null : slotEnd;
}

function normalizeReservationExtras(data) {
  if (!Array.isArray(data.extras)) return [];

  return data.extras
    .map((extra) => {
      if (!extra || typeof extra !== "object") return null;
      const id = String(extra.id || "").trim();
      const name = String(extra.name || "").trim();
      const priceCents = Number(extra.priceCents);
      if (!id || !name || !Number.isFinite(priceCents)) return null;
      return {
        id,
        name,
        priceCents: Math.max(0, Math.round(priceCents)),
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function extrasPriceCentsForReservation(data) {
  const storedExtrasPriceCents = Number(data.extrasPriceCents);
  if (Number.isFinite(storedExtrasPriceCents)) {
    return Math.max(0, Math.round(storedExtrasPriceCents));
  }

  return normalizeReservationExtras(data).reduce((total, extra) => total + extra.priceCents, 0);
}

function priceCentsForReservation(data, servicesById) {
  const storedPriceCents = Number(data.priceCents);
  if (Number.isFinite(storedPriceCents)) {
    return Math.max(0, Math.round(storedPriceCents));
  }

  const service = servicesById.get(String(data.serviceId || "").trim());
  if (!service) return null;
  const servicePriceCents = data.vehicleType === "suv" ? service.suvPriceCents : service.passengerPriceCents;
  return servicePriceCents + extrasPriceCentsForReservation(data);
}

function reservationDecisionAudit(data) {
  return {
    acceptedAt: timestampToIso(data.acceptedAt),
    acceptedByUid: String(data.acceptedByUid || "").trim(),
    startedAt: timestampToIso(data.startedAt),
    startedByUid: String(data.startedByUid || "").trim(),
    rejectedAt: timestampToIso(data.rejectedAt),
    rejectedByUid: String(data.rejectedByUid || "").trim(),
    completedAt: timestampToIso(data.completedAt),
    completedByUid: String(data.completedByUid || "").trim(),
  };
}

function normalizeAdminPendingReservationDocument(doc, servicesById, now = new Date()) {
  if (!doc?.exists) return null;

  const data = doc.data();
  if (!data || typeof data !== "object") return null;
  if (!isPendingReservationStatus(data.status)) return null;
  if (!reservationHoldsCapacity(data, now)) return null;

  const slotStart = String(data.slotStart || "").trim();
  const slotEnd = String(data.slotEnd || "").trim();
  if (!slotStart || !slotEnd) return null;

  const serviceId = String(data.serviceId || "").trim();
  const serviceName = String(data.serviceName || "").trim() ||
    servicesById.get(serviceId)?.name ||
    "Serviço";
  const vehicleLabel = String(data.vehicleLabel || "").trim();

  return {
    id: doc.id,
    reservationCode: String(data.reservationCode || "").trim(),
    customerName: String(data.customerName || "").trim(),
    customerEmail: String(data.customerEmail || "").trim(),
    customerPhone: String(data.customerPhone || "").trim(),
    serviceId,
    serviceName,
    slotStart,
    slotEnd,
    status: String(data.status || "pending").trim().toLowerCase(),
    paymentStatus: String(data.paymentStatus || "pending").trim().toLowerCase(),
    vehicleType: String(data.vehicleType || "passageiros").trim(),
    vehicleLabel,
    priceCents: priceCentsForReservation(data, servicesById),
    extras: normalizeReservationExtras(data),
    notes: String(data.notes || "").trim(),
    createdAt: timestampToIso(data.createdAt),
    pendingExpiresAt: timestampToIso(data.pendingExpiresAt),
    loyaltyRewardApplied: data.loyaltyRewardApplied === true,
    ...reservationDecisionAudit(data),
  };
}

function normalizeAdminAcceptedReservationDocument(doc, servicesById, now = new Date()) {
  if (!doc?.exists) return null;

  const data = doc.data();
  if (!data || typeof data !== "object") return null;

  const status = normalizeReservationStatus(data.status);
  if (!ACCEPTED_RESERVATION_STATUS_VALUES.includes(status)) return null;

  const slotEndDate = parseReservationSlotEnd(data);
  if (!slotEndDate) return null;

  const slotStart = String(data.slotStart || "").trim();
  const slotEnd = String(data.slotEnd || "").trim();
  if (!slotStart || !slotEnd) return null;

  const serviceId = String(data.serviceId || "").trim();
  const serviceName = String(data.serviceName || "").trim() ||
    servicesById.get(serviceId)?.name ||
    "Serviço";
  const vehicleLabel = String(data.vehicleLabel || "").trim();

  return {
    id: doc.id,
    reservationCode: String(data.reservationCode || "").trim(),
    customerName: String(data.customerName || "").trim(),
    customerEmail: String(data.customerEmail || "").trim(),
    customerPhone: String(data.customerPhone || "").trim(),
    serviceId,
    serviceName,
    slotStart,
    slotEnd,
    status,
    paymentStatus: String(data.paymentStatus || "pending").trim().toLowerCase(),
    vehicleType: String(data.vehicleType || "passageiros").trim(),
    vehicleLabel,
    priceCents: priceCentsForReservation(data, servicesById),
    extras: normalizeReservationExtras(data),
    notes: String(data.notes || "").trim(),
    createdAt: timestampToIso(data.createdAt),
    pendingExpiresAt: timestampToIso(data.pendingExpiresAt),
    loyaltyRewardApplied: data.loyaltyRewardApplied === true,
    canStart: STARTABLE_RESERVATION_STATUS_VALUES.includes(status),
    canComplete: COMPLETABLE_RESERVATION_STATUS_VALUES.includes(status),
    ...reservationDecisionAudit(data),
  };
}

function buildAdminPendingReservations({
  reservationDocs,
  serviceDocs,
  now = new Date(),
  limit = ADMIN_PENDING_RESERVATION_LIMIT,
}) {
  const catalog = buildServiceCatalog(serviceDocs || []);
  const servicesById = new Map(catalog.services.map((service) => [service.id, service]));
  const requests = (reservationDocs || [])
    .map((doc) => normalizeAdminPendingReservationDocument(doc, servicesById, now))
    .filter(Boolean)
    .sort((left, right) => left.slotStart.localeCompare(right.slotStart))
    .slice(0, limit);

  return {requests};
}

function buildAdminAcceptedReservations({
  reservationDocs,
  serviceDocs,
  now = new Date(),
  limit = ADMIN_ACCEPTED_RESERVATION_LIMIT,
}) {
  const catalog = buildServiceCatalog(serviceDocs || []);
  const servicesById = new Map(catalog.services.map((service) => [service.id, service]));
  const requests = (reservationDocs || [])
    .map((doc) => normalizeAdminAcceptedReservationDocument(doc, servicesById, now))
    .filter(Boolean)
    .sort((left, right) => left.slotStart.localeCompare(right.slotStart))
    .slice(0, limit);

  return {requests};
}

function buildAdminCompletableReservations(options) {
  return buildAdminAcceptedReservations(options);
}

function normalizeAdminCompletableReservationDocument(doc, servicesById, now = new Date()) {
  return normalizeAdminAcceptedReservationDocument(doc, servicesById, now);
}

function assertPendingReservationActionable({reservationSnap, now = new Date()}) {
  if (!reservationSnap?.exists) {
    throw new HttpsError("not-found", "Reservation not found");
  }

  const data = reservationSnap.data() || {};
  if (!isPendingReservationStatus(data.status)) {
    throw new HttpsError("failed-precondition", "Reservation request is not pending");
  }
  if (!reservationHoldsCapacity(data, now)) {
    if (isExpiredPendingReservation(data, now)) {
      throw new HttpsError("failed-precondition", "Reservation request has expired");
    }
    throw new HttpsError("failed-precondition", "Reservation request is not pending");
  }

  return data;
}

function assertReservationStartable({reservationSnap}) {
  if (!reservationSnap?.exists) {
    throw new HttpsError("not-found", "Reservation not found");
  }

  const data = reservationSnap.data() || {};
  const status = normalizeReservationStatus(data.status);
  if (COMPLETED_RESERVATION_STATUS_VALUES.includes(status)) {
    throw new HttpsError("failed-precondition", "Reservation is already completed");
  }
  if (!STARTABLE_RESERVATION_STATUS_VALUES.includes(status)) {
    throw new HttpsError("failed-precondition", "Reservation status cannot be started");
  }

  return data;
}

function assertReservationCompletable({reservationSnap}) {
  if (!reservationSnap?.exists) {
    throw new HttpsError("not-found", "Reservation not found");
  }

  const data = reservationSnap.data() || {};
  const status = normalizeReservationStatus(data.status);
  if (COMPLETED_RESERVATION_STATUS_VALUES.includes(status)) {
    throw new HttpsError("failed-precondition", "Reservation is already completed");
  }
  if (!COMPLETABLE_RESERVATION_STATUS_VALUES.includes(status)) {
    throw new HttpsError("failed-precondition", "Reservation status cannot be completed");
  }

  return data;
}

function completionPaymentStatus(data = {}) {
  const priceCents = Number(data.priceCents);
  if (data.loyaltyRewardApplied === true && Number.isFinite(priceCents) && priceCents <= 0) {
    return "covered_by_loyalty";
  }
  return "paid";
}

function reservationEarnsLoyaltyStamp(data = {}) {
  const priceCents = Number(data.priceCents);
  return data.loyaltyRewardApplied !== true && Number.isFinite(priceCents) && priceCents > 0;
}

module.exports = {
  ACCEPTED_RESERVATION_STATUS_VALUES,
  ADMIN_ACCEPTED_RESERVATION_LIMIT,
  ADMIN_COMPLETABLE_RESERVATION_LIMIT,
  ADMIN_PENDING_RESERVATION_LIMIT,
  COMPLETABLE_RESERVATION_STATUS_VALUES,
  COMPLETED_RESERVATION_STATUS_VALUES,
  MAX_REJECTION_REASON_LENGTH,
  STARTABLE_RESERVATION_STATUS_VALUES,
  assertAdminRole,
  assertPendingReservationActionable,
  assertReservationCompletable,
  assertReservationStartable,
  assertReservationId,
  buildAdminAcceptedReservations,
  buildAdminCompletableReservations,
  buildAdminPendingReservations,
  normalizeAdminAcceptedReservationDocument,
  normalizeAdminCompletableReservationDocument,
  normalizeAdminPendingReservationDocument,
  normalizeRejectionReason,
  normalizeReservationStatus,
  parseReservationSlotEnd,
  completionPaymentStatus,
  reservationEarnsLoyaltyStamp,
  validateAdminReservationActionInput,
};
