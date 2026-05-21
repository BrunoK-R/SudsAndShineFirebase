const {HttpsError} = require("firebase-functions/v2/https");

const VALID_VEHICLE_TYPES = new Set(["passenger", "suv"]);

function normalizeShortText(value, maxLength) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function normalizeVehicleType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "passageiros") return "passenger";
  return VALID_VEHICLE_TYPES.has(normalized) ? normalized : "";
}

function validateVehiclePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new HttpsError("invalid-argument", "Vehicle data is required");
  }

  const brand = normalizeShortText(payload.brand, 80);
  const model = normalizeShortText(payload.model, 80);
  const plate = normalizeShortText(payload.plate, 24).toUpperCase();
  const color = normalizeShortText(payload.color, 40);
  const type = normalizeVehicleType(payload.type || "passenger");
  const isDefault = payload.isDefault === true;

  if (!brand) throw new HttpsError("invalid-argument", "Vehicle brand is required");
  if (!model) throw new HttpsError("invalid-argument", "Vehicle model is required");
  if (plate.length < 2) throw new HttpsError("invalid-argument", "Vehicle plate is required");
  if (!type) throw new HttpsError("invalid-argument", "Vehicle type is invalid");

  return {
    brand,
    model,
    plate,
    color,
    type,
    isDefault,
  };
}

function assertVehicleId(value) {
  const vehicleId = String(value || "").trim();
  if (!vehicleId || vehicleId.length > 160 || vehicleId.includes("/")) {
    throw new HttpsError("invalid-argument", "Vehicle id is invalid");
  }
  return vehicleId;
}

function normalizeVehicleDocument(doc) {
  if (!doc) return null;
  const data = typeof doc.data === "function" ? doc.data() : doc;
  if (!data || typeof data !== "object") return null;

  const id = String(doc.id || data.id || "").trim();
  const brand = normalizeShortText(data.brand, 80);
  const model = normalizeShortText(data.model, 80);
  const plate = normalizeShortText(data.plate, 24).toUpperCase();
  const color = normalizeShortText(data.color, 40);
  const type = normalizeVehicleType(data.type || "passenger");
  const isDefault = data.isDefault === true;

  if (!id || !brand || !model || !plate || !type) return null;

  return {
    id,
    brand,
    model,
    plate,
    color,
    type,
    isDefault,
  };
}

function buildUserVehicleList(vehicleDocs) {
  return {
    vehicles: (vehicleDocs || [])
      .map((doc) => normalizeVehicleDocument(doc))
      .filter(Boolean),
  };
}

module.exports = {
  assertVehicleId,
  buildUserVehicleList,
  normalizeVehicleDocument,
  normalizeVehicleType,
  validateVehiclePayload,
};
