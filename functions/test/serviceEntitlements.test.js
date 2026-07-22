const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertEntitlementUsageAdjustment,
  buildServiceEntitlementList,
  effectiveEntitlementStatus,
  validateAdminEntitlementIssueInput,
  validateAdminEntitlementUsageInput,
} = require("../serviceEntitlements");

function doc(id, data, exists = true) {
  return {id, exists, data: () => data};
}

test("validates a staff-issued package with explicit commercial terms", () => {
  assert.deepEqual(validateAdminEntitlementIssueInput({
    operationId: "issue-12345678",
    customerEmail: " Client@Example.com ",
    kind: "package",
    name: " Pacote 5 lavagens ",
    totalUses: 5,
    validDays: 180,
    amountPaidCents: 10000,
    eligibleServiceIds: ["standard", "standard", "exterior"],
    staffNote: "Pago ao balcão por MB Way",
  }), {
    operationId: "issue-12345678",
    customerEmail: "client@example.com",
    kind: "package",
    name: "Pacote 5 lavagens",
    totalUses: 5,
    validDays: 180,
    amountPaidCents: 10000,
    eligibleServiceIds: ["standard", "exterior"],
    staffNote: "Pago ao balcão por MB Way",
  });
});

test("rejects unsafe entitlement issuance and usage inputs", () => {
  assert.throws(() => validateAdminEntitlementIssueInput({customerEmail: "bad"}), /valid/);
  assert.throws(() => validateAdminEntitlementIssueInput({
    operationId: "issue-12345678",
    customerEmail: "client@example.com",
    kind: "subscription",
    name: "Plan",
    totalUses: 5,
    validDays: 30,
    eligibleServiceIds: ["standard"],
    staffNote: "Counter sale",
  }), /package or membership/);
  assert.throws(() => validateAdminEntitlementUsageInput({
    operationId: "usage-12345678",
    customerEmail: "client@example.com",
    entitlementId: "plan/unsafe",
    deltaUses: 1,
    staffNote: "Used",
  }), /invalid/);
});

test("derives active, exhausted, expired, and revoked statuses", () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const base = {
    totalUses: 5,
    usedUses: 1,
    validFrom: "2026-07-01T00:00:00.000Z",
    validUntil: "2026-08-01T00:00:00.000Z",
  };
  assert.equal(effectiveEntitlementStatus(base, now), "active");
  assert.equal(effectiveEntitlementStatus({...base, usedUses: 5}, now), "exhausted");
  assert.equal(effectiveEntitlementStatus({...base, validUntil: "2026-07-20T00:00:00.000Z"}, now), "expired");
  assert.equal(effectiveEntitlementStatus({...base, status: "revoked"}, now), "revoked");
});

test("builds a privacy-scoped customer list and orders usable plans first", () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const base = {
    ownerUid: "uid-1",
    ownerEmail: "client@example.com",
    kind: "package",
    name: "Pacote 5",
    totalUses: 5,
    eligibleServiceIds: ["standard"],
    validFrom: "2026-07-01T00:00:00.000Z",
    validUntil: "2026-08-01T00:00:00.000Z",
  };
  const plans = buildServiceEntitlementList([
    doc("expired", {...base, usedUses: 1, validUntil: "2026-07-10T00:00:00.000Z"}),
    doc("active", {...base, usedUses: 2}),
  ], now);
  assert.equal(plans[0].id, "active");
  assert.equal(plans[0].remainingUses, 3);
  assert.equal(plans[0].onlinePurchaseAvailable, false);
  assert.equal(plans[0].ownerUid, undefined);
  assert.equal(plans[0].ownerEmail, undefined);
  assert.equal(plans[1].status, "expired");
});

test("usage adjustment prevents underflow and unavailable redemption", () => {
  assert.equal(assertEntitlementUsageAdjustment({status: "active", usedUses: 2, remainingUses: 3}, 1), 3);
  assert.equal(assertEntitlementUsageAdjustment({status: "exhausted", usedUses: 5, remainingUses: 0}, -1), 4);
  assert.throws(
    () => assertEntitlementUsageAdjustment({status: "expired", usedUses: 2, remainingUses: 3}, 1),
    /not available/,
  );
  assert.throws(
    () => assertEntitlementUsageAdjustment({status: "active", usedUses: 0, remainingUses: 5}, -1),
    /no usage/,
  );
});
