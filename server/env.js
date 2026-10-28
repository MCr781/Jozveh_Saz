import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Lightweight, zero-dependency .env loader that removes Windows CRLF (\r)
 * and leading/trailing whitespace from all environment variables.
 */
export function loadEnvFile(customPath = null) {
  const candidatePaths = [
    customPath,
    path.resolve(__dirname, '../.env'),
    path.resolve(process.cwd(), '.env')
  ].filter(Boolean);

  let envPath = null;
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      envPath = p;
      break;
    }
  }

  if (envPath) {
    try {
      const content = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        val = val.replace(/\r/g, '').trim();
        if (process.env[key] === undefined) {
          process.env[key] = val;
        } else if (typeof process.env[key] === 'string') {
          process.env[key] = process.env[key].replace(/\r/g, '').trim();
        }
      }
    } catch (err) {
      console.warn('⚠️ Warning: failed to read .env file:', err.message);
    }
  }

  // Ensure any pre-existing environment variables are also stripped of carriage returns
  for (const [key, val] of Object.entries(process.env)) {
    if (typeof val === 'string' && val.includes('\r')) {
      process.env[key] = val.replace(/\r/g, '').trim();
    }
  }
}

/**
 * Helper to get a trimmed environment variable with optional fallback.
 */
export function getEnv(key, fallback = '') {
  const val = process.env[key];
  if (val === undefined || val === null) return fallback;
  return String(val).replace(/\r/g, '').trim();
}

// Automatically execute upon initial import
loadEnvFile();
