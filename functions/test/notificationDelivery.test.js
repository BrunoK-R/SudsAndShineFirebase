const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ANDROID_NOTIFICATION_CHANNEL_ID,
  ANDROID_NOTIFICATION_CLICK_ACTION,
  MAX_DELIVERY_ATTEMPTS,
  NOTIFICATION_QUIET_HOURS_TIME_ZONE,
  buildNotificationPushMessage,
  deliveryCompletionUpdate,
  deliveryFailureUpdate,
  deliverySuppressionUpdate,
  isNotificationQuietHour,
  isNotificationQuietHoursDeferralActive,
  isNotificationOutboxDeliverable,
  isNotificationSendingLeaseExpired,
  nextDeliveryLeaseExpiration,
  notificationDeliverySafetySuppression,
  notificationDeliveryPreferenceSuppression,
  notificationQuietHoursDeferral,
  notificationTokenDeliveryFromSnap,
  shouldDeferNotificationForQuietHours,
} = require("../notificationDelivery");

test("notificationTokenDeliveryFromSnap returns only active owner-scoped tokens", () => {
  assert.deepEqual(notificationTokenDeliveryFromSnap(tokenDoc("current-device", {
    ownerUid: "user-1",
    tokenId: "ignored-data-id",
    token: "fcm_token_1234567890",
    platform: "android",
    enabled: true,
  }), "user-1"), {
    tokenId: "current-device",
    token: "fcm_token_1234567890",
    platform: "android",
  });

  assert.equal(notificationTokenDeliveryFromSnap(tokenDoc("other-device", {
    ownerUid: "user-2",
    token: "fcm_token_1234567890",
    enabled: true,
  }), "user-1"), null);
  assert.equal(notificationTokenDeliveryFromSnap(tokenDoc("disabled-device", {
    ownerUid: "user-1",
    token: "fcm_token_1234567890",
    enabled: false,
  }), "user-1"), null);
  assert.equal(notificationTokenDeliveryFromSnap(tokenDoc("revoked-device", {
    ownerUid: "user-1",
    token: "fcm_token_1234567890",
    revokedAt: new Date("2026-05-31T18:00:00.000Z"),
  }), "user-1"), null);
  assert.equal(notificationTokenDeliveryFromSnap(tokenDoc("bad-device", {
    ownerUid: "user-1",
    token: "fcm token with spaces",
    enabled: true,
  }), "user-1"), null);
});

test("buildNotificationPushMessage builds token-scoped booking payload", () => {
  const message = buildNotificationPushMessage(outbox(), [
    {tokenId: "device-1", token: "fcm_token_1234567890", platform: "android"},
  ]);

  assert.deepEqual(message.tokens, ["fcm_token_1234567890"]);
  assert.deepEqual(message.notification, {
    title: "Marcação confirmada",
    body: "A sua marcação foi confirmada.",
  });
  assert.equal(message.data.type, "booking_status");
  assert.equal(message.data.templateKey, "booking_accepted");
  assert.equal(message.data.campaignId, "");
  assert.equal(message.data.reservationId, "reservation-1");
  assert.equal(message.data.reservationCode, "SS-ABCDEFGH");
  assert.equal(message.data.redemptionId, "");
  assert.equal(message.data.targetScope, "");
  assert.equal(message.data.testOnly, "");
  assert.equal(message.data.dedupeKey, "booking_accepted:reservation-1");
  assert.equal(message.data.source, "notification_outbox");
  assert.equal(message.android.priority, "high");
  assert.equal(message.android.notification.channelId, ANDROID_NOTIFICATION_CHANNEL_ID);
  assert.equal(message.android.notification.clickAction, ANDROID_NOTIFICATION_CLICK_ACTION);
  assert.equal(message.apns.payload.aps.sound, "default");
});

test("buildNotificationPushMessage carries self-test campaign audit fields", () => {
  const message = buildNotificationPushMessage(outbox({
    type: "admin_test_notification",
    templateKey: "campaign_draft",
    campaignId: "summer-test",
    testOnly: true,
    targetScope: "self",
    preferencesSnapshot: {adminTestOnly: true, campaignDraftTest: true},
  }), [
    {tokenId: "device-1", token: "fcm_token_1234567890", platform: "android"},
  ]);

  assert.equal(message.data.type, "admin_test_notification");
  assert.equal(message.data.templateKey, "campaign_draft");
  assert.equal(message.data.campaignId, "summer-test");
  assert.equal(message.data.targetScope, "self");
  assert.equal(message.data.testOnly, "true");
});

