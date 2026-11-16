import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.EDGE_BRIDGE_PORT ?? 10087);
export const HOME_DIR = path.join(os.homedir(), '.edge-bridge');
export const TOKEN_FILE = path.join(HOME_DIR, 'token');
export const SHOTS_DIR = path.join(HOME_DIR, 'shots');
export const EDGE_LOCAL_STATE =
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Application Support/Microsoft Edge/Local State')
    : process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'Microsoft/Edge/User Data/Local State')
      : path.join(os.homedir(), '.config/microsoft-edge/Local State');

export const EXTENSION_IDS = new Set(
  (process.env.EDGE_BRIDGE_EXTENSION_IDS ?? 'kfjjmfgccekckgnegnjdbbloopmjdidk').split(',').map((s) => s.trim()),
);

export function ensureDirs(): void {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SHOTS_DIR, { recursive: true, mode: 0o700 });
}

export function loadOrCreateToken(): string {
  ensureDirs();
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {}
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  return token;
}

export function readToken(): string {
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
}
