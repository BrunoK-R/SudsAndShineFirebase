const test = require("node:test");
const assert = require("node:assert/strict");
const {buildNotificationSettings} = require("../notificationAdmin");
const {
  NOTIFICATION_OUTBOX_COLLECTION,
  REVIEW_PROMPT_RESERVATION_STATUS_VALUES,
  buildReservationNotificationOutboxDocument,
  enqueueReservationNotification,
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