test("deliveryCompletionUpdate marks sent attempts and returns invalid token ids", () => {
  const result = deliveryCompletionUpdate({
    tokenDeliveries: [
      {tokenId: "device-1", token: "fcm_token_success", platform: "android"},
      {tokenId: "device-2", token: "fcm_token_invalid", platform: "ios"},
    ],
    response: {
      responses: [
        {success: true},
        {
          success: false,
          error: {
            code: "messaging/registration-token-not-registered",
            message: "Token no longer exists",
          },
        },
      ],
    },
    attemptCount: 1,
    timestamp: new Date("2026-05-31T18:05:00.000Z"),
  });

  assert.equal(result.outboxUpdate.deliveryState, "sent");
  assert.equal(result.outboxUpdate.deliveryResult.successCount, 1);
  assert.equal(result.outboxUpdate.deliveryResult.failureCount, 1);
  assert.equal(result.outboxUpdate.deliveryResult.invalidTokenCount, 1);
  assert.deepEqual(result.invalidTokenIds, ["device-2"]);
  assert.equal(result.outboxUpdate.failedAt, undefined);
});

test("deliveryCompletionUpdate retries transient all-token failures until max attempts", () => {
  const retry = deliveryCompletionUpdate({
    tokenDeliveries: [
      {tokenId: "device-1", token: "fcm_token_retry", platform: "android"},
    ],
    response: {
      responses: [
        {
          success: false,
          error: {
            code: "messaging/server-unavailable",
            message: "Try later",
          },
        },
      ],
    },
    attemptCount: MAX_DELIVERY_ATTEMPTS - 1,
  });
  const final = deliveryCompletionUpdate({
    tokenDeliveries: [
      {tokenId: "device-1", token: "fcm_token_retry", platform: "android"},
    ],
    response: retryResponse(),
    attemptCount: MAX_DELIVERY_ATTEMPTS,
  });

  assert.equal(retry.outboxUpdate.deliveryState, "queued");
  assert.equal(retry.outboxUpdate.deliveryResult.retryableFailureCount, 1);
  assert.equal(final.outboxUpdate.deliveryState, "failed");
  assert.equal(final.outboxUpdate.deliveryFailureReason, "messaging/server-unavailable");
});

test("deliveryFailureUpdate fails missing-token deliveries without retry", () => {
  const update = deliveryFailureUpdate({
    reason: "no-active-tokens",
    error: {code: "no-active-tokens", message: "No active notification tokens"},
    attemptCount: 1,
    timestamp: new Date("2026-05-31T18:10:00.000Z"),
  });

  assert.equal(update.deliveryState, "failed");
  assert.equal(update.deliveryFailureReason, "no-active-tokens");
  assert.equal(update.deliveryResult.lastErrorCode, "no-active-tokens");
});

test("outbox deliverability and sending leases are bounded", () => {
  assert.equal(isNotificationOutboxDeliverable(outbox()), true);
  assert.equal(isNotificationOutboxDeliverable({
    ...outbox(),
    channels: ["email"],
  }), false);
  assert.equal(isNotificationOutboxDeliverable({
    ...outbox(),
    deliveryState: "deferred",
  }), true);
  assert.equal(isNotificationSendingLeaseExpired({
    ...outbox(),
    deliveryState: "sending",
    deliveryLeaseExpiresAt: new Date("2026-05-31T18:10:00.000Z"),
  }, new Date("2026-05-31T18:09:00.000Z")), false);
  assert.equal(isNotificationSendingLeaseExpired({
    ...outbox(),
    deliveryState: "sending",
    deliveryLeaseExpiresAt: new Date("2026-05-31T18:10:00.000Z"),
  }, new Date("2026-05-31T18:11:00.000Z")), true);

  const lease = nextDeliveryLeaseExpiration(new Date("2026-05-31T18:00:00.000Z"));
  assert.equal(lease.toISOString(), "2026-05-31T18:10:00.000Z");
});

