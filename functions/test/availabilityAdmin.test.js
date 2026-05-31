const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildAdminAvailabilityConfig,
  buildCapacityOverrideDocument,
  readDefaultCapacity,
  validateAvailabilityConfigurationInput,
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
      doc({date: "2026-06-11", maxBookingsPerSlot: 0}),
      doc({date: "2026-06-10", max_bookings_per_slot: "4"}),
      doc({date: "2026-06-12", maxBookingsPerSlot: 8, active: false}),
    ],
  });

  assert.equal(config.defaultMaxBookingsPerSlot, 3);
  assert.equal(config.openingHours.length, 2);
  assert.equal(config.openingHours[0].dayLabel, "Segunda a Sexta");
  assert.deepEqual(config.capacityOverrides, [
    {date: "2026-06-10", maxBookingsPerSlot: 4},
    {date: "2026-06-11", maxBookingsPerSlot: 0},
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

function doc(data) {
  return {
    data: () => data,
  };
}
