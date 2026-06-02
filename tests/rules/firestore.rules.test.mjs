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
  await seedDoc('services', 'basic-wash', {name: 'Lavagem Básica', active: true});

  const db = unauthDb();
  await assertSucceeds(getDoc(doc(db, 'services', 'basic-wash')));
  await assertFails(setDoc(doc(db, 'services', 'new-service'), {name: 'Hack'}));
  await assertFails(setDoc(doc(staffDb(), 'services', 'staff-service'), {name: 'Staff overwrite'}));
  await assertSucceeds(setDoc(doc(adminDb(), 'services', 'admin-service'), {name: 'Admin service'}));
});

test('service extras are admin-only for direct clients', async () => {
  await seedDoc('service_extras', 'wax', {name: 'Enceramento', active: true});

  await assertFails(getDoc(doc(unauthDb(), 'service_extras', 'wax')));
  await assertFails(setDoc(doc(unauthDb(), 'service_extras', 'new-extra'), {name: 'Hack'}));
  await assertFails(setDoc(doc(staffDb(), 'service_extras', 'staff-extra'), {name: 'Staff overwrite'}));
  await assertSucceeds(getDoc(doc(adminDb(), 'service_extras', 'wax')));
  await assertSucceeds(setDoc(doc(adminDb(), 'service_extras', 'admin-extra'), {name: 'Admin extra'}));
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

test('admin settings are hidden from non-admin direct clients', async () => {
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
  await assertSucceeds(setDoc(doc(adminDb(), 'admin_settings', 'loyalty_settings'), {
    value: {stampsRequired: 8},
  }));
  await assertSucceeds(setDoc(doc(adminDb(), 'admin_settings', 'notification_settings'), {
    value: {bookingStatusEnabled: true},
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
  await assertFails(setDoc(doc(userDb('user-2'), 'users', 'user-1', 'notification_tokens', 'token-2'), {
    ownerUid: 'user-1',
    tokenId: 'token-2',
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
  await assertFails(setDoc(doc(userDb('user-1'), 'users', 'user-1', 'notification_tokens', 'token-2'), {
    ownerUid: 'user-1',
    tokenId: 'other-token',
    platform: 'ios',
    token: 'test-token-for-current-device-2222222222',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }));
  await assertSucceeds(setDoc(doc(userDb('user-1'), 'users', 'user-1', 'notification_tokens', 'token-2'), {
    ownerUid: 'user-1',
    tokenId: 'token-2',
    platform: 'ios',
    token: 'test-token-for-current-device-2222222222',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }));
  await assertSucceeds(deleteDoc(doc(userDb('user-1'), 'users', 'user-1', 'notification_tokens', 'token-2')));
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
  await assertSucceeds(setDoc(doc(adminDb(), 'blocked_slots', 'b-2'), {
    date: '2026-04-08',
    slotStart: '2026-04-08T15:00:00.000Z',
    slotEnd: '2026-04-08T16:00:00.000Z',
    reason: 'Admin block',
  }));
});

test('capacity overrides are staff-readable and admin-writable only', async () => {
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
  await assertSucceeds(setDoc(doc(adminDb(), 'capacity_overrides', '2026-06-11'), {
    date: '2026-06-11',
    maxBookingsPerSlot: 0,
  }));
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
