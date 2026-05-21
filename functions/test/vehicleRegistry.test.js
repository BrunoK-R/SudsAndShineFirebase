const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildUserVehicleList,
  normalizeVehicleDocument,
  validateVehiclePayload,
} = require("../vehicleRegistry");

function doc(id, data) {
  return {
    id,
    data: () => data,
  };
}

test("validates and normalizes vehicle payloads", () => {
  const vehicle = validateVehiclePayload({
    brand: "  BMW  ",
    model: "  320d Touring  ",
    plate: " aa-00-bb ",
    color: " Preto ",
    type: "passageiros",
    isDefault: true,
  });

  assert.deepEqual(vehicle, {
    brand: "BMW",
    model: "320d Touring",
    plate: "AA-00-BB",
    color: "Preto",
    type: "passenger",
    isDefault: true,
  });
});

test("rejects invalid vehicle payloads", () => {
  assert.throws(
    () => validateVehiclePayload({brand: "", model: "Golf", plate: "CC-11-DD", type: "passenger"}),
    /Vehicle brand is required/,
  );
  assert.throws(
    () => validateVehiclePayload({brand: "VW", model: "Golf", plate: "C", type: "van"}),
    /Vehicle plate is required/,
  );
});

test("normalizes Firestore vehicle documents", () => {
  const vehicle = normalizeVehicleDocument(
    doc("vehicle-1", {
      brand: " Volkswagen ",
      model: " Golf ",
      plate: "cc-11-dd",
      color: "Branco",
      type: "suv",
      isDefault: true,
    }),
  );

  assert.equal(vehicle.id, "vehicle-1");
  assert.equal(vehicle.brand, "Volkswagen");
  assert.equal(vehicle.plate, "CC-11-DD");
  assert.equal(vehicle.type, "suv");
  assert.equal(vehicle.isDefault, true);
});

test("buildUserVehicleList drops malformed documents without failing the list", () => {
  const list = buildUserVehicleList([
    doc("vehicle-1", {
      brand: "BMW",
      model: "320d",
      plate: "AA-00-BB",
      type: "passenger",
    }),
    doc("broken", {
      brand: "",
      model: "Missing",
      plate: "XX",
      type: "passenger",
    }),
  ]);

  assert.deepEqual(
    list.vehicles.map((vehicle) => vehicle.id),
    ["vehicle-1"],
  );
});
