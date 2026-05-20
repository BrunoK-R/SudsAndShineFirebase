const admin = require("firebase-admin");
const {setGlobalOptions, logger} = require("firebase-functions/v2");
const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const {
  ACTIVE_RESERVATION_STATUS_VALUES,
  buildAvailabilityMonth,
  countOverlappingReservations,
  generateDeterministicReservationCode,
  hasBlockedSlotOverlap,
  resolveCapacityLimit,
  resolveAvailabilityRequest,
  validateCreateReservationInput,
} = require("./createReservation");
const {
  assertCatalogReadable,
  buildServiceCatalog,
} = require("./serviceCatalog");
const {
  buildUserReservationHistory,
} = require("./reservationHistory");
const {
  assertVehicleId,
  buildUserVehicleList,
  normalizeVehicleDocument,
  validateVehiclePayload,
} = require("./vehicleRegistry");
const {
  buildUserProfile,
  validateUserProfilePayload,
} = require("./userProfile");
const {
  assertReservationReviewable,
  buildReservationReviewDocument,
  buildReservationReviewId,
  validateReservationReviewInput,
} = require("./reservationReviews");

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

function assertAuthenticatedUid(request) {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }
  return uid;
}

function userVehiclesCollection(uid) {
  return db.collection("users").doc(uid).collection("vehicles");
}

function userDocument(uid) {
  return db.collection("users").doc(uid);
}

function reservationVehicleTypeForComparison(vehicleType) {
  return vehicleType === "passageiros" ? "passenger" : vehicleType;
}

exports.createReservation = onCall(async (request) => {
  const data = validateCreateReservationInput(request.data);
  const authenticatedUid = request.auth?.uid || null;

  const slotStart = data.slotStart;
  const slotEnd = data.slotEnd;
  const dateKey = slotStart.toISOString().slice(0, 10);

  const reservationRef = db.collection("reservations").doc();
  const reservationCode = generateDeterministicReservationCode(reservationRef.id);

  if (data.userVehicleId && !authenticatedUid) {
    throw new HttpsError("unauthenticated", "Authentication required for saved vehicle reservations");
  }

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
    const userVehicleRef = data.userVehicleId ?
      userVehiclesCollection(authenticatedUid).doc(data.userVehicleId) :
      null;

    const [
      reservationsSnap,
      blockedSnap,
      capacityOverrideSnap,
      defaultCapacitySnap,
      userVehicleSnap,
    ] = await Promise.all([
      tx.get(reservationsQuery),
      tx.get(blockedQuery),
      tx.get(capacityOverrideQuery),
      tx.get(defaultCapacityQuery),
      userVehicleRef ? tx.get(userVehicleRef) : Promise.resolve(null),
    ]);

    const capacityOverride = capacityOverrideSnap.empty ? null : capacityOverrideSnap.docs[0].data();
    const defaultCapacitySetting = defaultCapacitySnap.empty ? null : defaultCapacitySnap.docs[0].data();
    const capacityLimit = resolveCapacityLimit(defaultCapacitySetting, capacityOverride);
    let linkedVehicle = null;

    if (data.userVehicleId) {
      if (!userVehicleSnap?.exists) {
        throw new HttpsError("not-found", "Vehicle not found");
      }

      linkedVehicle = normalizeVehicleDocument(userVehicleSnap);
      if (!linkedVehicle) {
        throw new HttpsError("failed-precondition", "Vehicle data is incomplete");
      }
      if (linkedVehicle.type !== reservationVehicleTypeForComparison(data.vehicleType)) {
        throw new HttpsError("invalid-argument", "vehicleType must match the saved vehicle");
      }
    }

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
      customerUid: authenticatedUid,
      serviceId: data.serviceId,
      serviceName: data.serviceName,
      slotStart: slotStart.toISOString(),
      slotEnd: slotEnd.toISOString(),
      date: dateKey,
      vehicleType: data.vehicleType,
      userVehicleId: linkedVehicle?.id || null,
      vehicleLabel: linkedVehicle ? `${linkedVehicle.brand} ${linkedVehicle.model}` : data.vehicleLabel,
      vehiclePlate: linkedVehicle?.plate || "",
      vehicleColor: linkedVehicle?.color || "",
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

exports.getAvailability = onCall(async (request) => {
  const availabilityRequest = resolveAvailabilityRequest(request.data);

  const reservationsQuery = db
    .collection("reservations")
    .where("date", ">=", availabilityRequest.monthStart)
    .where("date", "<=", availabilityRequest.monthEnd);
  const blockedQuery = db
    .collection("blocked_slots")
    .where("date", ">=", availabilityRequest.monthStart)
    .where("date", "<=", availabilityRequest.monthEnd);
  const capacityOverrideQuery = db
    .collection("capacity_overrides")
    .where("date", ">=", availabilityRequest.monthStart)
    .where("date", "<=", availabilityRequest.monthEnd);
  const defaultCapacityQuery = db
    .collection("business_settings")
    .where("key", "==", "default_max_bookings_per_slot")
    .limit(1);

  const [reservationsSnap, blockedSnap, capacityOverrideSnap, defaultCapacitySnap] = await Promise.all([
    reservationsQuery.get(),
    blockedQuery.get(),
    capacityOverrideQuery.get(),
    defaultCapacityQuery.get(),
  ]);

  return buildAvailabilityMonth({
    request: availabilityRequest,
    reservations: reservationsSnap.docs.map((docSnap) => docSnap.data()),
    blockedSlots: blockedSnap.docs.map((docSnap) => docSnap.data()),
    capacityOverrides: capacityOverrideSnap.docs.map((docSnap) => docSnap.data()),
    defaultCapacitySetting: defaultCapacitySnap.empty ? null : defaultCapacitySnap.docs[0].data(),
  });
});

exports.getServiceCatalog = onCall(async () => {
  const servicesSnap = await db.collection("services").get();
  const catalog = buildServiceCatalog(servicesSnap.docs);
  assertCatalogReadable(catalog);
  return catalog;
});

exports.getMyReservations = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const uid = request.auth.uid;
  const email = String(request.auth.token.email || "").trim().toLowerCase();
  const reservationQueries = [
    db.collection("reservations").where("customerUid", "==", uid).limit(50).get(),
  ];

  if (email) {
    reservationQueries.push(
      db.collection("reservations").where("customerEmail", "==", email).limit(50).get(),
    );
  }

  const [servicesSnap, ...reservationSnaps] = await Promise.all([
    db.collection("services").get(),
    ...reservationQueries,
  ]);
  const reservationsById = new Map();

  for (const snap of reservationSnaps) {
    for (const docSnap of snap.docs) {
      reservationsById.set(docSnap.id, docSnap);
    }
  }

  const reviewRefs = Array.from(reservationsById.keys()).map((reservationId) =>
    db.collection("reservation_reviews").doc(buildReservationReviewId(reservationId, uid)),
  );
  const reviewDocs = reviewRefs.length > 0 ? await db.getAll(...reviewRefs) : [];

  return buildUserReservationHistory({
    reservationDocs: Array.from(reservationsById.values()),
    serviceDocs: servicesSnap.docs,
    reviewDocs,
  });
});

