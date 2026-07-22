const {buildNotificationSettings} = require("./notificationAdmin");
const {
  NOTIFICATION_CAMPAIGN_SEND_BLOCKED_REASON,
  NOTIFICATION_CAMPAIGN_SEND_STATE,
} = require("./notificationCampaigns");
const {buildUserNotificationPreferences} = require("./notificationPreferences");

const NOTIFICATION_OUTBOX_COLLECTION = "notification_outbox";
const ADMIN_PENDING_BOOKING_TEMPLATE_KEY = "admin_pending_booking";
const LOYALTY_REWARD_TEMPLATE_KEY = "loyalty_reward";
const WAITLIST_AVAILABLE_TEMPLATE_KEY = "waitlist_available";
const BOOKING_STATUS_TEMPLATE_KEYS = new Set([
  "booking_request",
  "booking_accepted",
  "booking_rejected",
  "booking_in_progress",
  "booking_completed",
  "booking_expired",
  "booking_cancelled",
  "booking_rescheduled",
  WAITLIST_AVAILABLE_TEMPLATE_KEY,
]);
const REVIEW_PROMPT_RESERVATION_STATUS_VALUES = [
  "completed",
  "complete",
  "concluido",
  "concluído",
  "done",
];
const BOOKING_REMINDER_RESERVATION_STATUS_VALUES = [
  "confirmed",
  "confirmado",
];

