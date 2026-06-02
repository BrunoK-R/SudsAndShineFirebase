const {HttpsError} = require("firebase-functions/v2/https");

const DEFAULT_BOOKING_POLICY = {
  pendingHoldMinutes: 24 * 60,
  cancellationWindowMinutes: 0,
  rescheduleWindowMinutes: 0,
  paymentEligibilityCopy: "Pagamento confirmado no local após validação da marcação.",
};

const MIN_PENDING_HOLD_MINUTES = 15;
const MAX_PENDING_HOLD_MINUTES = 7 * 24 * 60;
const MIN_CUTOFF_MINUTES = 0;
const MAX_CUTOFF_MINUTES = 7 * 24 * 60;
const MAX_PAYMENT_COPY_LENGTH = 500;

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

function coerceMinutes(value, fallback, min, max) {
  const parsed = parseInteger(value);
  if (parsed === null) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function requiredMinutes(value, fieldName, min, max) {
  const parsed = parseInteger(value);
  if (parsed === null || parsed < min || parsed > max) {
    throw new HttpsError(
      "invalid-argument",
      `${fieldName} must be an integer between ${min} and ${max}`,
    );
  }
  return parsed;
}

function cleanPaymentCopy(value, fallback = DEFAULT_BOOKING_POLICY.paymentEligibilityCopy) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return fallback;
  return trimmed.slice(0, MAX_PAYMENT_COPY_LENGTH);
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

function requiredPaymentCopy(value) {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", "paymentEligibilityCopy is required");
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    throw new HttpsError("invalid-argument", "paymentEligibilityCopy is required");
  }
  if (trimmed.length > MAX_PAYMENT_COPY_LENGTH) {
    throw new HttpsError("invalid-argument", "paymentEligibilityCopy is too long");
  }
  return trimmed;
}

function buildBookingPolicy(docSnap = null) {
  const root = docSnap?.exists ? docSnap.data() : docSnap;
  const source = settingPayload(root);
  return {
    pendingHoldMinutes: coerceMinutes(
      source.pendingHoldMinutes ?? source.pending_hold_minutes,
      DEFAULT_BOOKING_POLICY.pendingHoldMinutes,
      MIN_PENDING_HOLD_MINUTES,
      MAX_PENDING_HOLD_MINUTES,
    ),
    cancellationWindowMinutes: coerceMinutes(
      source.cancellationWindowMinutes ?? source.cancellation_window_minutes,
      DEFAULT_BOOKING_POLICY.cancellationWindowMinutes,
      MIN_CUTOFF_MINUTES,
      MAX_CUTOFF_MINUTES,
    ),
    rescheduleWindowMinutes: coerceMinutes(
      source.rescheduleWindowMinutes ?? source.reschedule_window_minutes,
      DEFAULT_BOOKING_POLICY.rescheduleWindowMinutes,
      MIN_CUTOFF_MINUTES,
      MAX_CUTOFF_MINUTES,
    ),
    paymentEligibilityCopy: cleanPaymentCopy(
      source.paymentEligibilityCopy ?? source.payment_eligibility_copy,
    ),
    source: docSnap?.exists ? "firestore" : "default",
    updatedAtIso: timestampToIso(root?.updatedAt || source.updatedAt),
    updatedByUid: cleanAuditString(root?.updatedByUid || source.updatedByUid),
  };
}

function validateBookingPolicyUpdateInput(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Booking policy payload is required");
  }

  return {
    pendingHoldMinutes: requiredMinutes(
      data.pendingHoldMinutes,
      "pendingHoldMinutes",
      MIN_PENDING_HOLD_MINUTES,
      MAX_PENDING_HOLD_MINUTES,
    ),
    cancellationWindowMinutes: requiredMinutes(
      data.cancellationWindowMinutes,
      "cancellationWindowMinutes",
      MIN_CUTOFF_MINUTES,
      MAX_CUTOFF_MINUTES,
    ),
    rescheduleWindowMinutes: requiredMinutes(
      data.rescheduleWindowMinutes,
      "rescheduleWindowMinutes",
      MIN_CUTOFF_MINUTES,
      MAX_CUTOFF_MINUTES,
    ),
    paymentEligibilityCopy: requiredPaymentCopy(data.paymentEligibilityCopy),
  };
}

function buildBookingPolicySettingValue(policy) {
  return {
    pendingHoldMinutes: policy.pendingHoldMinutes,
    cancellationWindowMinutes: policy.cancellationWindowMinutes,
    rescheduleWindowMinutes: policy.rescheduleWindowMinutes,
    paymentEligibilityCopy: policy.paymentEligibilityCopy,
  };
}

function pendingExpiresAtForPolicy(policy, now = new Date()) {
  const normalizedPolicy = buildBookingPolicy(policy);
  return new Date(now.getTime() + normalizedPolicy.pendingHoldMinutes * 60 * 1000);
}

module.exports = {
  DEFAULT_BOOKING_POLICY,
  buildBookingPolicy,
  buildBookingPolicySettingValue,
  pendingExpiresAtForPolicy,
  validateBookingPolicyUpdateInput,
};
