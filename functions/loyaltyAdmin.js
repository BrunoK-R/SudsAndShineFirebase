const {HttpsError} = require("firebase-functions/v2/https");
const {
  DEFAULT_LOYALTY_SETTINGS,
  normalizeLoyaltySettings,
} = require("./loyalty");

const MIN_STAMPS_REQUIRED = 1;
const MAX_STAMPS_REQUIRED = 50;
const MAX_REWARD_DESCRIPTION_LENGTH = 200;
const REWARD_TYPES = new Set([
  "free_wash",
  "discount_amount",
  "discount_percent",
]);

function settingPayload(data) {
  if (!data || typeof data !== "object") return {};
  const nested = data.value && typeof data.value === "object" ? data.value : null;
  return nested || data;
}

function parseInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return null;
}

function requiredInteger(value, fieldName, min, max) {
  const parsed = parseInteger(value);
  if (parsed === null || parsed < min || parsed > max) {
    throw new HttpsError("invalid-argument", `${fieldName} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function cleanRewardType(value) {
  const normalized = String(value || DEFAULT_LOYALTY_SETTINGS.rewardType)
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  return REWARD_TYPES.has(normalized) ? normalized : DEFAULT_LOYALTY_SETTINGS.rewardType;
}

function requiredRewardType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  if (!REWARD_TYPES.has(normalized)) {
    throw new HttpsError("invalid-argument", "rewardType is invalid");
  }
  return normalized;
}

function rewardValueRangeForType(rewardType) {
  if (rewardType === "discount_percent") return {min: 1, max: 100};
  if (rewardType === "discount_amount") return {min: 1, max: 100000};
  return {min: 1, max: 10};
}

function cleanRewardDescription(value, fallback = DEFAULT_LOYALTY_SETTINGS.rewardDescription) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return fallback;
  return trimmed.slice(0, MAX_REWARD_DESCRIPTION_LENGTH);
}

function cleanAuditString(value, fallback = "", maxLength = 128) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLength);
}

function timestampToIso(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value.toDate === "function") {
    const date = value.toDate();
    if (date instanceof Date && !Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value.seconds === "number") {
    const millis = value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1000000);
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return "";
}

function requiredRewardDescription(value) {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", "rewardDescription is required");
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    throw new HttpsError("invalid-argument", "rewardDescription is required");
  }
  if (trimmed.length > MAX_REWARD_DESCRIPTION_LENGTH) {
    throw new HttpsError("invalid-argument", "rewardDescription is too long");
  }
  return trimmed;
}

function buildLoyaltySettings(docSnap = null) {
  const root = docSnap?.exists ? docSnap.data() : docSnap;
  const source = settingPayload(root);
  const rewardType = cleanRewardType(source.rewardType ?? source.reward_type);
  const valueRange = rewardValueRangeForType(rewardType);
  const settings = normalizeLoyaltySettings({
    stampsRequired: source.stampsRequired ?? source.stamps_required ?? source.rewardInterval,
    rewardType,
    rewardValue: source.rewardValue ?? source.reward_value,
    rewardDescription: source.rewardDescription ?? source.reward_description,
  });

  return {
    ...settings,
    stampsRequired: Math.min(
      MAX_STAMPS_REQUIRED,
      Math.max(MIN_STAMPS_REQUIRED, settings.stampsRequired),
    ),
    rewardValue: Math.min(
      valueRange.max,
      Math.max(valueRange.min, settings.rewardValue),
    ),
    rewardDescription: cleanRewardDescription(settings.rewardDescription),
    source: docSnap?.exists ? "firestore" : "default",
    updatedAtIso: timestampToIso(root?.updatedAt || source.updatedAt),
    updatedByUid: cleanAuditString(root?.updatedByUid || source.updatedByUid),
  };
}

function validateLoyaltySettingsUpdateInput(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Loyalty settings payload is required");
  }

  const rewardType = requiredRewardType(data.rewardType);
  const valueRange = rewardValueRangeForType(rewardType);

  return {
    stampsRequired: requiredInteger(
      data.stampsRequired,
      "stampsRequired",
      MIN_STAMPS_REQUIRED,
      MAX_STAMPS_REQUIRED,
    ),
    rewardType,
    rewardValue: requiredInteger(
      data.rewardValue,
      "rewardValue",
      valueRange.min,
      valueRange.max,
    ),
    rewardDescription: requiredRewardDescription(data.rewardDescription),
  };
}

function buildLoyaltySettingsValue(settings) {
  return {
    stampsRequired: settings.stampsRequired,
    rewardType: settings.rewardType,
    rewardValue: settings.rewardValue,
    rewardDescription: settings.rewardDescription,
  };
}

function buildLoyaltyRedemptionMetadata(settings) {
  const normalized = buildLoyaltySettings(settings);
  return {
    rewardType: normalized.rewardType,
    rewardValue: normalized.rewardValue,
    rewardDescription: normalized.rewardDescription,
  };
}

function loyaltyDiscountCentsForRedemption(redemption, basePriceCents) {
  const basePrice = Math.max(0, Math.round(Number(basePriceCents) || 0));
  if (basePrice <= 0) return 0;

  const rewardType = cleanRewardType(redemption?.rewardType);
  const rewardValue = Math.max(0, Math.floor(Number(redemption?.rewardValue) || 0));
  if (rewardType === "discount_amount") {
    return Math.min(basePrice, rewardValue);
  }
  if (rewardType === "discount_percent") {
    return Math.min(basePrice, Math.floor(basePrice * Math.min(100, rewardValue) / 100));
  }
  return basePrice;
}

module.exports = {
  DEFAULT_LOYALTY_SETTINGS,
  buildLoyaltySettings,
  buildLoyaltyRedemptionMetadata,
  buildLoyaltySettingsValue,
  loyaltyDiscountCentsForRedemption,
  validateLoyaltySettingsUpdateInput,
};
