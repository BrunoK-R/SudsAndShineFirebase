const test = require("node:test");
const assert = require("node:assert/strict");
const {buildNotificationSettings} = require("../notificationAdmin");
const {
  ADMIN_PENDING_BOOKING_TEMPLATE_KEY,
  BOOKING_REMINDER_RESERVATION_STATUS_VALUES,
  LOYALTY_REWARD_TEMPLATE_KEY,
  NOTIFICATION_OUTBOX_COLLECTION,
  REVIEW_PROMPT_RESERVATION_STATUS_VALUES,
  adminNotificationOutboxDocId,
  buildAdminCampaignDraftTestNotificationOutboxDocument,
  buildAdminPendingBookingNotificationOutboxDocument,
  buildAdminTestNotificationOutboxDocument,
  buildLoyaltyRewardNotificationOutboxDocument,
  buildReservationNotificationOutboxDocument,
  enqueueAdminPendingBookingNotification,
  enqueueLoyaltyRewardNotification,
  enqueueReservationNotification,
  isBookingReminderReservationDue,
  isReviewPromptReservationDue,
  notificationOutboxDocId,
} = require("../notificationOutbox");

test("buildReservationNotificationOutboxDocument queues booking status with templates", () => {
  const settings = buildNotificationSettings(doc({
    value: {
      bookingStatusEnabled: true,
      templates: [
        {
          key: "booking_accepted",
          enabled: true,
          title: "Booking {{ reservationCode }} confirmed",
          body: "{{serviceName}} starts at {{slotStart}}.",
        },
      ],
    },
  }));
  const payload = buildReservationNotificationOutboxDocument({
    templateKey: "booking_accepted",
    reservationId: "reservation-1",
    reservation: reservation({
      status: "confirmed",
      serviceName: "Premium Wash",
    }),
    settings,
    preferences: {
      bookingStatusEnabled: true,
      appointmentReminderEnabled: true,
      loyaltyEnabled: true,
      marketingEnabled: false,
    },
    actorUid: "admin-1",
    timestamp: new Date("2026-05-31T16:00:00.000Z"),
  });

  assert.equal(payload.type, "booking_status");
  assert.equal(payload.templateKey, "booking_accepted");
  assert.equal(payload.recipientUid, "user-1");
  assert.equal(payload.title, "Booking SS-ABCDEFGH confirmed");
  assert.equal(payload.body, "Premium Wash starts at 2026-06-01T10:00:00.000Z.");
  assert.equal(payload.deliveryState, "queued");
  assert.equal(payload.createdByUid, "admin-1");
  assert.equal(payload.preferencesSnapshot.marketingEnabled, false);
  assert.equal(Object.hasOwn(payload, "token"), false);
});

test("buildReservationNotificationOutboxDocument respects admin and user opt-outs", () => {
  const enabledSettings = buildNotificationSettings(doc({
    value: {
      bookingStatusEnabled: true,
      templates: [
        {
          key: "booking_rejected",
          enabled: false,
          title: "Rejected",
          body: "Rejected",
        },
      ],
    },
  }));
  const globallyDisabledSettings = buildNotificationSettings(doc({
    value: {
      bookingStatusEnabled: false,
    },
  }));
  const enabledPreferences = {
    bookingStatusEnabled: true,
    appointmentReminderEnabled: true,
    loyaltyEnabled: true,
    marketingEnabled: false,
  };
  const disabledPreferences = {
    ...enabledPreferences,
    bookingStatusEnabled: false,
  };

  assert.equal(buildReservationNotificationOutboxDocument({
    templateKey: "booking_request",
    reservationId: "reservation-1",
    reservation: reservation(),
    settings: globallyDisabledSettings,
    preferences: enabledPreferences,
  }), null);
  assert.equal(buildReservationNotificationOutboxDocument({
    templateKey: "booking_request",
    reservationId: "reservation-1",
    reservation: reservation(),
    settings: buildNotificationSettings(null),
    preferences: disabledPreferences,
  }), null);
  assert.equal(buildReservationNotificationOutboxDocument({
    templateKey: "booking_rejected",
    reservationId: "reservation-1",
    reservation: reservation(),
    settings: enabledSettings,
    preferences: enabledPreferences,
  }), null);
  assert.equal(buildReservationNotificationOutboxDocument({
    templateKey: "booking_request",
    reservationId: "reservation-1",
    reservation: reservation({customerUid: ""}),
    settings: buildNotificationSettings(null),
    preferences: enabledPreferences,
  }), null);
});

