const {HttpsError} = require("firebase-functions/v2/https");

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return role === "admin" || role === "employee" ? role : null;
}

function authenticatedEmail(request) {
  return String(request?.auth?.token?.email || "").trim().toLowerCase();
}

function userRoleFromAuth(request) {
  return normalizeRole(request?.auth?.token?.role);
}

async function getAllowlistedRole(db, email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return null;

  const snap = await db.collection("admin_allowlist").doc(normalizedEmail).get();
  if (!snap.exists) return null;
  return normalizeRole(snap.get("role"));
}

async function effectiveRoleFromRequest(db, request) {
  if (!request?.auth) return null;

  const email = authenticatedEmail(request);
  if (email) {
    return getAllowlistedRole(db, email);
  }

  return userRoleFromAuth(request);
}

async function assertAdminRequest(db, request) {
  if (!request?.auth) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const role = await effectiveRoleFromRequest(db, request);
  if (role !== "admin") {
    throw new HttpsError("permission-denied", "Admin role required");
  }
  return role;
}

module.exports = {
  assertAdminRequest,
  authenticatedEmail,
  effectiveRoleFromRequest,
  getAllowlistedRole,
  normalizeRole,
  userRoleFromAuth,
};
