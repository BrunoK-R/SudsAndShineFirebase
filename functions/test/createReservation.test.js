const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ACTIVE_RESERVATION_STATUS_VALUES,
  countOverlappingReservations,
  generateDeterministicReservationCode,
  hasBlockedSlotOverlap,
  resolveCapacityLimit,
  validateCreateReservationInput,
} = require("../createReservation");

test("deterministic reservation code uses expected format", () => {
  const first = generateDeterministicReservationCode("abc123doc");
  const second = generateDeterministicReservationCode("abc123doc");
  const third = generateDeterministicReservationCode("different-doc-id");

  assert.equal(first, second);
  assert.notEqual(first, third);
  assert.match(first, /^SS-[A-Z2-9]{8}$/);
});

test("validateCreateReservationInput sanitizes and validates data", () => {
  const parsed = validateCreateReservationInput({
    customerName: "  Bruno  ",
    customerEmail: "  BKENDLEYR@GMAIL.COM  ",
    customerPhone: " 913005855 ",
    serviceId: " full-detail ",
    serviceName: " Detalhe Completo ",
    slotStart: "2026-04-10T10:00:00.000Z",
    slotEnd: "2026-04-10T12:00:00.000Z",
    vehicleType: "suv",
    gdprConsent: true,
    notes: "  limpar interior  ",
  });

  assert.equal(parsed.customerName, "Bruno");
  assert.equal(parsed.customerEmail, "bkendleyr@gmail.com");
  assert.equal(parsed.customerPhone, "913005855");
  assert.equal(parsed.serviceId, "full-detail");
  assert.equal(parsed.serviceName, "Detalhe Completo");
  assert.equal(parsed.vehicleType, "suv");
  assert.equal(parsed.gdprConsent, true);
  assert.equal(parsed.notes, "limpar interior");
});

test("validateCreateReservationInput rejects invalid slot ranges", () => {
  assert.throws(() => {
    validateCreateReservationInput({
      customerName: "Bruno",
      customerEmail: "bkendleyr@gmail.com",
      serviceId: "service",
      slotStart: "2026-04-10T12:00:00.000Z",
      slotEnd: "2026-04-10T10:00:00.000Z",
    });
  }, /slotEnd must be after slotStart/);
});

test("resolveCapacityLimit prioritizes override over default and fallback", () => {
  const defaultSetting = {key: "default_max_bookings_per_slot", value: 3};
  const overrideSetting = {date: "2026-04-10", maxBookingsPerSlot: 1};

  assert.equal(resolveCapacityLimit(defaultSetting, overrideSetting), 1);
  assert.equal(resolveCapacityLimit(defaultSetting, null), 3);
  assert.equal(resolveCapacityLimit(null, {max_bookings_per_slot: "4"}), 4);
  assert.equal(resolveCapacityLimit(null, null), 2);
});

test("overlap helpers count reservation collisions and blocked windows", () => {
  const slotStart = new Date("2026-04-10T10:00:00.000Z");
  const slotEnd = new Date("2026-04-10T11:00:00.000Z");

  const reservations = [
    {slotStart: "2026-04-10T08:00:00.000Z", slotEnd: "2026-04-10T09:00:00.000Z"},
    {slotStart: "2026-04-10T10:30:00.000Z", slotEnd: "2026-04-10T11:30:00.000Z"},
    {start_time: "2026-04-10T10:45:00.000Z", end_time: "2026-04-10T11:15:00.000Z"},
  ];

  const blockedSlots = [
    {startTime: "2026-04-10T12:00:00.000Z", endTime: "2026-04-10T13:00:00.000Z"},
    {slotStart: "2026-04-10T10:15:00.000Z", slotEnd: "2026-04-10T10:45:00.000Z"},
  ];

  assert.equal(countOverlappingReservations(reservations, slotStart, slotEnd), 2);
  assert.equal(hasBlockedSlotOverlap(blockedSlots, slotStart, slotEnd), true);
});

test("active statuses include firebase and legacy values for migration compatibility", () => {
  assert.deepEqual(ACTIVE_RESERVATION_STATUS_VALUES, [
    "pending",
    "confirmed",
    "in_progress",
    "novo",
    "confirmado",
    "em_execucao",
  ]);
});
