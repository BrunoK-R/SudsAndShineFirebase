const NOTIFICATION_DELIVERY_STATES = new Set(["queued", "retry", "sending"]);
const MAX_DELIVERY_TOKENS_PER_USER = 100;
const MAX_DELIVERY_ATTEMPTS = 5;
const DELIVERY_LEASE_MINUTES = 10;

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
  buildNotificationPushMessage,
  deliveryCompletionUpdate,
  deliveryFailureUpdate,
  isNotificationOutboxDeliverable,
  isNotificationSendingLeaseExpired,
  nextDeliveryLeaseExpiration,
  notificationTokenDeliveryFromSnap,
};
