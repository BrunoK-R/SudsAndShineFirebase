const {HttpsError} = require("firebase-functions/v2/https");
const {normalizeRewardCodeInput} = require("./loyalty");

const RESERVATION_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ACTIVE_RESERVATION_STATUS_VALUES = [
  "pending",
  "confirmed",
  "in_progress",
  "novo",
  "confirmado",
  "em_execucao",
];
const MONTH_NAMES_PT = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];
const MONTH_SHORT_NAMES_PT = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
];

function assertRequiredString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
}

function normalizeOptionalShortText(value, maxLength) {
  if (value === undefined || value === null) return "";
  return String(value)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function parseISODateTime(value, fieldName) {
  assertRequiredString(value, fieldName);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpsError("invalid-argument", `${fieldName} must be a valid ISO date string`);
  }
  return parsed;
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function parseDateKey(value, fieldName = "date") {
  assertRequiredString(value, fieldName);
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new HttpsError("invalid-argument", `${fieldName} must use YYYY-MM-DD format`);
  }

  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || formatDateKey(parsed) !== trimmed) {
    throw new HttpsError("invalid-argument", `${fieldName} must be a valid calendar date`);
  }

  return parsed;
}

function parsePositiveInteger(value, fieldName, defaultValue, minValue, maxValue) {
  if (value === undefined || value === null || value === "") return defaultValue;

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minValue || parsed > maxValue) {
    throw new HttpsError(
      "invalid-argument",
      `${fieldName} must be an integer between ${minValue} and ${maxValue}`,
    );
  }
  return parsed;
}

function monthEndFor(anchorDate) {
  return new Date(Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth() + 1, 0));
}

function addDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function formatTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function resolveAvailabilityRequest(rawData, now = new Date()) {
  const data = rawData || {};
  const todayKey = formatDateKey(now);
  const anchorDate = parseDateKey(
    typeof data.anchorDate === "string" && data.anchorDate.trim() ? data.anchorDate : todayKey,
    "anchorDate",
  );
  const monthStart = new Date(Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth(), 1));
  const monthEnd = monthEndFor(anchorDate);

  return {
    anchorDate: formatDateKey(anchorDate),
    monthStart: formatDateKey(monthStart),
    monthEnd: formatDateKey(monthEnd),
    todayKey,
    now,
    serviceDurationMinutes: parsePositiveInteger(
      data.serviceDurationMinutes,
      "serviceDurationMinutes",
      30,
      5,
      480,
    ),
    slotIntervalMinutes: parsePositiveInteger(data.slotIntervalMinutes, "slotIntervalMinutes", 30, 5, 240),
  };
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

function buildDefaultSlotWindows(dateKey, serviceDurationMinutes, slotIntervalMinutes) {
  const date = parseDateKey(dateKey);
  const dayOfWeek = date.getUTCDay();
  if (dayOfWeek === 0) return [];

  const openMinutes = 9 * 60;
  const closeMinutes = dayOfWeek === 6 ? 13 * 60 : 19 * 60;
  const lunchStart = 13 * 60;
  const lunchEnd = 14 * 60;
  const slots = [];

  for (
    let minutes = openMinutes;
    minutes + serviceDurationMinutes <= closeMinutes;
    minutes += slotIntervalMinutes
  ) {
    const endMinutes = minutes + serviceDurationMinutes;
    const overlapsLunchBreak = dayOfWeek !== 6 && minutes < lunchEnd && endMinutes > lunchStart;
    if (overlapsLunchBreak) continue;

    slots.push({
      time: formatTime(minutes),
      start: new Date(`${dateKey}T${formatTime(minutes)}:00.000Z`),
      end: new Date(`${dateKey}T${formatTime(endMinutes)}:00.000Z`),
    });
  }

  return slots;
}

function buildAvailabilityMonth({
  request,
  reservations,
  blockedSlots,
  capacityOverrides,
  defaultCapacitySetting,
}) {
  const monthStart = parseDateKey(request.monthStart);
  const monthEnd = parseDateKey(request.monthEnd);
  const daysInMonth = monthEnd.getUTCDate();
  const month = monthStart.getUTCMonth();
  const year = monthStart.getUTCFullYear();
  const leadingEmptyCells = (monthStart.getUTCDay() + 6) % 7;

  const capacityByDate = new Map();
  for (const override of capacityOverrides || []) {
    if (override && typeof override.date === "string") {
      capacityByDate.set(override.date, override);
    }
  }

  const activeReservations = (reservations || []).filter((item) => {
    if (!item || typeof item !== "object") return false;
    return ACTIVE_RESERVATION_STATUS_VALUES.includes(item.status);
  });

  const days = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = addDays(monthStart, day - 1);
    const dateKey = formatDateKey(date);
    const defaultSlots = buildDefaultSlotWindows(
      dateKey,
      request.serviceDurationMinutes,
      request.slotIntervalMinutes,
    );
    const capacityLimit = resolveCapacityLimit(defaultCapacitySetting, capacityByDate.get(dateKey));
    const reservationsForDate = activeReservations.filter((item) => item.date === dateKey);
    const blockedForDate = (blockedSlots || []).filter((item) => item.date === dateKey);

    const slots = defaultSlots.map((slot) => {
      const reservationCount = countOverlappingReservations(reservationsForDate, slot.start, slot.end);
      const remainingCapacity = Math.max(0, capacityLimit - reservationCount);
      const blocked = hasBlockedSlotOverlap(blockedForDate, slot.start, slot.end);
      const isPastDate = dateKey < request.todayKey;
      const isPastSlot = dateKey === request.todayKey && slot.start <= request.now;
      const available = capacityLimit > 0 && remainingCapacity > 0 && !blocked && !isPastDate && !isPastSlot;

      return {
        time: slot.time,
        available,
        remainingCapacity,
      };
    });

    days.push({
      id: dateKey,
      dayOfMonth: day,
      dateLabel: `${day} ${MONTH_SHORT_NAMES_PT[month]}`,
      summaryLabel: `${day} de ${MONTH_NAMES_PT[month]}, ${year}`,
      available: slots.some((slot) => slot.available),
      slots,
    });
  }

  return {
    monthTitle: `${MONTH_NAMES_PT[month]} ${year}`,
    leadingEmptyCells,
    days,
  };
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
  const userVehicleId = normalizeOptionalShortText(data.userVehicleId || data.vehicleId, 160);
  if (userVehicleId.includes("/")) {
    throw new HttpsError("invalid-argument", "userVehicleId is invalid");
  }
  const loyaltyRewardCode = normalizeRewardCodeInput(data.loyaltyRewardCode || data.rewardCode);
  if (loyaltyRewardCode.includes("/")) {
    throw new HttpsError("invalid-argument", "loyaltyRewardCode is invalid");
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
    userVehicleId,
    vehicleLabel: normalizeOptionalShortText(data.vehicleLabel, 160),
    loyaltyRewardCode,
  };
}

module.exports = {
  ACTIVE_RESERVATION_STATUS_VALUES,
  buildAvailabilityMonth,
  buildDefaultSlotWindows,
  countOverlappingReservations,
  generateDeterministicReservationCode,
  hasBlockedSlotOverlap,
  resolveCapacityLimit,
  resolveAvailabilityRequest,
  validateCreateReservationInput,
};
