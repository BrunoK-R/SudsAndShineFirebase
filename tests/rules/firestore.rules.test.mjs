import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {Timestamp, doc, getDoc, setDoc, updateDoc} from 'firebase/firestore';

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
});
