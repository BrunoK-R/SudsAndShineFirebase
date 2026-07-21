# SudsAndShine Firebase Workspace

This repository is the canonical production Firebase backend for Suds & Shine. Its Cloud Functions, Firestore rules and indexes, and Storage rules are shared by the mobile app and website.

Do not deploy production functions from the sibling mobile app repository. The app keeps a legacy functions directory for local compatibility, and its Firebase configuration blocks production function deployments.

## What Is Already Set Up In This Repo

- Firebase project mapping in `.firebaserc`
- Firebase config in `firebase.json` (hosting, functions, firestore, storage, emulators)
- Baseline Firestore rules in `firestore.rules`
- Baseline Storage rules in `storage.rules`
- Initial composite indexes in `firestore.indexes.json`
- Function stubs in `functions/index.js`:
  - `getServiceCatalog` callable for public service pricing/duration catalog from Firestore `services`
  - `createReservation` callable with transactional conflict checks
  - `getAvailability` callable for public month availability derived from capacity, reservations, and blocked slots
  - `getMyReservations` callable for authenticated user booking history from owned/legacy email reservations, including additive `paymentStatus` metadata for app payment surfaces
  - `getMyProfile` and `updateMyProfile` callables for authenticated customer profile management
  - `updateMyProfilePhoto` callable for validated, owner-scoped profile photo upload and removal
  - `assignAdminRole` callable for allowlist/claim assignment
  - `syncMyRole` callable to assign claims from `admin_allowlist` for authenticated users
  - `health` HTTP endpoint

## Local Commands

```bash
# from repo root
npm install
npm --prefix functions install
firebase emulators:start

# verify every callable referenced by the mobile app and website exists here
npm run test:consumer-contract

# run security rules tests (starts firestore+storage+auth emulators automatically)
npm run test:rules

# run migration CLI smoke tests
npm run test:migration

# data migration (DIGS-5)
npm run migrate:data -- --mode=full --dry-run
npm run migrate:data -- --mode=full
npm run migrate:data -- --mode=delta --since 2026-04-07T12:00:00Z

# deploy config-only assets
firebase deploy --only firestore:rules,firestore:indexes,storage

# deploy functions
firebase deploy --only functions

# build the website repo into this repo's public/ folder
npm run prepare:hosting

# deploy hosting (also runs prepare:hosting through firebase.json predeploy)
npm run deploy:hosting

# Firebase CLI direct hosting deploys from this repo also rebuild/sync first
firebase deploy --only hosting
```

## Required Manual Setup (GCP/Firebase Console)

Follow in this exact order:

1. Enable missing APIs on project `sudsandshine-bd3e2`:
   - `firestore.googleapis.com`
   - `cloudbuild.googleapis.com`
   - `artifactregistry.googleapis.com`
   - `run.googleapis.com`
2. Create Firestore database (Native mode, region `europe-west1` recommended).
3. In Firebase Auth:
   - Enable Google sign-in provider.
   - Add authorized domains for staging + production custom domain.
4. Create Firebase Web App and put web SDK keys in the website repo environment files.
5. Seed first allowlisted admin in Firestore:
   - collection: `admin_allowlist`
   - document id: lowercase email
   - fields: `email` (string), `role` (`admin`)
6. In admin frontend login flow, call `syncMyRole` right after Google sign-in.
7. Configure email provider secrets for functions (e.g. SendGrid/Resend).
8. Configure Hosting custom domain DNS + SSL.

## Notes

- Public routes must remain public; only admin area is authenticated/allowlisted.
- The function email workflow is intentionally non-blocking: booking success does not depend on email delivery.
- Migration runbook: `docs/migration-runbook.md`
