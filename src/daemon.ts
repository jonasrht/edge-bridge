import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { HOST, PORT, SHOTS_DIR, EDGE_LOCAL_STATE, EXTENSION_IDS, loadOrCreateToken } from './config.ts';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

type Ext = {
  ws: WebSocket;
  instanceId: string;
  customLabel: string | null;
  email: string | null;
  profileDir: string | null;
  profileName: string | null;
  version: string;
  userAgent: string;
  connectedAt: number;
  alive: boolean;
  pending: Map<string, Pending>;
};

const token = loadOrCreateToken();
const exts = new Map<string, Ext>();

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

function edgeProfileForEmail(email: string | null): { dir: string; name: string } | null {
  if (!email) return null;
  try {
    const state = JSON.parse(fs.readFileSync(EDGE_LOCAL_STATE, 'utf8'));
    const cache: Record<string, { name?: string; user_name?: string }> = state?.profile?.info_cache ?? {};
    for (const [dir, info] of Object.entries(cache)) {
      if (info.user_name && info.user_name.toLowerCase() === email.toLowerCase()) return { dir, name: info.name ?? dir };
    }
  } catch {}
  return null;
}

function labelOf(e: Ext): string {
  return e.customLabel || e.profileName || e.email || `profil-${e.instanceId.slice(0, 6)}`;
}

function describe(e: Ext) {
  return {
    profile: labelOf(e),
    instanceId: e.instanceId,
    customLabel: e.customLabel,
    edgeProfileName: e.profileName,
    edgeProfileDir: e.profileDir,
    email: e.email,
    extensionVersion: e.version,
    connectedSince: new Date(e.connectedAt).toISOString(),
  };
}

function findExt(profile: unknown): Ext {
  const list = [...exts.values()];
  if (list.length === 0) {
    throw new Error('No Edge profile connected. Is Edge running, and is the Edge Bridge extension installed and enabled in the profile?');
  }
  if (profile == null || profile === '') {
    if (list.length === 1) return list[0];
    throw new Error(`Several profiles connected, pass "profile": ${list.map(labelOf).join(', ')}`);
  }
  const q = String(profile).toLowerCase();
  const keys = (e: Ext) =>
    [labelOf(e), e.customLabel, e.profileName, e.profileDir, e.email].filter(Boolean).map((s) => String(s).toLowerCase());
  const exact = list.filter((e) => keys(e).includes(q) || (q.length >= 4 && e.instanceId.startsWith(q)));
  if (exact.length === 1) return exact[0];
  const partial = list.filter((e) => keys(e).some((k) => k.includes(q)));
  if (partial.length === 1) return partial[0];
  const hits = exact.length > 1 ? exact : partial;
  if (hits.length > 1) throw new Error(`"${profile}" is ambiguous: ${hits.map(labelOf).join(', ')}`);
  throw new Error(`Profile "${profile}" is not connected. Connected: ${list.map(labelOf).join(', ')}`);
}

