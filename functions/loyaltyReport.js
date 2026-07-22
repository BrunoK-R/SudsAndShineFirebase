const {buildLoyaltyRewardCode} = require("./loyalty");

const COMPLETED_STATUSES = new Set(["completed", "complete", "done", "concluido", "concluído"]);
const RELEASED_STATUSES = new Set([
  "cancelled",
  "canceled",
  "cancelado",
  "rejected",
  "rejeitado",
  "expired",
  "expirado",
]);
const DEFAULT_RESERVATION_LIMIT = 2000;
const DEFAULT_EVENT_LIMIT = 200;

function cleanText(value, maxLength = 160) {
  if (value === undefined || value === null) return "";
  return String(value).trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function normalizeStatus(value) {
  return cleanText(value || "pending", 40).toLowerCase();
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
    const parsed = new Date(value.seconds * 1000);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }
  return "";
}

function firstTimestamp(data, keys) {
  for (const key of keys) {
    const value = timestampToIso(data?.[key]);
    if (value) return value;
  }
  return "";
}

function normalizeReservation(docSnap) {
  if (!docSnap) return null;
  const data = typeof docSnap.data === "function" ? docSnap.data() || {} : docSnap.data || docSnap;
  const id = cleanText(docSnap.id || data.id, 160);
  if (!id) return null;
  const customerUid = cleanText(data.customerUid, 128);
  const customerEmail = cleanText(data.customerEmail || data.email, 254).toLowerCase();
  const customerKey = customerUid || customerEmail;
  if (!customerKey) return null;

  return {
    id,
    reservationCode: cleanText(data.reservationCode, 80),
    status: normalizeStatus(data.status),
    customerKey,
    customerUid,
    customerName: cleanText(data.customerName || data.name || "Cliente", 160),
    customerEmail,
    serviceName: cleanText(data.serviceName || "Lavagem", 160),
    slotStart: firstTimestamp(data, ["slotStart", "createdAt"]),
    completedAt: firstTimestamp(data, ["completedAt", "slotEnd", "updatedAt", "slotStart"]),
    updatedAt: firstTimestamp(data, ["updatedAt", "completedAt", "createdAt", "slotStart"]),
    loyaltyRewardApplied: data.loyaltyRewardApplied === true,
    loyaltyRewardCode: cleanText(data.loyaltyRewardCode, 80),
    loyaltyRewardDescription: cleanText(data.loyaltyRewardDescription, 200),
    loyaltyStampGranted: typeof data.loyaltyStampGranted === "boolean" ? data.loyaltyStampGranted : null,
    priceCents: Number(data.priceCents),
  };
}

function reservationEarnedStamp(reservation) {
  if (!COMPLETED_STATUSES.has(reservation.status)) return false;
  if (reservation.loyaltyRewardApplied || reservation.loyaltyStampGranted === false) return false;
  if (reservation.loyaltyStampGranted === true) return true;
  return Number.isFinite(reservation.priceCents) && reservation.priceCents > 0;
}

function rewardEventKind(reservation) {
  if (!reservation.loyaltyRewardApplied) return "";
  if (COMPLETED_STATUSES.has(reservation.status)) return "reward_redeemed";
  if (RELEASED_STATUSES.has(reservation.status)) return "reward_released";
  return "reward_reserved";
}

function baseEvent(reservation, kind, occurredAt) {
  return {
    id: `${kind}:${reservation.id}`,
    kind,
    occurredAt,
    customerUid: reservation.customerUid,
    customerName: reservation.customerName,
    customerEmail: reservation.customerEmail,
    reservationId: reservation.id,
    reservationCode: reservation.reservationCode,
    serviceName: reservation.serviceName,
    rewardCode: reservation.loyaltyRewardCode,
    rewardDescription: reservation.loyaltyRewardDescription,
    status: reservation.status,
    stampPosition: 0,
    stampsRequired: 0,
    rewardNumber: 0,
  };
}