test("enqueueReservationNotification writes deterministic internal outbox document", () => {
  const tx = fakeTx();
  const db = fakeDb();
  const queued = enqueueReservationNotification(tx, {
    db,
    templateKey: "booking_expired",
    reservationId: "reservation-1",
    reservation: reservation({
      status: "expired",
    }),
    notificationSettingsSnap: doc({
      value: {
        bookingStatusEnabled: true,
      },
    }),
    userPreferencesSnap: doc({
      bookingStatusEnabled: true,
      appointmentReminderEnabled: true,
      loyaltyEnabled: true,
      marketingEnabled: false,
    }),
    actorUid: "system",
    timestamp: new Date("2026-05-31T16:05:00.000Z"),
  });

  assert.equal(queued.templateKey, "booking_expired");
  assert.equal(tx.writes.length, 1);
  assert.deepEqual(tx.writes[0], {
    path: `${NOTIFICATION_OUTBOX_COLLECTION}/${notificationOutboxDocId("booking_expired", "reservation-1")}`,
    data: queued,
  });
});

test("buildReservationNotificationOutboxDocument supports cancellation and reschedule templates", () => {
  const settings = buildNotificationSettings(doc({
    value: {
      bookingStatusEnabled: true,
      templates: [
        {
          key: "booking_cancelled",
          enabled: true,
          title: "Cancelled {{reservationCode}}",
          body: "{{serviceName}} was cancelled.",
        },
        {
          key: "booking_rescheduled",
          enabled: true,
          title: "Rescheduled",
          body: "Moved from {{previousSlotStart}} to {{slotStart}}.",
        },
      ],
    },
  }));
  const preferences = {
    bookingStatusEnabled: true,
    appointmentReminderEnabled: true,
    loyaltyEnabled: true,
    marketingEnabled: false,
  };

  const cancelled = buildReservationNotificationOutboxDocument({
    templateKey: "booking_cancelled",
    reservationId: "reservation-1",
    reservation: reservation({status: "cancelled"}),
    settings,
    preferences,
    actorUid: "user-1",
    timestamp: new Date("2026-05-31T16:10:00.000Z"),
  });
  const rescheduled = buildReservationNotificationOutboxDocument({
    templateKey: "booking_rescheduled",
    reservationId: "reservation-1",
    reservation: reservation({
      status: "pending",
      slotStart: "2026-06-02T12:00:00.000Z",
      previousSlotStart: "2026-06-01T10:00:00.000Z",
    }),
    settings,
    preferences,
    actorUid: "user-1",
    timestamp: new Date("2026-05-31T16:11:00.000Z"),
  });

  assert.equal(cancelled.templateKey, "booking_cancelled");
  assert.equal(cancelled.body, "Detail was cancelled.");
  assert.equal(rescheduled.templateKey, "booking_rescheduled");
  assert.equal(rescheduled.body, "Moved from 2026-06-01T10:00:00.000Z to 2026-06-02T12:00:00.000Z.");
});

test("buildReservationNotificationOutboxDocument queues review prompts without token exposure", () => {
  const payload = buildReservationNotificationOutboxDocument({
    templateKey: "review_prompt",
    reservationId: "reservation-1",
    reservation: reservation({
      status: "confirmed",
      slotEnd: "2026-05-31T15:00:00.000Z",
    }),
    settings: buildNotificationSettings(doc({
      value: {
        bookingStatusEnabled: true,
      },
    })),
    preferences: {
      bookingStatusEnabled: true,
      appointmentReminderEnabled: true,
      loyaltyEnabled: true,
      marketingEnabled: false,
    },
    actorUid: "system",
    timestamp: new Date("2026-05-31T16:00:00.000Z"),
  });

  assert.equal(payload.type, "review_prompt");
  assert.equal(payload.templateKey, "review_prompt");
  assert.equal(payload.recipientUid, "user-1");
  assert.equal(payload.deliveryState, "queued");
  assert.equal(payload.createdByUid, "system");
  assert.equal(Object.hasOwn(payload, "token"), false);
});