function cleanReservationText(value, maxLength = 240) {
  if (value === undefined || value === null) return "";
  return String(value).trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function notificationOutboxDocId(templateKey, reservationId) {
  const safeTemplateKey = cleanReservationText(templateKey, 80).replace(/[^A-Za-z0-9_-]/g, "_");
  const safeReservationId = cleanReservationText(reservationId, 160).replace(/[^A-Za-z0-9_-]/g, "_");
  return `${safeTemplateKey}_${safeReservationId}`;
}

function adminNotificationOutboxDocId(templateKey, reservationId, recipientUid) {
  const safeRecipientUid = cleanReservationText(recipientUid, 128).replace(/[^A-Za-z0-9_-]/g, "_");
  return `${notificationOutboxDocId(templateKey, reservationId)}_${safeRecipientUid}`;
}

function campaignNotificationOutboxDocId(campaignId, recipientUid) {
  const safeCampaignId = cleanReservationText(campaignId, 80).replace(/[^A-Za-z0-9_-]/g, "_");
  const safeRecipientUid = cleanReservationText(recipientUid, 128).replace(/[^A-Za-z0-9_-]/g, "_");
  return `campaign_draft_${safeCampaignId}_${safeRecipientUid}`;
}

function templateForKey(settings, templateKey) {
  return (settings.templates || []).find((template) => template.key === templateKey) || null;
}

function isTemplateGloballyEnabled(settings, templateKey) {
  if (templateKey === ADMIN_PENDING_BOOKING_TEMPLATE_KEY) {
    return settings.adminPendingAlertEnabled !== false;
  }
  if (BOOKING_STATUS_TEMPLATE_KEYS.has(templateKey)) {
    return settings.bookingStatusEnabled !== false;
  }
  if (templateKey === "booking_reminder") {
    return settings.appointmentReminderEnabled !== false;
  }
  if (templateKey === "review_prompt") {
    return settings.bookingStatusEnabled !== false;
  }
  if (templateKey === LOYALTY_REWARD_TEMPLATE_KEY) {
    return settings.loyaltyEnabled !== false;
  }
  return false;
}

function isUserPreferenceEnabled(preferences, templateKey) {
  if (BOOKING_STATUS_TEMPLATE_KEYS.has(templateKey) || templateKey === "review_prompt") {
    return preferences.bookingStatusEnabled !== false;
  }
  if (templateKey === "booking_reminder") {
    return preferences.appointmentReminderEnabled !== false;
  }
  if (templateKey === ADMIN_PENDING_BOOKING_TEMPLATE_KEY) {
    return preferences.adminPendingAlertEnabled !== false;
  }
  if (templateKey === LOYALTY_REWARD_TEMPLATE_KEY) {
    return preferences.loyaltyEnabled !== false;
  }
  return false;
}

function reservationVariables(reservationId, reservation) {
  return {
    reservationId,
    reservationCode: cleanReservationText(reservation.reservationCode, 40),
    customerName: cleanReservationText(reservation.customerName, 160),
    customerEmail: cleanReservationText(reservation.customerEmail, 160),
    customerPhone: cleanReservationText(reservation.customerPhone, 80),
    serviceName: cleanReservationText(reservation.serviceName || "Servico", 160),
    slotStart: cleanReservationText(reservation.slotStart, 80),
    slotEnd: cleanReservationText(reservation.slotEnd, 80),
    previousSlotStart: cleanReservationText(reservation.previousSlotStart, 80),
    previousSlotEnd: cleanReservationText(reservation.previousSlotEnd, 80),
    status: cleanReservationText(reservation.status, 40),
    rejectionReason: cleanReservationText(reservation.rejectionReason, 500),
  };
}

function adminTestNotificationVariables() {
  return {
    reservationId: "admin-test",
    reservationCode: "TESTE",
    customerName: "Cliente de teste",
    customerEmail: "cliente.teste@example.com",
    customerPhone: "+351 900 000 000",
    serviceName: "Lavagem completa",
    slotStart: "2026-06-01 10:00",
    slotEnd: "2026-06-01 11:00",
    previousSlotStart: "2026-06-01 09:00",
    previousSlotEnd: "2026-06-01 10:00",
    status: "teste",
    rejectionReason: "Teste administrativo",
  };
}

function loyaltyRewardVariables(redemptionId, redemption) {
  return {
    redemptionId,
    rewardCode: cleanReservationText(redemption?.rewardCode, 80),
    rewardNumber: cleanReservationText(redemption?.rewardNumber, 20),
    rewardType: cleanReservationText(redemption?.rewardType, 80),
    rewardValue: cleanReservationText(redemption?.rewardValue, 40),
    rewardDescription: cleanReservationText(redemption?.rewardDescription || "recompensa", 200),
  };
}

function waitlistVariables(waitlistId, waitlist) {
  return {
    waitlistId,
    serviceName: cleanReservationText(waitlist?.serviceName || "serviço", 160),
    waitlistDate: cleanReservationText(waitlist?.date, 10),
    availableTimes: (waitlist?.availableTimes || [])
      .map((time) => cleanReservationText(time, 5))
      .filter(Boolean)
      .slice(0, 3)
      .join(", "),
  };
}

function isReviewPromptReservationDue(reservation, now = new Date()) {
  const customerUid = cleanReservationText(reservation?.customerUid, 128);
  if (!customerUid) return false;

  const status = cleanReservationText(reservation?.status || "pending", 40).toLowerCase();
  if (!REVIEW_PROMPT_RESERVATION_STATUS_VALUES.includes(status)) return false;

  const slotEnd = new Date(cleanReservationText(reservation?.slotEnd, 80));
  if (Number.isNaN(slotEnd.getTime())) return false;
  return slotEnd <= now;
}

function isBookingReminderReservationDue(reservation, settings, now = new Date()) {
  const customerUid = cleanReservationText(reservation?.customerUid, 128);
  if (!customerUid) return false;
  if (settings?.appointmentReminderEnabled === false) return false;

  const status = cleanReservationText(reservation?.status || "pending", 40).toLowerCase();
  if (!BOOKING_REMINDER_RESERVATION_STATUS_VALUES.includes(status)) return false;

  const slotStart = new Date(cleanReservationText(reservation?.slotStart, 80));
  if (Number.isNaN(slotStart.getTime())) return false;
  if (slotStart <= now) return false;

  const leadMinutes = Number.isFinite(settings?.reminderLeadMinutes) ?
    Math.max(0, Math.floor(settings.reminderLeadMinutes)) :
    0;
  const reminderWindowEnd = new Date(now.getTime() + leadMinutes * 60 * 1000);
  return slotStart <= reminderWindowEnd;
}

function notificationTypeForTemplateKey(templateKey) {
  if (templateKey === ADMIN_PENDING_BOOKING_TEMPLATE_KEY) return "admin_pending_booking";
  if (templateKey === "review_prompt") return "review_prompt";
  if (templateKey === "booking_reminder") return "booking_reminder";
  if (templateKey === LOYALTY_REWARD_TEMPLATE_KEY) return "loyalty_reward";
  if (templateKey === WAITLIST_AVAILABLE_TEMPLATE_KEY) return "waitlist_available";
  return "booking_status";
}

function interpolateTemplateText(text, variables) {
  return cleanReservationText(text, 600).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) return "";
    return variables[key];
  });
}

