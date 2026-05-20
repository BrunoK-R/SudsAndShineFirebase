const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ACTIVE_RESERVATION_STATUS_VALUES,
  buildAvailabilityMonth,
  buildDefaultSlotWindows,
  countOverlappingReservations,
  generateDeterministicReservationCode,
  hasBlockedSlotOverlap,
  resolveCapacityLimit,
  resolveAvailabilityRequest,
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
    userVehicleId: " vehicle-1 ",
    vehicleLabel: " BMW 320d  ",
    loyaltyRewardCode: " ss-free-uid1-0001 ",
  });

  assert.equal(parsed.customerName, "Bruno");
  assert.equal(parsed.customerEmail, "bkendleyr@gmail.com");
  assert.equal(parsed.customerPhone, "913005855");
  assert.equal(parsed.serviceId, "full-detail");
  assert.equal(parsed.serviceName, "Detalhe Completo");
  assert.equal(parsed.vehicleType, "suv");
  assert.equal(parsed.gdprConsent, true);
  assert.equal(parsed.notes, "limpar interior");
  assert.equal(parsed.userVehicleId, "vehicle-1");
  assert.equal(parsed.vehicleLabel, "BMW 320d");
  assert.equal(parsed.loyaltyRewardCode, "SS-FREE-UID1-0001");
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

test("validateCreateReservationInput rejects invalid saved vehicle ids", () => {
  assert.throws(() => {
    validateCreateReservationInput({
      customerName: "Bruno",
      customerEmail: "bkendleyr@gmail.com",
      serviceId: "service",
      slotStart: "2026-04-10T10:00:00.000Z",
      slotEnd: "2026-04-10T12:00:00.000Z",
      userVehicleId: "users/other",
    });
  }, /userVehicleId is invalid/);
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

test("resolveAvailabilityRequest returns current month window with validated duration", () => {
  const request = resolveAvailabilityRequest(
    {anchorDate: "2026-05-20", serviceDurationMinutes: 45},
    new Date("2026-05-20T08:00:00.000Z"),
  );

  assert.equal(request.monthStart, "2026-05-01");
  assert.equal(request.monthEnd, "2026-05-31");
  assert.equal(request.todayKey, "2026-05-20");
  assert.equal(request.serviceDurationMinutes, 45);
  assert.equal(request.slotIntervalMinutes, 30);
});

test("buildDefaultSlotWindows respects operating days and lunch break", () => {
  const weekdaySlots = buildDefaultSlotWindows("2026-05-20", 30, 30).map((slot) => slot.time);
  const saturdaySlots = buildDefaultSlotWindows("2026-05-23", 30, 30).map((slot) => slot.time);
  const sundaySlots = buildDefaultSlotWindows("2026-05-24", 30, 30);

  assert.ok(weekdaySlots.includes("09:00"));
  assert.ok(weekdaySlots.includes("12:30"));
  assert.ok(!weekdaySlots.includes("13:00"));
  assert.ok(weekdaySlots.includes("14:00"));
  assert.deepEqual(saturdaySlots, [
    "09:00",
    "09:30",
    "10:00",
    "10:30",
    "11:00",
    "11:30",
    "12:00",
    "12:30",
  ]);
  assert.deepEqual(sundaySlots, []);
});

test("buildAvailabilityMonth applies capacity, conflicts, blocked slots, and past dates", () => {
  const request = resolveAvailabilityRequest(
    {anchorDate: "2026-05-20", serviceDurationMinutes: 30},
    new Date("2026-05-20T09:15:00.000Z"),
  );

  const availability = buildAvailabilityMonth({
    request,
    reservations: [
      {
        date: "2026-05-20",
        status: "pending",
        slotStart: "2026-05-20T09:30:00.000Z",
        slotEnd: "2026-05-20T10:00:00.000Z",
      },
      {
        date: "2026-05-20",
        status: "confirmed",
        slotStart: "2026-05-20T09:30:00.000Z",
        slotEnd: "2026-05-20T10:00:00.000Z",
      },
      {
        date: "2026-05-20",
        status: "cancelled",
        slotStart: "2026-05-20T10:00:00.000Z",
        slotEnd: "2026-05-20T10:30:00.000Z",
      },
    ],
    blockedSlots: [
      {
        date: "2026-05-20",
        slotStart: "2026-05-20T10:30:00.000Z",
        slotEnd: "2026-05-20T11:00:00.000Z",
      },
    ],
    capacityOverrides: [{date: "2026-05-20", maxBookingsPerSlot: 2}],
    defaultCapacitySetting: {key: "default_max_bookings_per_slot", value: 3},
  });

  const may19 = availability.days.find((day) => day.id === "2026-05-19");
  const may20 = availability.days.find((day) => day.id === "2026-05-20");
  assert.equal(availability.monthTitle, "maio 2026");
  assert.equal(availability.leadingEmptyCells, 4);
  assert.equal(may19.available, false);
  assert.equal(may20.slots.find((slot) => slot.time === "09:00").available, false);
  assert.equal(may20.slots.find((slot) => slot.time === "09:30").available, false);
  assert.equal(may20.slots.find((slot) => slot.time === "10:00").available, true);
  assert.equal(may20.slots.find((slot) => slot.time === "10:30").available, false);
  assert.equal(may20.available, true);
});
