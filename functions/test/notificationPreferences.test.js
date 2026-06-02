const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildNotificationTokenValue,
  buildUserNotificationPreferences,
  buildUserNotificationPreferencesValue,
  scopedUserNotificationPreferencesForRole,
  validateNotificationTokenDeleteInput,
  validateNotificationTokenRegistrationInput,
  validateUserNotificationPreferencesInput,
} = require("../notificationPreferences");

test("buildUserNotificationPreferences returns safe defaults", () => {
  assert.deepEqual(buildUserNotificationPreferences(), {
    bookingStatusEnabled: true,
    appointmentReminderEnabled: true,
    loyaltyEnabled: true,
    adminPendingAlertEnabled: true,
    marketingEnabled: false,
  });
});

test("buildUserNotificationPreferences falls back to existing profile opt-ins", () => {
  const preferences = buildUserNotificationPreferences({
    preferencesDoc: {exists: false},
    userDoc: doc({
      appointmentReminderOptIn: false,
      marketingOptIn: true,
    }),
  });

  assert.deepEqual(preferences, {
    bookingStatusEnabled: true,
    appointmentReminderEnabled: false,
    loyaltyEnabled: true,
    adminPendingAlertEnabled: true,
    marketingEnabled: true,
  });
});

test("buildUserNotificationPreferences prefers dedicated preferences", () => {
  const preferences = buildUserNotificationPreferences({
    preferencesDoc: doc({
      bookingStatusEnabled: false,
      appointmentReminderEnabled: true,
      loyaltyEnabled: false,
      adminPendingAlertEnabled: false,
      marketingEnabled: false,
    }),
    userDoc: doc({
      appointmentReminderOptIn: false,
      marketingOptIn: true,
    }),
  });

  assert.deepEqual(preferences, {
    bookingStatusEnabled: false,
    appointmentReminderEnabled: true,
    loyaltyEnabled: false,
    adminPendingAlertEnabled: false,
    marketingEnabled: false,
  });
});

test("validateUserNotificationPreferencesInput normalizes booleans", () => {
  const preferences = validateUserNotificationPreferencesInput({
    bookingStatusEnabled: true,
    appointmentReminderEnabled: false,
    loyaltyEnabled: true,
    adminPendingAlertEnabled: false,
    marketingEnabled: true,
  });

  assert.deepEqual(buildUserNotificationPreferencesValue(preferences), {
    bookingStatusEnabled: true,
    appointmentReminderEnabled: false,
    loyaltyEnabled: true,
    adminPendingAlertEnabled: false,
    marketingEnabled: true,
  });
});

test("scopedUserNotificationPreferencesForRole preserves admin alert preference for non-admin callers", () => {
  const requestedPreferences = validateUserNotificationPreferencesInput({
    bookingStatusEnabled: true,
    appointmentReminderEnabled: true,
    loyaltyEnabled: true,
    adminPendingAlertEnabled: false,
    marketingEnabled: false,
  });

  const nonAdminPreferences = scopedUserNotificationPreferencesForRole(requestedPreferences, {
    canManageAdminPendingAlerts: false,
    existingPreferencesDoc: doc({
      adminPendingAlertEnabled: true,
    }),
  });
  const adminPreferences = scopedUserNotificationPreferencesForRole(requestedPreferences, {
    canManageAdminPendingAlerts: true,
    existingPreferencesDoc: doc({
      adminPendingAlertEnabled: true,
    }),
  });

  assert.equal(nonAdminPreferences.adminPendingAlertEnabled, true);
  assert.equal(adminPreferences.adminPendingAlertEnabled, false);
});

test("validateNotificationTokenRegistrationInput sanitizes dev token metadata", () => {
  const registration = validateNotificationTokenRegistrationInput({
    token: " fcm_token_1234567890 ",
    platform: " Android ",
    deviceId: " current-test-device ",
    deviceLabel: " Pixel   8  ",
    appVersion: " 1.0.0-debug ",
  });

  assert.deepEqual(buildNotificationTokenValue(registration, "uid-1"), {
    ownerUid: "uid-1",
    tokenId: "current-test-device",
    token: "fcm_token_1234567890",
    platform: "android",
    enabled: true,
    deviceLabel: "Pixel 8",
    appVersion: "1.0.0-debug",
  });
});

test("validateNotificationTokenRegistrationInput rejects unsafe targets", () => {
  assert.throws(
    () => validateNotificationTokenRegistrationInput({
      token: "short",
      platform: "android",
    }),
    /token is invalid/,
  );
  assert.throws(
    () => validateNotificationTokenRegistrationInput({
      token: "fcm_token_1234567890",
      platform: "android",
      deviceId: "users/uid-2/token",
    }),
    /tokenId is invalid/,
  );
  assert.throws(
    () => validateNotificationTokenRegistrationInput({
      token: "fcm_token_1234567890",
      platform: "sms",
    }),
    /platform/,
  );
});

test("validateNotificationTokenDeleteInput rejects path-like token ids", () => {
  assert.deepEqual(validateNotificationTokenDeleteInput({tokenId: "current-test-device"}), {
    tokenId: "current-test-device",
  });
  assert.throws(
    () => validateNotificationTokenDeleteInput({tokenId: "users/uid-2/token"}),
    /tokenId is invalid/,
  );
});

function doc(data) {
  return {
    exists: true,
    data: () => data,
  };
}
