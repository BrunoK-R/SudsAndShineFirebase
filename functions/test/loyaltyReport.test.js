const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildAdminLoyaltyReport,
  reservationEarnedStamp,
  rewardEventKind,
} = require("../loyaltyReport");

function doc(id, data) {
  return {id, data: () => data};
}

function completedReservation(index, overrides = {}) {
  const day = String(index).padStart(2, "0");
  return doc(`reservation-${index}`, {
    reservationCode: `SS-${index}`,
    status: "completed",
    customerUid: "user-1",
    customerName: "Bruno Ribeiro",
    customerEmail: "bruno@example.com",
    serviceName: "Lavagem Standard",
    slotStart: `2026-07-${day}T09:00:00.000Z`,
    slotEnd: `2026-07-${day}T09:30:00.000Z`,
    completedAt: `2026-07-${day}T09:30:00.000Z`,
    priceCents: 2500,
    loyaltyStampGranted: true,
    ...overrides,
  });
}

test("buildAdminLoyaltyReport marks the reward boundary and current totals", () => {
  const report = buildAdminLoyaltyReport({
    reservationDocs: Array.from({length: 10}, (_, index) => completedReservation(index + 1)),
    loyaltySettings: {stampsRequired: 10},
  });

  assert.equal(report.summary.qualifyingWashes, 10);
  assert.equal(report.summary.rewardsEarned, 1);
  assert.equal(report.summary.estimatedAvailableRewards, 1);
  assert.equal(report.summary.activeCustomers, 1);
  const reward = report.events.find((event) => event.kind === "reward_earned");
  assert.equal(reward.rewardNumber, 1);
  assert.equal(reward.rewardCode, "SS-FREE-SER1-0001");
  assert.equal(reward.stampPosition, 10);
});

test("buildAdminLoyaltyReport audits reserved redeemed and released rewards", () => {
  const report = buildAdminLoyaltyReport({
    reservationDocs: [
      completedReservation(1, {
        loyaltyRewardApplied: true,
        loyaltyStampGranted: false,
        loyaltyRewardCode: "SS-FREE-ER1X-0001",
        priceCents: 0,
      }),
      completedReservation(2, {
        status: "confirmed",
        loyaltyRewardApplied: true,
        loyaltyStampGranted: null,
        loyaltyRewardCode: "SS-FREE-ER1X-0002",
      }),
      completedReservation(3, {
        status: "cancelled",
        loyaltyRewardApplied: true,
        loyaltyStampGranted: null,
        loyaltyRewardCode: "SS-FREE-ER1X-0003",
      }),
    ],
  });

  assert.equal(report.summary.qualifyingWashes, 0);
  assert.equal(report.summary.rewardsRedeemed, 1);
  assert.equal(report.summary.rewardsReserved, 1);
  assert.equal(report.summary.rewardsReleased, 1);
  assert.deepEqual(
    new Set(report.events.map((event) => event.kind)),
    new Set(["reward_redeemed", "reward_reserved", "reward_released"]),
  );
});

test("legacy paid completions earn stamps while free and explicitly skipped washes do not", () => {
  assert.equal(reservationEarnedStamp({
    status: "completed",
    loyaltyRewardApplied: false,
    loyaltyStampGranted: null,
    priceCents: 2500,
  }), true);
  assert.equal(reservationEarnedStamp({
    status: "completed",
    loyaltyRewardApplied: false,
    loyaltyStampGranted: false,
    priceCents: 2500,
  }), false);
  assert.equal(reservationEarnedStamp({
    status: "completed",
    loyaltyRewardApplied: true,
    loyaltyStampGranted: true,
    priceCents: 0,
  }), false);
});

test("rewardEventKind follows the reservation lifecycle", () => {
  assert.equal(rewardEventKind({status: "pending", loyaltyRewardApplied: true}), "reward_reserved");
  assert.equal(rewardEventKind({status: "completed", loyaltyRewardApplied: true}), "reward_redeemed");
  assert.equal(rewardEventKind({status: "expired", loyaltyRewardApplied: true}), "reward_released");
  assert.equal(rewardEventKind({status: "completed", loyaltyRewardApplied: false}), "");
});
