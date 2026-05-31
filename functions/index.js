const admin = require("firebase-admin");
const {setGlobalOptions, logger} = require("firebase-functions/v2");
const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {
  ACTIVE_RESERVATION_STATUS_VALUES,
  buildAvailabilityMonth,
  countOverlappingReservations,
  generateDeterministicReservationCode,
  hasBlockedSlotOverlap,
  isExpiredPendingReservation,
  isSlotWithinOperatingHours,
  reservationHoldsCapacity,
  resolveSelectedExtras,
  resolveCapacityLimit,
  resolveAvailabilityRequest,
  totalSelectedExtrasPriceCents,
  validateCreateReservationInput,
} = require("./createReservation");
const {
  assertCatalogReadable,
  buildAdminServiceCatalog,
  buildServiceCatalog,
  validateAdminServiceCatalogArchiveInput,
  validateAdminServiceCatalogItemInput,
} = require("./serviceCatalog");
const {
  assertBusinessInfoReadable,
  buildBusinessInfoSettingValue,
  buildBusinessInfo,
  validateBusinessInfoUpdateInput,
} = require("./businessInfo");
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
const {
  assertReservationCancelable,
  assertReservationId,
} = require("./reservationCancellation");
const {
  assertReservationReschedulable,
  docsExcludingReservation,
  validateRescheduleReservationInput,
} = require("./reservationReschedule");
const {
  assertAdminRole,
  assertPendingReservationActionable,
  buildAdminPendingReservations,
  validateAdminReservationActionInput,
} = require("./reservationAdmin");
const {
  assertRedeemableLoyaltyRedemption,
  buildLoyaltyRewardCode,
  buildUserLoyalty,
} = require("./loyalty");

admin.initializeApp();
const db = admin.firestore();
const USER_HISTORY_RESERVATION_LIMIT = 50;
const PENDING_RESERVATION_HOLD_MS = 24 * 60 * 60 * 1000;

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

async function effectiveRoleFromRequest(request) {
  const tokenRole = await userRoleFromAuth(request);
  if (tokenRole === "admin" || tokenRole === "employee") return tokenRole;

  const email = authenticatedEmail(request);
  if (!email) return null;
  return getAllowlistedRole(email);
}