function send(e: Ext, action: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      e.pending.delete(id);
      reject(new Error(`"${action}" timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    e.pending.set(id, { resolve, reject, timer });
    e.ws.send(JSON.stringify({ type: 'command', id, action, args }));
  });
}

function saveShot(data: { base64: string; mimeType: string }): string {
  const ext = data.mimeType === 'image/png' ? 'png' : 'jpg';
  const file = path.join(SHOTS_DIR, `shot-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
  fs.writeFileSync(file, Buffer.from(data.base64, 'base64'), { mode: 0o600 });
  return file;
}

function pruneShots(): void {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const f of fs.readdirSync(SHOTS_DIR)) {
    const p = path.join(SHOTS_DIR, f);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {}
  }
}

async function runCommand(body: { profile?: unknown; action?: unknown; args?: unknown }): Promise<unknown> {
  const action = String(body.action ?? '');
  if (!action) throw new Error('"action" fehlt');
  if (action === 'list_profiles') return [...exts.values()].map(describe);
  const args = (body.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>;
  const e = findExt(body.profile);
  const waitMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 0;
  const result = (await send(e, action, args, Math.max(60_000, waitMs + 15_000))) as Record<string, unknown> | null;
  if (result && typeof result === 'object' && typeof result.base64 === 'string') {
    const { base64, mimeType, ...rest } = result as { base64: string; mimeType: string };
    return { ...rest, mimeType, path: saveShot({ base64, mimeType }), profile: labelOf(e) };
  }
  return result;
}

function authorized(req: http.IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
  const want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function hostOk(req: http.IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  return host === `${HOST}:${PORT}` || host === `localhost:${PORT}`;
}

function reply(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok: true, service: 'edge-bridge' });
  // Browsers always send Origin on cross-origin requests; refusing it stops web pages from driving the daemon.
  if (!hostOk(req) || req.headers.origin || !authorized(req)) {
    return reply(res, 403, { ok: false, error: { message: 'forbidden' } });
  }
  try {
    if (req.method === 'GET' && url.pathname === '/profiles') {
      return reply(res, 200, { ok: true, data: [...exts.values()].map(describe) });
    }
    if (req.method === 'POST' && url.pathname === '/command') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      const data = await runCommand(body);
      return reply(res, 200, { ok: true, data });
    }
    reply(res, 404, { ok: false, error: { message: 'not found' } });
  } catch (err) {
    reply(res, 200, { ok: false, error: { message: err instanceof Error ? err.message : String(err) } });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin ?? '';
  const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  if (new URL(req.url ?? '/', `http://${HOST}`).pathname !== '/ext' || !m || !EXTENSION_IDS.has(m[1]) || !hostOk(req)) {
    log('rejected ws upgrade from', origin || '(no origin)');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => onExtension(ws));
});

function onExtension(ws: WebSocket): void {
  let ext: Ext | null = null;
  ws.on('pong', () => {
    if (ext) ext.alive = true;
  });
  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      const instanceId = String(msg.instanceId ?? '');
      if (!instanceId) return ws.close();
      const email = typeof msg.email === 'string' && msg.email ? msg.email : null;
      const prof = edgeProfileForEmail(email);
      const previous = exts.get(instanceId);
      if (previous && previous.ws !== ws) previous.ws.terminate();
      ext = {
        ws,
        instanceId,
        customLabel: typeof msg.label === 'string' && msg.label.trim() ? msg.label.trim() : null,
        email,
        profileDir: prof?.dir ?? null,
        profileName: prof?.name ?? null,
        version: String(msg.version ?? '?'),
        userAgent: String(msg.userAgent ?? ''),
        connectedAt: previous?.ws === ws ? previous.connectedAt : Date.now(),
        alive: true,
        pending: previous?.ws === ws ? previous.pending : new Map(),
      };
      exts.set(instanceId, ext);
      log('profile connected:', labelOf(ext), instanceId);
      ws.send(JSON.stringify({ type: 'welcome', profile: labelOf(ext) }));
      return;
    }
    if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
    if (msg.type === 'result' && ext) {
      const p = ext.pending.get(String(msg.id));
      if (!p) return;
      ext.pending.delete(String(msg.id));
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(String((msg.error as { message?: string })?.message ?? msg.error ?? 'Extension error')));
    }
  });
  ws.on('close', () => {
    if (!ext) return;
    for (const p of ext.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection to the profile was lost'));
    }
    if (exts.get(ext.instanceId)?.ws === ws) {
      exts.delete(ext.instanceId);
      log('profile disconnected:', labelOf(ext));
    }
  });
}

setInterval(() => {
  for (const e of exts.values()) {
    if (!e.alive) {
      e.ws.terminate();
      continue;
    }
    e.alive = false;
    e.ws.ping();
  }
  pruneShots();
}, 30_000).unref();

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log(`port ${PORT} already in use – is another edge-bridge daemon running?`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, HOST, () => log(`edge-bridge daemon listening on ${HOST}:${PORT}`));
