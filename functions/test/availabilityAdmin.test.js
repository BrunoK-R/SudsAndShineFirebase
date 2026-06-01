const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildAdminAvailabilityConfig,
  buildBlockedSlotDocument,
  buildCapacityOverrideDocument,
  readDefaultCapacity,
  validateAvailabilityConfigurationInput,
  validateBlockedSlotClearInput,
  validateBlockedSlotInput,
  validateCapacityOverrideClearInput,
  validateCapacityOverrideInput,
} = require("../availabilityAdmin");

test("buildAdminAvailabilityConfig maps current capacity and operating hours", () => {
  const config = buildAdminAvailabilityConfig({
    businessInfo: {
      openingHours: [
        {dayLabel: "Segunda a Sexta", hoursLabel: "09:00 - 13:00, 14:00 - 19:00", closed: false},
        {dayLabel: "Domingo", hoursLabel: "Encerrado", closed: true},
      ],
    },
    defaultCapacitySetting: {
      value: {
        maxBookingsPerSlot: "3",
      },
    },
    capacityOverrideDocs: [
      doc({
        date: "2026-06-11",
        maxBookingsPerSlot: 0,
        updatedAt: {
          seconds: 1781171400,
          nanoseconds: 500000000,
        },
        updatedByUid: " admin-capacity ",
      }),
      doc({
        date: "2026-06-10",
        max_bookings_per_slot: "4",
        updatedAt: new Date("2026-06-01T10:15:00.000Z"),
        updatedByUid: "admin-capacity-2",
      }),
      doc({date: "2026-06-12", maxBookingsPerSlot: 8, active: false}),
    ],
    blockedSlotDocs: [
      doc({
        blockedSlotId: "slot-late",
        date: "2026-06-10",
        slotStart: "2026-06-10T16:00:00.000Z",
        slotEnd: "2026-06-10T17:00:00.000Z",
        reason: "Formação",
        updatedAt: "2026-06-01T11:45:00.000Z",
        updatedByUid: " admin-blocked ",
      }, "slot-late"),
      doc({
        blockedSlotId: "slot-early",
        date: "2026-06-10",
        slotStart: "2026-06-10T09:00:00.000Z",
        slotEnd: "2026-06-10T10:00:00.000Z",
        reason: "Manutenção",
      }, "slot-early"),
      doc({
        blockedSlotId: "slot-inactive",
        date: "2026-06-11",
        slotStart: "2026-06-11T09:00:00.000Z",
        slotEnd: "2026-06-11T10:00:00.000Z",
        active: false,
      }, "slot-inactive"),
    ],
  });

  assert.equal(config.defaultMaxBookingsPerSlot, 3);
  assert.equal(config.openingHours.length, 2);
  assert.equal(config.openingHours[0].dayLabel, "Segunda a Sexta");
  assert.deepEqual(config.capacityOverrides, [
    {
      date: "2026-06-10",
      maxBookingsPerSlot: 4,
      updatedAtIso: "2026-06-01T10:15:00.000Z",
      updatedByUid: "admin-capacity-2",
    },
    {
      date: "2026-06-11",
      maxBookingsPerSlot: 0,
      updatedAtIso: "2026-06-11T09:50:00.500Z",
      updatedByUid: "admin-capacity",
    },
  ]);
  assert.deepEqual(config.blockedSlots, [
    {
      blockedSlotId: "slot-early",
      date: "2026-06-10",
      slotStart: "2026-06-10T09:00:00.000Z",
      slotEnd: "2026-06-10T10:00:00.000Z",
      reason: "Manutenção",
      updatedAtIso: "",
      updatedByUid: "",
    },
    {
      blockedSlotId: "slot-late",
      date: "2026-06-10",
      slotStart: "2026-06-10T16:00:00.000Z",
      slotEnd: "2026-06-10T17:00:00.000Z",
      reason: "Formação",
      updatedAtIso: "2026-06-01T11:45:00.000Z",
      updatedByUid: "admin-blocked",
    },
  ]);
});

test("readDefaultCapacity falls back safely when setting is missing", () => {
  assert.equal(readDefaultCapacity(null), 2);
  assert.equal(readDefaultCapacity({value: "4"}), 4);
  assert.equal(readDefaultCapacity({value: {max_bookings_per_slot: 5}}), 5);
});

test("validateAvailabilityConfigurationInput sanitizes admin settings", () => {
  const config = validateAvailabilityConfigurationInput({
    defaultMaxBookingsPerSlot: "4",
    openingHours: [
      {dayLabel: " Segunda   a Sexta ", hoursLabel: " 09:00 - 13:00, 14:00 - 19:00 "},
      {day: "Domingo", hours: "Encerrado", closed: true},
    ],
  });

  assert.equal(config.defaultMaxBookingsPerSlot, 4);
  assert.deepEqual(config.openingHours, [
    {dayLabel: "Segunda a Sexta", hoursLabel: "09:00 - 13:00, 14:00 - 19:00", closed: false},
    {dayLabel: "Domingo", hoursLabel: "Encerrado", closed: true},
  ]);
});

