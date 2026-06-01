const {HttpsError} = require("firebase-functions/v2/https");

const DEFAULT_MAX_BOOKINGS_PER_SLOT = 2;
const MAX_BOOKINGS_PER_SLOT = 20;
const MAX_OPENING_HOURS = 10;
const MAX_BLOCKED_SLOT_REASON_LENGTH = 160;
const MAX_BLOCKED_SLOT_MINUTES = 24 * 60;
const BLOCKED_SLOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

function parseCapacityValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }
  return null;
}

function readDefaultCapacity(setting) {
  if (!setting || typeof setting !== "object") return DEFAULT_MAX_BOOKINGS_PER_SLOT;

  const direct = parseCapacityValue(setting.value);
  if (direct !== null) return direct;

  if (setting.value && typeof setting.value === "object") {
    const nested = parseCapacityValue(setting.value.maxBookingsPerSlot);
    if (nested !== null) return nested;

    const nestedLegacy = parseCapacityValue(setting.value.max_bookings_per_slot);
    if (nestedLegacy !== null) return nestedLegacy;
  }

  return DEFAULT_MAX_BOOKINGS_PER_SLOT;
}

function requiredString(value, fieldName, maxLength) {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new HttpsError("invalid-argument", `${fieldName} is too long`);
  }
  return trimmed;
}

function parseClockTime(hour, minute) {
  const parsedHour = Number(hour);
  const parsedMinute = Number(minute);
  if (
    !Number.isInteger(parsedHour) ||
    !Number.isInteger(parsedMinute) ||
    parsedHour < 0 ||
    parsedHour > 23 ||
    parsedMinute < 0 ||
    parsedMinute > 59
  ) {
    return null;
  }
  return parsedHour * 60 + parsedMinute;
}

function hasValidOperatingRange(hoursLabel) {
  const pattern = /([0-2]?\d):([0-5]\d)\D+([0-2]?\d):([0-5]\d)/g;
  let match;
  while ((match = pattern.exec(hoursLabel)) !== null) {
    const open = parseClockTime(match[1], match[2]);
    const close = parseClockTime(match[3], match[4]);
    if (open !== null && close !== null && close > open) {
      return true;
    }
  }
  return false;
}

function validateOpeningHours(value) {
  if (!Array.isArray(value)) {
    throw new HttpsError("invalid-argument", "openingHours must be a list");
  }
  if (value.length === 0) {
    throw new HttpsError("invalid-argument", "openingHours must include at least one row");
  }
  if (value.length > MAX_OPENING_HOURS) {
    throw new HttpsError("invalid-argument", `openingHours supports at most ${MAX_OPENING_HOURS} rows`);
  }

  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpsError("invalid-argument", "openingHours entries must be objects");
    }

    const dayLabel = requiredString(item.dayLabel || item.day, "dayLabel", 80);
    const hoursLabel = requiredString(item.hoursLabel || item.hours, "hoursLabel", 80);
    const closed = item.closed === true;
    if (!closed && !hasValidOperatingRange(hoursLabel)) {
      throw new HttpsError("invalid-argument", "open days must include a valid HH:MM time range");
    }

    return {
      dayLabel,
      hoursLabel,
      closed,
    };
  });
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function validateDateKey(value, fieldName = "date") {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new HttpsError("invalid-argument", `${fieldName} must use YYYY-MM-DD format`);
  }

  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || formatDateKey(parsed) !== trimmed) {
    throw new HttpsError("invalid-argument", `${fieldName} must be a valid calendar date`);
  }
  return trimmed;
}

function tryNormalizeDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  const trimmed = value.trim();
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || formatDateKey(parsed) !== trimmed) return null;
  return trimmed;
}

function validateBlockedSlotId(value, fallbackId = "") {
  const raw = typeof value === "string" && value.trim() ? value : fallbackId;
  const id = String(raw || "").trim();
  if (!BLOCKED_SLOT_ID_PATTERN.test(id) || id.includes("/")) {
    throw new HttpsError("invalid-argument", "blockedSlotId is invalid");
  }
  return id;
}

function validateIsoInstant(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpsError("invalid-argument", `${fieldName} must be a valid ISO timestamp`);
  }
  return parsed;
}

function normalizeOptionalText(value, fallback, maxLength) {
  const raw = typeof value === "string" ? value : "";
  const normalized = raw.trim().replace(/\s+/g, " ");
  const result = normalized || fallback;
  if (result.length > maxLength) {
    throw new HttpsError("invalid-argument", "reason is too long");
  }
  return result;
}

function validateAvailabilityConfigurationInput(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Availability payload is required");
  }

  const capacity = parseCapacityValue(data.defaultMaxBookingsPerSlot ?? data.maxBookingsPerSlot);
  if (capacity === null || capacity > MAX_BOOKINGS_PER_SLOT) {
    throw new HttpsError(
      "invalid-argument",
      `defaultMaxBookingsPerSlot must be an integer between 0 and ${MAX_BOOKINGS_PER_SLOT}`,
    );
  }

  return {
    defaultMaxBookingsPerSlot: capacity,
    openingHours: validateOpeningHours(data.openingHours),
  };
}

