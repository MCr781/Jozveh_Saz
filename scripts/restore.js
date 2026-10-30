// scripts/restore.js
// Production-grade encrypted restore for SQLite database:
// Decrypt AES-256-GCM -> gunzip -> PRAGMA integrity_check -> atomicity guard.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('JZBK');
const VERSION = 1;

/**
 * Restores an encrypted, gzipped SQLite backup file to target path and validates integrity.
 */
export async function restoreEncryptedBackup({
  inputPath,
  backupKey = process.env.BACKUP_KEY,
  outputPath = process.env.STATE_DB_PATH || path.resolve(process.cwd(), 'server/jozveh.db')
} = {}) {
  if (!inputPath) {
    throw new Error('inputPath is required for restore');
  }
  if (!backupKey) {
    const fallbackToken = (process.env.BOT_TOKEN || '').trim();
    if (fallbackToken) {
      backupKey = crypto.createHmac('sha256', fallbackToken).update('JozvehBackupKey').digest('hex');
    } else {
      throw new Error('BACKUP_KEY is required for decrypting the backup');
    }
  }

  const resolvedInputPath = path.resolve(inputPath);
  if (!fs.existsSync(resolvedInputPath)) {
    throw new Error(`Backup file not found at: ${resolvedInputPath}`);
  }

  const resolvedOutputPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });

  const backupData = fs.readFileSync(resolvedInputPath);
  if (backupData.length < 33) {
    throw new Error('Backup file is truncated or corrupted (less than header size)');
  }

  // 1. Verify Magic Header & Version
  const magic = backupData.subarray(0, 4);
  if (!magic.equals(MAGIC)) {
    throw new Error(`Invalid backup file header: expected JZBK, got ${magic.toString('utf8')}`);
  }

  const fileVersion = backupData[4];
  if (fileVersion !== VERSION) {
    throw new Error(`Unsupported backup format version: ${fileVersion} (expected ${VERSION})`);
  }

  const iv = backupData.subarray(5, 17);   // 12 bytes
  const tag = backupData.subarray(17, 33); // 16 bytes
  const ciphertext = backupData.subarray(33);

  // 2. Decrypt with AES-256-GCM
  const key = crypto.createHash('sha256').update(String(backupKey)).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  let compressed;
  try {
    compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new Error(`Decryption failed: invalid key or corrupted backup data (${err.message})`);
  }

  // 3. Decompress snapshot
  let decompressedDbBytes;
  try {
    decompressedDbBytes = zlib.gunzipSync(compressed);
  } catch (err) {
    throw new Error(`Decompression failed: ${err.message}`);
  }

  // 4. Write to temp file and verify SQLite integrity check
  const tempRestorePath = path.join(os.tmpdir(), `jozveh_restore_${crypto.randomUUID()}.db`);
  try {
    fs.writeFileSync(tempRestorePath, decompressedDbBytes);

    const testDb = new DatabaseSync(tempRestorePath, { readOnly: true });
    const integrityRow = testDb.prepare('PRAGMA integrity_check').get();
    testDb.close();

    if (!integrityRow || integrityRow.integrity_check !== 'ok') {
      throw new Error(`Restored database failed integrity check: ${JSON.stringify(integrityRow)}`);
    }

    // 5. Replace destination database atomically
    // If destination has active WAL files, unlink them to avoid stale journal conflicts
    try {
      if (fs.existsSync(resolvedOutputPath + '-wal')) fs.unlinkSync(resolvedOutputPath + '-wal');
      if (fs.existsSync(resolvedOutputPath + '-shm')) fs.unlinkSync(resolvedOutputPath + '-shm');
    } catch (_) {}

    fs.copyFileSync(tempRestorePath, resolvedOutputPath);

    return {
      ok: true,
      outputPath: resolvedOutputPath,
      integrity: 'ok',
      bytes: decompressedDbBytes.length
    };
  } finally {
    if (fs.existsSync(tempRestorePath)) {
      try { fs.unlinkSync(tempRestorePath); } catch (_) {}
    }
  }
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  let inputPath = null;
  let outputPath = process.env.STATE_DB_PATH;
  let backupKey = process.env.BACKUP_KEY;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--in' && args[i + 1]) { inputPath = args[++i]; }
    else if (args[i] === '--out' && args[i + 1]) { outputPath = args[++i]; }
    else if (args[i] === '--key' && args[i + 1]) { backupKey = args[++i]; }
  }

  if (!inputPath) {
    console.error('Usage: node scripts/restore.js --in <backup-file.enc> [--out <dest.db>] [--key <secret>]');
    process.exit(1);
  }

  restoreEncryptedBackup({ inputPath, outputPath, backupKey })
    .then((result) => {
      console.log(`[RESTORE SUCCESS] Database restored to ${result.outputPath} (integrity: ${result.integrity})`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[RESTORE ERROR] ${err.message}`);
      process.exit(1);
    });
}
