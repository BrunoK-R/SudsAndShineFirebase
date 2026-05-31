const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildBookingPolicy,
  buildBookingPolicySettingValue,
  pendingExpiresAtForPolicy,
  validateBookingPolicyUpdateInput,
} = require("../bookingPolicyAdmin");

test("buildBookingPolicy returns safe defaults when no policy is configured", () => {
  const policy = buildBookingPolicy(null);

  assert.equal(policy.pendingHoldMinutes, 1440);
  assert.equal(policy.cancellationWindowMinutes, 0);
  assert.equal(policy.rescheduleWindowMinutes, 0);
  assert.equal(policy.source, "default");
});

test("buildBookingPolicy maps configured policy with legacy keys", () => {
  const policy = buildBookingPolicy(doc({
    value: {
      pending_hold_minutes: "180",
      cancellation_window_minutes: "120",
      reschedule_window_minutes: "90",
      payment_eligibility_copy: "  Pago   no local  ",
    },
  }));

  assert.deepEqual(policy, {
    pendingHoldMinutes: 180,
    cancellationWindowMinutes: 120,
    rescheduleWindowMinutes: 90,
    paymentEligibilityCopy: "Pago no local",
    source: "firestore",
  });
});

test("validateBookingPolicyUpdateInput sanitizes admin settings", () => {
  const policy = validateBookingPolicyUpdateInput({
    pendingHoldMinutes: "240",
    cancellationWindowMinutes: "120",
    rescheduleWindowMinutes: 60,
    paymentEligibilityCopy: "  Confirmado   após validação  ",
  });

  assert.deepEqual(policy, {
    pendingHoldMinutes: 240,
    cancellationWindowMinutes: 120,
    rescheduleWindowMinutes: 60,
    paymentEligibilityCopy: "Confirmado após validação",
  });
  assert.deepEqual(buildBookingPolicySettingValue(policy), {
    pendingHoldMinutes: 240,
    cancellationWindowMinutes: 120,
    rescheduleWindowMinutes: 60,
    paymentEligibilityCopy: "Confirmado após validação",
  });
});

test("validateBookingPolicyUpdateInput rejects unsafe settings", () => {
  assert.throws(
    () => validateBookingPolicyUpdateInput({
      pendingHoldMinutes: 5,
      cancellationWindowMinutes: 0,
      rescheduleWindowMinutes: 0,
      paymentEligibilityCopy: "Pagamento no local",
    }),
    /pendingHoldMinutes/,
  );

  assert.throws(
    () => validateBookingPolicyUpdateInput({
      pendingHoldMinutes: 60,
      cancellationWindowMinutes: 0,
      rescheduleWindowMinutes: 0,
      paymentEligibilityCopy: "",
    }),
    /paymentEligibilityCopy/,
  );
});

test("pendingExpiresAtForPolicy uses configured hold duration", () => {
  assert.equal(
    pendingExpiresAtForPolicy(
      {pendingHoldMinutes: 90},
      new Date("2026-05-20T10:00:00.000Z"),
    ).toISOString(),
    "2026-05-20T11:30:00.000Z",
  );
});

function doc(data) {
  return {
    exists: true,
    data: () => data,
  };
}