function buildReservationNotificationOutboxDocument({
  templateKey,
  reservationId,
  reservation,
  settings,
  preferences,
  actorUid = "",
  timestamp = null,
} = {}) {
  const recipientUid = cleanReservationText(reservation?.customerUid, 128);
  const normalizedReservationId = cleanReservationText(reservationId, 160);
  if (!recipientUid || !normalizedReservationId) return null;
  if (!isTemplateGloballyEnabled(settings, templateKey)) return null;
  if (!isUserPreferenceEnabled(preferences, templateKey)) return null;

  const template = templateForKey(settings, templateKey);
  if (!template || template.enabled === false) return null;

  const variables = reservationVariables(normalizedReservationId, reservation || {});
  const title = interpolateTemplateText(template.title, variables);
  const body = interpolateTemplateText(template.body, variables);
  if (!title || !body) return null;

  const now = timestamp || new Date();
  return {
    type: notificationTypeForTemplateKey(templateKey),
    templateKey,
    recipientUid,
    reservationId: normalizedReservationId,
    reservationCode: variables.reservationCode,
    serviceName: variables.serviceName,
    slotStart: variables.slotStart,
    slotEnd: variables.slotEnd,
    status: variables.status,
    title,
    body,
    channels: ["push"],
    deliveryState: "queued",
    attemptCount: 0,
    dedupeKey: `${templateKey}:${normalizedReservationId}`,
    createdAt: now,
    updatedAt: now,
    createdByUid: cleanReservationText(actorUid, 128) || "system",
    source: "booking-lifecycle",
    templateSnapshot: {
      key: template.key,
      title: template.title,
      body: template.body,
    },
    preferencesSnapshot: {
      bookingStatusEnabled: preferences.bookingStatusEnabled !== false,
      appointmentReminderEnabled: preferences.appointmentReminderEnabled !== false,
      loyaltyEnabled: preferences.loyaltyEnabled !== false,
      marketingEnabled: preferences.marketingEnabled === true,
    },
  };
}

function buildAdminPendingBookingNotificationOutboxDocument({
  reservationId,
  reservation,
  settings,
  preferences = {},
  recipientUid,
  actorUid = "",
  timestamp = null,
} = {}) {
  const normalizedRecipientUid = cleanReservationText(recipientUid, 128);
  const normalizedReservationId = cleanReservationText(reservationId, 160);
  if (!normalizedRecipientUid || !normalizedReservationId) return null;
  if (!isTemplateGloballyEnabled(settings, ADMIN_PENDING_BOOKING_TEMPLATE_KEY)) return null;
  if (!isUserPreferenceEnabled(preferences, ADMIN_PENDING_BOOKING_TEMPLATE_KEY)) return null;

  const template = templateForKey(settings, ADMIN_PENDING_BOOKING_TEMPLATE_KEY);
  if (!template || template.enabled === false) return null;

  const variables = reservationVariables(normalizedReservationId, reservation || {});
  const title = interpolateTemplateText(template.title, variables);
  const body = interpolateTemplateText(template.body, variables);
  if (!title || !body) return null;

  const now = timestamp || new Date();
  return {
    type: "admin_pending_booking",
    templateKey: ADMIN_PENDING_BOOKING_TEMPLATE_KEY,
    recipientUid: normalizedRecipientUid,
    reservationId: normalizedReservationId,
    reservationCode: variables.reservationCode,
    customerUid: cleanReservationText(reservation?.customerUid, 128),
    customerName: variables.customerName,
    serviceName: variables.serviceName,
    slotStart: variables.slotStart,
    slotEnd: variables.slotEnd,
    status: variables.status,
    title,
    body,
    channels: ["push"],
    deliveryState: "queued",
    attemptCount: 0,
    dedupeKey: `${ADMIN_PENDING_BOOKING_TEMPLATE_KEY}:${normalizedReservationId}:${normalizedRecipientUid}`,
    createdAt: now,
    updatedAt: now,
    createdByUid: cleanReservationText(actorUid, 128) || "system",
    source: "admin-pending-booking",
    templateSnapshot: {
      key: template.key,
      title: template.title,
      body: template.body,
    },
    preferencesSnapshot: {
      adminPendingAlertEnabled: settings.adminPendingAlertEnabled !== false,
      recipientAdminPendingAlertEnabled: preferences.adminPendingAlertEnabled !== false,
    },
  };
}

