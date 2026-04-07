const admin = require("firebase-admin");
const {setGlobalOptions, logger} = require("firebase-functions/v2");
const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const {
  ACTIVE_RESERVATION_STATUS_VALUES,
  countOverlappingReservations,
  generateDeterministicReservationCode,
  hasBlockedSlotOverlap,
  resolveCapacityLimit,
  validateCreateReservationInput,
} = require("./createReservation");

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
  const data = validateCreateReservationInput(request.data);

  const slotStart = data.slotStart;
  const slotEnd = data.slotEnd;
  const dateKey = slotStart.toISOString().slice(0, 10);

  const reservationRef = db.collection("reservations").doc();
  const reservationCode = generateDeterministicReservationCode(reservationRef.id);

  await db.runTransaction(async (tx) => {
    const reservationsQuery = db
      .collection("reservations")
      .where("date", "==", dateKey)
      .where("status", "in", ACTIVE_RESERVATION_STATUS_VALUES);

    const blockedQuery = db.collection("blocked_slots").where("date", "==", dateKey);
    const capacityOverrideQuery = db
      .collection("capacity_overrides")
      .where("date", "==", dateKey)
      .limit(1);
    const defaultCapacityQuery = db
      .collection("business_settings")
      .where("key", "==", "default_max_bookings_per_slot")
      .limit(1);

    const [reservationsSnap, blockedSnap, capacityOverrideSnap, defaultCapacitySnap] = await Promise.all([
      tx.get(reservationsQuery),
      tx.get(blockedQuery),
      tx.get(capacityOverrideQuery),
      tx.get(defaultCapacityQuery),
    ]);

    const capacityOverride = capacityOverrideSnap.empty ? null : capacityOverrideSnap.docs[0].data();
    const defaultCapacitySetting = defaultCapacitySnap.empty ? null : defaultCapacitySnap.docs[0].data();
    const capacityLimit = resolveCapacityLimit(defaultCapacitySetting, capacityOverride);

    if (capacityLimit <= 0) {
      throw new HttpsError("already-exists", "Selected time slot is unavailable");
    }

    const blockedSlots = blockedSnap.docs.map((docSnap) => docSnap.data());
    if (hasBlockedSlotOverlap(blockedSlots, slotStart, slotEnd)) {
      throw new HttpsError("already-exists", "Selected time slot is blocked");
    }

    const reservations = reservationsSnap.docs.map((docSnap) => docSnap.data());
    const overlappingReservations = countOverlappingReservations(reservations, slotStart, slotEnd);
    if (overlappingReservations >= capacityLimit) {
      throw new HttpsError("already-exists", "Selected time slot is unavailable");
    }

    tx.set(reservationRef, {
      reservationCode,
      customerName: data.customerName,
      customerEmail: data.customerEmail,
      customerPhone: data.customerPhone,
      serviceId: data.serviceId,
      serviceName: data.serviceName,
      slotStart: slotStart.toISOString(),
      slotEnd: slotEnd.toISOString(),
      date: dateKey,
      vehicleType: data.vehicleType,
      gdprConsent: data.gdprConsent,
      status: "pending",
      notes: data.notes,
      internalNotes: "",
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
