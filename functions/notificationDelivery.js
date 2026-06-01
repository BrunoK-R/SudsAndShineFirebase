const NOTIFICATION_DELIVERY_STATES = new Set(["queued", "retry", "sending", "deferred"]);
const MAX_DELIVERY_TOKENS_PER_USER = 100;
const MAX_DELIVERY_ATTEMPTS = 5;
const DELIVERY_LEASE_MINUTES = 10;
const NOTIFICATION_QUIET_HOURS_TIME_ZONE = "Europe/Lisbon";
const MINUTES_PER_DAY = 24 * 60;
const BOOKING_STATUS_DELIVERY_TEMPLATE_KEYS = new Set([
  "booking_request",
  "booking_accepted",
  "booking_rejected",
  "booking_expired",
  "booking_cancelled",
  "booking_rescheduled",
  "review_prompt",
]);
const ADMIN_PENDING_BOOKING_TEMPLATE_KEY = "admin_pending_booking";
const BOOKING_REMINDER_TEMPLATE_KEY = "booking_reminder";

const TERMINAL_TOKEN_ERROR_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
]);

const RETRYABLE_MESSAGING_ERROR_CODES = new Set([
  "messaging/internal-error",
  "messaging/server-unavailable",
  "messaging/unknown-error",
  "messaging/unavailable",
  "messaging/quota-exceeded",
  "messaging/device-message-rate-exceeded",
]);

const QuietHourRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

