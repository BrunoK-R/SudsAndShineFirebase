import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {Timestamp, deleteDoc, doc, getDoc, setDoc, updateDoc} from 'firebase/firestore';

const PROJECT_ID = 'sudsandshine-rules-firestore';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const firestoreRules = fs.readFileSync(
  path.resolve(__dirname, '../../firestore.rules'),
  'utf8',
);

const storageRules = fs.readFileSync(
  path.resolve(__dirname, '../../storage.rules'),
  'utf8',
);

let testEnv;

async function seedDoc(collection, id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, collection, id), data);
  });
}

function unauthDb() {
  return testEnv.unauthenticatedContext().firestore();
}

function staffDb() {
  return testEnv.authenticatedContext('emp-1', {role: 'employee'}).firestore();
}

function adminDb() {
  return testEnv.authenticatedContext('admin-1', {role: 'admin'}).firestore();
}

function userDb(uid) {
  return testEnv.authenticatedContext(uid, {}).firestore();
}

function validReservationPayload() {
  const now = Timestamp.fromDate(new Date());
  return {
    reservationCode: 'SS-ABCDEFGH',
    customerName: 'Bruno Ribeiro',
    customerEmail: 'bkendleyr@gmail.com',
    customerPhone: '+351913005855',
    serviceId: 'full-detail',
    serviceName: 'Detalhe Completo',
    slotStart: '2026-04-08T10:00:00.000Z',
    slotEnd: '2026-04-08T12:00:00.000Z',
    date: '2026-04-08',
    status: 'pending',
    notes: 'Cliente pede limpeza interior',
    createdAt: now,
    updatedAt: now,
    source: 'public-booking',
  };
}

function validBookingPolicyPayload(now = Timestamp.fromDate(new Date())) {
  return {
    key: 'booking_policy',
    value: {
      pendingHoldMinutes: 1440,
      cancellationWindowMinutes: 120,
      rescheduleWindowMinutes: 120,
      paymentEligibilityCopy: 'Pagamento confirmado no local após validação.',
    },
    updatedAt: now,
    updatedByUid: 'admin-1',
    updateSource: 'admin-mobile-booking-policy',
  };
}

function validAvailabilitySettingPayload(docId, value, now = Timestamp.fromDate(new Date())) {
  return {
    key: docId,
    value,
    updatedAt: now,
    updatedByUid: 'admin-1',
    updateSource: 'admin-mobile-availability',
  };
}

function validBlockedSlotPayload(now = Timestamp.fromDate(new Date())) {
  return {
    blockedSlotId: 'b-2',
    date: '2026-04-08',
    slotStart: '2026-04-08T15:00:00.000Z',
    slotEnd: '2026-04-08T16:00:00.000Z',
    reason: 'Admin block',
    active: true,
    updatedAt: now,
    updatedByUid: 'admin-1',
    updateSource: 'admin-mobile-availability',
  };
}

function validCapacityOverridePayload(now = Timestamp.fromDate(new Date())) {
  return {
    date: '2026-06-11',
    maxBookingsPerSlot: 0,
    active: true,
    updatedAt: now,
    updatedByUid: 'admin-1',
    updateSource: 'admin-mobile-availability',
  };
}

function validServicePayload({
  id = 'admin-service',
  active = true,
  updatedByUid = 'admin-1',
  createdByUid = 'admin-1',
  now = Timestamp.fromDate(new Date()),
} = {}) {
  return {
    id,
    name: 'Lavagem Admin',
    description: 'Serviço gerido no mobile admin.',
    durationMinutes: 45,
    passengerPriceCents: 3200,
    suvPriceCents: 3400,
    iconKey: 'sparkles',
    popular: false,
    active,
    enabled: active,
    sortOrder: 20,
    createdAt: now,
    updatedAt: now,
    createdByUid,
    updatedByUid,
  };
}

function validServiceExtraPayload({
  id = 'admin-extra',
  active = true,
  updatedByUid = 'admin-1',
  createdByUid = 'admin-1',
  now = Timestamp.fromDate(new Date()),
} = {}) {
  return {
    id,
    name: 'Extra Admin',
    description: 'Extra gerido no mobile admin.',
    priceCents: 1500,
    iconKey: 'shield',
    eligibleServiceIds: ['admin-service'],
    active,
    enabled: active,
    sortOrder: 10,
    createdAt: now,
    updatedAt: now,
    createdByUid,
    updatedByUid,
  };
}

