const test = require("node:test");
const assert = require("node:assert/strict");
const {
  availableTimesForWaitlist,
  buildUserWaitlist,
  hasWaitlistDateAvailability,
  validateCancelWaitlistInput,
  validateJoinWaitlistInput,
  waitlistEntryId,
} = require("../waitlist");

function doc(id, data) {
  return {id, data: () => data};
}

test("validateJoinWaitlistInput normalizes a future service alert", () => {
  const input = validateJoinWaitlistInput(
    {
      date: "2026-07-25",
      serviceId: " premium ",
      serviceName: " Lavagem   Premium ",
      serviceDurationMinutes: "45",
    },
    new Date("2026-07-22T10:00:00.000Z"),
  );

  assert.deepEqual(input, {
    date: "2026-07-25",
    serviceId: "premium",
    serviceName: "Lavagem Premium",
    serviceDurationMinutes: 45,
  });
});

test("validateJoinWaitlistInput rejects past, distant, and unsafe alerts", () => {
  const now = new Date("2026-07-22T10:00:00.000Z");
  assert.throws(
    () => validateJoinWaitlistInput({
      date: "2026-07-21",
      serviceId: "premium",
      serviceName: "Lavagem Premium",
      serviceDurationMinutes: 45,
    }, now),
    /must not be in the past/,
  );
  assert.throws(
    () => validateJoinWaitlistInput({
      date: "2026-12-31",
      serviceId: "premium",
      serviceName: "Lavagem Premium",
      serviceDurationMinutes: 45,
    }, now),
    /within 120 days/,
  );
  assert.throws(
    () => validateJoinWaitlistInput({
      date: "2026-07-25",
      serviceId: "services/premium",
      serviceName: "Lavagem Premium",
      serviceDurationMinutes: 45,
    }, now),
    /serviceId is invalid/,
  );
});

test("waitlistEntryId is stable per user, date, service, and duration", () => {
  const input = {
    date: "2026-07-25",
    serviceId: "premium",
    serviceName: "Lavagem Premium",
    serviceDurationMinutes: 45,
  };
  const first = waitlistEntryId("user-1", input);
  const repeated = waitlistEntryId("user-1", input);
  const anotherDay = waitlistEntryId("user-1", {...input, date: "2026-07-26"});

  assert.match(first, /^wl_[a-f0-9]{32}$/);
  assert.equal(first, repeated);
  assert.notEqual(first, anotherDay);
});

test("buildUserWaitlist keeps owner entries sorted and normalized", () => {
  const result = buildUserWaitlist([
    doc("wl-2", {
      ownerUid: "user-1",
      date: "2026-07-26",
      serviceId: "premium",
      serviceName: "Lavagem Premium",
      serviceDurationMinutes: 45,
      status: "active",
      createdAt: "2026-07-22T10:00:00.000Z",
    }),
    doc("foreign", {
      ownerUid: "user-2",
      date: "2026-07-24",
      serviceId: "standard",
      serviceName: "Lavagem Standard",
      serviceDurationMinutes: 30,
    }),
    doc("wl-1", {
      ownerUid: "user-1",
      date: "2026-07-25",
      serviceId: "standard",
      serviceName: "Lavagem Standard",
      serviceDurationMinutes: 30,
      status: "notified",
      notifiedAt: "2026-07-23T09:00:00.000Z",
    }),
  ], "user-1");

  assert.deepEqual(result.entries.map((entry) => entry.id), ["wl-1", "wl-2"]);
  assert.equal(result.entries[0].status, "notified");
  assert.equal(result.entries[0].notifiedAt, "2026-07-23T09:00:00.000Z");
  assert.equal(Object.hasOwn(result.entries[0], "ownerUid"), false);
});

test("availability helpers find a reopened day and return only open times", () => {
  const waitlist = {date: "2026-07-25"};
  const availability = {
    days: [
      {
        id: "2026-07-25",
        available: true,
        slots: [
          {time: "09:00", available: false},
          {time: "09:30", available: true},
          {time: "10:00", available: true},
          {time: "10:30", available: true},
          {time: "11:00", available: true},
        ],
      },
    ],
  };

  assert.equal(hasWaitlistDateAvailability(waitlist, availability), true);
  assert.deepEqual(availableTimesForWaitlist(waitlist, availability), ["09:30", "10:00", "10:30"]);
  assert.equal(hasWaitlistDateAvailability({date: "2026-07-26"}, availability), false);
});

test("validateCancelWaitlistInput rejects document paths", () => {
  assert.deepEqual(validateCancelWaitlistInput({waitlistId: " wl-1 "}), {waitlistId: "wl-1"});
  assert.throws(
    () => validateCancelWaitlistInput({waitlistId: "waitlist/wl-1"}),
    /waitlistId is invalid/,
  );
});
