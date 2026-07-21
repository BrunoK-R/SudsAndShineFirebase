const {HttpsError} = require("firebase-functions/v2/https");

const DEFAULT_REWARD_INTERVAL = 10;
const DEFAULT_LOYALTY_SETTINGS = {
  stampsRequired: DEFAULT_REWARD_INTERVAL,
  rewardType: "free_wash",
  rewardValue: 1,
  rewardDescription: "1 lavagem grátis",
  rewardValueCents: 0,
  rewardLabel: "Lavagem grátis",
  rewardTerms: "A recompensa cobre o serviço base; extras são pagos à parte.",
};
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

const REDEEMABLE_REDEMPTION_STATUS_VALUES = [
  "issued",
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
  if (!COMPLETED_STATUS_VALUES.includes(status)) return false;
  if (data.loyaltyRewardApplied === true || data.loyaltyStampGranted === false) return false;
  if (data.loyaltyStampGranted === true) return true;

  // Historical completed reservations predate explicit stamp/payment audit
  // fields. Preserve positive-price washes; all new completions set the stamp
  // decision explicitly.
  const priceCents = Number(data.priceCents);
  return Number.isFinite(priceCents) && priceCents > 0;
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
    rewardType: normalizeRewardType(data.rewardType || data.reward_type),
    rewardValue: normalizeRewardValue(data.rewardValue ?? data.reward_value),
    rewardDescription: normalizeRewardDescription(data.rewardDescription || data.reward_description),
    rewardValueCents: normalizeRewardValueCents(data.rewardValueCents ?? data.reward_value_cents),
    rewardLabel: normalizeRewardLabel(data.rewardLabel || data.reward_label),
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

function normalizeRewardCodeInput(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase()
    .slice(0, 80);
}

function normalizeRewardType(value) {
  return String(value || DEFAULT_LOYALTY_SETTINGS.rewardType)
    .trim()
    .toLowerCase()
    .replace(/-/g, "_") || DEFAULT_LOYALTY_SETTINGS.rewardType;
}

function normalizeRewardValueCents(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LOYALTY_SETTINGS.rewardValueCents;
  return Math.max(0, Math.min(100000, Math.floor(parsed)));
}

function normalizeRewardValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LOYALTY_SETTINGS.rewardValue;
  return Math.max(1, Math.min(100000, Math.floor(parsed)));
}

function normalizeRewardLabel(value) {
  return String(value || DEFAULT_LOYALTY_SETTINGS.rewardLabel)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120) || DEFAULT_LOYALTY_SETTINGS.rewardLabel;
}

function normalizeRewardDescription(value) {
  return String(value || DEFAULT_LOYALTY_SETTINGS.rewardDescription)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 200) || DEFAULT_LOYALTY_SETTINGS.rewardDescription;
}

function assertRedeemableLoyaltyRedemption(redemptionSnap, uid) {
  if (!redemptionSnap?.exists) {
    throw new HttpsError("failed-precondition", "Loyalty reward is not available");
  }

  const data = redemptionSnap.data();
  if (!data || typeof data !== "object") {
    throw new HttpsError("failed-precondition", "Loyalty reward is not available");
  }

  const ownerUid = String(data.ownerUid || "").trim();
  if (ownerUid && ownerUid !== uid) {
    throw new HttpsError("permission-denied", "Loyalty reward belongs to another user");
  }

  const status = normalizeStatus(data.status, "issued");
  if (!REDEEMABLE_REDEMPTION_STATUS_VALUES.includes(status)) {
    throw new HttpsError("failed-precondition", "Loyalty reward has already been used");
  }

  const rewardCode = normalizeRewardCodeInput(data.rewardCode);
  if (!rewardCode) {
    throw new HttpsError("failed-precondition", "Loyalty reward code is missing");
  }

  const rewardNumber = Number(data.rewardNumber);
  return {
    id: redemptionSnap.id,
    ref: redemptionSnap.ref,
    rewardCode,
    rewardNumber: Number.isInteger(rewardNumber) && rewardNumber > 0 ? rewardNumber : null,
    status,
    rewardType: normalizeRewardType(data.rewardType || data.reward_type),
    rewardValue: normalizeRewardValue(data.rewardValue ?? data.reward_value),
    rewardDescription: normalizeRewardDescription(data.rewardDescription || data.reward_description),
    rewardValueCents: normalizeRewardValueCents(data.rewardValueCents ?? data.reward_value_cents),
    rewardLabel: normalizeRewardLabel(data.rewardLabel || data.reward_label),
  };
}

function buildUserLoyalty({
  reservationDocs,
  redemptionDocs = [],
  now = new Date(),
  rewardInterval = DEFAULT_REWARD_INTERVAL,
  loyaltySettings = null,
}) {
  const settings = normalizeLoyaltySettings(loyaltySettings, rewardInterval);
  const targetWashes = settings.stampsRequired;
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
    rewardType: settings.rewardType,
    rewardValue: settings.rewardValue,
    rewardValueCents: settings.rewardValueCents,
    rewardLabel: settings.rewardLabel,
    rewardTerms: settings.rewardTerms,
    rewardDescription: settings.rewardDescription,
    stampHistory,
    redemptions,
  };
}

function normalizeLoyaltySettings(settings, rewardInterval = DEFAULT_REWARD_INTERVAL) {
  const source = settings && typeof settings === "object" ? settings : {};
  const stampsRequired = Number(source.stampsRequired ?? source.rewardInterval ?? rewardInterval);
  const rewardValue = Number(source.rewardValue);
  const rewardType = normalizeRewardType(source.rewardType || DEFAULT_LOYALTY_SETTINGS.rewardType);
  const rewardValueCents = normalizeRewardValueCents(source.rewardValueCents ?? source.reward_value_cents);
  const rewardLabel = normalizeRewardLabel(source.rewardLabel || source.reward_label);
  const rewardTerms = String(source.rewardTerms || source.reward_terms || DEFAULT_LOYALTY_SETTINGS.rewardTerms)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 500) || DEFAULT_LOYALTY_SETTINGS.rewardTerms;
  const rewardDescription = String(source.rewardDescription || DEFAULT_LOYALTY_SETTINGS.rewardDescription)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 200) || DEFAULT_LOYALTY_SETTINGS.rewardDescription;

  return {
    stampsRequired: Number.isInteger(stampsRequired) && stampsRequired > 0 ?
      Math.min(50, stampsRequired) :
      DEFAULT_LOYALTY_SETTINGS.stampsRequired,
    rewardType,
    rewardValue: Number.isFinite(rewardValue) && rewardValue > 0 ?
      Math.min(100000, Math.floor(rewardValue)) :
      DEFAULT_LOYALTY_SETTINGS.rewardValue,
    rewardValueCents,
    rewardLabel,
    rewardTerms,
    rewardDescription,
  };
}

module.exports = {
  ACTIVE_REDEMPTION_STATUS_VALUES,
  DEFAULT_LOYALTY_SETTINGS,
  DEFAULT_REWARD_INTERVAL,
  REDEEMABLE_REDEMPTION_STATUS_VALUES,
  assertRedeemableLoyaltyRedemption,
  buildLoyaltyRewardCode,
  buildUserLoyalty,
  isCompletedLoyaltyWash,
  normalizeLoyaltySettings,
  normalizeRewardCodeInput,
  normalizeLoyaltyReservationDocument,
  normalizeRedemptionDocument,
};
