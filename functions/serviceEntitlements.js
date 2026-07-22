const {HttpsError} = require("firebase-functions/v2/https");

const ENTITLEMENT_KINDS = new Set(["package", "membership"]);
const ENTITLEMENT_LIMIT = 50;
const MAX_ENTITLEMENT_USES = 100;
const MAX_VALID_DAYS = 730;

function cleanText(value, maxLength = 160) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function timestampToIso(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  return "";
}

function normalizeEmail(value) {
  const email = cleanText(value, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError("invalid-argument", "A valid customer email is required");
  }
  return email;
}

function normalizeDocumentId(value, fieldName = "entitlementId") {
  const id = cleanText(value, 160);
  if (!id || id.includes("/")) {
    throw new HttpsError("invalid-argument", `${fieldName} is invalid`);
  }
  return id;
}

function normalizeOperationId(value) {
  const id = cleanText(value, 120);
  if (!/^[a-zA-Z0-9_-]{8,120}$/.test(id)) {
    throw new HttpsError("invalid-argument", "operationId is invalid");
  }
  return id;
}

function normalizeEligibleServiceIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new HttpsError("invalid-argument", "At least one eligible service is required");
  }
  const result = [];
  for (const rawId of value) {
    const id = cleanText(rawId, 80);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new HttpsError("invalid-argument", "Eligible service id is invalid");
    }
    if (!result.includes(id)) result.push(id);
  }
  if (!result.length) {
    throw new HttpsError("invalid-argument", "At least one eligible service is required");
  }
  return result;
}

function integerInRange(value, fieldName, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpsError("invalid-argument", `${fieldName} must be between ${min} and ${max}`);
  }
  return parsed;
}

function validateAdminEntitlementLookupInput(input) {
  return {customerEmail: normalizeEmail(input?.customerEmail)};
}

function validateAdminEntitlementIssueInput(input) {
  const customerEmail = normalizeEmail(input?.customerEmail);
  const kind = cleanText(input?.kind, 40).toLowerCase();
  if (!ENTITLEMENT_KINDS.has(kind)) {
    throw new HttpsError("invalid-argument", "kind must be package or membership");
  }
  const name = cleanText(input?.name, 120);
  if (name.length < 3) {
    throw new HttpsError("invalid-argument", "Plan name is required");
  }
  const totalUses = integerInRange(input?.totalUses, "totalUses", 1, MAX_ENTITLEMENT_USES);
  const validDays = integerInRange(input?.validDays, "validDays", 1, MAX_VALID_DAYS);
  const amountPaidCents = integerInRange(input?.amountPaidCents ?? 0, "amountPaidCents", 0, 1000000);
  const staffNote = cleanText(input?.staffNote, 500);
  if (!staffNote) {
    throw new HttpsError("invalid-argument", "A staff note is required for the audit trail");
  }
  return {
    operationId: normalizeOperationId(input?.operationId),
    customerEmail,
    kind,
    name,
    totalUses,
    validDays,
    amountPaidCents,
    eligibleServiceIds: normalizeEligibleServiceIds(input?.eligibleServiceIds),
    staffNote,
  };
}

function validateAdminEntitlementUsageInput(input) {
  const deltaUses = Number(input?.deltaUses);
  if (![1, -1].includes(deltaUses)) {
    throw new HttpsError("invalid-argument", "deltaUses must be 1 or -1");
  }
  const staffNote = cleanText(input?.staffNote, 500);
  if (!staffNote) {
    throw new HttpsError("invalid-argument", "A staff note is required for the audit trail");
  }
  return {
    operationId: normalizeOperationId(input?.operationId),
    customerEmail: normalizeEmail(input?.customerEmail),
    entitlementId: normalizeDocumentId(input?.entitlementId),
    deltaUses,
    reservationCode: cleanText(input?.reservationCode, 80).toUpperCase(),
    staffNote,
  };
}

function validateAdminEntitlementRevokeInput(input) {
  const reason = cleanText(input?.reason, 500);
  if (!reason) {
    throw new HttpsError("invalid-argument", "A revocation reason is required");
  }
  return {
    operationId: normalizeOperationId(input?.operationId),
    customerEmail: normalizeEmail(input?.customerEmail),
    entitlementId: normalizeDocumentId(input?.entitlementId),
    reason,
  };
}