async function assertAdminRequest(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const role = await effectiveRoleFromRequest(request);
  assertAdminRole(role);
  return role;
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

function userLoyaltyRedemptionsCollection(uid) {
  return db.collection("users").doc(uid).collection("loyalty_redemptions");
}

function reservationLoyaltyRedemptionRef(data) {
  const ownerUid = String(data?.customerUid || "").trim();
  const redemptionId = String(data?.loyaltyRedemptionId || "").trim();
  if (!ownerUid || !redemptionId) return null;
  return userLoyaltyRedemptionsCollection(ownerUid).doc(redemptionId);
}

function releaseReservedLoyaltyReward(tx, reservationData) {
  const redemptionRef = reservationLoyaltyRedemptionRef(reservationData);
  if (!redemptionRef) return;

  tx.update(redemptionRef, {
    status: "issued",
    reservationId: admin.firestore.FieldValue.delete(),
    reservationCode: admin.firestore.FieldValue.delete(),
    reservedAt: admin.firestore.FieldValue.delete(),
    redeemedAt: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

function redeemReservedLoyaltyReward(tx, reservationData, reservationId) {
  const redemptionRef = reservationLoyaltyRedemptionRef(reservationData);
  if (!redemptionRef) return;

  tx.update(redemptionRef, {
    status: "redeemed",
    redeemedAt: admin.firestore.FieldValue.serverTimestamp(),
    reservationId,
    reservationCode: String(reservationData.reservationCode || "").trim(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

function userDocument(uid) {
  return db.collection("users").doc(uid);
}

function reservationVehicleTypeForComparison(vehicleType) {
  return vehicleType === "passageiros" ? "passenger" : vehicleType;
}

function maybeLimitQuery(query, limit) {
  return Number.isInteger(limit) && limit > 0 ? query.limit(limit) : query;
}

function authenticatedEmail(request) {
  return String(request.auth?.token?.email || "").trim().toLowerCase();
}

function userReservationQueries(uid, email, {limit = USER_HISTORY_RESERVATION_LIMIT} = {}) {
  const queries = [
    maybeLimitQuery(db.collection("reservations").where("customerUid", "==", uid), limit),
  ];

  if (email) {
    queries.push(maybeLimitQuery(db.collection("reservations").where("customerEmail", "==", email), limit));
  }

  return queries;
}

function userHistoryReservationQueries(uid, email) {
  return userReservationQueries(uid, email, {limit: USER_HISTORY_RESERVATION_LIMIT});
}

function userLoyaltyReservationQueries(uid, email) {
  return userReservationQueries(uid, email, {limit: null});
}

function uniqueReservationDocsFromSnaps(reservationSnaps) {
  const reservationsById = new Map();
  for (const snap of reservationSnaps) {
    for (const docSnap of snap.docs) {
      reservationsById.set(docSnap.id, docSnap);
    }
  }
  return Array.from(reservationsById.values());
}

function priceCentsForService(service, vehicleType) {
  if (!service) return null;
  const rawValue = vehicleType === "suv" ? service.suvPriceCents : service.passengerPriceCents;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round(parsed));
}

function selectedBusinessInfoSnapshot(directSnap, keyedSnap) {
  return directSnap?.exists ? directSnap : keyedSnap?.docs?.[0];
}

function businessInfoFromSnapshots(directSnap, keyedSnap) {
  return buildBusinessInfo(selectedBusinessInfoSnapshot(directSnap, keyedSnap));
}

function settingPayload(data) {
  if (!data || typeof data !== "object") return {};
  const nested = data.value && typeof data.value === "object" ? data.value : null;
  return nested || data;
}

function hasConfiguredOpeningHours(docSnap) {
  if (!docSnap?.exists) return false;
  const source = settingPayload(docSnap.data());
  const configured = source.openingHours || source.hours;
  return Array.isArray(configured) && configured.length > 0;
}

function openingHoursForAvailability(businessInfo, directSnap, keyedSnap) {
  const sourceSnap = selectedBusinessInfoSnapshot(directSnap, keyedSnap);
  return hasConfiguredOpeningHours(sourceSnap) ? businessInfo.openingHours : null;
}

exports.createReservation = onCall(async (request) => {
  const data = validateCreateReservationInput(request.data);
  const authenticatedUid = request.auth?.uid || null;

  const slotStart = data.slotStart;
  const slotEnd = data.slotEnd;
  const dateKey = slotStart.toISOString().slice(0, 10);

  const reservationRef = db.collection("reservations").doc();
  const reservationCode = generateDeterministicReservationCode(reservationRef.id);
  const pendingExpiresAt = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() + PENDING_RESERVATION_HOLD_MS),
  );

  if (data.userVehicleId && !authenticatedUid) {
    throw new HttpsError("unauthenticated", "Authentication required for saved vehicle reservations");
  }
  if (data.loyaltyRewardCode && !authenticatedUid) {
    throw new HttpsError("unauthenticated", "Authentication required for loyalty rewards");
  }

  let appliedLoyaltyReward = null;
  let reservationPriceCents = null;
  let reservationDiscountCents = 0;
  let reservationExtras = [];
  let reservationPaymentStatus = "pending";

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
    const businessInfoRef = db.collection("business_settings").doc("business_info");
    const businessInfoQuery = db
      .collection("business_settings")
      .where("key", "==", "business_info")
      .limit(1);
    const servicesQuery = db.collection("services");
    const extrasQuery = db.collection("service_extras");
    const userVehicleRef = data.userVehicleId ?
      userVehiclesCollection(authenticatedUid).doc(data.userVehicleId) :
      null;
    const loyaltyRewardQuery = data.loyaltyRewardCode ?
      userLoyaltyRedemptionsCollection(authenticatedUid)
        .where("rewardCode", "==", data.loyaltyRewardCode)
        .limit(1) :
      null;

    const [
      reservationsSnap,
      blockedSnap,
      capacityOverrideSnap,
      defaultCapacitySnap,
      businessInfoSnap,
      keyedBusinessInfoSnap,
      servicesSnap,
      extrasSnap,
      userVehicleSnap,
      loyaltyRewardSnap,
    ] = await Promise.all([
      tx.get(reservationsQuery),
      tx.get(blockedQuery),
      tx.get(capacityOverrideQuery),
      tx.get(defaultCapacityQuery),
      tx.get(businessInfoRef),
      tx.get(businessInfoQuery),
      tx.get(servicesQuery),
      tx.get(extrasQuery),
      userVehicleRef ? tx.get(userVehicleRef) : Promise.resolve(null),
      loyaltyRewardQuery ? tx.get(loyaltyRewardQuery) : Promise.resolve(null),
    ]);

    const capacityOverride = capacityOverrideSnap.empty ? null : capacityOverrideSnap.docs[0].data();
    const defaultCapacitySetting = defaultCapacitySnap.empty ? null : defaultCapacitySnap.docs[0].data();
    const capacityLimit = resolveCapacityLimit(defaultCapacitySetting, capacityOverride);
    const businessInfo = businessInfoFromSnapshots(businessInfoSnap, keyedBusinessInfoSnap);
    const openingHours = openingHoursForAvailability(businessInfo, businessInfoSnap, keyedBusinessInfoSnap);
    const serviceCatalog = buildServiceCatalog(servicesSnap.docs, extrasSnap.docs);
    const service = serviceCatalog.services.find((item) => item.id === data.serviceId) || null;
    const basePriceCents = priceCentsForService(service, data.vehicleType);
    const selectedExtras = resolveSelectedExtras(data.extraIds, serviceCatalog.extras);
    const extrasPriceCents = totalSelectedExtrasPriceCents(selectedExtras);
    const subtotalPriceCents = basePriceCents === null ? null : basePriceCents + extrasPriceCents;
    let priceCents = subtotalPriceCents;
    let discountCents = 0;
    let linkedVehicle = null;
    let loyaltyReward = null;

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

    if (!isSlotWithinOperatingHours({dateKey, slotStart, slotEnd, openingHours})) {
      throw new HttpsError("already-exists", "Selected time slot is outside business hours");
    }

    const blockedSlots = blockedSnap.docs.map((docSnap) => docSnap.data());
    if (hasBlockedSlotOverlap(blockedSlots, slotStart, slotEnd)) {
      throw new HttpsError("already-exists", "Selected time slot is blocked");
    }

    const reservations = reservationsSnap.docs
      .map((docSnap) => docSnap.data())
      .filter((reservation) => reservationHoldsCapacity(reservation, new Date()));
    const overlappingReservations = countOverlappingReservations(reservations, slotStart, slotEnd);
    if (overlappingReservations >= capacityLimit) {
      throw new HttpsError("already-exists", "Selected time slot is unavailable");
    }

    if (data.loyaltyRewardCode) {
      loyaltyReward = assertRedeemableLoyaltyRedemption(loyaltyRewardSnap?.docs?.[0], authenticatedUid);
      discountCents = basePriceCents === null ? 0 : basePriceCents;
      priceCents = basePriceCents === null ? null : extrasPriceCents;
    }

    const paymentStatus = loyaltyReward && extrasPriceCents === 0 ? "covered_by_loyalty" : "pending";

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
      originalPriceCents: basePriceCents,
      extrasPriceCents,
      subtotalPriceCents,
      discountCents,
      priceCents,
      extraIds: selectedExtras.map((extra) => extra.id),
      extras: selectedExtras,
      paymentStatus,
      loyaltyRewardApplied: Boolean(loyaltyReward),
      loyaltyRewardCode: loyaltyReward?.rewardCode || "",
      loyaltyRedemptionId: loyaltyReward?.id || null,
      status: "pending",
      pendingExpiresAt,
      notes: data.notes,
      internalNotes: "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "public-booking",
    });

    if (loyaltyReward) {
      tx.update(loyaltyReward.ref, {
        status: "reserved",
        reservedAt: admin.firestore.FieldValue.serverTimestamp(),
        reservationId: reservationRef.id,
        reservationCode,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    appliedLoyaltyReward = loyaltyReward ? {
      id: loyaltyReward.id,
      rewardCode: loyaltyReward.rewardCode,
    } : null;
    reservationPriceCents = priceCents;
    reservationDiscountCents = discountCents;
    reservationExtras = selectedExtras;
    reservationPaymentStatus = paymentStatus;
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
    loyaltyRewardApplied: Boolean(appliedLoyaltyReward),
    loyaltyRewardCode: appliedLoyaltyReward?.rewardCode || null,
    priceCents: reservationPriceCents,
    discountCents: reservationDiscountCents,
    extras: reservationExtras,
    paymentStatus: reservationPaymentStatus,
    status: "pending",
    pendingExpiresAt: pendingExpiresAt.toDate().toISOString(),
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
  const businessInfoRef = db.collection("business_settings").doc("business_info");
  const businessInfoQuery = db
    .collection("business_settings")
    .where("key", "==", "business_info")
    .limit(1);

  const [
    reservationsSnap,
    blockedSnap,
    capacityOverrideSnap,
    defaultCapacitySnap,
    businessInfoSnap,
    keyedBusinessInfoSnap,
  ] = await Promise.all([
    reservationsQuery.get(),
    blockedQuery.get(),
    capacityOverrideQuery.get(),
    defaultCapacityQuery.get(),
    businessInfoRef.get(),
    businessInfoQuery.get(),
  ]);
  const businessInfo = businessInfoFromSnapshots(businessInfoSnap, keyedBusinessInfoSnap);

  return buildAvailabilityMonth({
    request: availabilityRequest,
    reservations: reservationsSnap.docs.map((docSnap) => docSnap.data()),
    blockedSlots: blockedSnap.docs.map((docSnap) => docSnap.data()),
    capacityOverrides: capacityOverrideSnap.docs.map((docSnap) => docSnap.data()),
    defaultCapacitySetting: defaultCapacitySnap.empty ? null : defaultCapacitySnap.docs[0].data(),
    openingHours: openingHoursForAvailability(businessInfo, businessInfoSnap, keyedBusinessInfoSnap),
  });
});

exports.getServiceCatalog = onCall(async () => {
  const [servicesSnap, extrasSnap] = await Promise.all([
    db.collection("services").get(),
    db.collection("service_extras").get(),
  ]);
  const catalog = buildServiceCatalog(servicesSnap.docs, extrasSnap.docs);
  assertCatalogReadable(catalog);
  return catalog;
});

exports.getBusinessInfo = onCall(async () => {
  const [directSnap, keyedSnap] = await Promise.all([
    db.collection("business_settings").doc("business_info").get(),
    db.collection("business_settings").where("key", "==", "business_info").limit(1).get(),
  ]);
  const businessInfo = businessInfoFromSnapshots(directSnap, keyedSnap);
  assertBusinessInfoReadable(businessInfo);
  return businessInfo;
});

exports.getMyReservations = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const uid = request.auth.uid;
  const email = authenticatedEmail(request);
  const historyReservationQueries = userHistoryReservationQueries(uid, email);
  const loyaltyReservationQueries = userLoyaltyReservationQueries(uid, email);

  const [servicesSnap, redemptionSnap, ...reservationSnaps] = await Promise.all([
    db.collection("services").get(),
    userLoyaltyRedemptionsCollection(uid).limit(100).get(),
    ...historyReservationQueries.map((query) => query.get()),
    ...loyaltyReservationQueries.map((query) => query.get()),
  ]);
  const historyReservationSnaps = reservationSnaps.slice(0, historyReservationQueries.length);
  const loyaltyReservationSnaps = reservationSnaps.slice(historyReservationQueries.length);
  const reservationDocs = uniqueReservationDocsFromSnaps(historyReservationSnaps);
  const loyaltyReservationDocs = uniqueReservationDocsFromSnaps(loyaltyReservationSnaps);

  const reviewRefs = reservationDocs.map((reservationDoc) =>
    db.collection("reservation_reviews").doc(buildReservationReviewId(reservationDoc.id, uid)),
  );
  const reviewDocs = reviewRefs.length > 0 ? await db.getAll(...reviewRefs) : [];
  const loyalty = buildUserLoyalty({
    reservationDocs: loyaltyReservationDocs,
    redemptionDocs: redemptionSnap.docs,
  });

  return buildUserReservationHistory({
    reservationDocs,
    serviceDocs: servicesSnap.docs,
    reviewDocs,
    loyalty,
  });
});

exports.getMyLoyalty = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const email = authenticatedEmail(request);

  const [redemptionSnap, ...reservationSnaps] = await Promise.all([
    userLoyaltyRedemptionsCollection(uid).limit(100).get(),
    ...userLoyaltyReservationQueries(uid, email).map((query) => query.get()),
  ]);

  return buildUserLoyalty({
    reservationDocs: uniqueReservationDocsFromSnaps(reservationSnaps),
    redemptionDocs: redemptionSnap.docs,
  });
});

exports.redeemMyLoyaltyReward = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const email = authenticatedEmail(request);
  let redemption = null;
  let loyalty = null;

  await db.runTransaction(async (tx) => {
    const [redemptionSnap, ...reservationSnaps] = await Promise.all([
      tx.get(userLoyaltyRedemptionsCollection(uid).limit(100)),
      ...userLoyaltyReservationQueries(uid, email).map((query) => tx.get(query)),
    ]);
    const reservationDocs = uniqueReservationDocsFromSnaps(reservationSnaps);
    const currentLoyalty = buildUserLoyalty({
      reservationDocs,
      redemptionDocs: redemptionSnap.docs,
    });

    if (!currentLoyalty.rewardReady) {
      throw new HttpsError("failed-precondition", "No loyalty reward is available");
    }

    const rewardNumber = currentLoyalty.claimedRewards + 1;
    const redemptionRef = userLoyaltyRedemptionsCollection(uid)
      .doc(`reward-${String(rewardNumber).padStart(4, "0")}`);
    const existingRedemptionSnap = await tx.get(redemptionRef);

    if (existingRedemptionSnap.exists) {
      throw new HttpsError("already-exists", "Loyalty reward has already been claimed");
    }

    const rewardCode = buildLoyaltyRewardCode(uid, rewardNumber);
    const now = new Date();
    const redemptionData = {
      ownerUid: uid,
      ownerEmail: email,
      rewardNumber,
      rewardCode,
      status: "issued",
      source: "mobile-app",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const previewRedemptionDoc = {
      id: redemptionRef.id,
      exists: true,
      data: () => ({
        ...redemptionData,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }),
    };

    tx.set(redemptionRef, redemptionData);

    redemption = {
      id: redemptionRef.id,
      rewardCode,
      rewardNumber,
      status: "issued",
    };
    loyalty = buildUserLoyalty({
      reservationDocs,
      redemptionDocs: [...redemptionSnap.docs, previewRedemptionDoc],
      now,
    });
  });

  return {
    ok: true,
    redemption,
    loyalty,
  };
});

exports.submitReservationReview = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const email = authenticatedEmail(request);
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

exports.cancelMyReservation = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const email = authenticatedEmail(request);
  const reservationId = assertReservationId(request.data?.reservationId || request.data?.id);
  const reservationRef = db.collection("reservations").doc(reservationId);
  let finalStatus = "cancelled";

  await db.runTransaction(async (tx) => {
    const reservationSnap = await tx.get(reservationRef);
    const result = assertReservationCancelable({
      reservationSnap,
      uid,
      email,
    });

    finalStatus = result.status;
    if (result.alreadyCancelled) {
      return;
    }

    tx.update(reservationRef, {
      status: "cancelled",
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      cancelledByUid: uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    finalStatus = "cancelled";
  });

  return {
    ok: true,
    reservationId,
    status: finalStatus,
  };
});

exports.rescheduleMyReservation = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const email = authenticatedEmail(request);
  const data = validateRescheduleReservationInput(request.data);
  const reservationRef = db.collection("reservations").doc(data.reservationId);
  const dateKey = data.dateKey;
  let finalStatus = "pending";

  await db.runTransaction(async (tx) => {
    const reservationSnap = await tx.get(reservationRef);
    const currentReservation = assertReservationReschedulable({
      reservationSnap,
      uid,
      email,
      newSlotStart: data.slotStart,
      newSlotEnd: data.slotEnd,
    });

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
    const businessInfoRef = db.collection("business_settings").doc("business_info");
    const businessInfoQuery = db
      .collection("business_settings")
      .where("key", "==", "business_info")
      .limit(1);

    const [
      reservationsSnap,
      blockedSnap,
      capacityOverrideSnap,
      defaultCapacitySnap,
      businessInfoSnap,
      keyedBusinessInfoSnap,
    ] = await Promise.all([
      tx.get(reservationsQuery),
      tx.get(blockedQuery),
      tx.get(capacityOverrideQuery),
      tx.get(defaultCapacityQuery),
      tx.get(businessInfoRef),
      tx.get(businessInfoQuery),
    ]);

    const capacityOverride = capacityOverrideSnap.empty ? null : capacityOverrideSnap.docs[0].data();
    const defaultCapacitySetting = defaultCapacitySnap.empty ? null : defaultCapacitySnap.docs[0].data();
    const capacityLimit = resolveCapacityLimit(defaultCapacitySetting, capacityOverride);
    const businessInfo = businessInfoFromSnapshots(businessInfoSnap, keyedBusinessInfoSnap);
    const openingHours = openingHoursForAvailability(businessInfo, businessInfoSnap, keyedBusinessInfoSnap);

    if (capacityLimit <= 0) {
      throw new HttpsError("already-exists", "Selected time slot is unavailable");
    }

    if (!isSlotWithinOperatingHours({
      dateKey,
      slotStart: data.slotStart,
      slotEnd: data.slotEnd,
      openingHours,
    })) {
      throw new HttpsError("already-exists", "Selected time slot is outside business hours");
    }

    const blockedSlots = blockedSnap.docs.map((docSnap) => docSnap.data());
    if (hasBlockedSlotOverlap(blockedSlots, data.slotStart, data.slotEnd)) {
      throw new HttpsError("already-exists", "Selected time slot is blocked");
    }

    const reservations = docsExcludingReservation(reservationsSnap.docs, data.reservationId)
      .map((docSnap) => docSnap.data())
      .filter((reservation) => reservationHoldsCapacity(reservation, new Date()));
    const overlappingReservations = countOverlappingReservations(reservations, data.slotStart, data.slotEnd);
    if (overlappingReservations >= capacityLimit) {
      throw new HttpsError("already-exists", "Selected time slot is unavailable");
    }

    tx.update(reservationRef, {
      slotStart: data.slotStart.toISOString(),
      slotEnd: data.slotEnd.toISOString(),
      date: dateKey,
      status: "pending",
      pendingExpiresAt: admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + PENDING_RESERVATION_HOLD_MS),
      ),
      previousSlotStart: currentReservation.currentSlotStart.toISOString(),
      previousSlotEnd: currentReservation.currentSlotEnd.toISOString(),
      previousStatus: currentReservation.previousStatus,
      rescheduledAt: admin.firestore.FieldValue.serverTimestamp(),
      rescheduledByUid: uid,
      rescheduleCount: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    finalStatus = "pending";
  });

  return {
    ok: true,
    reservationId: data.reservationId,
    status: finalStatus,
    slotStart: data.slotStart.toISOString(),
    slotEnd: data.slotEnd.toISOString(),
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
  let savedVehicle = null;

  await db.runTransaction(async (tx) => {
    const vehiclesSnap = await tx.get(userVehiclesCollection(uid).limit(50));
    const isDefault = data.isDefault || vehiclesSnap.empty;
    savedVehicle = {
      ...data,
      isDefault,
    };

    if (isDefault) {
      vehiclesSnap.docs.forEach((docSnap) => {
        tx.update(docSnap.ref, {
          isDefault: false,
          updatedAt: now,
        });
      });
    }

    tx.set(vehicleRef, {
      ...savedVehicle,
      ownerUid: uid,
      createdAt: now,
      updatedAt: now,
      source: "mobile-app",
    });
  });

  return {
    vehicle: {
      id: vehicleRef.id,
      ...savedVehicle,
    },
  };
});