function buildLoyaltyRewardNotificationOutboxDocument({
  redemptionId,
  redemption,
  settings,
  preferences,
  actorUid = "",
  timestamp = null,
} = {}) {
  const recipientUid = cleanReservationText(redemption?.ownerUid, 128);
  const normalizedRedemptionId = cleanReservationText(redemptionId, 160);
  if (!recipientUid || !normalizedRedemptionId) return null;
  if (!isTemplateGloballyEnabled(settings, LOYALTY_REWARD_TEMPLATE_KEY)) return null;
  if (!isUserPreferenceEnabled(preferences, LOYALTY_REWARD_TEMPLATE_KEY)) return null;

  const template = templateForKey(settings, LOYALTY_REWARD_TEMPLATE_KEY);
  if (!template || template.enabled === false) return null;

  const variables = loyaltyRewardVariables(normalizedRedemptionId, redemption || {});
  const title = interpolateTemplateText(template.title, variables);
  const body = interpolateTemplateText(template.body, variables);
  if (!title || !body) return null;

  const now = timestamp || new Date();
  return {
    type: "loyalty_reward",
    templateKey: LOYALTY_REWARD_TEMPLATE_KEY,
    recipientUid,
    redemptionId: normalizedRedemptionId,
    rewardCode: variables.rewardCode,
    rewardNumber: variables.rewardNumber,
    rewardType: variables.rewardType,
    rewardValue: variables.rewardValue,
    rewardDescription: variables.rewardDescription,
    title,
    body,
    channels: ["push"],
    deliveryState: "queued",
    attemptCount: 0,
    dedupeKey: `${LOYALTY_REWARD_TEMPLATE_KEY}:${normalizedRedemptionId}`,
    createdAt: now,
    updatedAt: now,
    createdByUid: cleanReservationText(actorUid, 128) || "system",
    source: "loyalty-reward",
    templateSnapshot: {
      key: template.key,
      title: template.title,
      body: template.body,
    },
    preferencesSnapshot: {
      loyaltyEnabled: preferences.loyaltyEnabled !== false,
      marketingEnabled: preferences.marketingEnabled === true,
    },
  };
}

function buildWaitlistAvailabilityNotificationOutboxDocument({
  waitlistId,
  waitlist,
  settings,
  preferences,
  actorUid = "",
  timestamp = null,
} = {}) {
  const recipientUid = cleanReservationText(waitlist?.ownerUid, 128);
  const normalizedWaitlistId = cleanReservationText(waitlistId, 160);
  if (!recipientUid || !normalizedWaitlistId) return null;
  if (!isTemplateGloballyEnabled(settings, WAITLIST_AVAILABLE_TEMPLATE_KEY)) return null;
  if (!isUserPreferenceEnabled(preferences, WAITLIST_AVAILABLE_TEMPLATE_KEY)) return null;

  const template = templateForKey(settings, WAITLIST_AVAILABLE_TEMPLATE_KEY);
  if (!template || template.enabled === false) return null;

  const variables = waitlistVariables(normalizedWaitlistId, waitlist || {});
  const title = interpolateTemplateText(template.title, variables);
  const body = interpolateTemplateText(template.body, variables);
  if (!title || !body) return null;

  const now = timestamp || new Date();
  const alertVersion = Math.max(1, Math.floor(Number(waitlist?.alertVersion) || 1));
  return {
    type: "waitlist_available",
    templateKey: WAITLIST_AVAILABLE_TEMPLATE_KEY,
    recipientUid,
    reservationId: normalizedWaitlistId,
    serviceName: variables.serviceName,
    waitlistDate: variables.waitlistDate,
    availableTimes: variables.availableTimes,
    title,
    body,
    channels: ["push"],
    deliveryState: "queued",
    attemptCount: 0,
    dedupeKey: `${WAITLIST_AVAILABLE_TEMPLATE_KEY}:${normalizedWaitlistId}:${alertVersion}`,
    createdAt: now,
    updatedAt: now,
    createdByUid: cleanReservationText(actorUid, 128) || "system",
    source: "waitlist-availability",
    templateSnapshot: {
      key: template.key,
      title: template.title,
      body: template.body,
    },
    preferencesSnapshot: {
      bookingStatusEnabled: preferences.bookingStatusEnabled !== false,
    },
  };
}

