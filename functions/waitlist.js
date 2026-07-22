const crypto = require("node:crypto");
const {HttpsError} = require("firebase-functions/v2/https");

const WAITLIST_COLLECTION = "waitlist_entries";
const WAITLIST_ACTIVE_STATUS = "active";
const WAITLIST_MAX_DAYS_AHEAD = 120;
const DateKeyRegex = /^\d{4}-\d{2}-\d{2}$/;

function cleanText(value, maxLength = 160) {
  if (value === undefined || value === null) return "";
  return String(value).trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function dateKeyFor(date) {
  return date.toISOString().slice(0, 10);
}

function parseDateKey(value, fieldName = "date") {
  const normalized = cleanText(value, 10);
  if (!DateKeyRegex.test(normalized)) {
    throw new HttpsError("invalid-argument", `${fieldName} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || dateKeyFor(parsed) !== normalized) {
    throw new HttpsError("invalid-argument", `${fieldName} is invalid`);
  }
  return {date: parsed, dateKey: normalized};
}

function requiredId(value, fieldName, maxLength = 120) {
  const normalized = cleanText(value, maxLength);
  if (!normalized || normalized.includes("/")) {
    throw new HttpsError("invalid-argument", `${fieldName} is invalid`);
  }
  return normalized;
}

function requiredText(value, fieldName, maxLength = 160) {
  const normalized = cleanText(value, maxLength);
  if (!normalized) {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
  return normalized;
}

function integerInRange(value, fieldName, minimum, maximum) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new HttpsError(
      "invalid-argument",
      `${fieldName} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return number;
}

function validateJoinWaitlistInput(rawData = {}, now = new Date()) {
  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) {
    throw new HttpsError("invalid-argument", "Waitlist payload is required");
  }

  const {date, dateKey} = parseDateKey(rawData.date);
  const todayKey = dateKeyFor(now);
  const maximumDate = new Date(`${todayKey}T00:00:00.000Z`);
  maximumDate.setUTCDate(maximumDate.getUTCDate() + WAITLIST_MAX_DAYS_AHEAD);
  if (dateKey < todayKey) {
    throw new HttpsError("failed-precondition", "Waitlist date must not be in the past");
  }
  if (date > maximumDate) {
    throw new HttpsError("failed-precondition", `Waitlist date must be within ${WAITLIST_MAX_DAYS_AHEAD} days`);
  }

  return {
    date: dateKey,
    serviceId: requiredId(rawData.serviceId, "serviceId"),
    serviceName: requiredText(rawData.serviceName, "serviceName"),
    serviceDurationMinutes: integerInRange(
      rawData.serviceDurationMinutes,
      "serviceDurationMinutes",
      5,
      480,
    ),
  };
}

function validateCancelWaitlistInput(rawData = {}) {
  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) {
    throw new HttpsError("invalid-argument", "Waitlist cancellation payload is required");
  }
  return {
    waitlistId: requiredId(rawData.waitlistId, "waitlistId", 160),
  };
}

function waitlistEntryId(ownerUid, entry) {
  const normalizedUid = requiredId(ownerUid, "ownerUid", 128);
  const normalizedEntry = validateJoinWaitlistInput(entry, new Date(`${entry.date}T00:00:00.000Z`));
  const digest = crypto
    .createHash("sha256")
    .update([
      normalizedUid,
      normalizedEntry.date,
      normalizedEntry.serviceId,
      normalizedEntry.serviceDurationMinutes,
    ].join(":"))
    .digest("hex")
    .slice(0, 32);
  return `wl_${digest}`;
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

function normalizeWaitlistDocument(docSnap) {
  if (!docSnap) return null;
  const data = typeof docSnap.data === "function" ? docSnap.data() : docSnap.data || docSnap;
  const id = cleanText(docSnap.id || data.id, 160);
  const ownerUid = cleanText(data.ownerUid, 128);
  const date = cleanText(data.date, 10);
  const serviceId = cleanText(data.serviceId, 120);
  const serviceName = cleanText(data.serviceName, 160);
  const serviceDurationMinutes = Number(data.serviceDurationMinutes);
  if (
    !id ||
    !ownerUid ||
    !DateKeyRegex.test(date) ||
    !serviceId ||
    !serviceName ||
    !Number.isInteger(serviceDurationMinutes)
  ) {
    return null;
  }
  return {
    id,
    ownerUid,
    date,
    serviceId,
    serviceName,
    serviceDurationMinutes,
    status: cleanText(data.status || WAITLIST_ACTIVE_STATUS, 32).toLowerCase(),
    alertVersion: Math.max(1, Math.floor(Number(data.alertVersion) || 1)),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
    notifiedAt: timestampToIso(data.notifiedAt) || null,
  };
}

function buildUserWaitlist(waitlistDocs, ownerUid) {
  const normalizedOwnerUid = cleanText(ownerUid, 128);
  return {
    entries: (waitlistDocs || [])
      .map(normalizeWaitlistDocument)
      .filter((entry) => entry && entry.ownerUid === normalizedOwnerUid)
      .sort((left, right) => {
        const dateOrder = left.date.localeCompare(right.date);
        return dateOrder === 0 ? left.serviceName.localeCompare(right.serviceName) : dateOrder;
      })
      .map(({ownerUid: ignoredOwnerUid, alertVersion: ignoredAlertVersion, ...entry}) => entry),
  };
}

function hasWaitlistDateAvailability(waitlist, availabilityMonth) {
  const date = cleanText(waitlist?.date, 10);
  if (!date) return false;
  return availabilityMonth?.days?.some((day) => day?.id === date && day.available === true) === true;
}

function availableTimesForWaitlist(waitlist, availabilityMonth, limit = 3) {
  const date = cleanText(waitlist?.date, 10);
  const day = availabilityMonth?.days?.find((item) => item?.id === date);
  return (day?.slots || [])
    .filter((slot) => slot?.available === true)
    .map((slot) => cleanText(slot.time, 5))
    .filter(Boolean)
    .slice(0, Math.max(0, limit));
}

module.exports = {
  WAITLIST_ACTIVE_STATUS,
  WAITLIST_COLLECTION,
  WAITLIST_MAX_DAYS_AHEAD,
  availableTimesForWaitlist,
  buildUserWaitlist,
  hasWaitlistDateAvailability,
  normalizeWaitlistDocument,
  validateCancelWaitlistInput,
  validateJoinWaitlistInput,
  waitlistEntryId,
};