exports.updateVehicle = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const vehicleId = assertVehicleId(request.data?.vehicleId || request.data?.id);
  const data = validateVehiclePayload(request.data);
  const vehicleRef = userVehiclesCollection(uid).doc(vehicleId);
  let savedVehicle = null;

  await db.runTransaction(async (tx) => {
    const vehicleSnap = await tx.get(vehicleRef);

    if (!vehicleSnap.exists) {
      throw new HttpsError("not-found", "Vehicle not found");
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    savedVehicle = {
      ...data,
      isDefault: data.isDefault,
    };

    if (data.isDefault) {
      const vehiclesSnap = await tx.get(userVehiclesCollection(uid).limit(50));
      vehiclesSnap.docs.forEach((docSnap) => {
        if (docSnap.id !== vehicleId) {
          tx.update(docSnap.ref, {
            isDefault: false,
            updatedAt: now,
          });
        }
      });
    }

    tx.update(vehicleRef, {
      ...savedVehicle,
      updatedAt: now,
    });
  });

  return {
    vehicle: {
      id: vehicleId,
      ...savedVehicle,
    },
  };
});

exports.deleteVehicle = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const vehicleId = assertVehicleId(request.data?.vehicleId || request.data?.id);
  const vehicleRef = userVehiclesCollection(uid).doc(vehicleId);

  await db.runTransaction(async (tx) => {
    const [vehicleSnap, vehiclesSnap] = await Promise.all([
      tx.get(vehicleRef),
      tx.get(userVehiclesCollection(uid).orderBy("createdAt", "asc").limit(50)),
    ]);

    if (!vehicleSnap.exists) {
      throw new HttpsError("not-found", "Vehicle not found");
    }

    const wasDefault = vehicleSnap.get("isDefault") === true;
    const replacementSnap = wasDefault ?
      vehiclesSnap.docs.find((docSnap) => docSnap.id !== vehicleId) :
      null;

    tx.delete(vehicleRef);
    if (replacementSnap) {
      tx.update(replacementSnap.ref, {
        isDefault: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  });

  return {
    ok: true,
    vehicleId,
  };
});

exports.getAdminPendingReservations = onCall(async (request) => {
  await assertAdminRequest(request);

  const [servicesSnap, reservationsSnap] = await Promise.all([
    db.collection("services").get(),
    db.collection("reservations")
      .where("status", "in", ["pending", "novo"])
      .get(),
  ]);

  return buildAdminPendingReservations({
    reservationDocs: reservationsSnap.docs,
    serviceDocs: servicesSnap.docs,
  });
});

exports.getAdminBusinessInfo = onCall(async (request) => {
  await assertAdminRequest(request);

  const [directSnap, keyedSnap] = await Promise.all([
    db.collection("business_settings").doc("business_info").get(),
    db.collection("business_settings").where("key", "==", "business_info").limit(1).get(),
  ]);
  const businessInfo = businessInfoFromSnapshots(directSnap, keyedSnap);
  assertBusinessInfoReadable(businessInfo);
  return businessInfo;
});

exports.getAdminServiceCatalog = onCall(async (request) => {
  await assertAdminRequest(request);

  const servicesSnap = await db.collection("services").get();
  return buildAdminServiceCatalog(servicesSnap.docs);
});

exports.updateBusinessInfo = onCall(async (request) => {
  await assertAdminRequest(request);
  const businessInfo = validateBusinessInfoUpdateInput(request.data);
  const value = buildBusinessInfoSettingValue(businessInfo);

  await db.collection("business_settings").doc("business_info").set(
    {
      key: "business_info",
      value,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedByUid: request.auth.uid,
      updateSource: "admin-mobile",
    },
    {merge: true},
  );

  return {
    ...businessInfo,
    source: "firestore",
  };
});

exports.upsertServiceCatalogItem = onCall(async (request) => {
  await assertAdminRequest(request);
  const serviceCollection = db.collection("services");
  const fallbackServiceRef = serviceCollection.doc();
  const data = validateAdminServiceCatalogItemInput(request.data, fallbackServiceRef.id);
  const serviceRef = serviceCollection.doc(data.serviceId);
  let created = false;

  await db.runTransaction(async (tx) => {
    const serviceSnap = await tx.get(serviceRef);
    created = !serviceSnap.exists;
    const update = {
      ...data.document,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedByUid: request.auth.uid,
    };

    if (created) {
      update.createdAt = admin.firestore.FieldValue.serverTimestamp();
      update.createdByUid = request.auth.uid;
    }
    if (data.document.active) {
      update.archivedAt = admin.firestore.FieldValue.delete();
      update.archivedByUid = admin.firestore.FieldValue.delete();
    }

    tx.set(serviceRef, update, {merge: true});
  });

  return {
    ok: true,
    serviceId: data.serviceId,
    status: data.document.active ? "active" : "inactive",
    created,
  };
});

exports.archiveServiceCatalogItem = onCall(async (request) => {
  await assertAdminRequest(request);
  const data = validateAdminServiceCatalogArchiveInput(request.data);
  const serviceRef = db.collection("services").doc(data.serviceId);

  await db.runTransaction(async (tx) => {
    const serviceSnap = await tx.get(serviceRef);
    if (!serviceSnap.exists) {
      throw new HttpsError("not-found", "Service catalog item not found");
    }

    tx.update(serviceRef, {
      active: false,
      enabled: false,
      archivedAt: admin.firestore.FieldValue.serverTimestamp(),
      archivedByUid: request.auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedByUid: request.auth.uid,
    });
  });

  return {
    ok: true,
    serviceId: data.serviceId,
    status: "archived",
  };
});

exports.acceptReservation = onCall(async (request) => {
  await assertAdminRequest(request);
  const data = validateAdminReservationActionInput(request.data);
  const reservationRef = db.collection("reservations").doc(data.reservationId);
  let reservationCode = "";

  await db.runTransaction(async (tx) => {
    const reservationSnap = await tx.get(reservationRef);
    const reservationData = assertPendingReservationActionable({reservationSnap});

    reservationCode = String(reservationData.reservationCode || "").trim();
    tx.update(reservationRef, {
      status: "confirmed",
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      acceptedByUid: request.auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    redeemReservedLoyaltyReward(tx, reservationData, data.reservationId);
  });

  return {
    ok: true,
    reservationId: data.reservationId,
    reservationCode,
    status: "confirmed",
  };
});

exports.rejectReservation = onCall(async (request) => {
  await assertAdminRequest(request);
  const data = validateAdminReservationActionInput(request.data);
  const reservationRef = db.collection("reservations").doc(data.reservationId);
  let reservationCode = "";

  await db.runTransaction(async (tx) => {
    const reservationSnap = await tx.get(reservationRef);
    const reservationData = assertPendingReservationActionable({reservationSnap});
    const update = {
      status: "rejected",
      rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
      rejectedByUid: request.auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (data.rejectionReason) {
      update.rejectionReason = data.rejectionReason;
    } else {
      update.rejectionReason = admin.firestore.FieldValue.delete();
    }

    reservationCode = String(reservationData.reservationCode || "").trim();
    tx.update(reservationRef, update);
    releaseReservedLoyaltyReward(tx, reservationData);
  });

  return {
    ok: true,
    reservationId: data.reservationId,
    reservationCode,
    status: "rejected",
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

exports.expirePendingReservations = onSchedule("every 60 minutes", async () => {
  const now = new Date();
  const pendingSnap = await db.collection("reservations")
    .where("status", "in", ["pending", "novo"])
    .limit(250)
    .get();
  let expiredCount = 0;

  for (const docSnap of pendingSnap.docs) {
    if (!isExpiredPendingReservation(docSnap.data(), now)) continue;

    await db.runTransaction(async (tx) => {
      const freshSnap = await tx.get(docSnap.ref);
      if (!freshSnap.exists || !isExpiredPendingReservation(freshSnap.data(), now)) return;

      const reservationData = freshSnap.data() || {};
      tx.update(docSnap.ref, {
        status: "expired",
        expiredAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      releaseReservedLoyaltyReward(tx, reservationData);
      expiredCount += 1;
    });
  }

  logger.info("Expired pending reservations", {expiredCount});
});

exports.health = onRequest((req, res) => {
  res.status(200).json({ok: true, service: "sudsandshine-firebase", now: new Date().toISOString()});
});

async function sendReservationEmails(payload) {
  // TODO(DIGS-9): Wire provider credentials (SendGrid/Resend/etc) using secrets.
  // Keep logging + retry policy explicit.
  logger.info("Reservation email workflow placeholder", payload);
}