function validLoyaltySettingsPayload(now = Timestamp.fromDate(new Date())) {
  return {
    key: 'loyalty_settings',
    value: {
      stampsRequired: 8,
      rewardType: 'discount_amount',
      rewardValue: 1500,
      rewardDescription: '15 euros de desconto',
    },
    updatedAt: now,
    updatedByUid: 'admin-1',
    updateSource: 'admin-mobile-loyalty',
  };
}

function validNotificationTemplate(key) {
  return {
    key,
    label: `${key} label`,
    enabled: true,
    title: `${key} title`,
    body: `${key} body`,
  };
}

function validNotificationSettingsPayload(now = Timestamp.fromDate(new Date())) {
  return {
    key: 'notification_settings',
    value: {
      bookingStatusEnabled: true,
      appointmentReminderEnabled: true,
      loyaltyEnabled: true,
      adminPendingAlertEnabled: true,
      marketingEnabled: false,
      reminderLeadMinutes: 120,
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
      quietHoursTimeZone: 'Europe/Lisbon',
      templates: [
        'booking_request',
        'booking_accepted',
        'booking_rejected',
        'booking_expired',
        'booking_cancelled',
        'booking_rescheduled',
        'booking_reminder',
        'review_prompt',
        'loyalty_reward',
        'admin_pending_booking',
      ].map(validNotificationTemplate),
    },
    updatedAt: now,
    updatedByUid: 'admin-1',
    updateSource: 'admin-mobile-notifications',
  };
}

test.before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {rules: firestoreRules},
    storage: {rules: storageRules},
  });
});

test.beforeEach(async () => {
  await testEnv.clearFirestore();
});

test.after(async () => {
  await testEnv.cleanup();
});

test('public can read services but cannot write them', async () => {
  const now = Timestamp.fromDate(new Date());
  await seedDoc('services', 'basic-wash', validServicePayload({
    id: 'basic-wash',
    now,
  }));

  const db = unauthDb();
  await assertSucceeds(getDoc(doc(db, 'services', 'basic-wash')));
  await assertFails(setDoc(doc(db, 'services', 'new-service'), {name: 'Hack'}));
  await assertFails(setDoc(doc(staffDb(), 'services', 'staff-service'), {name: 'Staff overwrite'}));
  await assertFails(setDoc(doc(adminDb(), 'services', 'admin-service'), {name: 'Admin service'}));
  await assertFails(setDoc(doc(adminDb(), 'services', 'admin-service'), {
    ...validServicePayload({id: 'other-service', now}),
  }));
  await assertFails(setDoc(doc(adminDb(), 'services', 'bad.path'), validServicePayload({id: 'bad.path', now})));
  await assertFails(setDoc(doc(adminDb(), 'services', 'admin-service'), {
    ...validServicePayload({id: 'admin-service', now}),
    internalNote: 'not allowed',
  }));
  await assertSucceeds(setDoc(
    doc(adminDb(), 'services', 'admin-service'),
    validServicePayload({id: 'admin-service', now}),
  ));
  await assertSucceeds(updateDoc(doc(adminDb(), 'services', 'admin-service'), {
    active: false,
    enabled: false,
    archivedAt: now,
    archivedByUid: 'admin-1',
    updatedAt: now,
    updatedByUid: 'admin-1',
  }));
  await assertFails(updateDoc(doc(adminDb(), 'services', 'admin-service'), {
    updatedAt: now,
    updatedByUid: 'other-admin',
  }));
  await assertFails(deleteDoc(doc(adminDb(), 'services', 'admin-service')));
});

