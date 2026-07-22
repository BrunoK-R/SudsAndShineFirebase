const assert = require("node:assert/strict");
const test = require("node:test");
const {
  REFERRAL_ATTRIBUTION_DAYS,
  assertReferralAttributionWindow,
  assertReferralClaimAllowed,
  buildReferralClaimEligibility,
  buildMyReferralProgram,
  buildReferralBonusAdjustment,
  buildReferralCode,
  normalizeReferralCode,
  referralCodeCandidates,
} = require("../referrals");

function doc(id, data, exists = true) {
  return {id, exists, data: () => data};
}

test("referral codes are deterministic, opaque, and have collision candidates", () => {
  const first = buildReferralCode("customer-uid-1");
  assert.match(first, /^SUDS-[A-F0-9]{10}$/);
  assert.equal(buildReferralCode("customer-uid-1"), first);
  const candidates = referralCodeCandidates("customer-uid-1");
  assert.equal(candidates.length, 5);
  assert.equal(new Set(candidates).size, 5);
});

test("normalizeReferralCode accepts readable separators but rejects malformed values", () => {
  assert.equal(normalizeReferralCode(" suds abcd-123456 "), "SUDS-ABCD123456");
  assert.throws(() => normalizeReferralCode("NOT-A-CODE"), /invalid/);
});

test("attribution window accepts a new account and rejects an old account", () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  assert.doesNotThrow(() => assertReferralAttributionWindow({
    metadata: {creationTime: "2026-07-02T12:00:00.000Z"},
  }, now));
  assert.throws(() => assertReferralAttributionWindow({
    metadata: {creationTime: "2026-06-01T12:00:00.000Z"},
  }, now), new RegExp(String(REFERRAL_ATTRIBUTION_DAYS)));
});

test("claim eligibility explains linked and expired attribution states", () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  assert.deepEqual(buildReferralClaimEligibility({
    authUser: {metadata: {creationTime: "2026-07-20T12:00:00.000Z"}},
    now,
  }), {canClaimCode: true, claimIneligibleReason: ""});
  assert.deepEqual(buildReferralClaimEligibility({
    authUser: {metadata: {creationTime: "2026-05-20T12:00:00.000Z"}},
    now,
  }), {canClaimCode: false, claimIneligibleReason: "account_too_old"});
  assert.deepEqual(buildReferralClaimEligibility({
    authUser: {metadata: {creationTime: "2026-07-20T12:00:00.000Z"}},
    hasExistingAttribution: true,
    now,
  }), {canClaimCode: false, claimIneligibleReason: "already_linked"});
});

test("claim guard blocks self-referral, replacement, and claims after a paid completion", () => {
  assert.throws(() => assertReferralClaimAllowed({uid: "same", referrerUid: "same"}), /own/);
  assert.throws(() => assertReferralClaimAllowed({
    uid: "new-user",
    referrerUid: "referrer-2",
    existingReferral: {referrerUid: "referrer-1"},
  }), /already linked/);
  assert.throws(() => assertReferralClaimAllowed({
    uid: "new-user",
    referrerUid: "referrer-1",
    hasEligibleCompletion: true,
  }), /first paid wash/);
  assert.equal(assertReferralClaimAllowed({
    uid: "new-user",
    referrerUid: "referrer-1",
    existingReferral: {referrerUid: "referrer-1"},
  }), "existing");
});

test("program exposes transparent aggregate and invitation status without customer identity", () => {
  const program = buildMyReferralProgram({
    profile: {ownerUid: "owner-1", code: "SUDS-ABCD123456"},
    referredBy: doc("owner-1", {
      referredUid: "owner-1",
      referrerUid: "another-owner",
      code: "SUDS-112233AABB",
      status: "claimed",
      claimedAt: "2026-07-20T09:00:00.000Z",
    }),
    invitedDocs: [
      doc("friend-1", {
        referredUid: "friend-1",
        referrerUid: "owner-1",
        code: "SUDS-ABCD123456",
        status: "qualified",
        claimedAt: "2026-07-01T09:00:00.000Z",
        qualifiedAt: "2026-07-05T09:00:00.000Z",
      }),
      doc("friend-2", {
        referredUid: "friend-2",
        referrerUid: "owner-1",
        code: "SUDS-ABCD123456",
        status: "claimed",
        claimedAt: "2026-07-10T09:00:00.000Z",
      }),
    ],
  });

  assert.equal(program.stats.claimedCount, 2);
  assert.equal(program.stats.qualifiedCount, 1);
  assert.equal(program.stats.pendingCount, 1);
  assert.equal(program.stats.bonusPointsEarned, 1);
  assert.equal(program.referredBy.status, "claimed");
  assert.equal(program.canClaimCode, false);
  assert.equal(program.claimIneligibleReason, "already_linked");
  assert.equal(program.invitations[0].referredUid, undefined);
  assert.match(program.invitations[0].id, /^invite-[a-f0-9]{12}$/);
  assert.notEqual(program.invitations[0].id, "friend-1");
});

test("referral bonus adjustments are auditable and role-specific", () => {
  const timestamp = "2026-07-22T12:00:00.000Z";
  const adjustment = buildReferralBonusAdjustment({
    ownerUid: "owner-1",
    relatedUid: "friend-1",
    role: "referrer",
    timestamp,
  });
  assert.equal(adjustment.points, 1);
  assert.equal(adjustment.source, "referral");
  assert.equal(adjustment.referralRole, "referrer");
  assert.match(adjustment.label, /amigo/);
});
