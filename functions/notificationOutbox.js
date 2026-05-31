const {buildNotificationSettings} = require("./notificationAdmin");
const {buildUserNotificationPreferences} = require("./notificationPreferences");

const NOTIFICATION_OUTBOX_COLLECTION = "notification_outbox";
const BOOKING_STATUS_TEMPLATE_KEYS = new Set([
  "booking_request",
  "booking_accepted",
  "booking_rejected",
  "booking_expired",
]);

function cleanReservationText(value, maxLength = 240) {
  if (value === undefined || value === null) return "";
  return String(value).trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function notificationOutboxDocId(templateKey, reservationId) {
  const safeTemplateKey = cleanReservationText(templateKey, 80).replace(/[^A-Za-z0-9_-]/g, "_");
  const safeReservationId = cleanReservationText(reservationId, 160).replace(/[^A-Za-z0-9_-]/g, "_");
  return `${safeTemplateKey}_${safeReservationId}`;
}

function templateForKey(settings, templateKey) {
  return (settings.templates || []).find((template) => template.key === templateKey) || null;
}

function isTemplateGloballyEnabled(settings, templateKey) {
  if (BOOKING_STATUS_TEMPLATE_KEYS.has(templateKey)) {
    return settings.bookingStatusEnabled !== false;
  }
  if (templateKey === "booking_reminder") {
    return settings.appointmentReminderEnabled !== false;
  }
  if (templateKey === "review_prompt") {
    return settings.bookingStatusEnabled !== false;
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
  return false;
}

function reservationVariables(reservationId, reservation) {
  return {
    reservationId,
    reservationCode: cleanReservationText(reservation.reservationCode, 40),
    serviceName: cleanReservationText(reservation.serviceName || "Servico", 160),
    slotStart: cleanReservationText(reservation.slotStart, 80),
    slotEnd: cleanReservationText(reservation.slotEnd, 80),
    status: cleanReservationText(reservation.status, 40),
    rejectionReason: cleanReservationText(reservation.rejectionReason, 500),
  };
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
    type: "booking_status",
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

function enqueueReservationNotification(tx, {
  db,
  templateKey,
  reservationId,
  reservation,
  notificationSettingsSnap = null,
  userPreferencesSnap = null,
  userDocSnap = null,
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

  tx.set(
    db.collection(NOTIFICATION_OUTBOX_COLLECTION).doc(notificationOutboxDocId(templateKey, reservationId)),
    document,
  );
  return document;
}

module.exports = {
  NOTIFICATION_OUTBOX_COLLECTION,
  buildReservationNotificationOutboxDocument,
  enqueueReservationNotification,
  notificationOutboxDocId,
};