function cleanDeliveryText(value, maxLength = 240) {
  if (value === undefined || value === null) return "";
  return String(value).trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function deliveryDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isNotificationOutboxDeliverable(outbox = {}) {
  if (!NOTIFICATION_DELIVERY_STATES.has(outbox.deliveryState)) return false;
  if (!cleanDeliveryText(outbox.recipientUid, 128)) return false;
  if (!cleanDeliveryText(outbox.title, 120)) return false;
  if (!cleanDeliveryText(outbox.body, 500)) return false;
  return (outbox.channels || []).includes("push");
}

function isNotificationSendingLeaseExpired(outbox = {}, now = new Date()) {
  if (outbox.deliveryState !== "sending") return true;
  const leaseExpiresAt = deliveryDate(outbox.deliveryLeaseExpiresAt);
  return !leaseExpiresAt || leaseExpiresAt <= now;
}

function nextDeliveryLeaseExpiration(now = new Date()) {
  return new Date(now.getTime() + DELIVERY_LEASE_MINUTES * 60 * 1000);
}

function quietHourMinutes(value) {
  const text = cleanDeliveryText(value, 5);
  const match = QuietHourRegex.exec(text);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function localMinutesForDate(now = new Date(), timeZone = NOTIFICATION_QUIET_HOURS_TIME_ZONE) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

function isNotificationQuietHour(
  settings = {},
  now = new Date(),
  timeZone = NOTIFICATION_QUIET_HOURS_TIME_ZONE,
) {
  const start = quietHourMinutes(settings?.quietHoursStart);
  const end = quietHourMinutes(settings?.quietHoursEnd);
  if (start === null || end === null || start === end) return false;

  const current = localMinutesForDate(now, timeZone);
  if (current === null) return false;

  if (start < end) {
    return current >= start && current < end;
  }
  return current >= start || current < end;
}

function shouldBypassNotificationQuietHours(outbox = {}) {
  return cleanDeliveryText(outbox.type, 80) === "admin_test_notification" ||
    outbox.preferencesSnapshot?.adminTestOnly === true;
}

function shouldBypassNotificationPreferenceSuppression(outbox = {}) {
  return cleanDeliveryText(outbox.type, 80) === "admin_test_notification" ||
    outbox.preferencesSnapshot?.adminTestOnly === true;
}

function minutesUntilQuietHourEnd(
  settings = {},
  now = new Date(),
  timeZone = NOTIFICATION_QUIET_HOURS_TIME_ZONE,
) {
  const start = quietHourMinutes(settings?.quietHoursStart);
  const end = quietHourMinutes(settings?.quietHoursEnd);
  if (start === null || end === null || start === end) return 0;

  const current = localMinutesForDate(now, timeZone);
  if (current === null || !isNotificationQuietHour(settings, now, timeZone)) return 0;
  if (start < end) return end - current;
  if (current >= start) return (MINUTES_PER_DAY - current) + end;
  return end - current;
}

function notificationQuietHoursDeferral(
  outbox = {},
  settings = {},
  now = new Date(),
  timeZone = NOTIFICATION_QUIET_HOURS_TIME_ZONE,
) {
  if (
    !isNotificationOutboxDeliverable(outbox) ||
    shouldBypassNotificationQuietHours(outbox) ||
    !isNotificationQuietHour(settings, now, timeZone)
  ) {
    return null;
  }

  const minutesUntilEnd = minutesUntilQuietHourEnd(settings, now, timeZone);
  if (minutesUntilEnd <= 0) return null;

  return {
    deliveryState: "deferred",
    deliveryLeaseExpiresAt: null,
    deliveryDeferralReason: "quiet-hours",
    quietHoursDeferredUntil: new Date(now.getTime() + minutesUntilEnd * 60 * 1000),
    quietHoursStart: cleanDeliveryText(settings.quietHoursStart, 16),
    quietHoursEnd: cleanDeliveryText(settings.quietHoursEnd, 16),
    quietHoursTimeZone: cleanDeliveryText(timeZone, 80) || NOTIFICATION_QUIET_HOURS_TIME_ZONE,
  };
}

function shouldDeferNotificationForQuietHours(
  outbox = {},
  settings = {},
  now = new Date(),
  timeZone = NOTIFICATION_QUIET_HOURS_TIME_ZONE,
) {
  return notificationQuietHoursDeferral(outbox, settings, now, timeZone) !== null;
}

function templateEnabledForDelivery(settings = {}, templateKey = "") {
  const template = (settings.templates || []).find((item) => item?.key === templateKey);
  return template && template.enabled !== false;
}

function notificationDeliveryPreferenceSuppression(outbox = {}, settings = {}, preferences = {}) {
  if (!isNotificationOutboxDeliverable(outbox) || shouldBypassNotificationPreferenceSuppression(outbox)) {
    return null;
  }

  const templateKey = cleanDeliveryText(outbox.templateKey, 80);
  if (!templateEnabledForDelivery(settings, templateKey)) {
    return {
      deliveryState: "suppressed",
      deliverySuppressionReason: "template-disabled",
    };
  }

  if (BOOKING_STATUS_DELIVERY_TEMPLATE_KEYS.has(templateKey)) {
    if (settings.bookingStatusEnabled === false) {
      return {
        deliveryState: "suppressed",
        deliverySuppressionReason: "admin-booking-status-disabled",
      };
    }
    if (preferences.bookingStatusEnabled === false) {
      return {
        deliveryState: "suppressed",
        deliverySuppressionReason: "user-booking-status-disabled",
      };
    }
    return null;
  }

  if (templateKey === BOOKING_REMINDER_TEMPLATE_KEY) {
    if (settings.appointmentReminderEnabled === false) {
      return {
        deliveryState: "suppressed",
        deliverySuppressionReason: "admin-reminders-disabled",
      };
    }
    if (preferences.appointmentReminderEnabled === false) {
      return {
        deliveryState: "suppressed",
        deliverySuppressionReason: "user-reminders-disabled",
      };
    }
    return null;
  }

  if (templateKey === ADMIN_PENDING_BOOKING_TEMPLATE_KEY) {
    if (settings.adminPendingAlertEnabled === false) {
      return {
        deliveryState: "suppressed",
        deliverySuppressionReason: "admin-pending-alerts-disabled",
      };
    }
    if (preferences.adminPendingAlertEnabled === false) {
      return {
        deliveryState: "suppressed",
        deliverySuppressionReason: "admin-pending-alerts-user-disabled",
      };
    }
    return null;
  }

  return {
    deliveryState: "suppressed",
    deliverySuppressionReason: "unknown-template",
  };
}

function notificationTokenDeliveryFromSnap(tokenSnap, recipientUid) {
  if (!tokenSnap?.exists) return null;
  const data = tokenSnap.data() || {};
  const token = cleanDeliveryText(data.token, 4096);
  if (!token || /\s/.test(token)) return null;
  if (data.enabled === false || data.revokedAt) return null;
  if (cleanDeliveryText(data.ownerUid, 128) !== cleanDeliveryText(recipientUid, 128)) return null;

  return {
    tokenId: cleanDeliveryText(tokenSnap.id, 128),
    token,
    platform: cleanDeliveryText(data.platform, 24),
  };
}

function pushDataValue(value, maxLength = 240) {
  return cleanDeliveryText(value, maxLength);
}

function buildNotificationPushMessage(outbox, tokenDeliveries) {
  const tokens = (tokenDeliveries || [])
    .map((delivery) => delivery.token)
    .filter(Boolean)
    .slice(0, MAX_DELIVERY_TOKENS_PER_USER);

  return {
    tokens,
    notification: {
      title: cleanDeliveryText(outbox.title, 120),
      body: cleanDeliveryText(outbox.body, 500),
    },
    data: {
      type: pushDataValue(outbox.type, 48),
      templateKey: pushDataValue(outbox.templateKey, 80),
      reservationId: pushDataValue(outbox.reservationId, 160),
      reservationCode: pushDataValue(outbox.reservationCode, 40),
      dedupeKey: pushDataValue(outbox.dedupeKey, 220),
      source: "notification_outbox",
    },
    android: {
      priority: "high",
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
  };
}

function messagingCode(error) {
  return cleanDeliveryText(error?.code || error?.errorInfo?.code, 120);
}

function messagingMessage(error) {
  return cleanDeliveryText(error?.message || error?.errorInfo?.message, 240);
}

function isTerminalTokenMessagingError(error) {
  return TERMINAL_TOKEN_ERROR_CODES.has(messagingCode(error));
}

function isRetryableMessagingError(error) {
  const code = messagingCode(error);
  return !code || RETRYABLE_MESSAGING_ERROR_CODES.has(code);
}

function deliveryFailureUpdate({
  reason,
  error = null,
  attemptCount = 0,
  maxAttempts = MAX_DELIVERY_ATTEMPTS,
  timestamp = new Date(),
} = {}) {
  const retryable = isRetryableMessagingError(error) && attemptCount < maxAttempts;
  const update = {
    deliveryState: retryable ? "queued" : "failed",
    deliveryLeaseExpiresAt: null,
    deliveryFailureReason: cleanDeliveryText(reason || messagingCode(error) || "delivery-failed", 120),
    deliveryResult: {
      tokenCount: 0,
      successCount: 0,
      failureCount: 0,
      invalidTokenCount: 0,
      retryableFailureCount: retryable ? 1 : 0,
      lastErrorCode: messagingCode(error),
      lastErrorMessage: messagingMessage(error),
    },
    updatedAt: timestamp,
  };
  if (!retryable) update.failedAt = timestamp;
  return update;
}

function deliverySuppressionUpdate({
  suppression,
  timestamp = new Date(),
} = {}) {
  const reason = cleanDeliveryText(suppression?.deliverySuppressionReason, 120) ||
    "delivery-suppressed";
  return {
    deliveryState: "suppressed",
    deliveryLeaseExpiresAt: null,
    deliverySuppressionReason: reason,
    deliveryResult: {
      tokenCount: 0,
      successCount: 0,
      failureCount: 0,
      invalidTokenCount: 0,
      retryableFailureCount: 0,
      lastErrorCode: reason,
      lastErrorMessage: "Notification delivery suppressed by current settings or preferences",
    },
    suppressedAt: timestamp,
    updatedAt: timestamp,
  };
}

function deliveryCompletionUpdate({
  response,
  tokenDeliveries,
  attemptCount = 0,
  maxAttempts = MAX_DELIVERY_ATTEMPTS,
  timestamp = new Date(),
} = {}) {
  const responses = response?.responses || [];
  let successCount = 0;
  let failureCount = 0;
  let retryableFailureCount = 0;
  let lastErrorCode = "";
  let lastErrorMessage = "";
  const invalidTokenIds = [];

  responses.forEach((result, index) => {
    if (result?.success) {
      successCount += 1;
      return;
    }

    failureCount += 1;
    const error = result?.error || null;
    lastErrorCode = messagingCode(error) || lastErrorCode;
    lastErrorMessage = messagingMessage(error) || lastErrorMessage;
    if (isTerminalTokenMessagingError(error)) {
      const tokenId = tokenDeliveries?.[index]?.tokenId;
      if (tokenId) invalidTokenIds.push(tokenId);
    } else if (isRetryableMessagingError(error)) {
      retryableFailureCount += 1;
    }
  });

  const tokenCount = tokenDeliveries?.length || 0;
  const shouldRetry = successCount === 0 && retryableFailureCount > 0 && attemptCount < maxAttempts;
  const deliveryState = successCount > 0 ? "sent" : shouldRetry ? "queued" : "failed";

  const update = {
    deliveryState,
    deliveryLeaseExpiresAt: null,
    deliveryResult: {
      tokenCount,
      successCount,
      failureCount,
      invalidTokenCount: invalidTokenIds.length,
      retryableFailureCount,
      lastErrorCode,
      lastErrorMessage,
    },
    updatedAt: timestamp,
  };
  if (successCount > 0) update.sentAt = timestamp;
  if (deliveryState === "failed") {
    update.failedAt = timestamp;
    update.deliveryFailureReason = lastErrorCode || "push-send-failed";
  }

  return {
    outboxUpdate: update,
    invalidTokenIds,
  };
}

module.exports = {
  DELIVERY_LEASE_MINUTES,
  MAX_DELIVERY_ATTEMPTS,
  MAX_DELIVERY_TOKENS_PER_USER,
  NOTIFICATION_QUIET_HOURS_TIME_ZONE,
  buildNotificationPushMessage,
  deliveryCompletionUpdate,
  deliveryFailureUpdate,
  deliverySuppressionUpdate,
  isNotificationQuietHour,
  isNotificationOutboxDeliverable,
  isNotificationSendingLeaseExpired,
  nextDeliveryLeaseExpiration,
  notificationDeliveryPreferenceSuppression,
  notificationQuietHoursDeferral,
  notificationTokenDeliveryFromSnap,
  shouldDeferNotificationForQuietHours,
};