test("notification delivery suppression re-checks current settings and preferences", () => {
  const enabledSettings = notificationSettings();
  const enabledPreferences = notificationPreferences();

  assert.equal(
    notificationDeliveryPreferenceSuppression(outbox(), enabledSettings, enabledPreferences),
    null,
  );
  assert.equal(
    notificationDeliveryPreferenceSuppression(
      outbox(),
      notificationSettings({templates: [{key: "booking_accepted", enabled: false}]}),
      enabledPreferences,
    ).deliverySuppressionReason,
    "template-disabled",
  );
  assert.equal(
    notificationDeliveryPreferenceSuppression(
      outbox(),
      notificationSettings({bookingStatusEnabled: false}),
      enabledPreferences,
    ).deliverySuppressionReason,
    "admin-booking-status-disabled",
  );
  assert.equal(
    notificationDeliveryPreferenceSuppression(
      outbox(),
      enabledSettings,
      notificationPreferences({bookingStatusEnabled: false}),
    ).deliverySuppressionReason,
    "user-booking-status-disabled",
  );
  assert.equal(
    notificationDeliveryPreferenceSuppression(
      outbox({templateKey: "booking_reminder"}),
      notificationSettings({appointmentReminderEnabled: false}),
      enabledPreferences,
    ).deliverySuppressionReason,
    "admin-reminders-disabled",
  );
  assert.equal(
    notificationDeliveryPreferenceSuppression(
      outbox({templateKey: "booking_reminder"}),
      enabledSettings,
      notificationPreferences({appointmentReminderEnabled: false}),
    ).deliverySuppressionReason,
    "user-reminders-disabled",
  );
  assert.equal(
    notificationDeliveryPreferenceSuppression(
      outbox({templateKey: "admin_pending_booking"}),
      notificationSettings({adminPendingAlertEnabled: false}),
      enabledPreferences,
    ).deliverySuppressionReason,
    "admin-pending-alerts-disabled",
  );
  assert.equal(
    notificationDeliveryPreferenceSuppression(
      outbox({templateKey: "admin_pending_booking"}),
      enabledSettings,
      notificationPreferences({adminPendingAlertEnabled: false}),
    ).deliverySuppressionReason,
    "admin-pending-alerts-user-disabled",
  );
  assert.equal(
    notificationDeliveryPreferenceSuppression(
      outbox({type: "loyalty_reward", templateKey: "loyalty_reward", redemptionId: "reward-0001"}),
      notificationSettings({loyaltyEnabled: false}),
      enabledPreferences,
    ).deliverySuppressionReason,
    "admin-loyalty-disabled",
  );
  assert.equal(
    notificationDeliveryPreferenceSuppression(
      outbox({type: "loyalty_reward", templateKey: "loyalty_reward", redemptionId: "reward-0001"}),
      enabledSettings,
      notificationPreferences({loyaltyEnabled: false}),
    ).deliverySuppressionReason,
    "user-loyalty-disabled",
  );
  assert.equal(
    notificationDeliveryPreferenceSuppression(
      outbox({
        type: "admin_test_notification",
        templateKey: "booking_accepted",
        testOnly: true,
        targetScope: "self",
        preferencesSnapshot: {adminTestOnly: true},
      }),
      notificationSettings({bookingStatusEnabled: false}),
      notificationPreferences({bookingStatusEnabled: false}),
    ),
    null,
  );
});

test("admin test notification bypass requires explicit self-test scope", () => {
  const validSelfTest = outbox({
    type: "admin_test_notification",
    templateKey: "booking_accepted",
    testOnly: true,
    targetScope: "self",
    preferencesSnapshot: {adminTestOnly: true},
  });
  const invalidCampaignTest = outbox({
    type: "admin_test_notification",
    templateKey: "campaign_draft",
    campaignId: "summer-test",
    testOnly: true,
    targetScope: "marketing_opt_in_users",
    preferencesSnapshot: {adminTestOnly: true, campaignDraftTest: true},
  });

  assert.equal(notificationDeliverySafetySuppression(validSelfTest), null);
  assert.deepEqual(notificationDeliverySafetySuppression(invalidCampaignTest), {
    deliveryState: "suppressed",
    deliverySuppressionReason: "admin-test-scope-invalid",
  });
  assert.equal(
    notificationDeliveryPreferenceSuppression(
      invalidCampaignTest,
      notificationSettings({bookingStatusEnabled: false}),
      notificationPreferences({bookingStatusEnabled: false}),
    ).deliverySuppressionReason,
    "admin-test-scope-invalid",
  );
});

