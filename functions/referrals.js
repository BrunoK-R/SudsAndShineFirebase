const crypto = require("node:crypto");
const {HttpsError} = require("firebase-functions/v2/https");

const REFERRAL_ATTRIBUTION_DAYS = 30;
const REFERRAL_BONUS_POINTS = 1;
const REFERRAL_CODE_CANDIDATE_COUNT = 5;
const REFERRAL_CODE_PREFIX = "SUDS";
const REFERRAL_CODE_SUFFIX_LENGTH = 10;
const REFERRAL_INVITE_LIMIT = 100;

function timestampToIsoString(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  return "";
}

function buildReferralCode(uid, attempt = 0) {
  const normalizedUid = String(uid || "").trim();
  if (!normalizedUid) {
    throw new HttpsError("invalid-argument", "Referral owner is required");
  }
  const normalizedAttempt = Number.isInteger(attempt) && attempt >= 0 ? attempt : 0;
  const suffix = crypto
    .createHash("sha256")
    .update(`suds-referral:v1:${normalizedUid}:${normalizedAttempt}`)
    .digest("hex")
    .slice(0, REFERRAL_CODE_SUFFIX_LENGTH)
    .toUpperCase();
  return `${REFERRAL_CODE_PREFIX}-${suffix}`;
}

function referralCodeCandidates(uid, count = REFERRAL_CODE_CANDIDATE_COUNT) {
  const safeCount = Number.isInteger(count) ? Math.max(1, Math.min(20, count)) : REFERRAL_CODE_CANDIDATE_COUNT;
  return Array.from({length: safeCount}, (_, attempt) => buildReferralCode(uid, attempt));
}

function normalizeReferralCode(value) {
  const compact = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const expectedLength = REFERRAL_CODE_PREFIX.length + REFERRAL_CODE_SUFFIX_LENGTH;
  if (compact.length !== expectedLength || !compact.startsWith(REFERRAL_CODE_PREFIX)) {
    throw new HttpsError("invalid-argument", "Referral code is invalid");
  }
  return `${REFERRAL_CODE_PREFIX}-${compact.slice(REFERRAL_CODE_PREFIX.length)}`;
}

function normalizeReferralProfileDocument(doc) {
  if (!doc?.exists) return null;
  const data = doc.data();
  if (!data || typeof data !== "object") return null;
  let code = "";
  try {
    code = normalizeReferralCode(data.code);
  } catch (_) {
    return null;
  }
  return {
    ownerUid: String(data.ownerUid || doc.id || "").trim(),
    code,
    createdAt: timestampToIsoString(data.createdAt),
  };
}

function normalizeReferralDocument(doc) {
  if (!doc?.exists) return null;
  const data = doc.data();
  if (!data || typeof data !== "object") return null;
  const referredUid = String(data.referredUid || doc.id || "").trim();
  const referrerUid = String(data.referrerUid || "").trim();
  if (!referredUid || !referrerUid || referredUid === referrerUid) return null;
  const rawStatus = String(data.status || "claimed").trim().toLowerCase();
  const status = ["claimed", "qualified"].includes(rawStatus) ? rawStatus : "inactive";
  let code = "";
  try {
    code = normalizeReferralCode(data.code);
  } catch (_) {
    return null;
  }
  return {
    id: doc.id,
    referredUid,
    referrerUid,
    code,
    status,
    claimedAt: timestampToIsoString(data.claimedAt || data.createdAt),
    qualifiedAt: timestampToIsoString(data.qualifiedAt),
  };
}