test('service extras are admin-only for direct clients', async () => {
  const now = Timestamp.fromDate(new Date());
  await seedDoc('service_extras', 'wax', validServiceExtraPayload({
    id: 'wax',
    now,
  }));

  await assertFails(getDoc(doc(unauthDb(), 'service_extras', 'wax')));
  await assertFails(setDoc(doc(unauthDb(), 'service_extras', 'new-extra'), {name: 'Hack'}));
  await assertFails(setDoc(doc(staffDb(), 'service_extras', 'staff-extra'), {name: 'Staff overwrite'}));
  await assertSucceeds(getDoc(doc(adminDb(), 'service_extras', 'wax')));
  await assertFails(setDoc(doc(adminDb(), 'service_extras', 'admin-extra'), {name: 'Admin extra'}));
  await assertFails(setDoc(doc(adminDb(), 'service_extras', 'admin-extra'), {
    ...validServiceExtraPayload({id: 'other-extra', now}),
  }));
  await assertFails(setDoc(doc(adminDb(), 'service_extras', 'admin-extra'), {
    ...validServiceExtraPayload({id: 'admin-extra', now}),
    updateSource: 'console',
  }));
  await assertFails(setDoc(doc(adminDb(), 'service_extras', 'admin-extra'), {
    ...validServiceExtraPayload({id: 'admin-extra', now}),
    eligibleServiceIds: ['admin-service', 'bad/path'],
  }));
  await assertFails(setDoc(doc(adminDb(), 'service_extras', 'admin-extra'), {
    ...validServiceExtraPayload({id: 'admin-extra', now}),
    eligibleServiceIds: ['admin-service', 123],
  }));
  await assertSucceeds(setDoc(
    doc(adminDb(), 'service_extras', 'admin-extra'),
    validServiceExtraPayload({id: 'admin-extra', now}),
  ));
  await assertSucceeds(updateDoc(doc(adminDb(), 'service_extras', 'admin-extra'), {
    eligibleServiceIds: Array.from({length: 12}, (_, index) => `service-${index}`),
    updatedAt: now,
    updatedByUid: 'admin-1',
  }));
  await assertSucceeds(updateDoc(doc(adminDb(), 'service_extras', 'admin-extra'), {
    active: false,
    enabled: false,
    archivedAt: now,
    archivedByUid: 'admin-1',
    updatedAt: now,
    updatedByUid: 'admin-1',
  }));
  await assertFails(updateDoc(doc(adminDb(), 'service_extras', 'admin-extra'), {
    eligibleServiceIds: Array.from({length: 13}, (_, index) => `service-${index}`),
    updatedAt: now,
    updatedByUid: 'admin-1',
  }));
  await assertFails(deleteDoc(doc(adminDb(), 'service_extras', 'admin-extra')));
});

test('employee can write portfolio while public cannot', async () => {
  await seedDoc('portfolio_items', 'seed-item', {title: 'Antes/Depois', tags: ['Interior']});

  await assertSucceeds(updateDoc(doc(staffDb(), 'portfolio_items', 'seed-item'), {
    title: 'Interior premium',
  }));

  await assertFails(updateDoc(doc(unauthDb(), 'portfolio_items', 'seed-item'), {
    title: 'Public overwrite',
  }));
});

test('business settings can only be written by admin', async () => {
  await assertSucceeds(setDoc(doc(adminDb(), 'business_settings', 'hours'), {
    weekdayStart: '08:00',
    weekdayEnd: '19:00',
  }));

  await assertFails(setDoc(doc(staffDb(), 'business_settings', 'hours'), {
    weekdayStart: '00:00',
  }));
});

test('booking policy business setting requires admin audit and safe shape', async () => {
  const now = Timestamp.fromDate(new Date());
  const validPolicy = validBookingPolicyPayload(now);

  await assertSucceeds(setDoc(doc(adminDb(), 'business_settings', 'booking_policy'), validPolicy));
  await assertFails(setDoc(doc(staffDb(), 'business_settings', 'booking_policy'), validPolicy));
  await assertFails(setDoc(doc(adminDb(), 'business_settings', 'booking_policy'), {
    ...validPolicy,
    value: {
      ...validPolicy.value,
      pendingHoldMinutes: 5,
    },
  }));
  await assertFails(setDoc(doc(adminDb(), 'business_settings', 'booking_policy'), {
    ...validPolicy,
    updatedByUid: 'other-admin',
  }));
  await assertFails(setDoc(doc(adminDb(), 'business_settings', 'booking_policy'), {
    ...validPolicy,
    updateSource: 'console',
  }));
  await assertFails(setDoc(doc(adminDb(), 'business_settings', 'booking_policy'), {
    ...validPolicy,
    internalNote: 'not allowed',
  }));
  await assertSucceeds(updateDoc(doc(adminDb(), 'business_settings', 'booking_policy'), {
    value: {
      ...validPolicy.value,
      pendingHoldMinutes: 2880,
    },
    updatedAt: now,
    updatedByUid: 'admin-1',
    updateSource: 'admin-mobile-booking-policy',
  }));
  await assertFails(deleteDoc(doc(adminDb(), 'business_settings', 'booking_policy')));
});