test("campaign broadcast delivery requires marketing opt-in when targeted", () => {
  const campaign = outbox({
    type: "campaign_broadcast",
    templateKey: "campaign_draft",
    campaignId: "summer-test",
    targetScope: "marketing_opt_in_users",
    preferencesSnapshot: {campaignBroadcast: true, marketingConsentRequired: true},
    campaignSnapshot: {marketingConsentRequired: true},
  });

  assert.equal(
    notificationDeliveryPreferenceSuppression(
      campaign,
      notificationSettings({marketingEnabled: true}),
      notificationPreferences({marketingEnabled: true}),
    ),
    null,
  );
  assert.equal(
    notificationDeliveryPreferenceSuppression(
      campaign,
      notificationSettings({marketingEnabled: false}),
      notificationPreferences({marketingEnabled: true}),
    ).deliverySuppressionReason,
    "admin-marketing-disabled",
  );
  assert.equal(
    notificationDeliveryPreferenceSuppression(
      campaign,
      notificationSettings({marketingEnabled: true}),
      notificationPreferences({marketingEnabled: false}),
    ).deliverySuppressionReason,
    "user-marketing-disabled",
  );
});

test("campaign broadcast push payload carries campaign data", () => {
  const message = buildNotificationPushMessage(
    outbox({
      type: "campaign_broadcast",
      templateKey: "campaign_draft",
      campaignId: "summer-test",
      targetScope: "marketing_opt_in_users",
      dedupeKey: "campaign_broadcast:summer-test:user-1",
    }),
    [{token: "token-1"}],
  );

  assert.equal(message.data.type, "campaign_broadcast");
  assert.equal(message.data.templateKey, "campaign_draft");
  assert.equal(message.data.campaignId, "summer-test");
  assert.equal(message.data.targetScope, "marketing_opt_in_users");
  assert.equal(message.data.dedupeKey, "campaign_broadcast:summer-test:user-1");
});

test("deliverySuppressionUpdate marks notifications terminal without send counts", () => {
  const update = deliverySuppressionUpdate({
    suppression: {deliverySuppressionReason: "user-booking-status-disabled"},
    timestamp: new Date("2026-06-01T08:15:00.000Z"),
  });

  assert.equal(update.deliveryState, "suppressed");
  assert.equal(update.deliveryLeaseExpiresAt, null);
  assert.equal(update.deliverySuppressionReason, "user-booking-status-disabled");
  assert.equal(update.deliveryResult.tokenCount, 0);
  assert.equal(update.deliveryResult.successCount, 0);
  assert.equal(update.deliveryResult.lastErrorCode, "user-booking-status-disabled");
  assert.equal(update.suppressedAt.toISOString(), "2026-06-01T08:15:00.000Z");
});

test("notification quiet hours support overnight and same-day windows", () => {
  const overnightSettings = {
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
  };
  const sameDaySettings = {
    quietHoursStart: "13:00",
    quietHoursEnd: "14:30",
  };

  assert.equal(NOTIFICATION_QUIET_HOURS_TIME_ZONE, "Europe/Lisbon");
  assert.equal(
    isNotificationQuietHour(overnightSettings, new Date("2026-01-01T22:30:00.000Z")),
    true,
  );
  assert.equal(
    isNotificationQuietHour(overnightSettings, new Date("2026-01-02T07:30:00.000Z")),
    true,
  );
  assert.equal(
    isNotificationQuietHour(overnightSettings, new Date("2026-01-02T08:00:00.000Z")),
    false,
  );
  assert.equal(
    isNotificationQuietHour(sameDaySettings, new Date("2026-01-01T13:30:00.000Z")),
    true,
  );
  assert.equal(
    isNotificationQuietHour(sameDaySettings, new Date("2026-01-01T14:30:00.000Z")),
    false,
  );
  assert.equal(isNotificationQuietHour({
    quietHoursStart: "08:00",
    quietHoursEnd: "08:00",
  }, new Date("2026-01-01T08:15:00.000Z")), false);
  assert.equal(isNotificationQuietHour({
    quietHoursStart: "bad",
    quietHoursEnd: "08:00",
  }, new Date("2026-01-01T07:30:00.000Z")), false);
  assert.equal(isNotificationQuietHour({
    quietHoursStart: "09:00",
    quietHoursEnd: "10:00",
    quietHoursTimeZone: "Asia/Tokyo",
  }, new Date("2026-01-01T00:30:00.000Z")), true);
});

test("quiet hours defer normal push delivery but allow admin self-tests", () => {
  const settings = {
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
  };
  const quietNow = new Date("2026-01-01T23:00:00.000Z");
  const activeNow = new Date("2026-01-01T12:00:00.000Z");

  assert.equal(shouldDeferNotificationForQuietHours(outbox(), settings, quietNow), true);
  assert.equal(shouldDeferNotificationForQuietHours(outbox(), settings, activeNow), false);
  assert.equal(shouldDeferNotificationForQuietHours(outbox({
    type: "admin_test_notification",
    testOnly: true,
    targetScope: "self",
    preferencesSnapshot: {adminTestOnly: true},
  }), settings, quietNow), false);
  assert.equal(shouldDeferNotificationForQuietHours(outbox({
    preferencesSnapshot: {adminTestOnly: true},
  }), settings, quietNow), true);
  assert.equal(shouldDeferNotificationForQuietHours(outbox({
    channels: ["email"],
  }), settings, quietNow), false);
});

