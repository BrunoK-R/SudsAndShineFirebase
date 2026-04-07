const {HttpsError} = require("firebase-functions/v2/https");

const RESERVATION_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ACTIVE_RESERVATION_STATUS_VALUES = [
  "pending",
  "confirmed",
  "in_progress",
  "novo",
  "confirmado",
  "em_execucao",
];

function assertRequiredString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
}

function parseISODateTime(value, fieldName) {
  assertRequiredString(value, fieldName);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpsError("invalid-argument", `${fieldName} must be a valid ISO date string`);
  }
  return parsed;
}

function normalizeSlotWindow(record) {
  const startRaw = record.slotStart || record.startTime || record.start_time;
  const endRaw = record.slotEnd || record.endTime || record.end_time;
  if (!startRaw || !endRaw) return null;

  const start = new Date(startRaw);
  const end = new Date(endRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }
  return {start, end};
}

function overlaps(slotStart, slotEnd, existingStart, existingEnd) {
  return slotStart < existingEnd && slotEnd > existingStart;
}

function hasBlockedSlotOverlap(blockedSlots, slotStart, slotEnd) {
  for (const item of blockedSlots) {
    const window = normalizeSlotWindow(item);
    if (!window) continue;
    if (overlaps(slotStart, slotEnd, window.start, window.end)) {
      return true;
    }
  }
  return false;
}

function countOverlappingReservations(reservations, slotStart, slotEnd) {
  let count = 0;
  for (const item of reservations) {
    const window = normalizeSlotWindow(item);
    if (!window) continue;
    if (overlaps(slotStart, slotEnd, window.start, window.end)) {
      count += 1;
    }
  }
  return count;
}

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

function readDefaultCapacityFromSetting(setting) {
  if (!setting || typeof setting !== "object") return null;

  const direct = parseCapacityValue(setting.value);
  if (direct !== null) return direct;

  if (setting.value && typeof setting.value === "object") {
    const nested = parseCapacityValue(setting.value.maxBookingsPerSlot);
    if (nested !== null) return nested;

    const nestedLegacy = parseCapacityValue(setting.value.max_bookings_per_slot);
    if (nestedLegacy !== null) return nestedLegacy;
  }

  return null;
}

function readOverrideCapacity(override) {
  if (!override || typeof override !== "object") return null;

  const camel = parseCapacityValue(override.maxBookingsPerSlot);
  if (camel !== null) return camel;

  const snake = parseCapacityValue(override.max_bookings_per_slot);
  if (snake !== null) return snake;

  return null;
}

function resolveCapacityLimit(defaultSetting, overrideSetting) {
  const fallbackDefaultCapacity = 2;

  const defaultCapacity = readDefaultCapacityFromSetting(defaultSetting);
  const overrideCapacity = readOverrideCapacity(overrideSetting);

  if (overrideCapacity !== null) return overrideCapacity;
  if (defaultCapacity !== null) return defaultCapacity;
  return fallbackDefaultCapacity;
}

function generateDeterministicReservationCode(docId) {
  let seed = 2166136261;
  const input = String(docId || "");

  for (let i = 0; i < input.length; i += 1) {
    seed ^= input.charCodeAt(i);
    seed = Math.imul(seed, 16777619) >>> 0;
  }

  let code = "SS-";
  let state = seed || 1;
  for (let i = 0; i < 8; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const idx = state % RESERVATION_CODE_ALPHABET.length;
    code += RESERVATION_CODE_ALPHABET[idx];
  }

  return code;
}

function sanitizeEmail(value) {
  const email = value.trim().toLowerCase();
  if (!email.includes("@") || email.startsWith("@") || email.endsWith("@")) {
    throw new HttpsError("invalid-argument", "customerEmail must be a valid email");
  }
  return email;
}

function validateCreateReservationInput(rawData) {
  const data = rawData || {};

  assertRequiredString(data.customerName, "customerName");
  assertRequiredString(data.customerEmail, "customerEmail");
  assertRequiredString(data.serviceId, "serviceId");
  assertRequiredString(data.slotStart, "slotStart");
  assertRequiredString(data.slotEnd, "slotEnd");

  const slotStart = parseISODateTime(data.slotStart, "slotStart");
  const slotEnd = parseISODateTime(data.slotEnd, "slotEnd");
  if (slotEnd <= slotStart) {
    throw new HttpsError("invalid-argument", "slotEnd must be after slotStart");
  }

  const vehicleType = data.vehicleType || "passageiros";
  if (!["passageiros", "suv"].includes(vehicleType)) {
    throw new HttpsError("invalid-argument", "vehicleType must be passageiros or suv");
  }

  return {
    customerName: data.customerName.trim(),
    customerEmail: sanitizeEmail(data.customerEmail),
    customerPhone: typeof data.customerPhone === "string" ? data.customerPhone.trim() : "",
    serviceId: data.serviceId.trim(),
    serviceName: typeof data.serviceName === "string" ? data.serviceName.trim() : "",
    slotStart,
    slotEnd,
    vehicleType,
    gdprConsent: data.gdprConsent === true,
    notes: typeof data.notes === "string" ? data.notes.trim() : "",
  };
}

module.exports = {
  ACTIVE_RESERVATION_STATUS_VALUES,
  countOverlappingReservations,
  generateDeterministicReservationCode,
  hasBlockedSlotOverlap,
  resolveCapacityLimit,
  validateCreateReservationInput,
};