test('availability business settings require admin audit and safe shape', async () => {
  const now = Timestamp.fromDate(new Date());
  const validCapacity = validAvailabilitySettingPayload('default_max_bookings_per_slot', 4, now);
  const validSlotInterval = validAvailabilitySettingPayload('default_slot_interval_minutes', 45, now);

  await assertSucceeds(setDoc(doc(adminDb(), 'business_settings', 'default_max_bookings_per_slot'), validCapacity));
  await assertSucceeds(setDoc(doc(adminDb(), 'business_settings', 'default_slot_interval_minutes'), validSlotInterval));
  await assertFails(setDoc(doc(staffDb(), 'business_settings', 'default_max_bookings_per_slot'), validCapacity));
  await assertFails(setDoc(doc(adminDb(), 'business_settings', 'default_max_bookings_per_slot'), {
    ...validCapacity,
    value: 30,
  }));
  await assertFails(setDoc(doc(adminDb(), 'business_settings', 'default_slot_interval_minutes'), {
    ...validSlotInterval,
    value: 300,
  }));
  await assertFails(setDoc(doc(adminDb(), 'business_settings', 'default_slot_interval_minutes'), {
    ...validSlotInterval,
    updatedByUid: 'other-admin',
  }));
  await assertFails(setDoc(doc(adminDb(), 'business_settings', 'default_max_bookings_per_slot'), {
    ...validCapacity,
    updateSource: 'console',
  }));
  await assertFails(setDoc(doc(adminDb(), 'business_settings', 'default_slot_interval_minutes'), {
    ...validSlotInterval,
    internalNote: 'not allowed',
  }));
});

test('admin settings are hidden from non-admin direct clients', async () => {
  const now = Timestamp.fromDate(new Date());
  const validLoyalty = validLoyaltySettingsPayload(now);
  const validNotifications = validNotificationSettingsPayload(now);

  await seedDoc('admin_settings', 'loyalty_settings', {
    value: {
      stampsRequired: 8,
      rewardType: 'discount_amount',
      rewardValue: 1500,
    },
  });
  await seedDoc('admin_settings', 'notification_settings', {
    value: {
      bookingStatusEnabled: true,
      appointmentReminderEnabled: true,
      loyaltyEnabled: true,
      adminPendingAlertEnabled: true,
      marketingEnabled: false,
      reminderLeadMinutes: 120,
    },
  });

  await assertFails(getDoc(doc(unauthDb(), 'admin_settings', 'loyalty_settings')));
  await assertFails(getDoc(doc(unauthDb(), 'admin_settings', 'notification_settings')));
  await assertFails(getDoc(doc(staffDb(), 'admin_settings', 'loyalty_settings')));
  await assertFails(getDoc(doc(staffDb(), 'admin_settings', 'notification_settings')));
  await assertFails(setDoc(doc(staffDb(), 'admin_settings', 'loyalty_settings'), {
    value: {stampsRequired: 1},
  }));
  await assertFails(setDoc(doc(staffDb(), 'admin_settings', 'notification_settings'), {
    value: {bookingStatusEnabled: false},
  }));
  await assertSucceeds(getDoc(doc(adminDb(), 'admin_settings', 'loyalty_settings')));
  await assertSucceeds(getDoc(doc(adminDb(), 'admin_settings', 'notification_settings')));
  await assertFails(setDoc(doc(adminDb(), 'admin_settings', 'loyalty_settings'), {
    value: {stampsRequired: 8},
  }));
  await assertFails(setDoc(doc(adminDb(), 'admin_settings', 'notification_settings'), {
    value: {bookingStatusEnabled: true},
  }));
  await assertSucceeds(setDoc(doc(adminDb(), 'admin_settings', 'loyalty_settings'), validLoyalty));
  await assertSucceeds(setDoc(doc(adminDb(), 'admin_settings', 'notification_settings'), validNotifications));
  await assertFails(deleteDoc(doc(adminDb(), 'admin_settings', 'loyalty_settings')));
  await assertFails(deleteDoc(doc(adminDb(), 'admin_settings', 'notification_settings')));
});

