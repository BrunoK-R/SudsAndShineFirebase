const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildLoyaltyRewardCode,
  buildUserLoyalty,
  isCompletedLoyaltyWash,
} = require("../loyalty");

function doc(id, data, exists = true) {
  return {
    id,
    exists,
    data: () => data,
  };
}

function completedReservation(id, day = 1) {
  return doc(id, {
    serviceId: "premium",
    serviceName: "Lavagem Premium",
    slotStart: `2026-05-${String(day).padStart(2, "0")}T09:00:00.000Z`,
    slotEnd: `2026-05-${String(day).padStart(2, "0")}T09:45:00.000Z`,
    status: "completed",
  });
}

test("buildUserLoyalty exposes available reward at the reward boundary", () => {
  const loyalty = buildUserLoyalty({
    now: new Date("2026-05-20T12:00:00.000Z"),
    reservationDocs: Array.from({length: 10}, (_, index) =>
      completedReservation(`reservation-${index + 1}`, index + 1),
    ),
  });

  assert.equal(loyalty.totalWashes, 10);
  assert.equal(loyalty.currentWashes, 10);
  assert.equal(loyalty.remainingWashes, 0);
  assert.equal(loyalty.completedRewards, 1);
  assert.equal(loyalty.claimedRewards, 0);
  assert.equal(loyalty.availableRewards, 1);
  assert.equal(loyalty.rewardReady, true);
  assert.equal(loyalty.stampHistory.length, 10);
});

test("buildUserLoyalty subtracts claimed rewards from available rewards", () => {
  const loyalty = buildUserLoyalty({
    now: new Date("2026-05-20T12:00:00.000Z"),
    reservationDocs: Array.from({length: 10}, (_, index) =>
      completedReservation(`reservation-${index + 1}`, index + 1),
    ),
    redemptionDocs: [
      doc("reward-0001", {
        rewardCode: "SS-FREE-UID1-0001",
        rewardNumber: 1,
        status: "issued",
      }),
    ],
  });

  assert.equal(loyalty.totalWashes, 10);
  assert.equal(loyalty.currentWashes, 0);
  assert.equal(loyalty.remainingWashes, 10);
  assert.equal(loyalty.completedRewards, 1);
  assert.equal(loyalty.claimedRewards, 1);
  assert.equal(loyalty.availableRewards, 0);
  assert.equal(loyalty.rewardReady, false);
  assert.equal(loyalty.redemptions.length, 1);
});

test("buildUserLoyalty ignores cancelled reservations and counts past completed slots", () => {
  const loyalty = buildUserLoyalty({
    now: new Date("2026-05-20T12:00:00.000Z"),
    reservationDocs: [
      completedReservation("completed", 1),
      doc("past-pending", {
        serviceId: "standard",
        serviceName: "Lavagem Standard",
        slotStart: "2026-05-10T09:00:00.000Z",
        slotEnd: "2026-05-10T09:45:00.000Z",
        status: "pending",
      }),
      doc("cancelled", {
        serviceId: "standard",
        serviceName: "Lavagem Standard",
        slotStart: "2026-05-11T09:00:00.000Z",
        slotEnd: "2026-05-11T09:45:00.000Z",
        status: "cancelled",
      }),
      doc("future", {
        serviceId: "standard",
        serviceName: "Lavagem Standard",
        slotStart: "2026-05-22T09:00:00.000Z",
        slotEnd: "2026-05-22T09:45:00.000Z",
        status: "pending",
      }),
    ],
  });

  assert.equal(isCompletedLoyaltyWash({status: "cancelled"}, new Date()), false);
  assert.equal(loyalty.totalWashes, 2);
  assert.deepEqual(
    loyalty.stampHistory.map((item) => item.id),
    ["past-pending", "completed"],
  );
});

test("buildLoyaltyRewardCode is deterministic for a user reward number", () => {
  assert.equal(buildLoyaltyRewardCode("uid-1234", 2), "SS-FREE-1234-0002");
});
