# SudsAndShine Firebase Workspace

This repository contains the Firebase-first infrastructure and Cloud Functions baseline for the Suds & Shine migration.

## What Is Already Set Up In This Repo

- Firebase project mapping in `.firebaserc`
- Firebase config in `firebase.json` (hosting, functions, firestore, storage, emulators)
- Baseline Firestore rules in `firestore.rules`
- Baseline Storage rules in `storage.rules`
- Initial composite indexes in `firestore.indexes.json`
- Function stubs in `functions/index.js`:
  - `createReservation` callable with transactional conflict checks
  - `assignAdminRole` callable for allowlist/claim assignment
  - `syncMyRole` callable to assign claims from `admin_allowlist` for authenticated users
  - `health` HTTP endpoint

## Local Commands

```bash
# from repo root
npm install
npm --prefix functions install
firebase emulators:start

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

# deploy hosting
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
