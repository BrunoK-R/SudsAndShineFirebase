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
const PENDING_RESERVATION_STATUS_VALUES = [
  "pending",
  "novo",
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

function normalizeExtraIds(value) {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value)) {
    throw new HttpsError("invalid-argument", "extraIds must be an array");
  }

  const seen = new Set();
  const extraIds = [];
  for (const item of value) {
    const rawId = item && typeof item === "object" ? item.id || item.extraId : item;
    const id = String(rawId || "").trim();
    if (!id) continue;
    if (id.length > 120 || id.includes("/")) {
      throw new HttpsError("invalid-argument", "extraIds contains an invalid extra");
    }
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    extraIds.push(id);
  }

  if (extraIds.length > 12) {
    throw new HttpsError("invalid-argument", "extraIds supports at most 12 extras");
  }
  return extraIds;
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

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeReservationStatus(value) {
  return String(value || "pending")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
}

function timestampToMillis(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }
  if (typeof value.toDate === "function") {
    const parsed = value.toDate();
    return parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed.getTime() : null;
  }
  if (Number.isFinite(value.seconds)) {
    const nanoseconds = Number.isFinite(value.nanoseconds) ? value.nanoseconds : 0;
    return value.seconds * 1000 + Math.floor(nanoseconds / 1000000);
  }
  return null;
}

function isPendingReservationStatus(status) {
  return PENDING_RESERVATION_STATUS_VALUES.includes(normalizeReservationStatus(status));
}

function isExpiredPendingReservation(reservation, now = new Date()) {
  if (!reservation || typeof reservation !== "object") return false;
  if (!isPendingReservationStatus(reservation.status)) return false;

  const expiresAtMillis = timestampToMillis(reservation.pendingExpiresAt);
  if (expiresAtMillis === null) return false;
  return expiresAtMillis <= now.getTime();
}

function reservationHoldsCapacity(reservation, now = new Date()) {
  if (!reservation || typeof reservation !== "object") return false;
  const status = normalizeReservationStatus(reservation.status);
  if (!ACTIVE_RESERVATION_STATUS_VALUES.includes(status)) return false;
  return !isExpiredPendingReservation(reservation, now);
}

function parseExplicitDayNumber(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) return null;
  if (parsed === 7) return 0;
  return parsed >= 0 && parsed <= 6 ? parsed : null;
}

function dayNumbersFromLabel(label) {
  const normalized = normalizeComparableText(label);
  if (!normalized) return [];

  if (
    normalized.includes("todos") ||
    normalized.includes("diariamente") ||
    normalized.includes("daily")
  ) {
    return [0, 1, 2, 3, 4, 5, 6];
  }

  if (
    normalized.includes("dias uteis") ||
    normalized.includes("weekdays") ||
    (normalized.includes("segunda") && normalized.includes("sexta")) ||
    (normalized.includes("seg") && normalized.includes("sex"))
  ) {
    return [1, 2, 3, 4, 5];
  }

  if (normalized.includes("fim de semana") || normalized.includes("weekend")) {
    return [0, 6];
  }

  const days = [];
  const dayMatchers = [
    {day: 0, keys: ["domingo", "dom", "sun"]},
    {day: 1, keys: ["segunda", "seg", "mon"]},
    {day: 2, keys: ["terca", "terça", "ter", "tue"]},
    {day: 3, keys: ["quarta", "qua", "wed"]},
    {day: 4, keys: ["quinta", "qui", "thu"]},
    {day: 5, keys: ["sexta", "sex", "fri"]},
    {day: 6, keys: ["sabado", "sábado", "sab", "sat"]},
  ];

  for (const matcher of dayMatchers) {
    if (matcher.keys.some((key) => normalized.includes(normalizeComparableText(key)))) {
      days.push(matcher.day);
    }
  }

  return Array.from(new Set(days));
}