function buildMyReferralProgram({profile, referredBy = null, invitedDocs = []}) {
  if (!profile?.code) {
    throw new HttpsError("failed-precondition", "Referral profile is unavailable");
  }
  const invitations = (invitedDocs || [])
    .map(normalizeReferralDocument)
    .filter((referral) => referral && referral.referrerUid === profile.ownerUid)
    .sort((left, right) => {
      const leftDate = left.qualifiedAt || left.claimedAt;
      const rightDate = right.qualifiedAt || right.claimedAt;
      return rightDate.localeCompare(leftDate);
    })
    .slice(0, REFERRAL_INVITE_LIMIT)
    .map((referral) => ({
      id: `invite-${crypto.createHash("sha256")
        .update(`suds-referral-public:v1:${referral.id}`)
        .digest("hex")
        .slice(0, 12)}`,
      status: referral.status,
      claimedAt: referral.claimedAt,
      qualifiedAt: referral.qualifiedAt,
    }));
  const qualifiedCount = invitations.filter((item) => item.status === "qualified").length;
  const claimedCount = invitations.length;
  const normalizedReferredBy = referredBy ? normalizeReferralDocument(referredBy) : null;

  return {
    code: profile.code,
    shareMessage: `Use o meu código ${profile.code} na app Suds & Shine. Depois da primeira lavagem paga concluída, recebemos ambos 1 selo extra.`,
    rewardPoints: REFERRAL_BONUS_POINTS,
    attributionDays: REFERRAL_ATTRIBUTION_DAYS,
    referredBy: normalizedReferredBy ? {
      code: normalizedReferredBy.code,
      status: normalizedReferredBy.status,
      claimedAt: normalizedReferredBy.claimedAt,
      qualifiedAt: normalizedReferredBy.qualifiedAt,
    } : null,
    stats: {
      claimedCount,
      qualifiedCount,
      pendingCount: Math.max(0, claimedCount - qualifiedCount),
      bonusPointsEarned: qualifiedCount * REFERRAL_BONUS_POINTS,
    },
    invitations,
  };
}

function assertReferralAttributionWindow(authUser, now = new Date()) {
  const creationTime = authUser?.metadata?.creationTime;
  const createdAt = new Date(creationTime || "");
  if (Number.isNaN(createdAt.getTime())) {
    throw new HttpsError("failed-precondition", "Account creation date is unavailable");
  }
  const ageMilliseconds = now.getTime() - createdAt.getTime();
  const windowMilliseconds = REFERRAL_ATTRIBUTION_DAYS * 24 * 60 * 60 * 1000;
  if (ageMilliseconds < 0 || ageMilliseconds > windowMilliseconds) {
    throw new HttpsError(
      "failed-precondition",
      `Referral codes must be added within ${REFERRAL_ATTRIBUTION_DAYS} days of account creation`,
    );
  }
}

function assertReferralClaimAllowed({uid, referrerUid, existingReferral = null, hasEligibleCompletion = false}) {
  if (!uid || !referrerUid) {
    throw new HttpsError("not-found", "Referral code was not found");
  }
  if (uid === referrerUid) {
    throw new HttpsError("failed-precondition", "You cannot use your own referral code");
  }
  if (existingReferral) {
    if (existingReferral.referrerUid === referrerUid) return "existing";
    throw new HttpsError("already-exists", "A referral code is already linked to this account");
  }
  if (hasEligibleCompletion) {
    throw new HttpsError("failed-precondition", "Referral codes must be added before the first paid wash is completed");
  }
  return "create";
}

function buildReferralBonusAdjustment({ownerUid, relatedUid, role, timestamp}) {
  const normalizedRole = role === "referrer" ? "referrer" : "referred";
  return {
    ownerUid,
    points: REFERRAL_BONUS_POINTS,
    status: "active",
    source: "referral",
    referralRole: normalizedRole,
    relatedUid,
    label: normalizedRole === "referrer" ? "Bónus por amigo indicado" : "Bónus de boas-vindas por indicação",
    occurredAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

module.exports = {
  REFERRAL_ATTRIBUTION_DAYS,
  REFERRAL_BONUS_POINTS,
  REFERRAL_CODE_CANDIDATE_COUNT,
  REFERRAL_INVITE_LIMIT,
  assertReferralAttributionWindow,
  assertReferralClaimAllowed,
  buildMyReferralProgram,
  buildReferralBonusAdjustment,
  buildReferralCode,
  normalizeReferralCode,
  normalizeReferralDocument,
  normalizeReferralProfileDocument,
  referralCodeCandidates,
};