function validateBlockedSlotInput(data = {}, fallbackId = "") {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Blocked slot payload is required");
  }

  const blockedSlotId = validateBlockedSlotId(data.blockedSlotId || data.id, fallbackId);
  const date = validateDateKey(data.date);
  const slotStart = validateIsoInstant(data.slotStart || data.startTime || data.start_time, "slotStart");
  const slotEnd = validateIsoInstant(data.slotEnd || data.endTime || data.end_time, "slotEnd");
  if (formatDateKey(slotStart) !== date || formatDateKey(slotEnd) !== date) {
    throw new HttpsError("invalid-argument", "Blocked slot timestamps must match the selected date");
  }
  const durationMinutes = (slotEnd.getTime() - slotStart.getTime()) / 60000;
  if (durationMinutes <= 0 || durationMinutes > MAX_BLOCKED_SLOT_MINUTES) {
    throw new HttpsError("invalid-argument", "Blocked slot end time must be after start time");
  }

  return {
    blockedSlotId,
    date,
    slotStart: slotStart.toISOString(),
    slotEnd: slotEnd.toISOString(),
    reason: normalizeOptionalText(data.reason, "Bloqueio administrativo", MAX_BLOCKED_SLOT_REASON_LENGTH),
  };
}

function validateBlockedSlotClearInput(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Blocked slot clear payload is required");
  }

  return {
    blockedSlotId: validateBlockedSlotId(data.blockedSlotId || data.id),
  };
}

function validateCapacityOverrideInput(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Capacity override payload is required");
  }

  const maxBookingsPerSlot = parseCapacityValue(data.maxBookingsPerSlot);
  if (maxBookingsPerSlot === null || maxBookingsPerSlot > MAX_BOOKINGS_PER_SLOT) {
    throw new HttpsError(
      "invalid-argument",
      `maxBookingsPerSlot must be an integer between 0 and ${MAX_BOOKINGS_PER_SLOT}`,
    );
  }

  return {
    date: validateDateKey(data.date),
    maxBookingsPerSlot,
  };
}

function validateCapacityOverrideClearInput(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Capacity override clear payload is required");
  }

  return {
    date: validateDateKey(data.date),
  };
}

function normalizeBlockedSlotDoc(docSnap) {
  const data = docSnap?.data?.() || docSnap || {};
  if (data.active === false) return null;

  const blockedSlotId = String(docSnap?.id || data.blockedSlotId || data.id || "").trim();
  if (!BLOCKED_SLOT_ID_PATTERN.test(blockedSlotId)) return null;

  const date = tryNormalizeDateKey(data.date);
  if (!date) return null;

  const startRaw = data.slotStart || data.startTime || data.start_time;
  const endRaw = data.slotEnd || data.endTime || data.end_time;
  if (typeof startRaw !== "string" || typeof endRaw !== "string") return null;
  const slotStart = new Date(startRaw.trim());
  const slotEnd = new Date(endRaw.trim());
  if (
    Number.isNaN(slotStart.getTime()) ||
    Number.isNaN(slotEnd.getTime()) ||
    slotEnd <= slotStart ||
    formatDateKey(slotStart) !== date ||
    formatDateKey(slotEnd) !== date
  ) {
    return null;
  }

  return {
    blockedSlotId,
    date,
    slotStart: slotStart.toISOString(),
    slotEnd: slotEnd.toISOString(),
    reason: typeof data.reason === "string" && data.reason.trim() ?
      data.reason.trim().replace(/\s+/g, " ").slice(0, MAX_BLOCKED_SLOT_REASON_LENGTH) :
      "Bloqueio administrativo",
  };
}

function buildBlockedSlotDocument(blockedSlot, uid) {
  return {
    blockedSlotId: blockedSlot.blockedSlotId,
    date: blockedSlot.date,
    slotStart: blockedSlot.slotStart,
    slotEnd: blockedSlot.slotEnd,
    reason: blockedSlot.reason,
    active: true,
    updatedByUid: uid,
    updateSource: "admin-mobile-availability",
  };
}

function normalizeCapacityOverrideDoc(docSnap) {
  const data = docSnap?.data?.() || docSnap || {};
  if (data.active === false) return null;
  const date = typeof data.date === "string" ? data.date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const maxBookingsPerSlot = parseCapacityValue(data.maxBookingsPerSlot ?? data.max_bookings_per_slot);
  if (maxBookingsPerSlot === null || maxBookingsPerSlot > MAX_BOOKINGS_PER_SLOT) return null;

  return {
    date,
    maxBookingsPerSlot,
  };
}

function buildCapacityOverrideDocument(override, uid) {
  return {
    date: override.date,
    maxBookingsPerSlot: override.maxBookingsPerSlot,
    active: true,
    updatedByUid: uid,
    updateSource: "admin-mobile-availability",
  };
}

function buildAdminAvailabilityConfig({
  businessInfo,
  defaultCapacitySetting,
  capacityOverrideDocs = [],
  blockedSlotDocs = [],
}) {
  return {
    defaultMaxBookingsPerSlot: readDefaultCapacity(defaultCapacitySetting),
    openingHours: Array.isArray(businessInfo?.openingHours) ? businessInfo.openingHours : [],
    capacityOverrides: (capacityOverrideDocs || [])
      .map(normalizeCapacityOverrideDoc)
      .filter(Boolean)
      .sort((left, right) => left.date.localeCompare(right.date)),
    blockedSlots: (blockedSlotDocs || [])
      .map(normalizeBlockedSlotDoc)
      .filter(Boolean)
      .sort((left, right) => {
        const dateCompare = left.date.localeCompare(right.date);
        return dateCompare === 0 ? left.slotStart.localeCompare(right.slotStart) : dateCompare;
      }),
  };
}

module.exports = {
  DEFAULT_MAX_BOOKINGS_PER_SLOT,
  buildAdminAvailabilityConfig,
  buildBlockedSlotDocument,
  buildCapacityOverrideDocument,
  readDefaultCapacity,
  validateAvailabilityConfigurationInput,
  validateBlockedSlotClearInput,
  validateBlockedSlotInput,
  validateCapacityOverrideClearInput,
  validateCapacityOverrideInput,
};
