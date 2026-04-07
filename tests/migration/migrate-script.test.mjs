import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'migrate-supabase-to-firebase.mjs');

function runScript(args = [], envOverrides = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      env: {...process.env, ...envOverrides},
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('close', (code) => {
      resolve({code, stdout, stderr});
    });
  });
}

test('migration script prints help and exits 0', async () => {
  const result = await runScript(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: node scripts\/migrate-supabase-to-firebase\.mjs/);
});

test('migration script fails fast when required env vars are missing', async () => {
  const result = await runScript(['--mode=full', '--dry-run'], {
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Missing required env var: SUPABASE_URL/);
});