test('admin settings direct writes require safe settings and audit metadata', async () => {
  const now = Timestamp.fromDate(new Date());
  const validLoyalty = validLoyaltySettingsPayload(now);
  const validNotifications = validNotificationSettingsPayload(now);

  await assertFails(setDoc(doc(adminDb(), 'admin_settings', 'loyalty_settings'), {
    ...validLoyalty,
    updatedByUid: 'other-admin',
  }));
  await assertFails(setDoc(doc(adminDb(), 'admin_settings', 'loyalty_settings'), {
    ...validLoyalty,
    updateSource: 'console',
  }));
  await assertFails(setDoc(doc(adminDb(), 'admin_settings', 'loyalty_settings'), {
    ...validLoyalty,
    value: {
      ...validLoyalty.value,
      rewardType: 'discount_percent',
      rewardValue: 150,
    },
  }));
  await assertSucceeds(setDoc(doc(adminDb(), 'admin_settings', 'loyalty_settings'), validLoyalty));
  await assertSucceeds(updateDoc(doc(adminDb(), 'admin_settings', 'loyalty_settings'), {
    value: {
      ...validLoyalty.value,
      stampsRequired: 10,
      rewardType: 'free_wash',
      rewardValue: 1,
      rewardDescription: '1 lavagem grátis',
    },
    updatedAt: now,
    updatedByUid: 'admin-1',
    updateSource: 'admin-mobile-loyalty',
  }));

  await assertFails(setDoc(doc(adminDb(), 'admin_settings', 'notification_settings'), {
    ...validNotifications,
    updatedByUid: 'other-admin',
  }));
  await assertFails(setDoc(doc(adminDb(), 'admin_settings', 'notification_settings'), {
    ...validNotifications,
    value: {
      ...validNotifications.value,
      reminderLeadMinutes: 10,
    },
  }));
  await assertFails(setDoc(doc(adminDb(), 'admin_settings', 'notification_settings'), {
    ...validNotifications,
    value: {
      ...validNotifications.value,
      quietHoursStart: '24:00',
    },
  }));
  await assertFails(setDoc(doc(adminDb(), 'admin_settings', 'notification_settings'), {
    ...validNotifications,
    value: {
      ...validNotifications.value,
      templates: validNotifications.value.templates.slice(0, 9),
    },
  }));
  await assertFails(setDoc(doc(adminDb(), 'admin_settings', 'notification_settings'), {
    ...validNotifications,
    value: {
      ...validNotifications.value,
      templates: validNotifications.value.templates.map((template, index) =>
        index === 0 ? {...template, key: 'booking_accepted'} : template),
    },
  }));
  await assertSucceeds(setDoc(doc(adminDb(), 'admin_settings', 'notification_settings'), validNotifications));
  await assertSucceeds(updateDoc(doc(adminDb(), 'admin_settings', 'notification_settings'), {
    value: {
      ...validNotifications.value,
      reminderLeadMinutes: 240,
      quietHoursTimeZone: 'Atlantic/Azores',
    },
    updatedAt: now,
    updatedByUid: 'admin-1',
    updateSource: 'admin-mobile-notifications',
  }));
});

