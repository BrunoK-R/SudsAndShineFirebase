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
  buildAdminServiceExtras,
  buildServiceCatalog,
  validateAdminServiceCatalogArchiveInput,
  validateAdminServiceCatalogItemInput,
  validateAdminServiceExtraArchiveInput,
  validateAdminServiceExtraInput,
} = require("./serviceCatalog");
const {
  assertBusinessInfoReadable,
  buildBusinessInfoSettingValue,
  buildBusinessInfo,
  validateBusinessInfoUpdateInput,
} = require("./businessInfo");
const {
  buildAdminAvailabilityConfig,
  buildBlockedSlotDocument,
  buildCapacityOverrideDocument,
  validateAvailabilityConfigurationInput,
  validateBlockedSlotClearInput,
  validateBlockedSlotInput,
  validateCapacityOverrideClearInput,
  validateCapacityOverrideInput,
} = require("./availabilityAdmin");
const {
  buildBookingPolicy,
  buildBookingPolicySettingValue,
  pendingExpiresAtForPolicy,
  validateBookingPolicyUpdateInput,
} = require("./bookingPolicyAdmin");
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
  assertReservationCompletable,
  buildAdminCompletableReservations,
  buildAdminPendingReservations,
  validateAdminReservationActionInput,
} = require("./reservationAdmin");
const {
  assertRedeemableLoyaltyRedemption,
  buildLoyaltyRewardCode,
  buildUserLoyalty,
} = require("./loyalty");
const {
  buildLoyaltySettings,
  buildLoyaltyRedemptionMetadata,
  buildLoyaltySettingsValue,
  loyaltyDiscountCentsForRedemption,
  validateLoyaltySettingsUpdateInput,
} = require("./loyaltyAdmin");
const {
  buildNotificationSettings,
  buildNotificationSettingsValue,
  validateAdminNotificationTestInput,
  validateNotificationSettingsUpdateInput,
} = require("./notificationAdmin");
const {
  NOTIFICATION_CAMPAIGN_DRAFTS_COLLECTION,
  buildAdminNotificationCampaignDrafts,
  buildNotificationCampaignDraftValue,
  validateNotificationCampaignDraftArchiveInput,
  validateNotificationCampaignDraftInput,
} = require("./notificationCampaigns");
const {
  buildNotificationTokenValue,
  buildUserNotificationPreferences,
  buildUserNotificationPreferencesValue,
  validateNotificationTokenDeleteInput,
  validateNotificationTokenRegistrationInput,
  validateUserNotificationPreferencesInput,
} = require("./notificationPreferences");
const {
  BOOKING_REMINDER_RESERVATION_STATUS_VALUES,
  NOTIFICATION_OUTBOX_COLLECTION,
  REVIEW_PROMPT_RESERVATION_STATUS_VALUES,
  enqueueAdminPendingBookingNotification,
  enqueueReservationNotification,
  buildAdminTestNotificationOutboxDocument,
  isBookingReminderReservationDue,
  isReviewPromptReservationDue,
  notificationOutboxDocId,
} = require("./notificationOutbox");
const {
  MAX_DELIVERY_ATTEMPTS,
  MAX_DELIVERY_TOKENS_PER_USER,
  buildNotificationPushMessage,
  deliveryCompletionUpdate,
  deliveryFailureUpdate,
  deliverySuppressionUpdate,
  isNotificationOutboxDeliverable,
  isNotificationSendingLeaseExpired,
  nextDeliveryLeaseExpiration,
  notificationDeliveryPreferenceSuppression,
  notificationQuietHoursDeferral,
  notificationTokenDeliveryFromSnap,
} = require("./notificationDelivery");

admin.initializeApp();
const db = admin.firestore();
const USER_HISTORY_RESERVATION_LIMIT = 50;
const ADMIN_ALERT_RECIPIENT_LIMIT = 25;

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

function loyaltySettingsRef() {
  return db.collection("admin_settings").doc("loyalty_settings");
}

function legacyLoyaltySettingsRef() {
  return db.collection("business_settings").doc("loyalty_settings");
}

function notificationSettingsRef() {
  return db.collection("admin_settings").doc("notification_settings");
}

function notificationCampaignDraftsCollection() {
  return db.collection(NOTIFICATION_CAMPAIGN_DRAFTS_COLLECTION);
}

function userNotificationPreferencesRef(uid) {
  return userDocument(uid).collection("notification_preferences").doc("default");
}

function userNotificationTokensCollection(uid) {
  return userDocument(uid).collection("notification_tokens");
}

function adminAlertRecipientsQuery() {
  return db.collection("admin_allowlist")
    .where("role", "==", "admin")
    .limit(ADMIN_ALERT_RECIPIENT_LIMIT);
}

function adminAlertRecipientUidsFromSnapshot(snap) {
  const seen = new Set();
  const recipientUids = [];
  for (const docSnap of snap?.docs || []) {
    const uid = String(docSnap.get("uid") || "").trim();
    if (!uid || uid.includes("/") || uid.length > 128 || seen.has(uid)) continue;
    seen.add(uid);
    recipientUids.push(uid);
  }
  return recipientUids;
}

