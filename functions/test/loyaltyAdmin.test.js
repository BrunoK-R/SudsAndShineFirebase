const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildLoyaltySettings,
  buildLoyaltyRedemptionMetadata,
  buildLoyaltySettingsValue,
  loyaltyDiscountCentsForRedemption,
  validateLoyaltySettingsUpdateInput,
} = require("../loyaltyAdmin");

test("buildLoyaltySettings returns safe defaults when no settings exist", () => {
  const settings = buildLoyaltySettings(null);

  assert.equal(settings.stampsRequired, 10);
  assert.equal(settings.rewardType, "free_wash");
  assert.equal(settings.rewardValue, 1);
  assert.equal(settings.rewardDescription, "1 lavagem grátis");
  assert.equal(settings.source, "default");
  assert.equal(settings.updatedAtIso, "");
  assert.equal(settings.updatedByUid, "");
});

test("buildLoyaltySettings maps nested legacy settings", () => {
  const settings = buildLoyaltySettings(doc({
    updatedAt: new Date("2026-06-01T10:15:00.000Z"),
    updatedByUid: " admin-updated ",
    value: {
      stamps_required: "8",
      reward_type: "discount_percent",
      reward_value: "15",
      reward_description: "  15%   de desconto  ",
    },
  }));

  assert.equal(settings.stampsRequired, 8);
  assert.equal(settings.rewardType, "discount_percent");
  assert.equal(settings.rewardValue, 15);
  assert.equal(settings.rewardDescription, "15% de desconto");
  assert.equal(settings.source, "firestore");
  assert.equal(settings.updatedAtIso, "2026-06-01T10:15:00.000Z");
  assert.equal(settings.updatedByUid, "admin-updated");
});

test("buildLoyaltySettings normalizes timestamp-like audit metadata", () => {
  const fromTimestamp = buildLoyaltySettings(doc({
    updatedAt: {seconds: 1780309800, nanoseconds: 500000000},
    updatedByUid: "admin-ts",
    value: validPayload(),
  }));
  const fromString = buildLoyaltySettings(doc({
    updatedAt: "2026-06-01T12:45:00.000Z",
    updatedByUid: " admin-string ",
    value: validPayload(),
  }));

  assert.equal(fromTimestamp.updatedAtIso, "2026-06-01T10:30:00.500Z");
  assert.equal(fromTimestamp.updatedByUid, "admin-ts");
  assert.equal(fromString.updatedAtIso, "2026-06-01T12:45:00.000Z");
  assert.equal(fromString.updatedByUid, "admin-string");
});

test("validateLoyaltySettingsUpdateInput sanitizes admin settings", () => {
  const settings = validateLoyaltySettingsUpdateInput({
    stampsRequired: "8",
    rewardType: "discount amount",
    rewardValue: "1500",
    rewardDescription: "  15 euros   de desconto  ",
  });

  assert.deepEqual(settings, {
    stampsRequired: 8,
    rewardType: "discount_amount",
    rewardValue: 1500,
    rewardDescription: "15 euros de desconto",
  });
  assert.deepEqual(buildLoyaltySettingsValue(settings), {
    stampsRequired: 8,
    rewardType: "discount_amount",
    rewardValue: 1500,
    rewardDescription: "15 euros de desconto",
  });
});

test("validateLoyaltySettingsUpdateInput rejects unsafe settings", () => {
  assert.throws(
    () => validateLoyaltySettingsUpdateInput({
      stampsRequired: 0,
      rewardType: "free_wash",
      rewardValue: 1,
      rewardDescription: "Lavagem grátis",
    }),
    /stampsRequired/,
  );

  assert.throws(
    () => validateLoyaltySettingsUpdateInput({
      stampsRequired: 8,
      rewardType: "javascript:alert",
      rewardValue: 1,
      rewardDescription: "Lavagem grátis",
    }),
    /rewardType/,
  );

  assert.throws(
    () => validateLoyaltySettingsUpdateInput({
      stampsRequired: 8,
      rewardType: "discount_percent",
      rewardValue: 150,
      rewardDescription: "Desconto",
    }),
    /rewardValue/,
  );
});

test("buildLoyaltyRedemptionMetadata snapshots current reward settings", () => {
  assert.deepEqual(
    buildLoyaltyRedemptionMetadata({
      stampsRequired: 8,
      rewardType: "discount_amount",
      rewardValue: 1500,
      rewardDescription: "15 euros de desconto",
    }),
    {
      rewardType: "discount_amount",
      rewardValue: 1500,
      rewardDescription: "15 euros de desconto",
    },
  );
});

test("loyaltyDiscountCentsForRedemption applies stored reward behavior", () => {
  assert.equal(
    loyaltyDiscountCentsForRedemption({rewardType: "free_wash", rewardValue: 1}, 3200),
    3200,
  );
  assert.equal(
    loyaltyDiscountCentsForRedemption({rewardType: "discount_amount", rewardValue: 1500}, 3200),
    1500,
  );
  assert.equal(
    loyaltyDiscountCentsForRedemption({rewardType: "discount_percent", rewardValue: 25}, 3200),
    800,
  );
});

function doc(data) {
  return {
    exists: true,
    data: () => data,
  };
}

function validPayload() {
  return {
    stampsRequired: 8,
    rewardType: "discount_amount",
    rewardValue: 1500,
    rewardDescription: "15 euros de desconto",
  };
}