test("buildReservationNotificationOutboxDocument queues reminder payloads without token exposure", () => {
  const settings = buildNotificationSettings(doc({
    value: {
      appointmentReminderEnabled: true,
      templates: [
        {
          key: "booking_reminder",
          enabled: true,
          title: "Reminder {{reservationCode}}",
          body: "{{serviceName}} starts at {{slotStart}}.",
        },
      ],
    },
  }));
  const preferences = {
    bookingStatusEnabled: true,
    appointmentReminderEnabled: true,
    loyaltyEnabled: true,
    marketingEnabled: false,
  };

  const payload = buildReservationNotificationOutboxDocument({
    templateKey: "booking_reminder",
    reservationId: "reservation-1",
    reservation: reservation({status: "confirmed"}),
    settings,
    preferences,
    actorUid: "system",
    timestamp: new Date("2026-05-31T16:00:00.000Z"),
  });
  const optedOut = buildReservationNotificationOutboxDocument({
    templateKey: "booking_reminder",
    reservationId: "reservation-1",
    reservation: reservation({status: "confirmed"}),
    settings,
    preferences: {
      ...preferences,
      appointmentReminderEnabled: false,
    },
    actorUid: "system",
    timestamp: new Date("2026-05-31T16:00:00.000Z"),
  });

  assert.equal(payload.type, "booking_reminder");
  assert.equal(payload.templateKey, "booking_reminder");
  assert.equal(payload.body, "Detail starts at 2026-06-01T10:00:00.000Z.");
  assert.equal(payload.preferencesSnapshot.appointmentReminderEnabled, true);
  assert.equal(Object.hasOwn(payload, "token"), false);
  assert.equal(optedOut, null);
});

test("buildLoyaltyRewardNotificationOutboxDocument queues loyalty rewards without token exposure", () => {
  const settings = buildNotificationSettings(doc({
    value: {
      loyaltyEnabled: true,
      templates: [
        {
          key: LOYALTY_REWARD_TEMPLATE_KEY,
          enabled: true,
          title: "Reward {{rewardCode}}",
          body: "{{rewardDescription}} is ready.",
        },
      ],
    },
  }));
  const preferences = {
    bookingStatusEnabled: true,
    appointmentReminderEnabled: true,
    loyaltyEnabled: true,
    marketingEnabled: false,
  };

  const payload = buildLoyaltyRewardNotificationOutboxDocument({
    redemptionId: "reward-0001",
    redemption: loyaltyRedemption({
      rewardCode: "SS-FREE-UID1-0001",
      rewardDescription: "1 lavagem grátis",
    }),
    settings,
    preferences,
    actorUid: "user-1",
    timestamp: new Date("2026-06-01T10:00:00.000Z"),
  });
  const optedOut = buildLoyaltyRewardNotificationOutboxDocument({
    redemptionId: "reward-0001",
    redemption: loyaltyRedemption(),
    settings,
    preferences: {
      ...preferences,
      loyaltyEnabled: false,
    },
  });

  assert.equal(payload.type, "loyalty_reward");
  assert.equal(payload.templateKey, LOYALTY_REWARD_TEMPLATE_KEY);
  assert.equal(payload.recipientUid, "user-1");
  assert.equal(payload.redemptionId, "reward-0001");
  assert.equal(payload.title, "Reward SS-FREE-UID1-0001");
  assert.equal(payload.body, "1 lavagem grátis is ready.");
  assert.equal(payload.preferencesSnapshot.loyaltyEnabled, true);
  assert.equal(Object.hasOwn(payload, "token"), false);
  assert.equal(optedOut, null);
});

test("enqueueLoyaltyRewardNotification writes deterministic loyalty outbox document", () => {
  const tx = fakeTx();
  const db = fakeDb();
  const queued = enqueueLoyaltyRewardNotification(tx, {
    db,
    redemptionId: "reward-0001",
    redemption: loyaltyRedemption(),
    notificationSettingsSnap: doc({
      value: {
        loyaltyEnabled: true,
      },
    }),
    userPreferencesSnap: doc({
      bookingStatusEnabled: true,
      appointmentReminderEnabled: true,
      loyaltyEnabled: true,
      marketingEnabled: false,
    }),
    actorUid: "user-1",
    timestamp: new Date("2026-06-01T10:05:00.000Z"),
  });

  assert.equal(queued.templateKey, LOYALTY_REWARD_TEMPLATE_KEY);
  assert.equal(tx.writes.length, 1);
  assert.deepEqual(tx.writes[0], {
    path: `${NOTIFICATION_OUTBOX_COLLECTION}/${notificationOutboxDocId(LOYALTY_REWARD_TEMPLATE_KEY, "reward-0001")}`,
    data: queued,
  });
});