test('users can only manage their own notification preferences and tokens', async () => {
  const now = Timestamp.fromDate(new Date());
  await seedDoc('users/user-1/notification_preferences', 'default', {
    ownerUid: 'user-1',
    bookingStatusEnabled: true,
    appointmentReminderEnabled: true,
    loyaltyEnabled: true,
    adminPendingAlertEnabled: true,
    marketingEnabled: false,
    updatedAt: now,
    updatedByUid: 'user-1',
  });
  await seedDoc('users/user-1/notification_tokens', 'current-test-device', {
    ownerUid: 'user-1',
    tokenId: 'current-test-device',
    platform: 'android',
    token: 'test-token-for-current-device-1234567890',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });

  await assertSucceeds(getDoc(doc(userDb('user-1'), 'users', 'user-1', 'notification_preferences', 'default')));
  await assertFails(getDoc(doc(userDb('user-2'), 'users', 'user-1', 'notification_preferences', 'default')));
  await assertFails(setDoc(doc(userDb('user-2'), 'users', 'user-1', 'notification_preferences', 'default'), {
    ownerUid: 'user-1',
    bookingStatusEnabled: false,
    appointmentReminderEnabled: false,
    loyaltyEnabled: false,
    adminPendingAlertEnabled: false,
    marketingEnabled: true,
    updatedAt: now,
    updatedByUid: 'user-2',
  }));
  await assertFails(setDoc(doc(userDb('user-1'), 'users', 'user-1', 'notification_preferences', 'default'), {
    ownerUid: 'user-1',
    bookingStatusEnabled: false,
    appointmentReminderEnabled: true,
    loyaltyEnabled: true,
    adminPendingAlertEnabled: false,
    marketingEnabled: false,
    updatedAt: now,
    updatedByUid: 'user-2',
  }));
  await assertFails(setDoc(doc(userDb('user-1'), 'users', 'user-1', 'notification_preferences', 'default'), {
    ownerUid: 'user-1',
    bookingStatusEnabled: false,
    appointmentReminderEnabled: true,
    loyaltyEnabled: true,
    adminPendingAlertEnabled: false,
    marketingEnabled: false,
    updatedAt: now,
    updatedByUid: 'user-1',
    updateSource: 'mobile-notifications',
  }));
  await assertSucceeds(setDoc(doc(userDb('user-1'), 'users', 'user-1', 'notification_preferences', 'default'), {
    ownerUid: 'user-1',
    bookingStatusEnabled: false,
    appointmentReminderEnabled: true,
    loyaltyEnabled: true,
    adminPendingAlertEnabled: true,
    marketingEnabled: false,
    updatedAt: now,
    updatedByUid: 'user-1',
    updateSource: 'mobile-notifications',
  }));
  await assertFails(setDoc(doc(userDb('user-3'), 'users', 'user-3', 'notification_preferences', 'default'), {
    ownerUid: 'user-3',
    bookingStatusEnabled: true,
    appointmentReminderEnabled: true,
    loyaltyEnabled: true,
    adminPendingAlertEnabled: true,
    marketingEnabled: false,
    updatedAt: now,
    updatedByUid: 'user-3',
  }));
  await assertSucceeds(setDoc(doc(userDb('user-3'), 'users', 'user-3', 'notification_preferences', 'default'), {
    ownerUid: 'user-3',
    bookingStatusEnabled: true,
    appointmentReminderEnabled: true,
    loyaltyEnabled: true,
    marketingEnabled: false,
    updatedAt: now,
    updatedByUid: 'user-3',
  }));
  await assertSucceeds(setDoc(doc(adminDb(), 'users', 'admin-1', 'notification_preferences', 'default'), {
    ownerUid: 'admin-1',
    bookingStatusEnabled: true,
    appointmentReminderEnabled: true,
    loyaltyEnabled: true,
    adminPendingAlertEnabled: false,
    marketingEnabled: false,
    updatedAt: now,
    updatedByUid: 'admin-1',
    updateSource: 'mobile-notifications',
  }));

  await assertSucceeds(getDoc(doc(userDb('user-1'), 'users', 'user-1', 'notification_tokens', 'current-test-device')));
  await assertFails(getDoc(doc(userDb('user-2'), 'users', 'user-1', 'notification_tokens', 'current-test-device')));
  await assertFails(getDoc(doc(staffDb(), 'users', 'user-1', 'notification_tokens', 'current-test-device')));
  await assertFails(setDoc(doc(userDb('user-2'), 'users', 'user-1', 'notification_tokens', 'token-22'), {
    ownerUid: 'user-1',
    tokenId: 'token-22',
    platform: 'android',
    token: 'test-token-for-current-device-2222222222',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }));
  await assertFails(setDoc(doc(userDb('user-1'), 'users', 'user-1', 'notification_tokens', 'bad-owner'), {
    ownerUid: 'user-2',
    tokenId: 'bad-owner',
    platform: 'ios',
    token: 'test-token-for-current-device-2222222222',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }));
  await assertFails(setDoc(doc(userDb('user-1'), 'users', 'user-1', 'notification_tokens', 'token-22'), {
    ownerUid: 'user-1',
    tokenId: 'other-token',
    platform: 'ios',
    token: 'test-token-for-current-device-2222222222',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }));
  await assertFails(setDoc(doc(userDb('user-1'), 'users', 'user-1', 'notification_tokens', 'short'), {
    ownerUid: 'user-1',
    tokenId: 'short',
    platform: 'ios',
    token: 'test-token-for-current-device-2222222222',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }));
  await assertFails(setDoc(doc(userDb('user-1'), 'users', 'user-1', 'notification_tokens', 'token-22'), {
    ownerUid: 'user-1',
    tokenId: 'token-22',
    platform: 'sms',
    token: 'test-token-for-current-device-2222222222',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }));
  await assertFails(setDoc(doc(userDb('user-1'), 'users', 'user-1', 'notification_tokens', 'token-22'), {
    ownerUid: 'user-1',
    tokenId: 'token-22',
    platform: 'ios',
    token: 'test token with spaces',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }));
  await assertFails(setDoc(doc(userDb('user-1'), 'users', 'user-1', 'notification_tokens', 'token-22'), {
    tokenId: 'token-22',
    platform: 'ios',
    token: 'test-token-for-current-device-2222222222',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }));
  await assertSucceeds(setDoc(doc(userDb('user-1'), 'users', 'user-1', 'notification_tokens', 'token-22'), {
    ownerUid: 'user-1',
    tokenId: 'token-22',
    platform: 'ios',
    token: 'test-token-for-current-device-2222222222',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }));
  await assertSucceeds(deleteDoc(doc(userDb('user-1'), 'users', 'user-1', 'notification_tokens', 'token-22')));
});