function buildAdminLoyaltyReport({
  reservationDocs = [],
  loyaltySettings = {},
  reservationLimit = DEFAULT_RESERVATION_LIMIT,
  eventLimit = DEFAULT_EVENT_LIMIT,
} = {}) {
  const stampsRequiredValue = Number(loyaltySettings?.stampsRequired);
  const stampsRequired = Number.isInteger(stampsRequiredValue) && stampsRequiredValue > 0 ?
    Math.min(50, stampsRequiredValue) :
    10;
  const reservations = (reservationDocs || [])
    .map(normalizeReservation)
    .filter(Boolean)
    .sort((left, right) => {
      const timeOrder = left.slotStart.localeCompare(right.slotStart);
      return timeOrder === 0 ? left.id.localeCompare(right.id) : timeOrder;
    });
  const stampCountByCustomer = new Map();
  const customerKeys = new Set();
  const events = [];
  let qualifyingWashes = 0;
  let rewardsEarned = 0;
  let rewardsRedeemed = 0;
  let rewardsReserved = 0;
  let rewardsReleased = 0;

  for (const reservation of reservations) {
    if (reservationEarnedStamp(reservation)) {
      customerKeys.add(reservation.customerKey);
      qualifyingWashes += 1;
      const customerStampCount = (stampCountByCustomer.get(reservation.customerKey) || 0) + 1;
      stampCountByCustomer.set(reservation.customerKey, customerStampCount);
      const stampPosition = ((customerStampCount - 1) % stampsRequired) + 1;
      events.push({
        ...baseEvent(reservation, "stamp_granted", reservation.completedAt || reservation.slotStart),
        stampPosition,
        stampsRequired,
      });
      if (stampPosition === stampsRequired) {
        rewardsEarned += 1;
        const rewardNumber = Math.floor(customerStampCount / stampsRequired);
        events.push({
          ...baseEvent(reservation, "reward_earned", reservation.completedAt || reservation.slotStart),
          rewardCode: reservation.customerUid ? buildLoyaltyRewardCode(reservation.customerUid, rewardNumber) : "",
          rewardNumber,
          stampPosition,
          stampsRequired,
        });
      }
    }

    const kind = rewardEventKind(reservation);
    if (!kind) continue;
    customerKeys.add(reservation.customerKey);
    if (kind === "reward_redeemed") rewardsRedeemed += 1;
    if (kind === "reward_reserved") rewardsReserved += 1;
    if (kind === "reward_released") rewardsReleased += 1;
    events.push(baseEvent(reservation, kind, reservation.completedAt || reservation.updatedAt || reservation.slotStart));
  }

  const recentEvents = events
    .filter((event) => event.occurredAt)
    .sort((left, right) => {
      const timeOrder = right.occurredAt.localeCompare(left.occurredAt);
      return timeOrder === 0 ? right.id.localeCompare(left.id) : timeOrder;
    })
    .slice(0, Math.max(1, eventLimit));
  const occurredTimes = events.map((event) => event.occurredAt).filter(Boolean).sort();

  return {
    source: reservations.length > 0 ? "reservations" : "empty",
    summary: {
      stampsRequired,
      qualifyingWashes,
      rewardsEarned,
      rewardsRedeemed,
      rewardsReserved,
      rewardsReleased,
      estimatedAvailableRewards: Math.max(0, rewardsEarned - rewardsRedeemed - rewardsReserved),
      activeCustomers: customerKeys.size,
      reservationsScanned: reservations.length,
      truncated: reservationDocs.length >= reservationLimit,
      periodStart: occurredTimes[0] || "",
      periodEnd: occurredTimes[occurredTimes.length - 1] || "",
    },
    events: recentEvents,
  };
}

module.exports = {
  DEFAULT_EVENT_LIMIT,
  DEFAULT_RESERVATION_LIMIT,
  buildAdminLoyaltyReport,
  normalizeReservation,
  reservationEarnedStamp,
  rewardEventKind,
};
