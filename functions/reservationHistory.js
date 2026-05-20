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
];

function normalizeStatus(value) {
  return String(value || "pending").trim().toLowerCase();
}

function isCompletedReservation(status, slotEnd, now) {
  const normalizedStatus = normalizeStatus(status);
  if (COMPLETED_STATUS_VALUES.includes(normalizedStatus)) return true;

  const parsedEnd = new Date(slotEnd);
  if (Number.isNaN(parsedEnd.getTime())) return false;
  return parsedEnd < now;
}

function priceCentsForReservation(data, servicesById) {
  const service = servicesById.get(String(data.serviceId || "").trim());
  if (!service) return null;
  return data.vehicleType === "suv" ? service.suvPriceCents : service.passengerPriceCents;
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

  return {
    reservationId,
    reviewRating,
    reviewTags,
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
    vehicleType: String(data.vehicleType || "passageiros").trim(),
    vehicleLabel: String(data.vehicleLabel || "").trim(),
    priceCents: priceCentsForReservation(data, servicesById),
    upcoming: !completed,
    reviewed: review !== null,
    reviewRating: review?.reviewRating || null,
    reviewTags: review?.reviewTags || [],
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
};