function buildAdminTestNotificationOutboxDocument({
  templateKey,
  settings,
  recipientUid,
  actorUid = "",
  timestamp = null,
} = {}) {
  const normalizedRecipientUid = cleanReservationText(recipientUid, 128);
  const normalizedTemplateKey = cleanReservationText(templateKey, 80);
  if (!normalizedRecipientUid || !normalizedTemplateKey) return null;
  if (!isTemplateGloballyEnabled(settings, normalizedTemplateKey)) return null;

  const template = templateForKey(settings, normalizedTemplateKey);
  if (!template || template.enabled === false) return null;

  const variables = adminTestNotificationVariables();
  const title = interpolateTemplateText(template.title, variables);
  const body = interpolateTemplateText(template.body, variables);
  if (!title || !body) return null;

  const now = timestamp || new Date();
  const normalizedActorUid = cleanReservationText(actorUid, 128) || normalizedRecipientUid;
  return {
    type: "admin_test_notification",
    templateKey: normalizedTemplateKey,
    recipientUid: normalizedRecipientUid,
    reservationId: variables.reservationId,
    reservationCode: variables.reservationCode,
    serviceName: variables.serviceName,
    slotStart: variables.slotStart,
    slotEnd: variables.slotEnd,
    status: variables.status,
    title,
    body,
    channels: ["push"],
    deliveryState: "queued",
    attemptCount: 0,
    testOnly: true,
    targetScope: "self",
    dedupeKey: `admin_test:${normalizedTemplateKey}:${normalizedRecipientUid}:${now.getTime()}`,
    createdAt: now,
    updatedAt: now,
    createdByUid: normalizedActorUid,
    notificationCreatedByUid: normalizedActorUid,
    source: "admin-test-notification",
    templateSnapshot: {
      key: template.key,
      title: template.title,
      body: template.body,
    },
    preferencesSnapshot: {
      adminTestOnly: true,
    },
  };
}

function buildAdminCampaignDraftTestNotificationOutboxDocument({
  campaign,
  recipientUid,
  actorUid = "",
  timestamp = null,
} = {}) {
  const normalizedRecipientUid = cleanReservationText(recipientUid, 128);
  const campaignId = cleanReservationText(campaign?.campaignId, 80);
  const title = cleanReservationText(campaign?.title, 120);
  const body = cleanReservationText(campaign?.body, 1000);
  if (!normalizedRecipientUid || !campaignId || !title || !body) return null;

  const now = timestamp || new Date();
  const normalizedActorUid = cleanReservationText(actorUid, 128) || normalizedRecipientUid;
  const targetAudience = cleanReservationText(campaign?.targetAudience, 80) || "test_users";
  const sendBlockedReason =
    cleanReservationText(campaign?.sendBlockedReason, 160) || NOTIFICATION_CAMPAIGN_SEND_BLOCKED_REASON;
  return {
    type: "admin_test_notification",
    templateKey: "campaign_draft",
    campaignId,
    recipientUid: normalizedRecipientUid,
    title,
    body,
    channels: ["push"],
    deliveryState: "queued",
    attemptCount: 0,
    testOnly: true,
    targetScope: "self",
    dedupeKey: `admin_campaign_test:${campaignId}:${normalizedRecipientUid}:${now.getTime()}`,
    createdAt: now,
    updatedAt: now,
    createdByUid: normalizedActorUid,
    notificationCreatedByUid: normalizedActorUid,
    source: "admin-campaign-test-notification",
    templateSnapshot: {
      key: "campaign_draft",
      title,
      body,
      campaignId,
    },
    campaignSnapshot: {
      campaignId,
      title,
      body,
      targetAudience,
      marketingConsentRequired: targetAudience === "marketing_opt_in_users" ||
        campaign?.marketingConsentRequired === true,
      status: cleanReservationText(campaign?.status, 40) || "draft",
      sendBlocked: true,
      sendBlockedReason,
      deliveryLocked: true,
      sendState: NOTIFICATION_CAMPAIGN_SEND_STATE,
    },
    preferencesSnapshot: {
      adminTestOnly: true,
      campaignDraftTest: true,
    },
  };
}

