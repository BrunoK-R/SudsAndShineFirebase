const {HttpsError} = require("firebase-functions/v2/https");

const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_PHONE_LENGTH = 32;
const MAX_PROFILE_PHOTO_URL_LENGTH = 2048;
const PHONE_PATTERN = /^[0-9+\-().\s]{6,32}$/;

function normalizeRequiredText(value, fieldName, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }

  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new HttpsError("invalid-argument", `${fieldName} is too long`);
  }
  return normalized;
}

function normalizeOptionalText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function normalizePhoneNumber(value) {
  const phoneNumber = normalizeRequiredText(value, "phoneNumber", MAX_PHONE_LENGTH);
  if (!PHONE_PATTERN.test(phoneNumber)) {
    throw new HttpsError("invalid-argument", "phoneNumber is invalid");
  }
  return phoneNumber;
}

function validateUserProfilePayload(data = {}) {
  return {
    displayName: normalizeRequiredText(data.displayName, "displayName", MAX_DISPLAY_NAME_LENGTH),
    phoneNumber: normalizePhoneNumber(data.phoneNumber),
    marketingOptIn: data.marketingOptIn === true,
    appointmentReminderOptIn: data.appointmentReminderOptIn === true,
  };
}

function normalizeUserProfile({uid, authToken = {}, userData = {}}) {
  const email = normalizeOptionalText(
    userData.email || authToken.email,
    160,
  ).toLowerCase();
  const displayName = normalizeOptionalText(
    userData.displayName || authToken.name,
    MAX_DISPLAY_NAME_LENGTH,
  );
  const phoneNumber = normalizeOptionalText(
    userData.phoneNumber || authToken.phone_number,
    MAX_PHONE_LENGTH,
  );
  const photoUrl = normalizeOptionalText(
    userData.photoUrl,
    MAX_PROFILE_PHOTO_URL_LENGTH,
  );

  return {
    uid,
    email,
    displayName,
    phoneNumber,
    photoUrl,
    marketingOptIn: userData.marketingOptIn === true,
    appointmentReminderOptIn: userData.appointmentReminderOptIn === true,
  };
}

function buildUserProfile({uid, authToken = {}, userDoc = null}) {
  const userData = userDoc?.exists ? userDoc.data() : {};
  return {
    profile: normalizeUserProfile({uid, authToken, userData}),
  };
}

module.exports = {
  buildUserProfile,
  normalizeUserProfile,
  validateUserProfilePayload,
};