function enqueueAdminPendingBookingAlerts(tx, {
  reservationId,
  reservation,
  notificationSettingsSnap,
  adminAllowlistSnap,
  adminPreferenceSnaps = [],
  actorUid = "",
} = {}) {
  const recipientUids = adminAlertRecipientUidsFromSnapshot(adminAllowlistSnap);
  let queuedCount = 0;
  recipientUids.forEach((recipientUid, index) => {
    const queued = enqueueAdminPendingBookingNotification(tx, {
      db,
      reservationId,
      reservation,
      recipientUid,
      notificationSettingsSnap,
      adminPreferencesSnap: adminPreferenceSnaps[index] || null,
      actorUid,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (queued) queuedCount += 1;
  });
  return queuedCount;
}

function selectedLoyaltySettingsSnapshot(primarySnap, legacySnap) {
  return primarySnap?.exists ? primarySnap : legacySnap;
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
  let pendingExpiresAt = admin.firestore.Timestamp.fromDate(pendingExpiresAtForPolicy(null));

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
    const bookingPolicyRef = db.collection("business_settings").doc("booking_policy");
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
    const notificationPreferencesRef = authenticatedUid ? userNotificationPreferencesRef(authenticatedUid) : null;
    const notificationUserRef = authenticatedUid ? userDocument(authenticatedUid) : null;
    const adminAlertsQuery = adminAlertRecipientsQuery();

    const [
      reservationsSnap,
      blockedSnap,
      capacityOverrideSnap,
      defaultCapacitySnap,
      businessInfoSnap,
      keyedBusinessInfoSnap,
      bookingPolicySnap,
      servicesSnap,
      extrasSnap,
      userVehicleSnap,
      loyaltyRewardSnap,
      notificationSettingsSnap,
      notificationPreferencesSnap,
      notificationUserSnap,
      adminAllowlistSnap,
    ] = await Promise.all([
      tx.get(reservationsQuery),
      tx.get(blockedQuery),
      tx.get(capacityOverrideQuery),
      tx.get(defaultCapacityQuery),
      tx.get(businessInfoRef),
      tx.get(businessInfoQuery),
      tx.get(bookingPolicyRef),
      tx.get(servicesQuery),
      tx.get(extrasQuery),
      userVehicleRef ? tx.get(userVehicleRef) : Promise.resolve(null),
      loyaltyRewardQuery ? tx.get(loyaltyRewardQuery) : Promise.resolve(null),
      tx.get(notificationSettingsRef()),
      notificationPreferencesRef ? tx.get(notificationPreferencesRef) : Promise.resolve(null),
      notificationUserRef ? tx.get(notificationUserRef) : Promise.resolve(null),
      tx.get(adminAlertsQuery),
    ]);

    const capacityOverride = capacityOverrideSnap.empty ? null : capacityOverrideSnap.docs[0].data();
    const defaultCapacitySetting = defaultCapacitySnap.empty ? null : defaultCapacitySnap.docs[0].data();
    const capacityLimit = resolveCapacityLimit(defaultCapacitySetting, capacityOverride);
    const adminAlertRecipientUids = adminAlertRecipientUidsFromSnapshot(adminAllowlistSnap);
    const adminPreferenceSnaps = await Promise.all(
      adminAlertRecipientUids.map((uid) => tx.get(userNotificationPreferencesRef(uid))),
    );
    const businessInfo = businessInfoFromSnapshots(businessInfoSnap, keyedBusinessInfoSnap);
    const bookingPolicy = buildBookingPolicy(bookingPolicySnap);
    pendingExpiresAt = admin.firestore.Timestamp.fromDate(pendingExpiresAtForPolicy(bookingPolicy));
    const openingHours = openingHoursForAvailability(businessInfo, businessInfoSnap, keyedBusinessInfoSnap);
    const serviceCatalog = buildServiceCatalog(servicesSnap.docs, extrasSnap.docs);
    const service = serviceCatalog.services.find((item) => item.id === data.serviceId) || null;
    const basePriceCents = priceCentsForService(service, data.vehicleType);
    const selectedExtras = resolveSelectedExtras(data.extraIds, serviceCatalog.extras, service.id);
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
      discountCents = loyaltyDiscountCentsForRedemption(loyaltyReward, basePriceCents);
      priceCents = subtotalPriceCents === null ? null : Math.max(0, subtotalPriceCents - discountCents);
    }

    const paymentStatus = loyaltyReward && priceCents === 0 ? "covered_by_loyalty" : "pending";
    const reservationDocument = {
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
      loyaltyRewardType: loyaltyReward?.rewardType || "",
      loyaltyRewardValue: loyaltyReward?.rewardValue || 0,
      loyaltyRewardDescription: loyaltyReward?.rewardDescription || "",
      status: "pending",
      pendingExpiresAt,
      notes: data.notes,
      internalNotes: "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "public-booking",
    };

    tx.set(reservationRef, reservationDocument);

    if (loyaltyReward) {
      tx.update(loyaltyReward.ref, {
        status: "reserved",
        reservedAt: admin.firestore.FieldValue.serverTimestamp(),
        reservationId: reservationRef.id,
        reservationCode,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    if (authenticatedUid) {
      enqueueReservationNotification(tx, {
        db,
        templateKey: "booking_request",
        reservationId: reservationRef.id,
        reservation: reservationDocument,
        notificationSettingsSnap,
        userPreferencesSnap: notificationPreferencesSnap,
        userDocSnap: notificationUserSnap,
        actorUid: authenticatedUid,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    enqueueAdminPendingBookingAlerts(tx, {
      reservationId: reservationRef.id,
      reservation: reservationDocument,
      notificationSettingsSnap,
      adminAllowlistSnap,
      adminPreferenceSnaps,
      actorUid: authenticatedUid || "public-booking",
    });

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

  const [
    servicesSnap,
    redemptionSnap,
    loyaltySettingsSnap,
    legacyLoyaltySettingsSnap,
    ...reservationSnaps
  ] = await Promise.all([
    db.collection("services").get(),
    userLoyaltyRedemptionsCollection(uid).limit(100).get(),
    loyaltySettingsRef().get(),
    legacyLoyaltySettingsRef().get(),
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
  const loyaltySettings = buildLoyaltySettings(
    selectedLoyaltySettingsSnapshot(loyaltySettingsSnap, legacyLoyaltySettingsSnap),
  );
  const loyalty = buildUserLoyalty({
    reservationDocs: loyaltyReservationDocs,
    redemptionDocs: redemptionSnap.docs,
    loyaltySettings,
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

  const [redemptionSnap, loyaltySettingsSnap, legacyLoyaltySettingsSnap, ...reservationSnaps] = await Promise.all([
    userLoyaltyRedemptionsCollection(uid).limit(100).get(),
    loyaltySettingsRef().get(),
    legacyLoyaltySettingsRef().get(),
    ...userLoyaltyReservationQueries(uid, email).map((query) => query.get()),
  ]);
  const loyaltySettings = buildLoyaltySettings(
    selectedLoyaltySettingsSnapshot(loyaltySettingsSnap, legacyLoyaltySettingsSnap),
  );

  return buildUserLoyalty({
    reservationDocs: uniqueReservationDocsFromSnaps(reservationSnaps),
    redemptionDocs: redemptionSnap.docs,
    loyaltySettings,
  });
});

exports.redeemMyLoyaltyReward = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const email = authenticatedEmail(request);
  let redemption = null;
  let loyalty = null;

  await db.runTransaction(async (tx) => {
    const [
      redemptionSnap,
      loyaltySettingsSnap,
      legacyLoyaltySettingsSnap,
      ...reservationSnaps
    ] = await Promise.all([
      tx.get(userLoyaltyRedemptionsCollection(uid).limit(100)),
      tx.get(loyaltySettingsRef()),
      tx.get(legacyLoyaltySettingsRef()),
      ...userLoyaltyReservationQueries(uid, email).map((query) => tx.get(query)),
    ]);
    const reservationDocs = uniqueReservationDocsFromSnaps(reservationSnaps);
    const loyaltySettings = buildLoyaltySettings(
      selectedLoyaltySettingsSnapshot(loyaltySettingsSnap, legacyLoyaltySettingsSnap),
    );
    const currentLoyalty = buildUserLoyalty({
      reservationDocs,
      redemptionDocs: redemptionSnap.docs,
      loyaltySettings,
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
      ...buildLoyaltyRedemptionMetadata(loyaltySettings),
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
      loyaltySettings,
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
    const bookingPolicyRef = db.collection("business_settings").doc("booking_policy");
    const [reservationSnap, bookingPolicySnap] = await Promise.all([
      tx.get(reservationRef),
      tx.get(bookingPolicyRef),
    ]);
    const result = assertReservationCancelable({
      reservationSnap,
      uid,
      email,
      bookingPolicy: buildBookingPolicy(bookingPolicySnap),
    });

    finalStatus = result.status;
    if (result.alreadyCancelled) {
      return;
    }

    const reservationData = reservationSnap.data() || {};
    const customerUid = String(reservationData.customerUid || "").trim();
    const [
      notificationSettingsSnap,
      notificationPreferencesSnap,
      notificationUserSnap,
    ] = customerUid ? await Promise.all([
      tx.get(notificationSettingsRef()),
      tx.get(userNotificationPreferencesRef(customerUid)),
      tx.get(userDocument(customerUid)),
    ]) : [null, null, null];

    tx.update(reservationRef, {
      status: "cancelled",
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      cancelledByUid: uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    enqueueReservationNotification(tx, {
      db,
      templateKey: "booking_cancelled",
      reservationId,
      reservation: {
        ...reservationData,
        status: "cancelled",
      },
      notificationSettingsSnap,
      userPreferencesSnap: notificationPreferencesSnap,
      userDocSnap: notificationUserSnap,
      actorUid: uid,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
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
    const bookingPolicyRef = db.collection("business_settings").doc("booking_policy");
    const [reservationSnap, bookingPolicySnap] = await Promise.all([
      tx.get(reservationRef),
      tx.get(bookingPolicyRef),
    ]);
    const bookingPolicy = buildBookingPolicy(bookingPolicySnap);
    const currentReservation = assertReservationReschedulable({
      reservationSnap,
      uid,
      email,
      newSlotStart: data.slotStart,
      newSlotEnd: data.slotEnd,
      bookingPolicy,
    });
    const reservationData = reservationSnap.data() || {};
    const customerUid = String(reservationData.customerUid || "").trim();

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
      notificationSettingsSnap,
      notificationPreferencesSnap,
      notificationUserSnap,
    ] = await Promise.all([
      tx.get(reservationsQuery),
      tx.get(blockedQuery),
      tx.get(capacityOverrideQuery),
      tx.get(defaultCapacityQuery),
      tx.get(businessInfoRef),
      tx.get(businessInfoQuery),
      customerUid ? tx.get(notificationSettingsRef()) : Promise.resolve(null),
      customerUid ? tx.get(userNotificationPreferencesRef(customerUid)) : Promise.resolve(null),
      customerUid ? tx.get(userDocument(customerUid)) : Promise.resolve(null),
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
      pendingExpiresAt: admin.firestore.Timestamp.fromDate(pendingExpiresAtForPolicy(bookingPolicy)),
      previousSlotStart: currentReservation.currentSlotStart.toISOString(),
      previousSlotEnd: currentReservation.currentSlotEnd.toISOString(),
      previousStatus: currentReservation.previousStatus,
      rescheduledAt: admin.firestore.FieldValue.serverTimestamp(),
      rescheduledByUid: uid,
      rescheduleCount: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    enqueueReservationNotification(tx, {
      db,
      templateKey: "booking_rescheduled",
      reservationId: data.reservationId,
      reservation: {
        ...reservationData,
        slotStart: data.slotStart.toISOString(),
        slotEnd: data.slotEnd.toISOString(),
        date: dateKey,
        status: "pending",
        pendingExpiresAt: admin.firestore.Timestamp.fromDate(pendingExpiresAtForPolicy(bookingPolicy)),
        previousSlotStart: currentReservation.currentSlotStart.toISOString(),
        previousSlotEnd: currentReservation.currentSlotEnd.toISOString(),
        previousStatus: currentReservation.previousStatus,
      },
      notificationSettingsSnap,
      userPreferencesSnap: notificationPreferencesSnap,
      userDocSnap: notificationUserSnap,
      actorUid: uid,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
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
  await userNotificationPreferencesRef(uid).set(
    {
      ownerUid: uid,
      appointmentReminderEnabled: data.appointmentReminderOptIn,
      marketingEnabled: data.marketingOptIn,
      updatedAt: now,
      updatedByUid: uid,
      updateSource: "mobile-profile",
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

exports.getMyNotificationPreferences = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const [preferencesSnap, userSnap] = await Promise.all([
    userNotificationPreferencesRef(uid).get(),
    userDocument(uid).get(),
  ]);

  return {
    preferences: buildUserNotificationPreferences({
      preferencesDoc: preferencesSnap,
      userDoc: userSnap,
    }),
  };
});

exports.updateMyNotificationPreferences = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const preferences = validateUserNotificationPreferencesInput(request.data);
  const value = buildUserNotificationPreferencesValue(preferences);
  const now = admin.firestore.FieldValue.serverTimestamp();

  await db.runTransaction(async (tx) => {
    tx.set(
      userNotificationPreferencesRef(uid),
      {
        ownerUid: uid,
        ...value,
        updatedAt: now,
        updatedByUid: uid,
        updateSource: "mobile-notifications",
      },
      {merge: true},
    );
    tx.set(
      userDocument(uid),
      {
        uid,
        email: String(request.auth?.token?.email || "").trim().toLowerCase(),
        marketingOptIn: preferences.marketingEnabled,
        appointmentReminderOptIn: preferences.appointmentReminderEnabled,
        updatedAt: now,
      },
      {merge: true},
    );
  });

  return {preferences};
});

exports.registerNotificationToken = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const registration = validateNotificationTokenRegistrationInput(request.data);
  const tokenRef = userNotificationTokensCollection(uid).doc(registration.tokenId);
  const now = admin.firestore.FieldValue.serverTimestamp();

  await db.runTransaction(async (tx) => {
    const tokenSnap = await tx.get(tokenRef);
    tx.set(
      tokenRef,
      {
        ...buildNotificationTokenValue(registration, uid),
        createdAt: tokenSnap.exists ? tokenSnap.get("createdAt") || now : now,
        lastSeenAt: now,
        updatedAt: now,
        revokedAt: admin.firestore.FieldValue.delete(),
        updateSource: "mobile-notification-token",
      },
      {merge: true},
    );
  });

  return {
    token: {
      tokenId: registration.tokenId,
      platform: registration.platform,
      enabled: true,
    },
  };
});

exports.deleteNotificationToken = onCall(async (request) => {
  const uid = assertAuthenticatedUid(request);
  const deletion = validateNotificationTokenDeleteInput(request.data);
  const now = admin.firestore.FieldValue.serverTimestamp();

  await userNotificationTokensCollection(uid).doc(deletion.tokenId).set(
    {
      ownerUid: uid,
      tokenId: deletion.tokenId,
      token: admin.firestore.FieldValue.delete(),
      enabled: false,
      revokedAt: now,
      updatedAt: now,
      updateSource: "mobile-notification-token-revoke",
    },
    {merge: true},
  );

  return {
    ok: true,
    tokenId: deletion.tokenId,
    status: "revoked",
  };
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

exports.getAdminCompletableReservations = onCall(async (request) => {
  await assertAdminRequest(request);

  const [servicesSnap, reservationsSnap] = await Promise.all([
    db.collection("services").get(),
    db.collection("reservations")
      .where("status", "in", ["confirmed", "confirmado", "in_progress", "em_execucao", "em execução"])
      .get(),
  ]);

  return buildAdminCompletableReservations({
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

exports.getAdminServiceExtras = onCall(async (request) => {
  await assertAdminRequest(request);

  const extrasSnap = await db.collection("service_extras").get();
  return buildAdminServiceExtras(extrasSnap.docs);
});

exports.getAdminAvailabilityConfiguration = onCall(async (request) => {
  await assertAdminRequest(request);

  const [
    directSnap,
    keyedSnap,
    defaultCapacitySnap,
    capacityOverridesSnap,
    blockedSlotsSnap,
  ] = await Promise.all([
    db.collection("business_settings").doc("business_info").get(),
    db.collection("business_settings").where("key", "==", "business_info").limit(1).get(),
    db.collection("business_settings").where("key", "==", "default_max_bookings_per_slot").limit(1).get(),
    db.collection("capacity_overrides").orderBy("date").limit(120).get(),
    db.collection("blocked_slots").orderBy("date").limit(240).get(),
  ]);
  const businessInfo = businessInfoFromSnapshots(directSnap, keyedSnap);
  assertBusinessInfoReadable(businessInfo);

  return buildAdminAvailabilityConfig({
    businessInfo,
    defaultCapacitySetting: defaultCapacitySnap.empty ? null : defaultCapacitySnap.docs[0].data(),
    capacityOverrideDocs: capacityOverridesSnap.docs,
    blockedSlotDocs: blockedSlotsSnap.docs,
  });
});

exports.getAdminBookingPolicy = onCall(async (request) => {
  await assertAdminRequest(request);

  const policySnap = await db.collection("business_settings").doc("booking_policy").get();
  return buildBookingPolicy(policySnap);
});

exports.getAdminLoyaltySettings = onCall(async (request) => {
  await assertAdminRequest(request);

  const [settingsSnap, legacySettingsSnap] = await Promise.all([
    loyaltySettingsRef().get(),
    legacyLoyaltySettingsRef().get(),
  ]);
  return buildLoyaltySettings(selectedLoyaltySettingsSnapshot(settingsSnap, legacySettingsSnap));
});

exports.getAdminNotificationSettings = onCall(async (request) => {
  await assertAdminRequest(request);

  const settingsSnap = await notificationSettingsRef().get();
  return buildNotificationSettings(settingsSnap);
});

exports.getAdminNotificationCampaignDrafts = onCall(async (request) => {
  await assertAdminRequest(request);

  const campaignsSnap = await notificationCampaignDraftsCollection().limit(100).get();
  return buildAdminNotificationCampaignDrafts(campaignsSnap.docs);
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

exports.updateBookingPolicy = onCall(async (request) => {
  await assertAdminRequest(request);
  const policy = validateBookingPolicyUpdateInput(request.data);
  const value = buildBookingPolicySettingValue(policy);

  await db.collection("business_settings").doc("booking_policy").set(
    {
      key: "booking_policy",
      value,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedByUid: request.auth.uid,
      updateSource: "admin-mobile-booking-policy",
    },
    {merge: true},
  );

  return {
    ...policy,
    source: "firestore",
  };
});

exports.updateLoyaltySettings = onCall(async (request) => {
  await assertAdminRequest(request);
  const settings = validateLoyaltySettingsUpdateInput(request.data);
  const value = buildLoyaltySettingsValue(settings);

  await loyaltySettingsRef().set(
    {
      key: "loyalty_settings",
      value,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedByUid: request.auth.uid,
      updateSource: "admin-mobile-loyalty",
    },
    {merge: true},
  );

  return {
    ...settings,
    source: "firestore",
  };
});

exports.updateNotificationSettings = onCall(async (request) => {
  await assertAdminRequest(request);
  const settings = validateNotificationSettingsUpdateInput(request.data);
  const value = buildNotificationSettingsValue(settings);

  await notificationSettingsRef().set(
    {
      key: "notification_settings",
      value,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedByUid: request.auth.uid,
      updateSource: "admin-mobile-notifications",
    },
    {merge: true},
  );

  return {
    ...settings,
    source: "firestore",
  };
});

exports.sendAdminNotificationTest = onCall(async (request) => {
  await assertAdminRequest(request);
  const {templateKey} = validateAdminNotificationTestInput(request.data);
  const recipientUid = request.auth.uid;

  const hasActiveToken = await hasActiveNotificationTokenForUser(recipientUid);
  if (!hasActiveToken) {
    throw new HttpsError(
      "failed-precondition",
      "Register a notification device before sending a test notification",
    );
  }

  const settingsSnap = await notificationSettingsRef().get();
  const settings = buildNotificationSettings(settingsSnap);
  const notification = buildAdminTestNotificationOutboxDocument({
    templateKey,
    settings,
    recipientUid,
    actorUid: recipientUid,
    timestamp: new Date(),
  });
  if (!notification) {
    throw new HttpsError("failed-precondition", "Notification template is disabled");
  }

  const notificationRef = db.collection(NOTIFICATION_OUTBOX_COLLECTION).doc();
  await notificationRef.set(notification);

  return {
    queued: true,
    notificationId: notificationRef.id,
    templateKey: notification.templateKey,
    deliveryState: notification.deliveryState,
    recipientUid,
    message: "Test notification queued for the current admin user",
  };
});

exports.upsertAdminNotificationCampaignDraft = onCall(async (request) => {
  await assertAdminRequest(request);
  const fallbackRef = notificationCampaignDraftsCollection().doc();
  const draft = validateNotificationCampaignDraftInput(request.data, fallbackRef.id);
  const campaignRef = notificationCampaignDraftsCollection().doc(draft.campaignId);
  const value = buildNotificationCampaignDraftValue(draft);
  let created = false;

  await db.runTransaction(async (tx) => {
    const campaignSnap = await tx.get(campaignRef);
    created = !campaignSnap.exists;
    const currentStatus = String(campaignSnap.get("status") || "draft").trim();
    if (!created && currentStatus !== "draft") {
      throw new HttpsError("failed-precondition", "Only draft notification campaigns can be edited");
    }
    const update = {
      ...value,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedByUid: request.auth.uid,
      archivedAt: admin.firestore.FieldValue.delete(),
      archivedByUid: admin.firestore.FieldValue.delete(),
    };

    if (created) {
      update.createdAt = admin.firestore.FieldValue.serverTimestamp();
      update.createdByUid = request.auth.uid;
      update.notificationCreatedByUid = request.auth.uid;
    }

    tx.set(campaignRef, update, {merge: true});
  });

  return {
    ok: true,
    created,
    campaignId: draft.campaignId,
    status: draft.status,
    targetAudience: draft.targetAudience,
    sendBlocked: true,
    sendBlockedReason: draft.sendBlockedReason,
  };
});

exports.archiveAdminNotificationCampaignDraft = onCall(async (request) => {
  await assertAdminRequest(request);
  const data = validateNotificationCampaignDraftArchiveInput(request.data);
  const campaignRef = notificationCampaignDraftsCollection().doc(data.campaignId);

  await db.runTransaction(async (tx) => {
    const campaignSnap = await tx.get(campaignRef);
    if (!campaignSnap.exists) {
      throw new HttpsError("not-found", "Notification campaign draft not found");
    }
    const currentStatus = String(campaignSnap.get("status") || "draft").trim();
    if (currentStatus === "archived") return;
    if (currentStatus !== "draft") {
      throw new HttpsError("failed-precondition", "Only draft notification campaigns can be archived");
    }

    tx.update(campaignRef, {
      status: "archived",
      archivedAt: admin.firestore.FieldValue.serverTimestamp(),
      archivedByUid: request.auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedByUid: request.auth.uid,
      updateSource: "admin-mobile-notification-campaigns",
      sendBlocked: true,
      sendBlockedReason: "campaign-send-not-implemented",
    });
  });

  return {
    ok: true,
    campaignId: data.campaignId,
    status: "archived",
  };
});

exports.updateAvailabilityConfiguration = onCall(async (request) => {
  await assertAdminRequest(request);
  const availability = validateAvailabilityConfigurationInput(request.data);

  const [directSnap, keyedSnap] = await Promise.all([
    db.collection("business_settings").doc("business_info").get(),
    db.collection("business_settings").where("key", "==", "business_info").limit(1).get(),
  ]);
  const businessInfo = businessInfoFromSnapshots(directSnap, keyedSnap);
  assertBusinessInfoReadable(businessInfo);
  const updatedBusinessInfo = {
    ...businessInfo,
    openingHours: availability.openingHours,
  };
  const businessInfoValue = buildBusinessInfoSettingValue(updatedBusinessInfo);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();

  batch.set(
    db.collection("business_settings").doc("business_info"),
    {
      key: "business_info",
      value: businessInfoValue,
      updatedAt: now,
      updatedByUid: request.auth.uid,
      updateSource: "admin-mobile-availability",
    },
    {merge: true},
  );
  batch.set(
    db.collection("business_settings").doc("default_max_bookings_per_slot"),
    {
      key: "default_max_bookings_per_slot",
      value: availability.defaultMaxBookingsPerSlot,
      updatedAt: now,
      updatedByUid: request.auth.uid,
      updateSource: "admin-mobile-availability",
    },
    {merge: true},
  );
  await batch.commit();

  const [capacityOverridesSnap, blockedSlotsSnap] = await Promise.all([
    db.collection("capacity_overrides").orderBy("date").limit(120).get(),
    db.collection("blocked_slots").orderBy("date").limit(240).get(),
  ]);

  return buildAdminAvailabilityConfig({
    businessInfo: updatedBusinessInfo,
    defaultCapacitySetting: {value: availability.defaultMaxBookingsPerSlot},
    capacityOverrideDocs: capacityOverridesSnap.docs,
    blockedSlotDocs: blockedSlotsSnap.docs,
  });
});

exports.upsertCapacityOverride = onCall(async (request) => {
  await assertAdminRequest(request);
  const override = validateCapacityOverrideInput(request.data);

  await db.collection("capacity_overrides").doc(override.date).set(
    {
      ...buildCapacityOverrideDocument(override, request.auth.uid),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    {merge: true},
  );

  return {
    ok: true,
    date: override.date,
    maxBookingsPerSlot: override.maxBookingsPerSlot,
    status: "updated",
  };
});

exports.clearCapacityOverride = onCall(async (request) => {
  await assertAdminRequest(request);
  const override = validateCapacityOverrideClearInput(request.data);

  await db.collection("capacity_overrides").doc(override.date).set(
    {
      date: override.date,
      active: false,
      maxBookingsPerSlot: admin.firestore.FieldValue.delete(),
      clearedAt: admin.firestore.FieldValue.serverTimestamp(),
      clearedByUid: request.auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedByUid: request.auth.uid,
      updateSource: "admin-mobile-availability",
    },
    {merge: true},
  );

  return {
    ok: true,
    date: override.date,
    status: "cleared",
  };
});

exports.upsertBlockedSlot = onCall(async (request) => {
  await assertAdminRequest(request);
  const fallbackRef = db.collection("blocked_slots").doc();
  const blockedSlot = validateBlockedSlotInput(request.data, fallbackRef.id);

  await db.collection("blocked_slots").doc(blockedSlot.blockedSlotId).set(
    {
      ...buildBlockedSlotDocument(blockedSlot, request.auth.uid),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    {merge: true},
  );

  return {
    ok: true,
    blockedSlotId: blockedSlot.blockedSlotId,
    date: blockedSlot.date,
    status: "updated",
  };
});

exports.clearBlockedSlot = onCall(async (request) => {
  await assertAdminRequest(request);
  const blockedSlot = validateBlockedSlotClearInput(request.data);

  await db.collection("blocked_slots").doc(blockedSlot.blockedSlotId).set(
    {
      blockedSlotId: blockedSlot.blockedSlotId,
      active: false,
      slotStart: admin.firestore.FieldValue.delete(),
      slotEnd: admin.firestore.FieldValue.delete(),
      startTime: admin.firestore.FieldValue.delete(),
      endTime: admin.firestore.FieldValue.delete(),
      start_time: admin.firestore.FieldValue.delete(),
      end_time: admin.firestore.FieldValue.delete(),
      clearedAt: admin.firestore.FieldValue.serverTimestamp(),
      clearedByUid: request.auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedByUid: request.auth.uid,
      updateSource: "admin-mobile-availability",
    },
    {merge: true},
  );

  return {
    ok: true,
    blockedSlotId: blockedSlot.blockedSlotId,
    status: "cleared",
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

exports.upsertServiceExtra = onCall(async (request) => {
  await assertAdminRequest(request);
  const extraCollection = db.collection("service_extras");
  const fallbackExtraRef = extraCollection.doc();
  const data = validateAdminServiceExtraInput(request.data, fallbackExtraRef.id);
  const extraRef = extraCollection.doc(data.extraId);
  let created = false;

  await db.runTransaction(async (tx) => {
    const extraSnap = await tx.get(extraRef);
    created = !extraSnap.exists;
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

    tx.set(extraRef, update, {merge: true});
  });

  return {
    ok: true,
    extraId: data.extraId,
    status: data.document.active ? "active" : "inactive",
    created,
  };
});

exports.archiveServiceExtra = onCall(async (request) => {
  await assertAdminRequest(request);
  const data = validateAdminServiceExtraArchiveInput(request.data);
  const extraRef = db.collection("service_extras").doc(data.extraId);

  await db.runTransaction(async (tx) => {
    const extraSnap = await tx.get(extraRef);
    if (!extraSnap.exists) {
      throw new HttpsError("not-found", "Service extra not found");
    }

    tx.update(extraRef, {
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
    extraId: data.extraId,
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
    const customerUid = String(reservationData.customerUid || "").trim();
    const [
      notificationSettingsSnap,
      notificationPreferencesSnap,
      notificationUserSnap,
    ] = customerUid ? await Promise.all([
      tx.get(notificationSettingsRef()),
      tx.get(userNotificationPreferencesRef(customerUid)),
      tx.get(userDocument(customerUid)),
    ]) : [null, null, null];

    reservationCode = String(reservationData.reservationCode || "").trim();
    tx.update(reservationRef, {
      status: "confirmed",
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      acceptedByUid: request.auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    redeemReservedLoyaltyReward(tx, reservationData, data.reservationId);
    enqueueReservationNotification(tx, {
      db,
      templateKey: "booking_accepted",
      reservationId: data.reservationId,
      reservation: {
        ...reservationData,
        status: "confirmed",
      },
      notificationSettingsSnap,
      userPreferencesSnap: notificationPreferencesSnap,
      userDocSnap: notificationUserSnap,
      actorUid: request.auth.uid,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
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
    const customerUid = String(reservationData.customerUid || "").trim();
    const [
      notificationSettingsSnap,
      notificationPreferencesSnap,
      notificationUserSnap,
    ] = customerUid ? await Promise.all([
      tx.get(notificationSettingsRef()),
      tx.get(userNotificationPreferencesRef(customerUid)),
      tx.get(userDocument(customerUid)),
    ]) : [null, null, null];
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
    enqueueReservationNotification(tx, {
      db,
      templateKey: "booking_rejected",
      reservationId: data.reservationId,
      reservation: {
        ...reservationData,
        status: "rejected",
        rejectionReason: data.rejectionReason,
      },
      notificationSettingsSnap,
      userPreferencesSnap: notificationPreferencesSnap,
      userDocSnap: notificationUserSnap,
      actorUid: request.auth.uid,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return {
    ok: true,
    reservationId: data.reservationId,
    reservationCode,
    status: "rejected",
  };
});

exports.completeReservation = onCall(async (request) => {
  await assertAdminRequest(request);
  const data = validateAdminReservationActionInput(request.data);
  const reservationRef = db.collection("reservations").doc(data.reservationId);
  let reservationCode = "";

  await db.runTransaction(async (tx) => {
    const reservationSnap = await tx.get(reservationRef);
    const reservationData = assertReservationCompletable({reservationSnap});
    const customerUid = String(reservationData.customerUid || "").trim();
    const outboxRef = db
      .collection(NOTIFICATION_OUTBOX_COLLECTION)
      .doc(notificationOutboxDocId("review_prompt", data.reservationId));
    const reviewRef = customerUid ?
      db.collection("reservation_reviews").doc(buildReservationReviewId(data.reservationId, customerUid)) :
      null;
    const [
      notificationSettingsSnap,
      notificationPreferencesSnap,
      notificationUserSnap,
      reviewSnap,
      existingOutboxSnap,
    ] = customerUid ? await Promise.all([
      tx.get(notificationSettingsRef()),
      tx.get(userNotificationPreferencesRef(customerUid)),
      tx.get(userDocument(customerUid)),
      tx.get(reviewRef),
      tx.get(outboxRef),
    ]) : [null, null, null, null, null];

    reservationCode = String(reservationData.reservationCode || "").trim();
    tx.update(reservationRef, {
      status: "completed",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      completedByUid: request.auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updateSource: "admin-mobile-completion",
    });

    if (customerUid && !reviewSnap.exists && !existingOutboxSnap.exists) {
      enqueueReservationNotification(tx, {
        db,
        templateKey: "review_prompt",
        reservationId: data.reservationId,
        reservation: {
          ...reservationData,
          status: "completed",
        },
        notificationSettingsSnap,
        userPreferencesSnap: notificationPreferencesSnap,
        userDocSnap: notificationUserSnap,
        existingOutboxSnap,
        actorUid: request.auth.uid,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  });

  return {
    ok: true,
    reservationId: data.reservationId,
    reservationCode,
    status: "completed",
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
      uid: user.uid,
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
  await db.collection("admin_allowlist").doc(email).set(
    {
      uid: request.auth.uid,
      email,
      role,
      lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    {merge: true},
  );
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
      const customerUid = String(reservationData.customerUid || "").trim();
      const [
        notificationSettingsSnap,
        notificationPreferencesSnap,
        notificationUserSnap,
      ] = customerUid ? await Promise.all([
        tx.get(notificationSettingsRef()),
        tx.get(userNotificationPreferencesRef(customerUid)),
        tx.get(userDocument(customerUid)),
      ]) : [null, null, null];
      tx.update(docSnap.ref, {
        status: "expired",
        expiredAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      releaseReservedLoyaltyReward(tx, reservationData);
      enqueueReservationNotification(tx, {
        db,
        templateKey: "booking_expired",
        reservationId: docSnap.id,
        reservation: {
          ...reservationData,
          status: "expired",
        },
        notificationSettingsSnap,
        userPreferencesSnap: notificationPreferencesSnap,
        userDocSnap: notificationUserSnap,
        actorUid: "system",
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      expiredCount += 1;
    });
  }

  logger.info("Expired pending reservations", {expiredCount});
});

exports.queueReviewPromptNotifications = onSchedule("every 60 minutes", async () => {
  const now = new Date();
  const completedSnap = await db.collection("reservations")
    .where("status", "in", REVIEW_PROMPT_RESERVATION_STATUS_VALUES)
    .limit(250)
    .get();
  let queuedCount = 0;

  for (const docSnap of completedSnap.docs) {
    if (!isReviewPromptReservationDue(docSnap.data(), now)) continue;

    const queued = await db.runTransaction(async (tx) => {
      const freshSnap = await tx.get(docSnap.ref);
      const reservationData = freshSnap.data() || {};
      if (!freshSnap.exists || !isReviewPromptReservationDue(reservationData, now)) return false;

      const customerUid = String(reservationData.customerUid || "").trim();
      const reviewRef = db
        .collection("reservation_reviews")
        .doc(buildReservationReviewId(docSnap.id, customerUid));
      const outboxRef = db
        .collection(NOTIFICATION_OUTBOX_COLLECTION)
        .doc(notificationOutboxDocId("review_prompt", docSnap.id));
      const [
        reviewSnap,
        existingOutboxSnap,
        notificationSettingsSnap,
        notificationPreferencesSnap,
        notificationUserSnap,
      ] = await Promise.all([
        tx.get(reviewRef),
        tx.get(outboxRef),
        tx.get(notificationSettingsRef()),
        tx.get(userNotificationPreferencesRef(customerUid)),
        tx.get(userDocument(customerUid)),
      ]);

      if (reviewSnap.exists || existingOutboxSnap.exists) return false;

      return Boolean(enqueueReservationNotification(tx, {
        db,
        templateKey: "review_prompt",
        reservationId: docSnap.id,
        reservation: reservationData,
        notificationSettingsSnap,
        userPreferencesSnap: notificationPreferencesSnap,
        userDocSnap: notificationUserSnap,
        existingOutboxSnap,
        actorUid: "system",
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      }));
    });

    if (queued) queuedCount += 1;
  }

  logger.info("Queued review prompt notifications", {queuedCount});
});

exports.queueBookingReminderNotifications = onSchedule("every 15 minutes", async () => {
  const now = new Date();
  const settingsSnap = await notificationSettingsRef().get();
  const settings = buildNotificationSettings(settingsSnap);
  const confirmedSnap = await db.collection("reservations")
    .where("status", "in", BOOKING_REMINDER_RESERVATION_STATUS_VALUES)
    .limit(250)
    .get();
  let queuedCount = 0;

  for (const docSnap of confirmedSnap.docs) {
    if (!isBookingReminderReservationDue(docSnap.data(), settings, now)) continue;

    const queued = await db.runTransaction(async (tx) => {
      const freshSnap = await tx.get(docSnap.ref);
      const reservationData = freshSnap.data() || {};
      const customerUid = String(reservationData.customerUid || "").trim();
      if (!freshSnap.exists || !customerUid) return false;

      const outboxRef = db
        .collection(NOTIFICATION_OUTBOX_COLLECTION)
        .doc(notificationOutboxDocId("booking_reminder", docSnap.id));
      const [
        existingOutboxSnap,
        notificationSettingsSnap,
        notificationPreferencesSnap,
        notificationUserSnap,
      ] = await Promise.all([
        tx.get(outboxRef),
        tx.get(notificationSettingsRef()),
        tx.get(userNotificationPreferencesRef(customerUid)),
        tx.get(userDocument(customerUid)),
      ]);
      const freshSettings = buildNotificationSettings(notificationSettingsSnap);
      if (!isBookingReminderReservationDue(reservationData, freshSettings, now)) return false;
      if (existingOutboxSnap.exists) return false;

      return Boolean(enqueueReservationNotification(tx, {
        db,
        templateKey: "booking_reminder",
        reservationId: docSnap.id,
        reservation: reservationData,
        notificationSettingsSnap,
        userPreferencesSnap: notificationPreferencesSnap,
        userDocSnap: notificationUserSnap,
        existingOutboxSnap,
        actorUid: "system",
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      }));
    });

    if (queued) queuedCount += 1;
  }

  logger.info("Queued booking reminder notifications", {
    scannedCount: confirmedSnap.size,
    queuedCount,
    reminderLeadMinutes: settings.reminderLeadMinutes,
  });
  return {
    scannedCount: confirmedSnap.size,
    queuedCount,
  };
});

async function claimNotificationOutboxDelivery(docSnap, now = new Date(), notificationSettings = {}) {
  return db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(docSnap.ref);
    if (!freshSnap.exists) return null;

    const outbox = freshSnap.data() || {};
    if (!isNotificationOutboxDeliverable(outbox)) return null;
    if (!isNotificationSendingLeaseExpired(outbox, now)) return null;

    const previousAttemptCount = Number.isFinite(outbox.attemptCount) ?
      Math.max(0, Math.floor(outbox.attemptCount)) :
      0;
    const serverNow = admin.firestore.FieldValue.serverTimestamp();
    if (previousAttemptCount >= MAX_DELIVERY_ATTEMPTS) {
      tx.update(freshSnap.ref, {
        deliveryState: "failed",
        deliveryLeaseExpiresAt: null,
        deliveryFailureReason: "max-attempts-exceeded",
        failedAt: serverNow,
        updatedAt: serverNow,
      });
      return null;
    }

    const quietHoursDeferral = notificationQuietHoursDeferral(outbox, notificationSettings, now);
    if (quietHoursDeferral) {
      tx.update(freshSnap.ref, {
        ...quietHoursDeferral,
        quietHoursDeferredUntil: admin.firestore.Timestamp.fromDate(
          quietHoursDeferral.quietHoursDeferredUntil,
        ),
        updatedAt: serverNow,
      });
      return {
        ref: freshSnap.ref,
        state: "deferred",
        outbox,
        deferredUntil: quietHoursDeferral.quietHoursDeferredUntil,
      };
    }

    const attemptCount = previousAttemptCount + 1;
    tx.update(freshSnap.ref, {
      deliveryState: "sending",
      attemptCount,
      lastAttemptAt: serverNow,
      deliveryLeaseExpiresAt: admin.firestore.Timestamp.fromDate(nextDeliveryLeaseExpiration(now)),
      deliveryDeferralReason: admin.firestore.FieldValue.delete(),
      quietHoursDeferredUntil: admin.firestore.FieldValue.delete(),
      quietHoursStart: admin.firestore.FieldValue.delete(),
      quietHoursEnd: admin.firestore.FieldValue.delete(),
      quietHoursTimeZone: admin.firestore.FieldValue.delete(),
      updatedAt: serverNow,
    });

    return {
      ref: freshSnap.ref,
      attemptCount,
      outbox: {
        ...outbox,
        attemptCount,
      },
    };
  });
}

async function activeNotificationTokenDeliveriesForUser(uid) {
  const tokenSnap = await userNotificationTokensCollection(uid)
    .where("enabled", "==", true)
    .limit(MAX_DELIVERY_TOKENS_PER_USER)
    .get();
  return tokenSnap.docs
    .map((snap) => notificationTokenDeliveryFromSnap(snap, uid))
    .filter(Boolean);
}

async function hasActiveNotificationTokenForUser(uid) {
  const tokenDeliveries = await activeNotificationTokenDeliveriesForUser(uid);
  return tokenDeliveries.length > 0;
}

async function revokeInvalidNotificationTokens(uid, invalidTokenIds) {
  if (!invalidTokenIds.length) return;

  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();
  for (const tokenId of invalidTokenIds) {
    batch.set(
      userNotificationTokensCollection(uid).doc(tokenId),
      {
        enabled: false,
        token: admin.firestore.FieldValue.delete(),
        revokedAt: now,
        updatedAt: now,
        updateSource: "push-delivery-invalid-token",
      },
      {merge: true},
    );
  }
  await batch.commit();
}

async function processNotificationOutboxDocument(docSnap, {
  notificationSettingsSnap = null,
  now = new Date(),
} = {}) {
  const settings = buildNotificationSettings(notificationSettingsSnap);
  const claimed = await claimNotificationOutboxDelivery(docSnap, now, settings);
  if (!claimed) return {state: "skipped"};
  if (claimed.state === "deferred") {
    return {state: "deferred", reason: "quiet-hours"};
  }

  const serverNow = admin.firestore.FieldValue.serverTimestamp();
  const recipientUid = String(claimed.outbox.recipientUid || "").trim();
  const [preferencesSnap, userSnap] = await Promise.all([
    userNotificationPreferencesRef(recipientUid).get(),
    userDocument(recipientUid).get(),
  ]);
  const suppression = notificationDeliveryPreferenceSuppression(
    claimed.outbox,
    settings,
    buildUserNotificationPreferences({
      preferencesDoc: preferencesSnap,
      userDoc: userSnap,
    }),
  );
  if (suppression) {
    await claimed.ref.update({
      ...deliverySuppressionUpdate({
        suppression,
        timestamp: serverNow,
      }),
      attemptCount: Math.max(0, claimed.attemptCount - 1),
    });
    return {
      state: "suppressed",
      reason: suppression.deliverySuppressionReason,
    };
  }

  const tokenDeliveries = await activeNotificationTokenDeliveriesForUser(recipientUid);

  if (!tokenDeliveries.length) {
    await claimed.ref.update({
      ...deliveryFailureUpdate({
        reason: "no-active-tokens",
        error: {code: "no-active-tokens", message: "No active notification tokens"},
        attemptCount: claimed.attemptCount,
        timestamp: serverNow,
      }),
      attemptCount: claimed.attemptCount,
    });
    return {state: "failed", reason: "no-active-tokens"};
  }

  try {
    const response = await admin.messaging().sendEachForMulticast(
      buildNotificationPushMessage(claimed.outbox, tokenDeliveries),
    );
    const {outboxUpdate, invalidTokenIds} = deliveryCompletionUpdate({
      response,
      tokenDeliveries,
      attemptCount: claimed.attemptCount,
      timestamp: serverNow,
    });

    await Promise.all([
      claimed.ref.update({
        ...outboxUpdate,
        attemptCount: claimed.attemptCount,
      }),
      revokeInvalidNotificationTokens(recipientUid, invalidTokenIds),
    ]);

    return {
      state: outboxUpdate.deliveryState,
      successCount: outboxUpdate.deliveryResult.successCount,
      failureCount: outboxUpdate.deliveryResult.failureCount,
      invalidTokenCount: invalidTokenIds.length,
    };
  } catch (error) {
    const outboxUpdate = deliveryFailureUpdate({
      reason: "messaging-send-failed",
      error,
      attemptCount: claimed.attemptCount,
      timestamp: serverNow,
    });
    await claimed.ref.update({
      ...outboxUpdate,
      attemptCount: claimed.attemptCount,
    });
    logger.warn("Notification outbox delivery attempt failed", {
      outboxId: docSnap.id,
      code: error?.code || error?.errorInfo?.code || "unknown",
    });
    return {state: outboxUpdate.deliveryState, reason: "messaging-send-failed"};
  }
}

exports.processNotificationOutbox = onSchedule("every 5 minutes", async () => {
  const [outboxSnap, notificationSettingsSnap] = await Promise.all([
    db.collection(NOTIFICATION_OUTBOX_COLLECTION)
      .where("deliveryState", "in", ["queued", "retry", "sending", "deferred"])
      .limit(100)
      .get(),
    notificationSettingsRef().get(),
  ]);
  const now = new Date();

  const summary = {
    scannedCount: outboxSnap.size,
    sentCount: 0,
    queuedCount: 0,
    failedCount: 0,
    deferredCount: 0,
    suppressedCount: 0,
    skippedCount: 0,
  };

  for (const docSnap of outboxSnap.docs) {
    const result = await processNotificationOutboxDocument(docSnap, {
      notificationSettingsSnap,
      now,
    });
    if (result.state === "sent") summary.sentCount += 1;
    else if (result.state === "queued") summary.queuedCount += 1;
    else if (result.state === "failed") summary.failedCount += 1;
    else if (result.state === "deferred") summary.deferredCount += 1;
    else if (result.state === "suppressed") summary.suppressedCount += 1;
    else summary.skippedCount += 1;
  }

  logger.info("Processed notification outbox", summary);
  return summary;
});

exports.health = onRequest((req, res) => {
  res.status(200).json({ok: true, service: "sudsandshine-firebase", now: new Date().toISOString()});
});

async function sendReservationEmails(payload) {
  // TODO(DIGS-9): Wire provider credentials (SendGrid/Resend/etc) using secrets.
  // Keep logging + retry policy explicit.
  logger.info("Reservation email workflow placeholder", payload);
}
