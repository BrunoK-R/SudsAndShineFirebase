const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertRedeemableLoyaltyRedemption,
  buildLoyaltyRewardCode,
  buildUserLoyalty,
  isCompletedLoyaltyWash,
  normalizeRewardCodeInput,
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

test("buildUserLoyalty respects configured stamp target and reward copy", () => {
  const loyalty = buildUserLoyalty({
    now: new Date("2026-05-20T12:00:00.000Z"),
    loyaltySettings: {
      stampsRequired: 8,
      rewardType: "discount_percent",
      rewardValue: 15,
      rewardDescription: "15% de desconto",
    },
    reservationDocs: Array.from({length: 8}, (_, index) =>
      completedReservation(`reservation-${index + 1}`, index + 1),
    ),
  });

  assert.equal(loyalty.targetWashes, 8);
  assert.equal(loyalty.availableRewards, 1);
  assert.equal(loyalty.rewardType, "discount_percent");
  assert.equal(loyalty.rewardValue, 15);
  assert.equal(loyalty.rewardDescription, "15% de desconto");
});

test("buildUserLoyalty counts only explicitly completed reservations", () => {
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
  assert.equal(isCompletedLoyaltyWash({
    status: "pending",
    slotEnd: "2026-05-10T09:45:00.000Z",
  }, new Date("2026-05-20T12:00:00.000Z")), false);
  assert.equal(loyalty.totalWashes, 1);
  assert.deepEqual(
    loyalty.stampHistory.map((item) => item.id),
    ["completed"],
  );
});

test("buildLoyaltyRewardCode is deterministic for a user reward number", () => {
  assert.equal(buildLoyaltyRewardCode("uid-1234", 2), "SS-FREE-1234-0002");
});

test("normalizeRewardCodeInput removes spaces and uppercases codes", () => {
  assert.equal(normalizeRewardCodeInput(" ss-free-uid1-0001 "), "SS-FREE-UID1-0001");
  assert.equal(normalizeRewardCodeInput("SS FREE UID1 0001"), "SSFREEUID10001");
});

test("assertRedeemableLoyaltyRedemption accepts issued user rewards", () => {
  const redemption = assertRedeemableLoyaltyRedemption(
    doc("reward-0001", {
      ownerUid: "uid-1",
      rewardCode: "ss-free-uid1-0001",
      rewardNumber: 1,
      status: "issued",
    }),
    "uid-1",
  );

  assert.equal(redemption.id, "reward-0001");
  assert.equal(redemption.rewardCode, "SS-FREE-UID1-0001");
  assert.equal(redemption.rewardNumber, 1);
});

test("assertRedeemableLoyaltyRedemption rejects used rewards", () => {
  assert.throws(() => {
    assertRedeemableLoyaltyRedemption(
      doc("reward-0001", {
        ownerUid: "uid-1",
        rewardCode: "SS-FREE-UID1-0001",
        rewardNumber: 1,
        status: "redeemed",
      }),
      "uid-1",
    );
  }, /already been used/);
});

test("assertRedeemableLoyaltyRedemption rejects rewards for another user", () => {
  assert.throws(() => {
    assertRedeemableLoyaltyRedemption(
      doc("reward-0001", {
        ownerUid: "uid-2",
        rewardCode: "SS-FREE-UID1-0001",
        rewardNumber: 1,
        status: "issued",
      }),
      "uid-1",
    );
  }, /another user/);
});