test("quiet hours deferral records next delivery window without consuming attempts", () => {
  const settings = {
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
    quietHoursTimeZone: "UTC",
  };
  const deferral = notificationQuietHoursDeferral(
    outbox(),
    settings,
    new Date("2026-01-01T23:30:00.000Z"),
  );

  assert.equal(deferral.deliveryState, "deferred");
  assert.equal(deferral.deliveryLeaseExpiresAt, null);
  assert.equal(deferral.deliveryDeferralReason, "quiet-hours");
  assert.equal(deferral.quietHoursDeferredUntil.toISOString(), "2026-01-02T08:00:00.000Z");
  assert.equal(deferral.quietHoursStart, "22:00");
  assert.equal(deferral.quietHoursEnd, "08:00");
  assert.equal(deferral.quietHoursTimeZone, "UTC");
  assert.equal(
    notificationQuietHoursDeferral(outbox(), settings, new Date("2026-01-01T12:00:00.000Z")),
    null,
  );
});

test("active quiet hours deferral keeps deferred notifications parked", () => {
  const settings = {
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
    quietHoursTimeZone: "UTC",
  };
  const now = new Date("2026-01-01T23:30:00.000Z");

  assert.equal(isNotificationQuietHoursDeferralActive(outbox({
    deliveryState: "deferred",
    quietHoursDeferredUntil: new Date("2026-01-02T08:00:00.000Z"),
  }), settings, now), true);
  assert.equal(isNotificationQuietHoursDeferralActive(outbox({
    deliveryState: "queued",
    quietHoursDeferredUntil: new Date("2026-01-02T08:00:00.000Z"),
  }), settings, now), false);
  assert.equal(isNotificationQuietHoursDeferralActive(outbox({
    deliveryState: "deferred",
    quietHoursDeferredUntil: new Date("2026-01-01T23:00:00.000Z"),
  }), settings, now), false);
  assert.equal(isNotificationQuietHoursDeferralActive(outbox({
    deliveryState: "deferred",
    quietHoursDeferredUntil: new Date("2026-01-02T08:00:00.000Z"),
  }), {
    quietHoursStart: "08:00",
    quietHoursEnd: "08:00",
    quietHoursTimeZone: "UTC",
  }, now), false);
});

function retryResponse() {
  return {
    responses: [
      {
        success: false,
        error: {
          code: "messaging/server-unavailable",
          message: "Try later",
        },
      },
    ],
  };
}

function outbox(overrides = {}) {
  return {
    type: "booking_status",
    templateKey: "booking_accepted",
    recipientUid: "user-1",
    reservationId: "reservation-1",
    reservationCode: "SS-ABCDEFGH",
    title: "Marcação confirmada",
    body: "A sua marcação foi confirmada.",
    channels: ["push"],
    deliveryState: "queued",
    attemptCount: 0,
    dedupeKey: "booking_accepted:reservation-1",
    ...overrides,
  };
}

function notificationSettings(overrides = {}) {
  const {templates: templateOverrides = [], ...settingOverrides} = overrides;
  const templates = [
    {key: "booking_accepted", enabled: true},
    {key: "booking_reminder", enabled: true},
    {key: "loyalty_reward", enabled: true},
    {key: "admin_pending_booking", enabled: true},
  ];
  const overrideTemplates = new Map(templateOverrides.map((template) => [template.key, template]));
  return {
    bookingStatusEnabled: true,
    appointmentReminderEnabled: true,
    loyaltyEnabled: true,
    adminPendingAlertEnabled: true,
    templates: templates.map((template) => overrideTemplates.get(template.key) || template),
    ...settingOverrides,
  };
}

function notificationPreferences(overrides = {}) {
  return {
    bookingStatusEnabled: true,
    appointmentReminderEnabled: true,
    loyaltyEnabled: true,
    adminPendingAlertEnabled: true,
    marketingEnabled: false,
    ...overrides,
  };
}

function tokenDoc(id, data) {
  return {
    id,
    exists: true,
    data: () => data,
  };
}