function effectiveEntitlementStatus(data, now = new Date()) {
  const storedStatus = cleanText(data?.status || "active", 40).toLowerCase();
  if (storedStatus === "revoked") return "revoked";
  const totalUses = Number(data?.totalUses);
  const usedUses = Number(data?.usedUses);
  if (Number.isInteger(totalUses) && Number.isInteger(usedUses) && usedUses >= totalUses) return "exhausted";
  const validFrom = new Date(timestampToIso(data?.validFrom) || "");
  const validUntil = new Date(timestampToIso(data?.validUntil) || "");
  if (!Number.isNaN(validFrom.getTime()) && now.getTime() < validFrom.getTime()) return "scheduled";
  if (!Number.isNaN(validUntil.getTime()) && now.getTime() > validUntil.getTime()) return "expired";
  return "active";
}

function normalizeServiceEntitlement(docSnap, now = new Date()) {
  if (!docSnap?.exists) return null;
  const data = docSnap.data();
  if (!data || typeof data !== "object") return null;
  const id = cleanText(docSnap.id, 160);
  const ownerUid = cleanText(data.ownerUid, 128);
  const ownerEmail = cleanText(data.ownerEmail, 254).toLowerCase();
  const name = cleanText(data.name, 120);
  const kind = cleanText(data.kind, 40).toLowerCase();
  const totalUses = Number(data.totalUses);
  const usedUsesValue = Number(data.usedUses);
  const usedUses = Number.isInteger(usedUsesValue) ? Math.max(0, usedUsesValue) : 0;
  const validFrom = timestampToIso(data.validFrom);
  const validUntil = timestampToIso(data.validUntil);
  if (
    !id || !ownerUid || !ownerEmail || !name || !ENTITLEMENT_KINDS.has(kind) ||
    !Number.isInteger(totalUses) || totalUses < 1 || totalUses > MAX_ENTITLEMENT_USES ||
    !validFrom || !validUntil
  ) return null;
  return {
    id,
    code: cleanText(data.code, 80),
    ownerUid,
    ownerEmail,
    kind,
    name,
    status: effectiveEntitlementStatus(data, now),
    totalUses,
    usedUses: Math.min(totalUses, usedUses),
    remainingUses: Math.max(0, totalUses - usedUses),
    eligibleServiceIds: Array.isArray(data.eligibleServiceIds) ?
      data.eligibleServiceIds.map((value) => cleanText(value, 80)).filter(Boolean).slice(0, 20) :
      [],
    eligibleServiceNames: Array.isArray(data.eligibleServiceNames) ?
      data.eligibleServiceNames.map((value) => cleanText(value, 120)).filter(Boolean).slice(0, 20) :
      [],
    validFrom,
    validUntil,
    amountPaidCents: Math.max(0, Number(data.amountPaidCents) || 0),
    purchaseMode: "staff_issued",
    onlinePurchaseAvailable: false,
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
    lastUsedAt: timestampToIso(data.lastUsedAt),
    lastReservationCode: cleanText(data.lastReservationCode, 80),
  };
}

function toServiceEntitlementResponse(entitlement) {
  if (!entitlement) return null;
  const {ownerUid: _ownerUid, ownerEmail: _ownerEmail, ...response} = entitlement;
  return response;
}

function buildServiceEntitlementList(docs, now = new Date()) {
  const statusOrder = {active: 0, scheduled: 1, exhausted: 2, expired: 3, revoked: 4};
  return (docs || [])
    .map((docSnap) => normalizeServiceEntitlement(docSnap, now))
    .filter(Boolean)
    .sort((left, right) => {
      const statusDifference = (statusOrder[left.status] ?? 9) - (statusOrder[right.status] ?? 9);
      if (statusDifference !== 0) return statusDifference;
      return right.validUntil.localeCompare(left.validUntil);
    })
    .slice(0, ENTITLEMENT_LIMIT)
    .map(toServiceEntitlementResponse);
}

function assertEntitlementUsageAdjustment(entitlement, deltaUses) {
  if (!entitlement) {
    throw new HttpsError("not-found", "Service plan was not found");
  }
  if (deltaUses === 1) {
    if (entitlement.status !== "active" || entitlement.remainingUses <= 0) {
      throw new HttpsError("failed-precondition", "Service plan is not available for use");
    }
  } else if (entitlement.usedUses <= 0) {
    throw new HttpsError("failed-precondition", "Service plan has no usage to correct");
  }
  return entitlement.usedUses + deltaUses;
}

module.exports = {
  ENTITLEMENT_LIMIT,
  MAX_ENTITLEMENT_USES,
  MAX_VALID_DAYS,
  assertEntitlementUsageAdjustment,
  buildServiceEntitlementList,
  effectiveEntitlementStatus,
  normalizeServiceEntitlement,
  toServiceEntitlementResponse,
  validateAdminEntitlementIssueInput,
  validateAdminEntitlementLookupInput,
  validateAdminEntitlementRevokeInput,
  validateAdminEntitlementUsageInput,
};