test("buildAdminPendingBookingNotificationOutboxDocument queues admin alerts without customer preferences", () => {
  const settings = buildNotificationSettings(doc({
    value: {
      adminPendingAlertEnabled: true,
      templates: [
        {
          key: ADMIN_PENDING_BOOKING_TEMPLATE_KEY,
          enabled: true,
          title: "New request {{reservationCode}}",
          body: "{{customerName}} requested {{serviceName}} at {{slotStart}}.",
        },
      ],
    },
  }));
  const payload = buildAdminPendingBookingNotificationOutboxDocument({
    reservationId: "reservation-1",
    reservation: reservation({
      customerName: "  Bruno   Ribeiro  ",
      serviceName: "Premium",
    }),
    settings,
    recipientUid: "admin-1",
    actorUid: "public-booking",
    timestamp: new Date("2026-05-31T16:20:00.000Z"),
  });

  assert.equal(payload.type, "admin_pending_booking");
  assert.equal(payload.templateKey, ADMIN_PENDING_BOOKING_TEMPLATE_KEY);
  assert.equal(payload.recipientUid, "admin-1");
  assert.equal(payload.title, "New request SS-ABCDEFGH");
  assert.equal(payload.body, "Bruno Ribeiro requested Premium at 2026-06-01T10:00:00.000Z.");
  assert.equal(payload.deliveryState, "queued");
  assert.equal(payload.createdByUid, "public-booking");
  assert.equal(payload.preferencesSnapshot.adminPendingAlertEnabled, true);
  assert.equal(payload.preferencesSnapshot.recipientAdminPendingAlertEnabled, true);
  assert.equal(Object.hasOwn(payload, "token"), false);
});

test("buildAdminPendingBookingNotificationOutboxDocument respects admin alert opt-outs", () => {
  const enabledSettings = buildNotificationSettings(doc({
    value: {
      adminPendingAlertEnabled: true,
      templates: [
        {
          key: ADMIN_PENDING_BOOKING_TEMPLATE_KEY,
          enabled: false,
          title: "New request",
          body: "New request",
        },
      ],
    },
  }));
  const disabledSettings = buildNotificationSettings(doc({
    value: {
      adminPendingAlertEnabled: false,
    },
  }));

  assert.equal(buildAdminPendingBookingNotificationOutboxDocument({
    reservationId: "reservation-1",
    reservation: reservation(),
    settings: disabledSettings,
    recipientUid: "admin-1",
  }), null);
  assert.equal(buildAdminPendingBookingNotificationOutboxDocument({
    reservationId: "reservation-1",
    reservation: reservation(),
    settings: enabledSettings,
    recipientUid: "admin-1",
  }), null);
  assert.equal(buildAdminPendingBookingNotificationOutboxDocument({
    reservationId: "reservation-1",
    reservation: reservation(),
    settings: buildNotificationSettings(null),
    preferences: {adminPendingAlertEnabled: false},
    recipientUid: "admin-1",
  }), null);
  assert.equal(buildAdminPendingBookingNotificationOutboxDocument({
    reservationId: "reservation-1",
    reservation: reservation(),
    settings: buildNotificationSettings(null),
    recipientUid: "",
  }), null);
});

test("enqueueAdminPendingBookingNotification writes deterministic per-admin outbox documents", () => {
  const tx = fakeTx();
  const db = fakeDb();
  const queued = enqueueAdminPendingBookingNotification(tx, {
    db,
    reservationId: "reservation-1",
    reservation: reservation(),
    recipientUid: "admin-1",
    notificationSettingsSnap: doc({
      value: {
        adminPendingAlertEnabled: true,
      },
    }),
    actorUid: "public-booking",
    timestamp: new Date("2026-05-31T16:25:00.000Z"),
  });

  assert.equal(queued.templateKey, ADMIN_PENDING_BOOKING_TEMPLATE_KEY);
  assert.equal(tx.writes.length, 1);
  assert.deepEqual(tx.writes[0], {
    path: `${NOTIFICATION_OUTBOX_COLLECTION}/${adminNotificationOutboxDocId(
      ADMIN_PENDING_BOOKING_TEMPLATE_KEY,
      "reservation-1",
      "admin-1",
    )}`,
    data: queued,
  });
});

