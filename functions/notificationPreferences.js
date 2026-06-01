const crypto = require("node:crypto");
const {HttpsError} = require("firebase-functions/v2/https");

const DEFAULT_USER_NOTIFICATION_PREFERENCES = {
  bookingStatusEnabled: true,
  appointmentReminderEnabled: true,
  loyaltyEnabled: true,
  adminPendingAlertEnabled: true,
  marketingEnabled: false,
};

const SUPPORTED_TOKEN_PLATFORMS = ["android", "ios", "web"];
const MAX_TOKEN_LENGTH = 4096;
const MAX_DEVICE_LABEL_LENGTH = 120;
const MAX_APP_VERSION_LENGTH = 64;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function boolValue(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function preferencePayload(docSnap = null) {
  if (!docSnap?.exists) return {};
  const data = docSnap.data() || {};
  const nested = data.value && typeof data.value === "object" ? data.value : null;
  return nested || data;
}

function profileFallback(userDoc = null) {
  if (!userDoc?.exists) return {};
  const data = userDoc.data() || {};
  return {
    appointmentReminderEnabled: data.appointmentReminderOptIn,
    marketingEnabled: data.marketingOptIn,
  };
}

function buildUserNotificationPreferences({preferencesDoc = null, userDoc = null} = {}) {
  const fallback = profileFallback(userDoc);
  const source = preferencePayload(preferencesDoc);
  return {
    bookingStatusEnabled: boolValue(
      source.bookingStatusEnabled,
      DEFAULT_USER_NOTIFICATION_PREFERENCES.bookingStatusEnabled,
    ),
    appointmentReminderEnabled: boolValue(
      source.appointmentReminderEnabled,
      boolValue(fallback.appointmentReminderEnabled, DEFAULT_USER_NOTIFICATION_PREFERENCES.appointmentReminderEnabled),
    ),
    loyaltyEnabled: boolValue(source.loyaltyEnabled, DEFAULT_USER_NOTIFICATION_PREFERENCES.loyaltyEnabled),
    adminPendingAlertEnabled: boolValue(
      source.adminPendingAlertEnabled,
      DEFAULT_USER_NOTIFICATION_PREFERENCES.adminPendingAlertEnabled,
    ),
    marketingEnabled: boolValue(
      source.marketingEnabled,
      boolValue(fallback.marketingEnabled, DEFAULT_USER_NOTIFICATION_PREFERENCES.marketingEnabled),
    ),
  };
}

function validateUserNotificationPreferencesInput(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Notification preferences payload is required");
  }

  return {
    bookingStatusEnabled: data.bookingStatusEnabled === true,
    appointmentReminderEnabled: data.appointmentReminderEnabled === true,
    loyaltyEnabled: data.loyaltyEnabled === true,
    adminPendingAlertEnabled: data.adminPendingAlertEnabled !== false,
    marketingEnabled: data.marketingEnabled === true,
  };
}

function buildUserNotificationPreferencesValue(preferences) {
  return {
    bookingStatusEnabled: preferences.bookingStatusEnabled,
    appointmentReminderEnabled: preferences.appointmentReminderEnabled,
    loyaltyEnabled: preferences.loyaltyEnabled,
    adminPendingAlertEnabled: preferences.adminPendingAlertEnabled,
    marketingEnabled: preferences.marketingEnabled,
  };
}

function cleanOptionalText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function tokenIdForToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function validateOptionalTokenId(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const tokenId = value.trim();
  if (!TOKEN_ID_PATTERN.test(tokenId)) {
    throw new HttpsError("invalid-argument", "tokenId is invalid");
  }
  return tokenId;
}

function normalizePlatform(value) {
  const platform = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SUPPORTED_TOKEN_PLATFORMS.includes(platform)) {
    throw new HttpsError("invalid-argument", "platform must be android, ios, or web");
  }
  return platform;
}

function normalizeToken(value) {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", "token is required");
  }
  const token = value.trim();
  if (token.length < 10 || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    throw new HttpsError("invalid-argument", "token is invalid");
  }
  return token;
}

function validateNotificationTokenRegistrationInput(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Notification token payload is required");
  }

  const token = normalizeToken(data.token);
  const tokenId = validateOptionalTokenId(data.tokenId || data.deviceId) || tokenIdForToken(token);
  return {
    tokenId,
    token,
    platform: normalizePlatform(data.platform),
    deviceLabel: cleanOptionalText(data.deviceLabel, MAX_DEVICE_LABEL_LENGTH),
    appVersion: cleanOptionalText(data.appVersion, MAX_APP_VERSION_LENGTH),
  };
}

function validateNotificationTokenDeleteInput(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Notification token delete payload is required");
  }

  const tokenId = validateOptionalTokenId(data.tokenId || data.deviceId);
  if (!tokenId) {
    throw new HttpsError("invalid-argument", "tokenId is required");
  }

  return {
    tokenId,
  };
}

function buildNotificationTokenValue(registration, ownerUid) {
  return {
    ownerUid,
    tokenId: registration.tokenId,
    token: registration.token,
    platform: registration.platform,
    enabled: true,
    deviceLabel: registration.deviceLabel,
    appVersion: registration.appVersion,
  };
}

module.exports = {
  DEFAULT_USER_NOTIFICATION_PREFERENCES,
  buildNotificationTokenValue,
  buildUserNotificationPreferences,
  buildUserNotificationPreferencesValue,
  validateNotificationTokenDeleteInput,
  validateNotificationTokenRegistrationInput,
  validateUserNotificationPreferencesInput,
};