exports.submitReservationReview = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const email = String(request.auth?.token?.email || "").trim().toLowerCase();
  const review = validateReservationReviewInput(request.data);
  const reservationRef = db.collection("reservations").doc(review.reservationId);
  const reviewId = buildReservationReviewId(review.reservationId, uid);
  const reviewRef = db.collection("reservation_reviews").doc(reviewId);

  await db.runTransaction(async (tx) => {
    const [reservationSnap, existingReviewSnap] = await Promise.all([
      tx.get(reservationRef),
      tx.get(reviewRef),
    ]);
    const reservationData = assertReservationReviewable({
      reservationSnap,
      uid,
      email,
    });
    const createdAt = existingReviewSnap.exists ?
      existingReviewSnap.get("createdAt") || admin.firestore.FieldValue.serverTimestamp() :
      admin.firestore.FieldValue.serverTimestamp();

    tx.set(reviewRef, {
      ...buildReservationReviewDocument({
        review,
        reservationData,
        uid,
        email,
      }),
      createdAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
  });

  return {
    ok: true,
    reviewId,
    reservationId: review.reservationId,
  };
});

exports.getMyVehicles = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const vehiclesSnap = await userVehiclesCollection(uid)
    .orderBy("createdAt", "asc")
    .limit(50)
    .get();

  return buildUserVehicleList(vehiclesSnap.docs);
});

exports.getMyProfile = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const userSnap = await userDocument(uid).get();

  return buildUserProfile({
    uid,
    authToken: request.auth?.token || {},
    userDoc: userSnap,
  });
});

exports.updateMyProfile = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const data = validateUserProfilePayload(request.data);
  const userRef = userDocument(uid);
  const userSnap = await userRef.get();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const email = String(request.auth?.token?.email || "").trim().toLowerCase();

  await userRef.set(
    {
      ...data,
      uid,
      email,
      source: "mobile-app",
      createdAt: userSnap.exists ? userSnap.get("createdAt") || now : now,
      updatedAt: now,
    },
    {merge: true},
  );

  admin.auth().updateUser(uid, {displayName: data.displayName}).catch((err) => {
    logger.warn("Firebase Auth displayName update failed", {
      uid,
      message: err?.message,
    });
  });

  const updatedSnap = await userRef.get();
  return buildUserProfile({
    uid,
    authToken: request.auth?.token || {},
    userDoc: updatedSnap,
  });
});

exports.createVehicle = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const data = validateVehiclePayload(request.data);
  const vehicleRef = userVehiclesCollection(uid).doc();
  const now = admin.firestore.FieldValue.serverTimestamp();

  await vehicleRef.set({
    ...data,
    ownerUid: uid,
    createdAt: now,
    updatedAt: now,
    source: "mobile-app",
  });

  return {
    vehicle: {
      id: vehicleRef.id,
      ...data,
    },
  };
});

exports.updateVehicle = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const vehicleId = assertVehicleId(request.data?.vehicleId || request.data?.id);
  const data = validateVehiclePayload(request.data);
  const vehicleRef = userVehiclesCollection(uid).doc(vehicleId);
  const vehicleSnap = await vehicleRef.get();

  if (!vehicleSnap.exists) {
    throw new HttpsError("not-found", "Vehicle not found");
  }

  await vehicleRef.update({
    ...data,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    vehicle: {
      id: vehicleId,
      ...data,
    },
  };
});

exports.deleteVehicle = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const vehicleId = assertVehicleId(request.data?.vehicleId || request.data?.id);
  const vehicleRef = userVehiclesCollection(uid).doc(vehicleId);
  const vehicleSnap = await vehicleRef.get();

  if (!vehicleSnap.exists) {
    throw new HttpsError("not-found", "Vehicle not found");
  }

  await vehicleRef.delete();

  return {
    ok: true,
    vehicleId,
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
