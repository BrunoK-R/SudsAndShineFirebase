#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {createClient} from '@supabase/supabase-js';
import admin from 'firebase-admin';

const STATUS_MAP = {
  novo: 'pending',
  confirmado: 'confirmed',
  em_execucao: 'in_progress',
  concluido: 'completed',
  cancelado: 'cancelled',
};

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [k, inlineValue] = token.slice(2).split('=');
    if (inlineValue !== undefined) {
      parsed[k] = inlineValue;
      continue;
    }
    const maybeValue = argv[i + 1];
    if (maybeValue && !maybeValue.startsWith('--')) {
      parsed[k] = maybeValue;
      i += 1;
    } else {
      parsed[k] = true;
    }
  }
  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/migrate-supabase-to-firebase.mjs [options]',
    '',
    'Options:',
    '  --mode full|delta          Migration mode (default: full)',
    '  --since <ISO datetime>     Required for delta mode',
    '  --batch-size <number>      Supabase page size (default: 500)',
    '  --report-dir <path>        Report output dir (default: reports)',
    '  --dry-run                  Build report without writing to Firebase',
    '  --help                     Show this help',
    '',
    'Required env vars:',
    '  SUPABASE_URL',
    '  SUPABASE_SERVICE_ROLE_KEY',
    '',
    'Optional env vars:',
    '  FIREBASE_SERVICE_ACCOUNT_JSON (JSON string)',
    '  FIREBASE_STORAGE_BUCKET',
  ].join('\n');
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function initFirebase() {
  if (admin.apps.length > 0) return admin.app();

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;

  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson);
    return admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket,
    });
  }

  return admin.initializeApp({storageBucket});
}

function sanitizeFileName(name) {
  return String(name || 'asset').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function fileNameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const candidate = decodeURIComponent(pathname.split('/').pop() || 'asset');
    return sanitizeFileName(candidate);
  } catch {
    return 'asset';
  }
}

function isFirebaseStorageUrl(url, bucketName) {
  if (!url) return false;
  return url.includes('firebasestorage.googleapis.com') || (bucketName && url.includes(bucketName));
}

function buildDownloadUrl(bucketName, objectPath, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

async function ensureTokenizedDownloadUrl(file, bucketName, objectPath) {
  const [metadata] = await file.getMetadata();
  const existingTokens = metadata?.metadata?.firebaseStorageDownloadTokens;
  let token = existingTokens ? String(existingTokens).split(',')[0] : null;

  if (!token) {
    token = crypto.randomUUID();
    await file.setMetadata({
      metadata: {
        ...(metadata?.metadata || {}),
        firebaseStorageDownloadTokens: token,
      },
    });
  }

  return buildDownloadUrl(bucketName, objectPath, token);
}

async function migrateAssetToFirebase({url, objectPath, bucketName, bucket, dryRun}) {
  if (!url) return null;
  if (isFirebaseStorageUrl(url, bucketName)) return url;

  if (dryRun) {
    return buildDownloadUrl(bucketName, objectPath, 'dry-run-token');
  }

  const file = bucket.file(objectPath);
  const [exists] = await file.exists();

  if (!exists) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download asset ${url}: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await response.arrayBuffer());
    const token = crypto.randomUUID();

    await file.save(buffer, {
      contentType,
      resumable: false,
      metadata: {
        metadata: {
          firebaseStorageDownloadTokens: token,
        },
      },
    });

    return buildDownloadUrl(bucketName, objectPath, token);
  }

  return ensureTokenizedDownloadUrl(file, bucketName, objectPath);
}

