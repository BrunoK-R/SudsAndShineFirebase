const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertBookingPresetId,
  bookingPresetId,
  buildUserBookingPresetList,
  validateUserBookingPresetInput,
} = require("../bookingPresets");

function doc(id, data) {
  return {id, data: () => data};
}

test("validateUserBookingPresetInput normalizes a reusable selection", () => {
  const preset = validateUserBookingPresetInput({
    label: "  Premium   do Bruno ",
    serviceId: "premium",
    extraIds: ["wax", "wax", "interior"],
    userVehicleId: "vehicle-1",
    vehicleType: "passageiros",
    vehicleLabel: " BMW   Série 1 ",
  });

  assert.deepEqual(preset, {
    presetId: "",
    label: "Premium do Bruno",
    serviceId: "premium",
    extraIds: ["wax", "interior"],
    userVehicleId: "vehicle-1",
    vehicleType: "passenger",
    vehicleLabel: "BMW Série 1",
  });
});

test("bookingPresetId is stable for the same selection regardless of extra order", () => {
  const left = bookingPresetId({
    serviceId: "premium",
    extraIds: ["wax", "interior"],
    userVehicleId: "vehicle-1",
    vehicleType: "passenger",
  });
  const right = bookingPresetId({
    serviceId: "premium",
    extraIds: ["interior", "wax"],
    userVehicleId: "vehicle-1",
    vehicleType: "passenger",
  });

  assert.equal(left, right);
  assert.match(left, /^preset-[a-f0-9]{20}$/);
});

test("buildUserBookingPresetList drops malformed records and orders recent first", () => {
  const result = buildUserBookingPresetList([
    doc("older", {
      label: "Lavagem simples",
      serviceId: "standard",
      vehicleType: "passenger",
      updatedAt: "2026-07-01T10:00:00.000Z",
    }),
    doc("newer", {
      label: "Premium SUV",
      serviceId: "premium",
      extraIds: ["wax"],
      vehicleType: "suv",
      updatedAt: "2026-07-20T10:00:00.000Z",
    }),
    doc("broken", {label: "Sem serviço"}),
  ]);

  assert.equal(result.maxPresets, 5);
  assert.deepEqual(result.presets.map((preset) => preset.id), ["newer", "older"]);
  assert.deepEqual(result.presets[0].extraIds, ["wax"]);
});

test("booking preset validation rejects unsafe document ids", () => {
  assert.throws(() => assertBookingPresetId("../preset"), /presetId is invalid/);
  assert.throws(
    () => validateUserBookingPresetInput({
      label: "Preset",
      serviceId: "premium/path",
      vehicleType: "passenger",
    }),
    /serviceId is invalid/,
  );
});