function dayNumbersFromOpeningHoursItem(item) {
  const explicitDays = item.days ?? item.dayNumbers ?? item.dayOfWeek ?? item.dayOfWeeks;
  const explicitValues = Array.isArray(explicitDays) ? explicitDays : [explicitDays];
  const parsedExplicitDays = explicitValues
    .map(parseExplicitDayNumber)
    .filter((day) => day !== null);
  if (parsedExplicitDays.length > 0) {
    return Array.from(new Set(parsedExplicitDays));
  }

  return dayNumbersFromLabel(item.dayLabel || item.day || item.label);
}

function parseClockTimeToMinutes(hour, minute) {
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

function parseClockTextToMinutes(value) {
  const match = String(value || "").trim().match(/^([0-2]?\d):([0-5]\d)$/);
  if (!match) return null;
  return parseClockTimeToMinutes(match[1], match[2]);
}

function parseWindowObject(value) {
  if (!value || typeof value !== "object") return null;

  const start = parseClockTextToMinutes(value.start || value.open || value.from);
  const end = parseClockTextToMinutes(value.end || value.close || value.to);
  if (start === null || end === null || end <= start) return null;

  return {
    openMinutes: start,
    closeMinutes: end,
  };
}

function parseTimeRanges(hoursLabel) {
  const label = normalizeComparableText(hoursLabel);
  if (!label || label.includes("encerrado") || label.includes("fechado") || label.includes("closed")) {
    return [];
  }

  const windows = [];
  const timeRangePattern = /([0-2]?\d):([0-5]\d)\D+([0-2]?\d):([0-5]\d)/g;
  let match;
  while ((match = timeRangePattern.exec(String(hoursLabel || ""))) !== null) {
    const openMinutes = parseClockTimeToMinutes(match[1], match[2]);
    const closeMinutes = parseClockTimeToMinutes(match[3], match[4]);
    if (openMinutes !== null && closeMinutes !== null && closeMinutes > openMinutes) {
      windows.push({openMinutes, closeMinutes});
    }
  }

  return windows;
}

function openingHoursWindowsForDay(openingHours, dayOfWeek) {
  if (!Array.isArray(openingHours) || openingHours.length === 0) return null;

  const windows = [];
  for (const item of openingHours) {
    if (!item || typeof item !== "object" || item.closed === true) continue;

    const days = dayNumbersFromOpeningHoursItem(item);
    if (!days.includes(dayOfWeek)) continue;

    const itemWindows = Array.isArray(item.windows) ?
      item.windows.map(parseWindowObject).filter(Boolean) :
      parseTimeRanges(item.hoursLabel || item.hours || item.value);
    windows.push(...itemWindows);
  }

  return windows.sort((left, right) => left.openMinutes - right.openMinutes);
}

function defaultOperatingWindowsForDate(dateKey) {
  const date = parseDateKey(dateKey);
  const dayOfWeek = date.getUTCDay();
  if (dayOfWeek === 0) return [];
  if (dayOfWeek === 6) {
    return [{openMinutes: 9 * 60, closeMinutes: 13 * 60}];
  }

  return [
    {openMinutes: 9 * 60, closeMinutes: 13 * 60},
    {openMinutes: 14 * 60, closeMinutes: 19 * 60},
  ];
}

function operatingWindowsForDate(dateKey, openingHours = null) {
  const date = parseDateKey(dateKey);
  const configuredWindows = openingHoursWindowsForDay(openingHours, date.getUTCDay());
  return configuredWindows === null ? defaultOperatingWindowsForDate(dateKey) : configuredWindows;
}

function buildSlotWindowsForOperatingWindows(dateKey, serviceDurationMinutes, slotIntervalMinutes, operatingWindows) {
  const slots = [];
  for (const window of operatingWindows) {
    for (
      let minutes = window.openMinutes;
      minutes + serviceDurationMinutes <= window.closeMinutes;
      minutes += slotIntervalMinutes
    ) {
      const endMinutes = minutes + serviceDurationMinutes;
      slots.push({
        time: formatTime(minutes),
        start: new Date(`${dateKey}T${formatTime(minutes)}:00.000Z`),
        end: new Date(`${dateKey}T${formatTime(endMinutes)}:00.000Z`),
      });
    }
  }
  return slots;
}

function buildDefaultSlotWindows(dateKey, serviceDurationMinutes, slotIntervalMinutes) {
  return buildSlotWindowsForOperatingWindows(
    dateKey,
    serviceDurationMinutes,
    slotIntervalMinutes,
    defaultOperatingWindowsForDate(dateKey),
  );
}

function buildSlotWindows(dateKey, serviceDurationMinutes, slotIntervalMinutes, openingHours = null) {
  return buildSlotWindowsForOperatingWindows(
    dateKey,
    serviceDurationMinutes,
    slotIntervalMinutes,
    operatingWindowsForDate(dateKey, openingHours),
  );
}

function minutesSinceUtcMidnight(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function isSlotWithinOperatingHours({dateKey, slotStart, slotEnd, openingHours = null}) {
  if (formatDateKey(slotStart) !== dateKey || formatDateKey(slotEnd) !== dateKey || slotEnd <= slotStart) {
    return false;
  }

  const slotStartMinutes = minutesSinceUtcMidnight(slotStart);
  const slotEndMinutes = minutesSinceUtcMidnight(slotEnd);
  return operatingWindowsForDate(dateKey, openingHours).some((window) =>
    slotStartMinutes >= window.openMinutes && slotEndMinutes <= window.closeMinutes,
  );
}

function buildAvailabilityMonth({
  request,
  reservations,
  blockedSlots,
  capacityOverrides,
  defaultCapacitySetting,
  openingHours,
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

  const activeReservations = (reservations || []).filter((item) => reservationHoldsCapacity(item, request.now));

  const days = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = addDays(monthStart, day - 1);
    const dateKey = formatDateKey(date);
    const defaultSlots = buildSlotWindows(
      dateKey,
      request.serviceDurationMinutes,
      request.slotIntervalMinutes,
      openingHours,
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
  const extraIds = normalizeExtraIds(data.extraIds || data.selectedExtraIds || data.extras);

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
    extraIds,
  };
}

function resolveSelectedExtras(extraIds, catalogExtras, serviceId = "") {
  if (!extraIds || extraIds.length === 0) return [];

  const extrasById = new Map((catalogExtras || []).map((extra) => [extra.id, extra]));
  return extraIds.map((extraId) => {
    const extra = extrasById.get(extraId);
    if (!extra) {
      throw new HttpsError("invalid-argument", "Um dos extras selecionados já não está disponível.");
    }
    const eligibleServiceIds = Array.isArray(extra.eligibleServiceIds) ? extra.eligibleServiceIds : [];
    if (eligibleServiceIds.length > 0 && !eligibleServiceIds.includes(serviceId)) {
      throw new HttpsError("invalid-argument", "Um dos extras selecionados não está disponível para este serviço.");
    }
    return {
      id: extra.id,
      name: extra.name,
      priceCents: Math.max(0, Math.round(Number(extra.priceCents) || 0)),
    };
  });
}

function totalSelectedExtrasPriceCents(selectedExtras) {
  return (selectedExtras || []).reduce((total, extra) => {
    const priceCents = Math.max(0, Math.round(Number(extra.priceCents) || 0));
    return total + priceCents;
  }, 0);
}

module.exports = {
  ACTIVE_RESERVATION_STATUS_VALUES,
  PENDING_RESERVATION_STATUS_VALUES,
  buildAvailabilityMonth,
  buildDefaultSlotWindows,
  buildSlotWindows,
  countOverlappingReservations,
  generateDeterministicReservationCode,
  hasBlockedSlotOverlap,
  isSlotWithinOperatingHours,
  isExpiredPendingReservation,
  isPendingReservationStatus,
  normalizeExtraIds,
  reservationHoldsCapacity,
  resolveSelectedExtras,
  resolveCapacityLimit,
  resolveAvailabilityRequest,
  totalSelectedExtrasPriceCents,
  validateCreateReservationInput,
};