function mapService(row) {
  return {
    docId: row.id,
    data: {
      name: row.name,
      description: row.description,
      displayOrder: row.display_order,
      durationMinutes: row.duration_minutes,
      isActive: row.is_active,
      pricePassageiros: row.price_passageiros,
      priceSuv: row.price_suv,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  };
}

function mapReservation(row) {
  return {
    docId: row.id,
    data: {
      reservationCode: row.reference_code,
      serviceId: row.service_id,
      serviceName: null,
      vehicleType: row.vehicle_type,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      customerEmail: row.customer_email,
      slotStart: row.start_time,
      slotEnd: row.end_time,
      date: String(row.start_time).slice(0, 10),
      status: STATUS_MAP[row.status] || 'pending',
      gdprConsent: row.gdpr_consent,
      notes: row.notes,
      internalNotes: row.internal_notes,
      source: 'legacy-migration',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  };
}

function mapBusinessSetting(row) {
  return {
    docId: row.key,
    data: {
      key: row.key,
      value: row.value,
      updatedAt: row.updated_at,
    },
  };
}

function mapBlockedSlot(row) {
  return {
    docId: row.id,
    data: {
      startTime: row.start_time,
      endTime: row.end_time,
      date: String(row.start_time).slice(0, 10),
      reason: row.reason,
      createdBy: row.created_by,
      createdAt: row.created_at,
    },
  };
}

function mapWorker(row) {
  return {
    docId: row.id,
    data: {
      name: row.name,
      isActive: row.is_active,
      userId: row.user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  };
}

function mapWorkerPresence(row) {
  return {
    docId: `${row.worker_id}_${row.date}`,
    data: {
      workerId: row.worker_id,
      date: row.date,
      isPresent: row.is_present,
      createdAt: row.created_at,
    },
  };
}

function mapCapacityOverride(row) {
  return {
    docId: row.date,
    data: {
      date: row.date,
      maxBookingsPerSlot: row.max_bookings_per_slot,
      createdAt: row.created_at,
    },
  };
}

const ENTITY_CONFIG = [
  {
    key: 'services',
    table: 'services',
    collection: 'services',
    sinceColumn: 'updated_at',
    mapper: mapService,
  },
  {
    key: 'business_settings',
    table: 'business_settings',
    collection: 'business_settings',
    sinceColumn: 'updated_at',
    mapper: mapBusinessSetting,
  },
  {
    key: 'portfolio_items',
    table: 'portfolio_items',
    collection: 'portfolio_items',
    sinceColumn: 'updated_at',
    mapper: (row) => ({
      docId: row.id,
      data: {
        title: row.title,
        description: row.description,
        images: row.images || [],
        tags: row.tags || [],
        isVisible: row.is_visible,
        isBeforeAfter: row.is_before_after,
        beforeImage: row.before_image,
        afterImage: row.after_image,
        displayOrder: row.display_order,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      original: row,
    }),
    migrateStorage: true,
  },
  {
    key: 'reservations',
    table: 'reservations',
    collection: 'reservations',
    sinceColumn: 'updated_at',
    mapper: mapReservation,
  },
  {
    key: 'blocked_slots',
    table: 'blocked_slots',
    collection: 'blocked_slots',
    sinceColumn: 'created_at',
    mapper: mapBlockedSlot,
  },
  {
    key: 'workers',
    table: 'workers',
    collection: 'workers',
    sinceColumn: 'updated_at',
    mapper: mapWorker,
  },
  {
    key: 'worker_presence',
    table: 'worker_presence',
    collection: 'worker_presence',
    sinceColumn: 'created_at',
    mapper: mapWorkerPresence,
  },
  {
    key: 'capacity_overrides',
    table: 'capacity_overrides',
    collection: 'capacity_overrides',
    sinceColumn: 'created_at',
    mapper: mapCapacityOverride,
  },
];

async function fetchSupabaseRows({supabase, table, mode, since, sinceColumn, batchSize}) {
  const rows = [];
  let from = 0;

  for (;;) {
    let query = supabase
      .from(table)
      .select('*')
      .order('id', {ascending: true})
      .range(from, from + batchSize - 1);

    if (mode === 'delta' && since) {
      query = query.gte(sinceColumn, since);
    }

    const {data, error} = await query;
    if (error) {
      throw new Error(`Supabase query failed for ${table}: ${error.message}`);
    }

    if (!data || data.length === 0) break;
    rows.push(...data);

    if (data.length < batchSize) break;
    from += data.length;
  }

  return rows;
}

async function migratePortfolioRowStorage({mapped, original, bucket, bucketName, dryRun, warnings}) {
  const itemId = mapped.docId;
  let migrated = 0;

  const migrateOne = async (url, label, index = 0) => {
    if (!url) return null;
    const fileName = fileNameFromUrl(url);
    const objectPath = `portfolio/${itemId}/legacy-${label}-${index}-${fileName}`;
    try {
      const migratedUrl = await migrateAssetToFirebase({
        url,
        objectPath,
        bucketName,
        bucket,
        dryRun,
      });
      if (migratedUrl !== url) migrated += 1;
      return migratedUrl;
    } catch (error) {
      warnings.push(`portfolio_items/${itemId}: ${error.message}`);
      return url;
    }
  };

  const migratedImages = [];
  for (let i = 0; i < (original.images || []).length; i += 1) {
    const url = original.images[i];
    migratedImages.push(await migrateOne(url, 'image', i));
  }

  const beforeImage = await migrateOne(original.before_image, 'before', 0);
  const afterImage = await migrateOne(original.after_image, 'after', 0);

  mapped.data.images = migratedImages.filter(Boolean);
  mapped.data.beforeImage = beforeImage;
  mapped.data.afterImage = afterImage;
  mapped.data.updatedAt = nowIso();

  return migrated;
}

async function getCollectionCount(firestore, collectionName) {
  const snap = await firestore.collection(collectionName).count().get();
  return Number(snap.data().count || 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const mode = args.mode || 'full';
  if (!['full', 'delta'].includes(mode)) {
    throw new Error(`Invalid --mode value: ${mode}`);
  }

  const since = args.since;
  if (mode === 'delta' && !since) {
    throw new Error('Delta mode requires --since <ISO datetime>.');
  }

  const dryRun = Boolean(args['dry-run']);
  const batchSize = Number(args['batch-size'] || 500);
  const reportDir = args['report-dir'] || 'reports';

  const supabaseUrl = requireEnv('SUPABASE_URL');
  const supabaseServiceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const app = initFirebase();
  const firestore = app.firestore();
  const bucket = app.storage().bucket();
  const bucketName = bucket.name;

  if (!bucketName) {
    throw new Error('Firebase Storage bucket is not configured. Set FIREBASE_STORAGE_BUCKET.');
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {persistSession: false},
  });

  const startedAt = nowIso();
  const report = {
    startedAt,
    finishedAt: null,
    mode,
    since: since || null,
    dryRun,
    bucket: bucketName,
    entities: [],
    totals: {
      sourceRows: 0,
      migratedWrites: 0,
      storageAssetsMigrated: 0,
      warnings: 0,
    },
  };

  for (const entity of ENTITY_CONFIG) {
    const warnings = [];
    const rows = await fetchSupabaseRows({
      supabase,
      table: entity.table,
      mode,
      since,
      sinceColumn: entity.sinceColumn,
      batchSize,
    });

    let writes = 0;
    let storageAssetsMigrated = 0;

    for (const row of rows) {
      const mapped = entity.mapper(row);

      if (entity.migrateStorage) {
        storageAssetsMigrated += await migratePortfolioRowStorage({
          mapped,
          original: mapped.original,
          bucket,
          bucketName,
          dryRun,
          warnings,
        });
      }

      if (!dryRun) {
        await firestore.collection(entity.collection).doc(mapped.docId).set(mapped.data, {merge: true});
      }
      writes += 1;
    }

    const targetCount = dryRun ? null : await getCollectionCount(firestore, entity.collection);

    report.entities.push({
      key: entity.key,
      table: entity.table,
      collection: entity.collection,
      sourceRows: rows.length,
      migratedWrites: writes,
      targetCount,
      storageAssetsMigrated,
      warnings,
    });

    report.totals.sourceRows += rows.length;
    report.totals.migratedWrites += writes;
    report.totals.storageAssetsMigrated += storageAssetsMigrated;
    report.totals.warnings += warnings.length;
  }

  report.finishedAt = nowIso();

  await fs.mkdir(reportDir, {recursive: true});
  const reportPath = path.join(reportDir, `migration-report-${Date.now()}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('Migration finished successfully.');
  console.log(`Mode: ${mode}${since ? ` (since ${since})` : ''}${dryRun ? ' [dry-run]' : ''}`);
  console.log(`Report: ${reportPath}`);
  console.log(`Source rows: ${report.totals.sourceRows}`);
  console.log(`Writes: ${report.totals.migratedWrites}`);
  console.log(`Storage assets migrated: ${report.totals.storageAssetsMigrated}`);
  console.log(`Warnings: ${report.totals.warnings}`);

  if (report.totals.warnings > 0) {
    console.log('Review warnings in the report before cutover.');
  }
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
