const admin = require("firebase-admin");
const {setGlobalOptions, logger} = require("firebase-functions/v2");
const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({
  maxInstances: 10,
  region: "europe-west1",
});

function assertString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
}

function parseISODateTime(value, fieldName) {
  assertString(value, fieldName);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpsError("invalid-argument", `${fieldName} must be a valid ISO date string`);
  }
  return parsed;
}

function generateReservationCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "SS-";
  for (let i = 0; i < 8; i += 1) {
    const idx = Math.floor(Math.random() * alphabet.length);
    code += alphabet[idx];
  }
  return code;
}

async function userRoleFromAuth(context) {
  const auth = context.auth;
  if (!auth) return null;
  return auth.token.role || null;
}

async function getAllowlistedRole(email) {
  const snap = await db.collection("admin_allowlist").doc(email).get();
  if (!snap.exists) return null;
  const role = snap.get("role");
  if (role === "admin" || role === "employee") return role;
  return null;
}

exports.createReservation = onCall(async (request) => {
  const data = request.data || {};

  assertString(data.customerName, "customerName");
  assertString(data.customerEmail, "customerEmail");
  assertString(data.serviceId, "serviceId");
  assertString(data.slotStart, "slotStart");
  assertString(data.slotEnd, "slotEnd");

  const slotStart = parseISODateTime(data.slotStart, "slotStart");
  const slotEnd = parseISODateTime(data.slotEnd, "slotEnd");

  if (slotEnd <= slotStart) {
    throw new HttpsError("invalid-argument", "slotEnd must be after slotStart");
  }

  const dateKey = slotStart.toISOString().slice(0, 10);

  const reservationRef = db.collection("reservations").doc();
  const reservationCode = generateReservationCode();

  await db.runTransaction(async (tx) => {
    const reservationsQuery = db
      .collection("reservations")
      .where("date", "==", dateKey)
      .where("status", "in", ["pending", "confirmed"]);

    const blockedQuery = db.collection("blocked_slots").where("date", "==", dateKey);

    const [reservationsSnap, blockedSnap] = await Promise.all([
      tx.get(reservationsQuery),
      tx.get(blockedQuery),
    ]);

    const overlaps = (existingStart, existingEnd) => {
      return slotStart < existingEnd && slotEnd > existingStart;
    };

    for (const doc of reservationsSnap.docs) {
      const item = doc.data();
      if (!item.slotStart || !item.slotEnd) continue;
      const existingStart = new Date(item.slotStart);
      const existingEnd = new Date(item.slotEnd);
      if (overlaps(existingStart, existingEnd)) {
        throw new HttpsError("already-exists", "Selected time slot is unavailable");
      }
    }

    for (const doc of blockedSnap.docs) {
      const item = doc.data();
      if (!item.slotStart || !item.slotEnd) continue;
      const existingStart = new Date(item.slotStart);
      const existingEnd = new Date(item.slotEnd);
      if (overlaps(existingStart, existingEnd)) {
        throw new HttpsError("already-exists", "Selected time slot is blocked");
      }
    }

    tx.set(reservationRef, {
      reservationCode,
      customerName: data.customerName.trim(),
      customerEmail: data.customerEmail.trim().toLowerCase(),
      customerPhone: typeof data.customerPhone === "string" ? data.customerPhone.trim() : "",
      serviceId: data.serviceId,
      serviceName: typeof data.serviceName === "string" ? data.serviceName : "",
      slotStart: slotStart.toISOString(),
      slotEnd: slotEnd.toISOString(),
      date: dateKey,
      status: "pending",
      notes: typeof data.notes === "string" ? data.notes : "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "public-booking",
    });
  });

  // Fire-and-forget email workflow. Booking success should not depend on email.
  sendReservationEmails({
    reservationCode,
    customerName: data.customerName,
    customerEmail: data.customerEmail,
    slotStart: slotStart.toISOString(),
    slotEnd: slotEnd.toISOString(),
  }).catch((err) => {
    logger.error("Email workflow failed", {
      reservationCode,
      message: err?.message,
    });
  });

  return {
    ok: true,
    reservationId: reservationRef.id,
    reservationCode,
  };
});

exports.assignAdminRole = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const callerRole = await userRoleFromAuth(request);
  if (callerRole !== "admin") {
    throw new HttpsError("permission-denied", "Admin role required");
  }

  assertString(request.data.email, "email");
  assertString(request.data.role, "role");

  const email = request.data.email.trim().toLowerCase();
  const role = request.data.role;

  if (!["admin", "employee"].includes(role)) {
    throw new HttpsError("invalid-argument", "role must be admin or employee");
  }

  const user = await admin.auth().getUserByEmail(email);
  await admin.auth().setCustomUserClaims(user.uid, {role});

  await db.collection("admin_allowlist").doc(email).set(
    {
      email,
      role,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedByUid: request.auth.uid,
    },
    {merge: true},
  );

  return {ok: true, uid: user.uid, role};
});

exports.syncMyRole = onCall(async (request) => {
  if (!request.auth?.token?.email) {
    throw new HttpsError("unauthenticated", "Authentication with email is required");
  }

  const email = String(request.auth.token.email).trim().toLowerCase();
  const role = await getAllowlistedRole(email);

  if (!role) {
    await admin.auth().setCustomUserClaims(request.auth.uid, {});
    throw new HttpsError("permission-denied", "User is not allowlisted for admin access");
  }

  await admin.auth().setCustomUserClaims(request.auth.uid, {role});
  return {ok: true, uid: request.auth.uid, email, role};
});

exports.health = onRequest((req, res) => {
  res.status(200).json({ok: true, service: "sudsandshine-firebase", now: new Date().toISOString()});
});

async function sendReservationEmails(payload) {
  // TODO(DIGS-9): Wire provider credentials (SendGrid/Resend/etc) using secrets.
  // Keep logging + retry policy explicit.
  logger.info("Reservation email workflow placeholder", payload);
}
