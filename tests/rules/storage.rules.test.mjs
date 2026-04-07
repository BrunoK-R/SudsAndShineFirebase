import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {ref, uploadBytes, getBytes} from 'firebase/storage';

const PROJECT_ID = 'sudsandshine-rules-storage';
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

function asStorage(context) {
  return context.storage();
}

async function seedFile(filePath, bytes, contentType) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const storage = asStorage(context);
    await uploadBytes(ref(storage, filePath), bytes, {contentType});
  });
}

test.before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {rules: firestoreRules},
    storage: {rules: storageRules},
  });
});

test.after(async () => {
  await testEnv.cleanup();
});

test('public can read portfolio assets but cannot upload', async () => {
  const filePath = `portfolio/seed/existing-${Date.now()}.jpg`;
  await seedFile(filePath, Buffer.from('seed-image'), 'image/jpeg');

  const publicStorage = asStorage(testEnv.unauthenticatedContext());
  await assertSucceeds(getBytes(ref(publicStorage, filePath)));
  await assertFails(uploadBytes(
    ref(publicStorage, `portfolio/seed/public-write-${Date.now()}.jpg`),
    Buffer.from('x'),
    {contentType: 'image/jpeg'},
  ));
});

test('staff can upload image inside portfolio path', async () => {
  const staffStorage = asStorage(testEnv.authenticatedContext('emp-storage-1', {role: 'employee'}));

  await assertSucceeds(uploadBytes(
    ref(staffStorage, `portfolio/item-1/staff-ok-${Date.now()}.jpg`),
    Buffer.from('valid-image-content'),
    {contentType: 'image/jpeg'},
  ));
});

test('staff cannot upload non-image or write outside portfolio path', async () => {
  const staffStorage = asStorage(testEnv.authenticatedContext('emp-storage-2', {role: 'employee'}));

  await assertFails(uploadBytes(
    ref(staffStorage, `portfolio/item-2/not-image-${Date.now()}.txt`),
    Buffer.from('plain-text'),
    {contentType: 'text/plain'},
  ));

  await assertFails(uploadBytes(
    ref(staffStorage, `private/internal-${Date.now()}.jpg`),
    Buffer.from('image-content'),
    {contentType: 'image/jpeg'},
  ));
});