test("validateAvailabilityConfigurationInput rejects unsafe settings", () => {
  assert.throws(
    () => validateAvailabilityConfigurationInput({
      defaultMaxBookingsPerSlot: 30,
      openingHours: [{dayLabel: "Segunda", hoursLabel: "09:00 - 19:00"}],
    }),
    /defaultMaxBookingsPerSlot/,
  );

  assert.throws(
    () => validateAvailabilityConfigurationInput({
      defaultMaxBookingsPerSlot: 2,
      openingHours: [{dayLabel: "Segunda", hoursLabel: "horário completo"}],
    }),
    /valid HH:MM time range/,
  );

  assert.throws(
    () => validateAvailabilityConfigurationInput({
      defaultMaxBookingsPerSlot: 2,
      openingHours: [{dayLabel: "Segunda", hoursLabel: "18:00 - 09:00"}],
    }),
    /valid HH:MM time range/,
  );
});

test("validateCapacityOverrideInput sanitizes admin day capacity", () => {
  const override = validateCapacityOverrideInput({
    date: " 2026-06-10 ",
    maxBookingsPerSlot: "4",
  });

  assert.deepEqual(override, {
    date: "2026-06-10",
    maxBookingsPerSlot: 4,
  });
  assert.deepEqual(buildCapacityOverrideDocument(override, "admin-1"), {
    date: "2026-06-10",
    maxBookingsPerSlot: 4,
    active: true,
    updatedByUid: "admin-1",
    updateSource: "admin-mobile-availability",
  });
});

test("validateCapacityOverrideInput rejects invalid dates and capacity", () => {
  assert.throws(
    () => validateCapacityOverrideInput({date: "2026-02-31", maxBookingsPerSlot: 2}),
    /valid calendar date/,
  );
  assert.throws(
    () => validateCapacityOverrideInput({date: "2026-06-10", maxBookingsPerSlot: 30}),
    /maxBookingsPerSlot/,
  );
  assert.deepEqual(validateCapacityOverrideClearInput({date: "2026-06-10"}), {
    date: "2026-06-10",
  });
});

test("validateBlockedSlotInput sanitizes admin blocked windows", () => {
  const blockedSlot = validateBlockedSlotInput({
    blockedSlotId: "  staff_meeting ",
    date: " 2026-06-10 ",
    slotStart: "2026-06-10T09:00:00Z",
    slotEnd: "2026-06-10T10:30:00Z",
    reason: "  Equipa   em reunião ",
  });

  assert.deepEqual(blockedSlot, {
    blockedSlotId: "staff_meeting",
    date: "2026-06-10",
    slotStart: "2026-06-10T09:00:00.000Z",
    slotEnd: "2026-06-10T10:30:00.000Z",
    reason: "Equipa em reunião",
  });
  assert.deepEqual(buildBlockedSlotDocument(blockedSlot, "admin-1"), {
    blockedSlotId: "staff_meeting",
    date: "2026-06-10",
    slotStart: "2026-06-10T09:00:00.000Z",
    slotEnd: "2026-06-10T10:30:00.000Z",
    reason: "Equipa em reunião",
    active: true,
    updatedByUid: "admin-1",
    updateSource: "admin-mobile-availability",
  });
});

test("validateBlockedSlotInput rejects path ids, date mismatches, and reversed times", () => {
  assert.throws(
    () => validateBlockedSlotInput({
      blockedSlotId: "../bad",
      date: "2026-06-10",
      slotStart: "2026-06-10T09:00:00.000Z",
      slotEnd: "2026-06-10T10:00:00.000Z",
    }),
    /blockedSlotId/,
  );
  assert.throws(
    () => validateBlockedSlotInput({
      blockedSlotId: "slot-1",
      date: "2026-06-10",
      slotStart: "2026-06-11T09:00:00.000Z",
      slotEnd: "2026-06-11T10:00:00.000Z",
    }),
    /match the selected date/,
  );
  assert.throws(
    () => validateBlockedSlotInput({
      blockedSlotId: "slot-1",
      date: "2026-06-10",
      slotStart: "2026-06-10T11:00:00.000Z",
      slotEnd: "2026-06-10T10:00:00.000Z",
    }),
    /after start time/,
  );
  assert.deepEqual(validateBlockedSlotClearInput({blockedSlotId: "slot-1"}), {
    blockedSlotId: "slot-1",
  });
});

function doc(data, id = undefined) {
  return {
    id,
    data: () => data,
  };
}