test("enqueueAdminPendingBookingNotification skips admin alert recipient opt-outs", () => {
  const tx = fakeTx();
  const db = fakeDb();
  const suppressed = enqueueAdminPendingBookingNotification(tx, {
    db,
    reservationId: "reservation-1",
    reservation: reservation(),
    recipientUid: "admin-1",
    notificationSettingsSnap: doc({
      value: {
        adminPendingAlertEnabled: true,
      },
    }),
    adminPreferencesSnap: doc({
      adminPendingAlertEnabled: false,
    }),
    actorUid: "public-booking",
    timestamp: new Date("2026-05-31T16:25:00.000Z"),
  });

  assert.equal(suppressed, null);
  assert.equal(tx.writes.length, 0);
});

test("buildAdminTestNotificationOutboxDocument queues current-admin test without token exposure", () => {
  const payload = buildAdminTestNotificationOutboxDocument({
    templateKey: "admin_pending_booking",
    recipientUid: "admin-1",
    actorUid: "admin-1",
    settings: buildNotificationSettings(doc({
      value: {
        adminPendingAlertEnabled: true,
        templates: [
          {
            key: "admin_pending_booking",
            enabled: true,
            title: "Teste {{reservationCode}}",
            body: "{{customerName}} pediu {{serviceName}} para {{slotStart}}.",
          },
        ],
      },
    })),
    timestamp: new Date("2026-06-01T08:00:00.000Z"),
  });

  assert.equal(payload.type, "admin_test_notification");
  assert.equal(payload.templateKey, "admin_pending_booking");
  assert.equal(payload.recipientUid, "admin-1");
  assert.equal(payload.title, "Teste TESTE");
  assert.equal(payload.body, "Cliente de teste pediu Lavagem completa para 2026-06-01 10:00.");
  assert.equal(payload.notificationCreatedByUid, "admin-1");
  assert.equal(payload.preferencesSnapshot.adminTestOnly, true);
  assert.equal(Object.hasOwn(payload, "token"), false);
});

test("buildAdminCampaignDraftTestNotificationOutboxDocument queues campaign preview to current admin only", () => {
  const payload = buildAdminCampaignDraftTestNotificationOutboxDocument({
    campaign: {
      campaignId: "summer-test",
      title: "Oferta de teste",
      body: "Mensagem segura para preview.",
      targetAudience: "marketing_opt_in_users",
      status: "draft",
      sendBlockedReason: "campaign-send-not-implemented",
    },
    recipientUid: "admin-1",
    actorUid: "admin-1",
    timestamp: new Date("2026-06-01T08:05:00.000Z"),
  });

  assert.equal(payload.type, "admin_test_notification");
  assert.equal(payload.templateKey, "campaign_draft");
  assert.equal(payload.campaignId, "summer-test");
  assert.equal(payload.recipientUid, "admin-1");
  assert.equal(payload.title, "Oferta de teste");
  assert.equal(payload.body, "Mensagem segura para preview.");
  assert.equal(payload.campaignSnapshot.targetAudience, "marketing_opt_in_users");
  assert.equal(payload.preferencesSnapshot.adminTestOnly, true);
  assert.equal(payload.preferencesSnapshot.campaignDraftTest, true);
  assert.equal(Object.hasOwn(payload, "token"), false);
});

test("buildAdminTestNotificationOutboxDocument respects disabled settings", () => {
  assert.equal(buildAdminTestNotificationOutboxDocument({
    templateKey: "booking_reminder",
    recipientUid: "admin-1",
    settings: buildNotificationSettings(doc({
      value: {
        appointmentReminderEnabled: false,
      },
    })),
  }), null);

  assert.equal(buildAdminTestNotificationOutboxDocument({
    templateKey: "booking_request",
    recipientUid: "admin-1",
    settings: buildNotificationSettings(doc({
      value: {
        templates: [
          {
            key: "booking_request",
            enabled: false,
            title: "Pedido",
            body: "Recebido",
          },
        ],
      },
    })),
  }), null);
});

