# DIGS-5 Migration Runbook (Supabase -> Firebase)

## Goal
Migrate database records and portfolio storage assets from Supabase into Firebase with:

- one-shot full migration
- delta migration for cutover window
- parity report per entity
- resumable/idempotent writes

## Script
Use:

`node scripts/migrate-supabase-to-firebase.mjs`

Or via npm:

`npm run migrate:data -- --mode=full`

## Prerequisites
1. Firebase project is active and reachable.
2. Firestore/Storage rules and functions are already deployed.
3. Service account has permissions for Firestore + Storage write.
4. Supabase service role key is available.

## Environment
Copy `.env.migration.example` and export vars in your shell.

Required:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional:
- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `FIREBASE_STORAGE_BUCKET`

## Full Migration (One-shot)
1. Dry-run first:
   - `npm run migrate:data -- --mode=full --dry-run`
2. Review report in `reports/` for warnings.
3. Real run:
   - `npm run migrate:data -- --mode=full`
4. Validate report counts.

## Delta Migration (Cutover)
1. Pick a timestamp right after full migration end (UTC ISO), e.g. `2026-04-07T12:00:00Z`.
2. Run dry-run delta:
   - `npm run migrate:data -- --mode=delta --since 2026-04-07T12:00:00Z --dry-run`
3. Run real delta in cutover window:
   - `npm run migrate:data -- --mode=delta --since 2026-04-07T12:00:00Z`
4. Validate report and smoke-test app flows.

## Idempotency & Resume
- Firestore writes are `set(..., { merge: true })` with deterministic doc IDs.
- Capacity override doc IDs use date.
- Worker presence doc IDs use `workerId_date`.
- Storage migration uses deterministic object paths under `portfolio/<itemId>/legacy-*`.
- Existing files are reused; missing download token metadata is repaired.

If interrupted, rerun the same command.

## Parity Checks
Each run emits `reports/migration-report-<timestamp>.json` including:
- source row count per entity
- writes performed
- target collection count
- storage assets migrated
- warnings

## Rollback Notes
If migration quality is unacceptable:
1. Stop cutover and keep app on current data path.
2. Re-run full migration in dry-run to inspect warnings.
3. Fix mapping/config issues, then rerun full migration.
4. For Storage cleanup, remove objects under `portfolio/<itemId>/legacy-*` only for affected items.

Firestore rollback is collection-doc based. Prefer restoring from backup/export if a destructive rollback is needed.
