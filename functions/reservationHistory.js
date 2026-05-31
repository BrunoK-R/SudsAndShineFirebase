const {buildServiceCatalog} = require("./serviceCatalog");

const USER_RESERVATION_LIMIT = 50;
const COMPLETED_STATUS_VALUES = [
  "completed",
  "concluido",
  "concluído",
  "complete",
  "done",
  "cancelled",
  "canceled",
  "cancelado",
  "rejected",
  "rejeitado",
  "expired",
  "expirado",
];

function normalizeStatus(value) {
  return String(value || "pending").trim().toLowerCase();
}

function normalizePaymentStatus(value) {
  const normalized = String(value || "pending")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");

  switch (normalized) {
    case "paid":
    case "pago":
    case "succeeded":
    case "complete":
    case "completed":
      return "paid";
    case "covered_by_loyalty":
    case "loyalty":
    case "reward":
    case "recompensa":
      return "covered_by_loyalty";
    case "failed":
    case "declined":
    case "falhou":
      return "failed";
    case "refunded":
    case "refund":
    case "reembolsado":
      return "refunded";
    case "pending":
    case "unpaid":
    case "waiting_for_payment":
    case "awaiting_payment":
    case "pendente":
    default:
      return "pending";
  }
}

function timestampToIso(value) {
  if (!value) return "";

  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }

  if (typeof value.toDate === "function") {
    const parsed = value.toDate();
    return parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : "";
  }

  if (Number.isFinite(value.seconds)) {
    const nanoseconds = Number.isFinite(value.nanoseconds) ? value.nanoseconds : 0;
    const parsed = new Date(value.seconds * 1000 + Math.floor(nanoseconds / 1000000));
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }

  return "";
}

function normalizeRescheduleCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed));
}

function isCompletedReservation(status, slotEnd, now) {
  const normalizedStatus = normalizeStatus(status);
  if (COMPLETED_STATUS_VALUES.includes(normalizedStatus)) return true;

  const parsedEnd = new Date(slotEnd);
  if (Number.isNaN(parsedEnd.getTime())) return false;
  return parsedEnd < now;
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

function normalizeReviewDocument(doc) {
  if (!doc?.exists) return null;

  const data = doc.data();
  if (!data || typeof data !== "object") return null;

  const reservationId = String(data.reservationId || "").trim();
  if (!reservationId) return null;

  const rating = Number(data.rating);
  const reviewRating = Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
  const reviewTags = Array.isArray(data.tags) ?
    data.tags
      .map((tag) => String(tag || "").trim())
      .filter(Boolean)
      .slice(0, 8) :
    [];
  const reviewComment = String(data.comment || "")
    .trim()
    .slice(0, 1000);

  return {
    reservationId,
    reviewRating,
    reviewTags,
    reviewComment,
  };
}

function normalizeReservationDocument(doc, servicesById, reviewsByReservationId, now) {
  const data = doc.data();
  if (!data || typeof data !== "object") return null;

  const slotStart = String(data.slotStart || "").trim();
  const slotEnd = String(data.slotEnd || "").trim();
  if (!slotStart || !slotEnd) return null;

  const parsedStart = new Date(slotStart);
  const parsedEnd = new Date(slotEnd);
  if (Number.isNaN(parsedStart.getTime()) || Number.isNaN(parsedEnd.getTime())) return null;

  const serviceId = String(data.serviceId || "").trim();
  const serviceName = String(data.serviceName || "").trim() ||
    servicesById.get(serviceId)?.name ||
    "Serviço";
  const status = normalizeStatus(data.status);
  const completed = isCompletedReservation(status, slotEnd, now);
  const review = reviewsByReservationId.get(doc.id) || null;

  return {
    id: doc.id,
    reservationCode: String(data.reservationCode || "").trim(),
    serviceId,
    serviceName,
    slotStart,
    slotEnd,
    status,
    paymentStatus: normalizePaymentStatus(data.paymentStatus),
    vehicleType: String(data.vehicleType || "passageiros").trim(),
    vehicleLabel: String(data.vehicleLabel || "").trim(),
    priceCents: priceCentsForReservation(data, servicesById),
    extras: normalizeReservationExtras(data),
    upcoming: !completed,
    reviewed: review !== null,
    reviewRating: review?.reviewRating || null,
    reviewTags: review?.reviewTags || [],
    reviewComment: review?.reviewComment || "",
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
    cancelledAt: timestampToIso(data.cancelledAt) || null,
    rejectedAt: timestampToIso(data.rejectedAt) || null,
    rejectionReason: String(data.rejectionReason || "").trim(),
    acceptedAt: timestampToIso(data.acceptedAt) || null,
    pendingExpiresAt: timestampToIso(data.pendingExpiresAt) || null,
    rescheduledAt: timestampToIso(data.rescheduledAt) || null,
    previousSlotStart: String(data.previousSlotStart || "").trim() || null,
    previousSlotEnd: String(data.previousSlotEnd || "").trim() || null,
    rescheduleCount: normalizeRescheduleCount(data.rescheduleCount),
  };
}

function buildUserReservationHistory({reservationDocs, serviceDocs, reviewDocs = [], loyalty = null, now = new Date()}) {
  const catalog = buildServiceCatalog(serviceDocs || []);
  const servicesById = new Map(catalog.services.map((service) => [service.id, service]));
  const reviewsByReservationId = new Map(
    (reviewDocs || [])
      .map((doc) => normalizeReviewDocument(doc))
      .filter(Boolean)
      .map((review) => [review.reservationId, review]),
  );
  const reservations = (reservationDocs || [])
    .map((doc) => normalizeReservationDocument(doc, servicesById, reviewsByReservationId, now))
    .filter(Boolean)
    .sort((left, right) => right.slotStart.localeCompare(left.slotStart))
    .slice(0, USER_RESERVATION_LIMIT);

  const result = {reservations};
  if (loyalty) {
    result.loyalty = loyalty;
  }
  return result;
}

module.exports = {
  buildUserReservationHistory,
  normalizeReservationDocument,
  normalizeReviewDocument,
  normalizePaymentStatus,
  timestampToIso,
};
