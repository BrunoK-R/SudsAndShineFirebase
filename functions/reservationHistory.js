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

function normalizeReservationDocument(doc, servicesById, now) {
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
  };
}

function buildUserReservationHistory({reservationDocs, serviceDocs, now = new Date()}) {
  const catalog = buildServiceCatalog(serviceDocs || []);
  const servicesById = new Map(catalog.services.map((service) => [service.id, service]));
  const reservations = (reservationDocs || [])
    .map((doc) => normalizeReservationDocument(doc, servicesById, now))
    .filter(Boolean)
    .sort((left, right) => right.slotStart.localeCompare(left.slotStart))
    .slice(0, USER_RESERVATION_LIMIT);

  return {reservations};
}

module.exports = {
  buildUserReservationHistory,
  normalizeReservationDocument,
};