function buildNotificationCampaignBroadcastOutboxDocument({
  campaign,
  recipientUid,
  actorUid = "",
  timestamp = null,
} = {}) {
  const normalizedRecipientUid = cleanReservationText(recipientUid, 128);
  const campaignId = cleanReservationText(campaign?.campaignId, 80);
  const title = cleanReservationText(campaign?.title, 120);
  const body = cleanReservationText(campaign?.body, 1000);
  if (!normalizedRecipientUid || !campaignId || !title || !body) return null;

  const now = timestamp || new Date();
  const rawTargetAudience = cleanReservationText(campaign?.targetAudience, 80);
  const targetAudience = rawTargetAudience === "test_users" ? "test_users" : "marketing_opt_in_users";
  const normalizedActorUid = cleanReservationText(actorUid, 128) || "system";
  return {
    type: "campaign_broadcast",
    templateKey: "campaign_draft",
    campaignId,
    recipientUid: normalizedRecipientUid,
    title,
    body,
    channels: ["push"],
    deliveryState: "queued",
    attemptCount: 0,
    testOnly: false,
    targetScope: targetAudience,
    dedupeKey: `campaign_broadcast:${campaignId}:${normalizedRecipientUid}`,
    createdAt: now,
    updatedAt: now,
    createdByUid: normalizedActorUid,
    notificationCreatedByUid: normalizedActorUid,
    source: "admin-campaign-broadcast",
    templateSnapshot: {
      key: "campaign_draft",
      title,
      body,
      campaignId,
    },
    campaignSnapshot: {
      campaignId,
      title,
      body,
      targetAudience,
      marketingConsentRequired: targetAudience !== "test_users",
      status: cleanReservationText(campaign?.status, 40) || "draft",
      sendBlocked: false,
      sendBlockedReason: "",
      deliveryLocked: false,
      sendState: "ready",
    },
    preferencesSnapshot: {
      campaignBroadcast: true,
      marketingConsentRequired: targetAudience !== "test_users",
    },
  };
}

function buildAdminNotificationTestResponse({
  notification,
  notificationId,
  recipientUid,
} = {}) {
  const campaignSnapshot = notification?.campaignSnapshot || {};
  return {
    queued: true,
    notificationId: cleanReservationText(notificationId, 160),
    templateKey: cleanReservationText(notification?.templateKey, 80),
    campaignId: cleanReservationText(notification?.campaignId, 80),
    deliveryState: cleanReservationText(notification?.deliveryState, 40),
    recipientUid: cleanReservationText(recipientUid, 128),
    targetScope: cleanReservationText(notification?.targetScope, 40) || "self",
    testOnly: notification?.testOnly === true || notification?.preferencesSnapshot?.adminTestOnly === true,
    targetAudience: cleanReservationText(campaignSnapshot.targetAudience, 80),
    marketingConsentRequired: campaignSnapshot.marketingConsentRequired === true,
    sendBlocked: campaignSnapshot.sendBlocked === true,
    sendBlockedReason: cleanReservationText(campaignSnapshot.sendBlockedReason, 160),
    deliveryLocked: campaignSnapshot.deliveryLocked === true,
    sendState: cleanReservationText(campaignSnapshot.sendState, 40),
    message: "Test notification queued for the current admin user only",
  };
}