test("isReviewPromptReservationDue requires owned completed past reservations", () => {
  assert.deepEqual(REVIEW_PROMPT_RESERVATION_STATUS_VALUES.includes("confirmed"), true);
  assert.equal(isReviewPromptReservationDue(reservation({
    status: "confirmed",
    slotEnd: "2026-05-31T15:00:00.000Z",
  }), new Date("2026-05-31T16:00:00.000Z")), true);
  assert.equal(isReviewPromptReservationDue(reservation({
    status: "pending",
    slotEnd: "2026-05-31T15:00:00.000Z",
  }), new Date("2026-05-31T16:00:00.000Z")), false);
  assert.equal(isReviewPromptReservationDue(reservation({
    status: "confirmed",
    slotEnd: "2026-05-31T17:00:00.000Z",
  }), new Date("2026-05-31T16:00:00.000Z")), false);
  assert.equal(isReviewPromptReservationDue(reservation({
    customerUid: "",
    status: "confirmed",
    slotEnd: "2026-05-31T15:00:00.000Z",
  }), new Date("2026-05-31T16:00:00.000Z")), false);
});

test("isBookingReminderReservationDue requires owned confirmed reservations inside lead window", () => {
  const settings = buildNotificationSettings(doc({
    value: {
      appointmentReminderEnabled: true,
      reminderLeadMinutes: 120,
    },
  }));
  const now = new Date("2026-06-01T08:00:00.000Z");

  assert.deepEqual(BOOKING_REMINDER_RESERVATION_STATUS_VALUES.includes("confirmed"), true);
  assert.equal(isBookingReminderReservationDue(reservation({
    status: "confirmed",
    slotStart: "2026-06-01T09:30:00.000Z",
  }), settings, now), true);
  assert.equal(isBookingReminderReservationDue(reservation({
    status: "confirmado",
    slotStart: "2026-06-01T09:30:00.000Z",
  }), settings, now), true);
  assert.equal(isBookingReminderReservationDue(reservation({
    status: "pending",
    slotStart: "2026-06-01T09:30:00.000Z",
  }), settings, now), false);
  assert.equal(isBookingReminderReservationDue(reservation({
    status: "confirmed",
    slotStart: "2026-06-01T10:30:00.000Z",
  }), settings, now), false);
  assert.equal(isBookingReminderReservationDue(reservation({
    status: "confirmed",
    slotStart: "2026-06-01T07:30:00.000Z",
  }), settings, now), false);
  assert.equal(isBookingReminderReservationDue(reservation({
    customerUid: "",
    status: "confirmed",
    slotStart: "2026-06-01T09:30:00.000Z",
  }), settings, now), false);
  assert.equal(isBookingReminderReservationDue(reservation({
    status: "confirmed",
    slotStart: "2026-06-01T09:30:00.000Z",
  }), {
    ...settings,
    appointmentReminderEnabled: false,
  }, now), false);
});

test("enqueueReservationNotification does not requeue an existing outbox record", () => {
  const tx = fakeTx();
  const db = fakeDb();
  const queued = enqueueReservationNotification(tx, {
    db,
    templateKey: "review_prompt",
    reservationId: "reservation-1",
    reservation: reservation({
      status: "confirmed",
      slotEnd: "2026-05-31T15:00:00.000Z",
    }),
    notificationSettingsSnap: doc({
      value: {
        bookingStatusEnabled: true,
      },
    }),
    userPreferencesSnap: doc({
      bookingStatusEnabled: true,
      appointmentReminderEnabled: true,
      loyaltyEnabled: true,
      marketingEnabled: false,
    }),
    existingOutboxSnap: doc({deliveryState: "sent"}),
    actorUid: "system",
    timestamp: new Date("2026-05-31T16:05:00.000Z"),
  });

  assert.equal(queued, null);
  assert.equal(tx.writes.length, 0);
});

function reservation(overrides = {}) {
  return {
    customerUid: "user-1",
    reservationCode: "SS-ABCDEFGH",
    serviceName: "Detail",
    slotStart: "2026-06-01T10:00:00.000Z",
    slotEnd: "2026-06-01T11:00:00.000Z",
    status: "pending",
    ...overrides,
  };
}

function loyaltyRedemption(overrides = {}) {
  return {
    ownerUid: "user-1",
    rewardCode: "SS-FREE-UID1-0001",
    rewardNumber: 1,
    rewardType: "free_wash",
    rewardValue: 1,
    rewardDescription: "1 lavagem grátis",
    ...overrides,
  };
}

function doc(data) {
  return {
    exists: true,
    data: () => data,
  };
}

function fakeTx() {
  return {
    writes: [],
    set(ref, data) {
      this.writes.push({path: ref.path, data});
    },
  };
}

function fakeDb() {
  return {
    collection(name) {
      return {
        doc(id) {
          return {path: `${name}/${id}`};
        },
      };
    },
  };
}