test('notification outbox is hidden from all direct clients', async () => {
  const now = Timestamp.fromDate(new Date());
  await seedDoc('notification_outbox', 'booking_accepted_reservation-1', {
    type: 'booking_status',
    templateKey: 'booking_accepted',
    recipientUid: 'user-1',
    reservationId: 'reservation-1',
    deliveryState: 'queued',
    title: 'Confirmed',
    body: 'Your booking is confirmed.',
    createdAt: now,
    updatedAt: now,
    source: 'booking-lifecycle',
  });

  await assertFails(getDoc(doc(unauthDb(), 'notification_outbox', 'booking_accepted_reservation-1')));
  await assertFails(getDoc(doc(userDb('user-1'), 'notification_outbox', 'booking_accepted_reservation-1')));
  await assertFails(getDoc(doc(staffDb(), 'notification_outbox', 'booking_accepted_reservation-1')));
  await assertFails(getDoc(doc(adminDb(), 'notification_outbox', 'booking_accepted_reservation-1')));
  await assertFails(setDoc(doc(adminDb(), 'notification_outbox', 'manual'), {
    type: 'booking_status',
    templateKey: 'booking_accepted',
    recipientUid: 'user-1',
    reservationId: 'reservation-1',
    deliveryState: 'queued',
    title: 'Manual',
    body: 'Manual write',
    createdAt: now,
    updatedAt: now,
  }));
});

test('notification campaign drafts are callable-only for direct clients', async () => {
  const now = Timestamp.fromDate(new Date());
  await seedDoc('notification_campaign_drafts', 'spring-draft', {
    campaignId: 'spring-draft',
    title: 'Campanha de primavera',
    body: 'Mensagem para clientes opt-in.',
    targetAudience: 'marketing_opt_in_users',
    channels: ['push'],
    marketingConsentRequired: true,
    status: 'draft',
    sendBlocked: true,
    sendBlockedReason: 'campaign-send-not-implemented',
    createdAt: now,
    updatedAt: now,
  });

  await assertFails(getDoc(doc(unauthDb(), 'notification_campaign_drafts', 'spring-draft')));
  await assertFails(getDoc(doc(userDb('user-1'), 'notification_campaign_drafts', 'spring-draft')));
  await assertFails(getDoc(doc(staffDb(), 'notification_campaign_drafts', 'spring-draft')));
  await assertFails(getDoc(doc(adminDb(), 'notification_campaign_drafts', 'spring-draft')));
  await assertFails(setDoc(doc(adminDb(), 'notification_campaign_drafts', 'manual'), {
    campaignId: 'manual',
    title: 'Manual write',
    body: 'Direct clients must use callables.',
    targetAudience: 'marketing_opt_in_users',
    channels: ['push'],
    marketingConsentRequired: true,
    status: 'draft',
    sendBlocked: true,
    sendBlockedReason: 'campaign-send-not-implemented',
    createdAt: now,
    updatedAt: now,
  }));
});

test('public reservation create is allowed only with valid payload shape', async () => {
  const db = unauthDb();
  const goodPayload = validReservationPayload();
  await assertSucceeds(setDoc(doc(db, 'reservations', 'public-ok'), goodPayload));

  const badPayload = {
    ...validReservationPayload(),
    status: 'confirmed',
    internalNotes: 'not allowed for public create',
  };
  await assertFails(setDoc(doc(db, 'reservations', 'public-bad'), badPayload));
});

