const {HttpsError} = require("firebase-functions/v2/https");

const DEFAULT_MAX_BOOKINGS_PER_SLOT = 2;
const MAX_BOOKINGS_PER_SLOT = 20;
const MAX_OPENING_HOURS = 10;

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

function buildAdminAvailabilityConfig({businessInfo, defaultCapacitySetting, capacityOverrideDocs = []}) {
  return {
    defaultMaxBookingsPerSlot: readDefaultCapacity(defaultCapacitySetting),
    openingHours: Array.isArray(businessInfo?.openingHours) ? businessInfo.openingHours : [],
    capacityOverrides: (capacityOverrideDocs || [])
      .map(normalizeCapacityOverrideDoc)
      .filter(Boolean)
      .sort((left, right) => left.date.localeCompare(right.date)),
  };
}

module.exports = {
  DEFAULT_MAX_BOOKINGS_PER_SLOT,
  buildAdminAvailabilityConfig,
  buildCapacityOverrideDocument,
  readDefaultCapacity,
  validateAvailabilityConfigurationInput,
  validateCapacityOverrideClearInput,
  validateCapacityOverrideInput,
};
