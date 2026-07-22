const crypto = require("node:crypto");
const {HttpsError} = require("firebase-functions/v2/https");

const MAX_BOOKING_PRESETS = 5;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const VALID_VEHICLE_TYPES = new Set(["passenger", "suv"]);

function cleanText(value, maxLength = 160) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function cleanId(value, fieldName, {required = true, maxLength = 160} = {}) {
  const id = cleanText(value, maxLength);
  if ((!id && required) || (id && (!SAFE_ID_PATTERN.test(id) || id.includes("/")))) {
    throw new HttpsError("invalid-argument", `${fieldName} is invalid`);
  }
  return id;
}

function timestampToIso(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
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

function normalizeVehicleType(value) {
  const normalized = cleanText(value, 40).toLowerCase();
  if (normalized === "passageiros") return "passenger";
  return VALID_VEHICLE_TYPES.has(normalized) ? normalized : "";
}

function normalizeExtraIds(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const rawId of value) {
    const id = cleanId(rawId, "extraIds", {maxLength: 120});
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(id);
  }
  if (result.length > 12) {
    throw new HttpsError("invalid-argument", "Choose no more than 12 extras");
  }
  return result;
}

function validateUserBookingPresetInput(data = {}) {
  if (!data || typeof data !== "object") {
    throw new HttpsError("invalid-argument", "Booking preset data is required");
  }
  const presetId = cleanId(data.presetId, "presetId", {required: false, maxLength: 80});
  const label = cleanText(data.label, 80);
  const serviceId = cleanId(data.serviceId, "serviceId", {maxLength: 120});
  const extraIds = normalizeExtraIds(data.extraIds);
  const userVehicleId = cleanId(data.userVehicleId, "userVehicleId", {required: false, maxLength: 160});
  const vehicleType = normalizeVehicleType(data.vehicleType);
  const vehicleLabel = cleanText(data.vehicleLabel, 120);

  if (label.length < 2) throw new HttpsError("invalid-argument", "Preset label is required");
  if (!vehicleType) throw new HttpsError("invalid-argument", "Vehicle type is invalid");

  return {
    presetId,
    label,
    serviceId,
    extraIds,
    userVehicleId,
    vehicleType,
    vehicleLabel,
  };
}

function assertBookingPresetId(value) {
  return cleanId(value, "presetId", {maxLength: 80});
}

function bookingPresetId(preset) {
  const fingerprint = [
    preset.serviceId,
    [...(preset.extraIds || [])].sort().join(","),
    preset.userVehicleId || "",
    preset.vehicleType || "",
  ].join("|");
  return `preset-${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 20)}`;
}

function normalizeUserBookingPresetDocument(doc) {
  if (!doc) return null;
  const data = typeof doc.data === "function" ? doc.data() || {} : doc.data || doc;
  const id = cleanText(doc.id || data.presetId, 80);
  const label = cleanText(data.label, 80);
  const serviceId = cleanText(data.serviceId, 120);
  const vehicleType = normalizeVehicleType(data.vehicleType);
  if (!id || !SAFE_ID_PATTERN.test(id) || !label || !serviceId || !vehicleType) return null;

  let extraIds = [];
  try {
    extraIds = normalizeExtraIds(data.extraIds);
  } catch (_) {
    extraIds = [];
  }
  const userVehicleId = cleanText(data.userVehicleId, 160);
  return {
    id,
    label,
    serviceId,
    extraIds,
    userVehicleId,
    vehicleType,
    vehicleLabel: cleanText(data.vehicleLabel, 120),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

function buildUserBookingPresetList(docs = []) {
  return {
    maxPresets: MAX_BOOKING_PRESETS,
    presets: (docs || [])
      .map(normalizeUserBookingPresetDocument)
      .filter(Boolean)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  };
}

module.exports = {
  MAX_BOOKING_PRESETS,
  assertBookingPresetId,
  bookingPresetId,
  buildUserBookingPresetList,
  normalizeUserBookingPresetDocument,
  validateUserBookingPresetInput,
};