function enqueueReservationNotification(tx, {
  db,
  templateKey,
  reservationId,
  reservation,
  notificationSettingsSnap = null,
  userPreferencesSnap = null,
  userDocSnap = null,
  existingOutboxSnap = null,
  actorUid = "",
  timestamp = null,
} = {}) {
  const settings = buildNotificationSettings(notificationSettingsSnap);
  const preferences = buildUserNotificationPreferences({
    preferencesDoc: userPreferencesSnap,
    userDoc: userDocSnap,
  });
  const document = buildReservationNotificationOutboxDocument({
    templateKey,
    reservationId,
    reservation,
    settings,
    preferences,
    actorUid,
    timestamp,
  });

  if (!document) return null;
  if (existingOutboxSnap?.exists) return null;

  tx.set(
    db.collection(NOTIFICATION_OUTBOX_COLLECTION).doc(notificationOutboxDocId(templateKey, reservationId)),
    document,
  );
  return document;
}

function enqueueAdminPendingBookingNotification(tx, {
  db,
  reservationId,
  reservation,
  recipientUid,
  notificationSettingsSnap = null,
  adminPreferencesSnap = null,
  existingOutboxSnap = null,
  actorUid = "",
  timestamp = null,
} = {}) {
  const settings = buildNotificationSettings(notificationSettingsSnap);
  const preferences = buildUserNotificationPreferences({
    preferencesDoc: adminPreferencesSnap,
  });
  const document = buildAdminPendingBookingNotificationOutboxDocument({
    reservationId,
    reservation,
    settings,
    preferences,
    recipientUid,
    actorUid,
    timestamp,
  });

  if (!document) return null;
  if (existingOutboxSnap?.exists) return null;

  tx.set(
    db.collection(NOTIFICATION_OUTBOX_COLLECTION).doc(
      adminNotificationOutboxDocId(ADMIN_PENDING_BOOKING_TEMPLATE_KEY, reservationId, recipientUid),
    ),
    document,
  );
  return document;
}

function enqueueLoyaltyRewardNotification(tx, {
  db,
  redemptionId,
  redemption,
  notificationSettingsSnap = null,
  userPreferencesSnap = null,
  userDocSnap = null,
  existingOutboxSnap = null,
  actorUid = "",
  timestamp = null,
} = {}) {
  const settings = buildNotificationSettings(notificationSettingsSnap);
  const preferences = buildUserNotificationPreferences({
    preferencesDoc: userPreferencesSnap,
    userDoc: userDocSnap,
  });
  const document = buildLoyaltyRewardNotificationOutboxDocument({
    redemptionId,
    redemption,
    settings,
    preferences,
    actorUid,
    timestamp,
  });

  if (!document) return null;
  if (existingOutboxSnap?.exists) return null;

  tx.set(
    db.collection(NOTIFICATION_OUTBOX_COLLECTION).doc(
      notificationOutboxDocId(LOYALTY_REWARD_TEMPLATE_KEY, redemptionId),
    ),
    document,
  );
  return document;
}

module.exports = {
  ADMIN_PENDING_BOOKING_TEMPLATE_KEY,
  BOOKING_REMINDER_RESERVATION_STATUS_VALUES,
  LOYALTY_REWARD_TEMPLATE_KEY,
  NOTIFICATION_OUTBOX_COLLECTION,
  REVIEW_PROMPT_RESERVATION_STATUS_VALUES,
  WAITLIST_AVAILABLE_TEMPLATE_KEY,
  adminNotificationOutboxDocId,
  buildAdminCampaignDraftTestNotificationOutboxDocument,
  buildAdminNotificationTestResponse,
  buildAdminPendingBookingNotificationOutboxDocument,
  buildAdminTestNotificationOutboxDocument,
  buildLoyaltyRewardNotificationOutboxDocument,
  buildWaitlistAvailabilityNotificationOutboxDocument,
  buildNotificationCampaignBroadcastOutboxDocument,
  buildReservationNotificationOutboxDocument,
  campaignNotificationOutboxDocId,
  enqueueAdminPendingBookingNotification,
  enqueueLoyaltyRewardNotification,
  enqueueReservationNotification,
  isBookingReminderReservationDue,
  isReviewPromptReservationDue,
  notificationOutboxDocId,
};
