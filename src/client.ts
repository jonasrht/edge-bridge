import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST, PORT, readToken } from './config.ts';

const BASE = `http://${HOST}:${PORT}`;

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    const j = (await r.json()) as { service?: string };
    return j.service === 'edge-bridge';
  } catch {
    return false;
  }
}

export async function ensureDaemon(): Promise<void> {
  if (await healthy()) return;
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'daemon.ts');
  spawn(process.execPath, [script], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await healthy()) return;
  }
  throw new Error(`edge-bridge daemon antwortet nicht auf ${BASE}`);
}

export async function call(action: string, args: Record<string, unknown> = {}, profile?: string): Promise<unknown> {
  await ensureDaemon();
  const r = await fetch(`${BASE}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readToken()}` },
    body: JSON.stringify({ action, args, profile }),
  });
  const j = (await r.json()) as { ok: boolean; data?: unknown; error?: { message: string } };
  if (!j.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j.data;
}
