// scripts/backup.js
// Production-grade encrypted backup for SQLite database:
// VACUUM snapshot -> gzip -> AES-256-GCM -> optional Telegram sendDocument.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('JZBK'); // Jozveh Backup magic header
const VERSION = 1;

/**
 * Creates an encrypted, gzipped snapshot of a SQLite database.
 */
export async function createEncryptedBackup({
  dbPath = process.env.STATE_DB_PATH || path.resolve(process.cwd(), 'server/jozveh.db'),
  backupKey = process.env.BACKUP_KEY,
  outputPath = null,
  sendToAdmin = false,
  botToken = process.env.BOT_TOKEN,
  adminChatId = process.env.ADMIN_CHAT_ID
} = {}) {
  if (!backupKey) {
    throw new Error('BACKUP_KEY is required for creating an encrypted backup');
  }

  const resolvedDbPath = path.resolve(dbPath);
  if (!fs.existsSync(resolvedDbPath)) {
    throw new Error(`Database file not found at: ${resolvedDbPath}`);
  }

  if (!outputPath) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    outputPath = path.resolve(process.cwd(), 'backups', `backup-${timestamp}.enc`);
  } else {
    outputPath = path.resolve(outputPath);
  }

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // 1. Take a clean, atomic snapshot via VACUUM INTO
  const tempSnapshot = path.join(os.tmpdir(), `jozveh_snap_${crypto.randomUUID()}.db`);
  try {
    const srcDb = new DatabaseSync(resolvedDbPath, { readOnly: true });
    // SQLite string literal escaping (single quote doubled)
    const escapedTemp = tempSnapshot.replace(/'/g, "''");
    srcDb.exec(`VACUUM INTO '${escapedTemp}'`);
    srcDb.close();

    const snapshotBytes = fs.readFileSync(tempSnapshot);

    // 2. Gzip compress snapshot
    const compressed = zlib.gzipSync(snapshotBytes, { level: 9 });

    // 3. Encrypt with AES-256-GCM
    const key = crypto.createHash('sha256').update(String(backupKey)).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const tag = cipher.getAuthTag(); // 16 bytes

    // File structure: [MAGIC(4)] + [VERSION(1)] + [IV(12)] + [TAG(16)] + [CIPHERTEXT]
    const backupData = Buffer.concat([
      MAGIC,
      Buffer.from([VERSION]),
      iv,
      tag,
      ciphertext
    ]);

    fs.writeFileSync(outputPath, backupData);

    // 4. Optionally upload to Telegram admin chat
    let telegramResult = null;
    if (sendToAdmin && botToken && adminChatId) {
      const form = new FormData();
      form.append('chat_id', String(adminChatId));
      form.append('caption', `📦 Jozveh Backup: ${path.basename(outputPath)} (${(backupData.length / 1024).toFixed(1)} KB)`);
      form.append('document', new Blob([backupData], { type: 'application/octet-stream' }), path.basename(outputPath));

      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
        method: 'POST',
        body: form
      });
      telegramResult = await res.json().catch(() => null);
    }

    return {
      ok: true,
      outputPath,
      bytes: backupData.length,
      uncompressedBytes: snapshotBytes.length,
      telegram: telegramResult
    };
  } finally {
    if (fs.existsSync(tempSnapshot)) {
      try { fs.unlinkSync(tempSnapshot); } catch (_) {}
    }
  }
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  let dbPath = process.env.STATE_DB_PATH;
  let outputPath = null;
  let backupKey = process.env.BACKUP_KEY;
  let sendToAdmin = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db' && args[i + 1]) { dbPath = args[++i]; }
    else if (args[i] === '--out' && args[i + 1]) { outputPath = args[++i]; }
    else if (args[i] === '--key' && args[i + 1]) { backupKey = args[++i]; }
    else if (args[i] === '--send-telegram') { sendToAdmin = true; }
  }

  createEncryptedBackup({ dbPath, backupKey, outputPath, sendToAdmin })
    .then((result) => {
      console.log(`[BACKUP SUCCESS] Saved to ${result.outputPath} (${result.bytes} bytes)`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[BACKUP ERROR] ${err.message}`);
      process.exit(1);
    });
}
