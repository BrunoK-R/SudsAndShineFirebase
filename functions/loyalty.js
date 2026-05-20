const DEFAULT_REWARD_INTERVAL = 10;
const USER_REDEMPTION_LIMIT = 100;

const CANCELLED_STATUS_VALUES = [
  "cancelled",
  "canceled",
  "cancelado",
];

const COMPLETED_STATUS_VALUES = [
  "completed",
  "concluido",
  "concluído",
  "complete",
  "done",
];

const ACTIVE_REDEMPTION_STATUS_VALUES = [
  "issued",
  "redeemed",
  "reserved",
];

function normalizeStatus(value, fallback = "pending") {
  return String(value || fallback).trim().toLowerCase();
}

function isCancelledStatus(status) {
  return CANCELLED_STATUS_VALUES.includes(normalizeStatus(status));
}

function isCompletedLoyaltyWash(data, now) {
  const status = normalizeStatus(data.status);
  if (isCancelledStatus(status)) return false;
  if (COMPLETED_STATUS_VALUES.includes(status)) return true;

  const parsedEnd = new Date(data.slotEnd);
  if (Number.isNaN(parsedEnd.getTime())) return false;
  return parsedEnd < now;
}

function normalizeLoyaltyReservationDocument(doc, now) {
  if (!doc?.exists) return null;

  const data = doc.data();
  if (!data || typeof data !== "object") return null;
  if (!isCompletedLoyaltyWash(data, now)) return null;

  const slotStart = String(data.slotStart || "").trim();
  const slotEnd = String(data.slotEnd || "").trim();
  if (!slotStart || !slotEnd) return null;

  return {
    id: doc.id,
    serviceId: String(data.serviceId || "").trim(),
    serviceName: String(data.serviceName || "").trim() || "Lavagem",
    slotStart,
    slotEnd,
    points: 1,
  };
}

function normalizeRedemptionDocument(doc) {
  if (!doc?.exists) return null;

  const data = doc.data();
  if (!data || typeof data !== "object") return null;

  const status = normalizeStatus(data.status, "issued");
  const rewardNumber = Number(data.rewardNumber);

  return {
    id: doc.id,
    rewardCode: String(data.rewardCode || "").trim(),
    rewardNumber: Number.isInteger(rewardNumber) && rewardNumber > 0 ? rewardNumber : null,
    status,
    createdAt: timestampToIsoString(data.createdAt),
  };
}

function timestampToIsoString(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return "";
}

function buildLoyaltyRewardCode(uid, rewardNumber) {
  const suffix = String(uid || "user")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-4)
    .toUpperCase()
    .padStart(4, "X");
  const sequence = String(rewardNumber).padStart(4, "0");
  return `SS-FREE-${suffix}-${sequence}`;
}

function buildUserLoyalty({
  reservationDocs,
  redemptionDocs = [],
  now = new Date(),
  rewardInterval = DEFAULT_REWARD_INTERVAL,
}) {
  const targetWashes = Math.max(1, Number(rewardInterval) || DEFAULT_REWARD_INTERVAL);
  const stampHistory = (reservationDocs || [])
    .map((doc) => normalizeLoyaltyReservationDocument(doc, now))
    .filter(Boolean)
    .sort((left, right) => right.slotStart.localeCompare(left.slotStart));

  const redemptions = (redemptionDocs || [])
    .map((doc) => normalizeRedemptionDocument(doc))
    .filter(Boolean)
    .sort((left, right) => right.rewardNumber - left.rewardNumber)
    .slice(0, USER_REDEMPTION_LIMIT);

  const totalWashes = stampHistory.length;
  const completedRewards = Math.floor(totalWashes / targetWashes);
  const claimedRewards = redemptions.filter((redemption) =>
    ACTIVE_REDEMPTION_STATUS_VALUES.includes(redemption.status),
  ).length;
  const availableRewards = Math.max(0, completedRewards - claimedRewards);
  const cycleWashes = totalWashes % targetWashes;
  const currentWashes = availableRewards > 0 ? targetWashes : cycleWashes;
  const remainingWashes = availableRewards > 0 ? 0 : targetWashes - currentWashes;

  return {
    totalWashes,
    currentWashes,
    targetWashes,
    remainingWashes,
    progress: currentWashes / targetWashes,
    rewardReady: availableRewards > 0,
    completedRewards,
    claimedRewards,
    availableRewards,
    stampHistory,
    redemptions,
  };
}

module.exports = {
  ACTIVE_REDEMPTION_STATUS_VALUES,
  DEFAULT_REWARD_INTERVAL,
  buildLoyaltyRewardCode,
  buildUserLoyalty,
  isCompletedLoyaltyWash,
  normalizeLoyaltyReservationDocument,
  normalizeRedemptionDocument,
};
