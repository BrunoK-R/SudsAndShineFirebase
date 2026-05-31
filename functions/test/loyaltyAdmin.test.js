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
});

test("buildLoyaltySettings maps nested legacy settings", () => {
  const settings = buildLoyaltySettings(doc({
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