test('only staff can read reservations and blocked slots', async () => {
  const now = Timestamp.fromDate(new Date());
  await seedDoc('reservations', 'r-1', validReservationPayload());
  await seedDoc('blocked_slots', 'b-1', {
    date: '2026-04-08',
    slotStart: '2026-04-08T13:00:00.000Z',
    slotEnd: '2026-04-08T14:00:00.000Z',
    reason: 'Maintenance',
  });

  await assertSucceeds(getDoc(doc(staffDb(), 'reservations', 'r-1')));
  await assertSucceeds(getDoc(doc(staffDb(), 'blocked_slots', 'b-1')));

  await assertFails(getDoc(doc(unauthDb(), 'reservations', 'r-1')));
  await assertFails(getDoc(doc(unauthDb(), 'blocked_slots', 'b-1')));
  await assertFails(setDoc(doc(staffDb(), 'blocked_slots', 'b-2'), {
    date: '2026-04-08',
    slotStart: '2026-04-08T15:00:00.000Z',
    slotEnd: '2026-04-08T16:00:00.000Z',
    reason: 'Staff cannot block directly',
  }));
  await assertSucceeds(setDoc(doc(adminDb(), 'blocked_slots', 'b-2'), validBlockedSlotPayload(now)));
  await assertFails(setDoc(doc(adminDb(), 'blocked_slots', 'b-2'), {
    ...validBlockedSlotPayload(now),
    blockedSlotId: 'different-id',
  }));
  await assertFails(setDoc(doc(adminDb(), 'blocked_slots', 'b-2'), {
    ...validBlockedSlotPayload(now),
    slotEnd: '2026-04-08T14:00:00.000Z',
  }));
  await assertFails(setDoc(doc(adminDb(), 'blocked_slots', 'b-2'), {
    ...validBlockedSlotPayload(now),
    updateSource: 'console',
  }));
  await assertSucceeds(updateDoc(doc(adminDb(), 'blocked_slots', 'b-2'), {
    active: false,
    clearedAt: now,
    clearedByUid: 'admin-1',
    updatedAt: now,
    updatedByUid: 'admin-1',
    updateSource: 'admin-mobile-availability',
  }));
  await assertFails(deleteDoc(doc(adminDb(), 'blocked_slots', 'b-2')));
});

test('capacity overrides are staff-readable and admin-writable only', async () => {
  const now = Timestamp.fromDate(new Date());
  await seedDoc('capacity_overrides', '2026-06-10', {
    date: '2026-06-10',
    maxBookingsPerSlot: 4,
  });

  await assertSucceeds(getDoc(doc(staffDb(), 'capacity_overrides', '2026-06-10')));
  await assertFails(getDoc(doc(unauthDb(), 'capacity_overrides', '2026-06-10')));
  await assertFails(setDoc(doc(staffDb(), 'capacity_overrides', '2026-06-11'), {
    date: '2026-06-11',
    maxBookingsPerSlot: 0,
  }));
  await assertSucceeds(setDoc(doc(adminDb(), 'capacity_overrides', '2026-06-11'), validCapacityOverridePayload(now)));
  await assertFails(setDoc(doc(adminDb(), 'capacity_overrides', '2026-06-11'), {
    ...validCapacityOverridePayload(now),
    maxBookingsPerSlot: 30,
  }));
  await assertFails(setDoc(doc(adminDb(), 'capacity_overrides', '2026-06-11'), {
    ...validCapacityOverridePayload(now),
    updatedByUid: 'other-admin',
  }));
  await assertFails(setDoc(doc(adminDb(), 'capacity_overrides', '2026-06-11'), {
    ...validCapacityOverridePayload(now),
    updateSource: 'console',
  }));
  await assertSucceeds(setDoc(doc(adminDb(), 'capacity_overrides', '2026-06-11'), {
    date: '2026-06-11',
    active: false,
    clearedAt: now,
    clearedByUid: 'admin-1',
    updatedAt: now,
    updatedByUid: 'admin-1',
    updateSource: 'admin-mobile-availability',
  }));
  await assertFails(deleteDoc(doc(adminDb(), 'capacity_overrides', '2026-06-11')));
});

test('only staff can read and write reservation reviews directly', async () => {
  await seedDoc('reservation_reviews', 'review-1', {
    reservationId: 'r-1',
    customerUid: 'uid-1',
    rating: 5,
  });

  await assertSucceeds(getDoc(doc(staffDb(), 'reservation_reviews', 'review-1')));
  await assertSucceeds(setDoc(doc(staffDb(), 'reservation_reviews', 'review-2'), {
    reservationId: 'r-2',
    customerUid: 'uid-2',
    rating: 4,
  }));

  await assertFails(getDoc(doc(unauthDb(), 'reservation_reviews', 'review-1')));
  await assertFails(setDoc(doc(unauthDb(), 'reservation_reviews', 'public-review'), {
    reservationId: 'r-1',
    customerUid: 'uid-1',
    rating: 5,
  }));
});
