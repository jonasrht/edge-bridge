import { pageAgent } from './page-agent.js';
import { agentOverlay } from './overlay.js';

const WS_URL = 'ws://127.0.0.1:10087/ext';
const VERSION = chrome.runtime.getManifest().version;
const IDLE_DETACH_MS = 120_000;
const BLOCKED_URL = /^(edge|chrome|about|devtools|chrome-extension|extension|view-source):|^https:\/\/(microsoftedge\.microsoft\.com\/addons|chromewebstore\.google\.com)/;

let ws = null;
let retryDelay = 1000;
let retryTimer = null;
let pingTimer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function settings() {
  const s = await chrome.storage.local.get(['instanceId', 'label', 'enabled', 'tabMode']);
  if (!s.instanceId) {
    s.instanceId = crypto.randomUUID();
    await chrome.storage.local.set({ instanceId: s.instanceId });
  }
  return { instanceId: s.instanceId, label: s.label || '', enabled: s.enabled !== false, tabMode: s.tabMode === 'window' ? 'window' : 'group' };
}

async function getState() {
  return chrome.storage.session.get(['currentTabId', 'agentWindowId', 'agentGroupId']);
}

async function setState(patch) {
  await chrome.storage.session.set(patch);
}

async function profileEmail() {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    return info?.email || null;
  } catch {
    return null;
  }
}

async function setStatus(status, profile) {
  await chrome.storage.session.set({ status, profile: profile ?? null });
  await chrome.action.setBadgeText({ text: status === 'connected' ? '' : 'aus' });
  await chrome.action.setBadgeBackgroundColor({ color: '#8a8a8a' });
}

async function hello(sock) {
  const s = await settings();
  sock.send(
    JSON.stringify({
      type: 'hello',
      instanceId: s.instanceId,
      label: s.label || null,
      email: await profileEmail(),
      version: VERSION,
      userAgent: navigator.userAgent,
    }),
  );
}

let connecting = false;

async function connect() {
  if (connecting || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
  connecting = true;
  try {
    await openSocket();
  } finally {
    connecting = false;
  }
}

async function openSocket() {
  const s = await settings();
  if (!s.enabled) return setStatus('disabled');
  clearTimeout(retryTimer);
  let sock;
  try {
    sock = new WebSocket(WS_URL);
  } catch {
    return scheduleRetry();
  }
  ws = sock;
  sock.onopen = () => {
    retryDelay = 1000;
    hello(sock);
    clearInterval(pingTimer);
    pingTimer = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('{"type":"ping"}'), 20_000);
  };
  sock.onmessage = (ev) => onMessage(sock, ev.data);
  sock.onclose = () => {
    if (ws === sock) ws = null;
    clearInterval(pingTimer);
    settings().then((s2) => setStatus(s2.enabled ? 'disconnected' : 'disabled'));
    scheduleRetry();
  };
  sock.onerror = () => {};
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 10_000);
}

async function onMessage(sock, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === 'welcome') return setStatus('connected', msg.profile);
  if (msg.type !== 'command') return;
  const respond = (payload) => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ type: 'result', id: msg.id, ...payload }));
  const fn = actions[msg.action];
  if (!fn) return respond({ ok: false, error: { message: `Unbekannte Aktion "${msg.action}"` } });
  try {
    respond({ ok: true, data: await fn(msg.args || {}) });
  } catch (err) {
    respond({ ok: false, error: { message: err?.message || String(err) } });
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled) {
    if (changes.enabled.newValue === false) {
      clearTimeout(retryTimer);
      ws?.close();
      setStatus('disabled');
    } else connect();
  }
  if (changes.label && ws?.readyState === WebSocket.OPEN) hello(ws);
});

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === 'keepalive' && connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// --- debugger ---

const attached = new Map();

chrome.debugger.onDetach.addListener((src) => {
  clearTimeout(attached.get(src.tabId));
  attached.delete(src.tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  attached.delete(tabId);
  const st = await getState();
  if (st.currentTabId === tabId) await setState({ currentTabId: null });
});

function touchDebugger(tabId) {
  clearTimeout(attached.get(tabId));
  attached.set(
    tabId,
    setTimeout(() => {
      attached.delete(tabId);
      chrome.debugger.detach({ tabId }).catch(() => {});
    }, IDLE_DETACH_MS),
  );
}

async function cdp(tabId, method, params = {}) {
  if (!attached.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (err) {
      if (!/already attached/i.test(err.message)) throw err;
      try {
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' });
      } catch {
        throw new Error('An diesem Tab hängt schon ein anderer Debugger (DevTools oder eine andere KI-Erweiterung). Bitte dort beenden.');
      }
    }
  }
  touchDebugger(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function withTimeout(promise, ms, msg) {
  return Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(msg)))]);
}

// --- tabs ---

function tabInfo(t, st = {}) {
  return {
    tabId: t.id,
    windowId: t.windowId,
    url: t.url,
    title: t.title,
    active: t.active,
    agent: t.windowId === st.agentWindowId || (st.agentGroupId != null && t.groupId === st.agentGroupId),
    current: t.id === st.currentTabId,
  };
}

async function tryTab(tabId) {
  if (tabId == null) return null;
  return chrome.tabs.get(Number(tabId)).catch(() => null);
}

async function resolveTab(args) {
  const st = await getState();
  const tab = await tryTab(args.tabId ?? st.currentTabId);
  if (!tab) throw new Error('Kein aktueller Tab. Erst navigate (öffnet einen Tab) oder select_tab aufrufen.');
  if (args.tabId != null && args.tabId !== st.currentTabId) await setState({ currentTabId: tab.id });
  if (tab.url && BLOCKED_URL.test(tab.url)) throw new Error(`Auf ${tab.url} dürfen Erweiterungen nicht zugreifen.`);
  return tab;
}

async function waitForLoad(tabId, timeout = 30_000) {
  const start = Date.now();
  let seenLoading = false;
  while (Date.now() - start < timeout) {
    const t = await tryTab(tabId);
    if (!t) return null;
    if (t.status === 'loading') seenLoading = true;
    else if (t.status === 'complete' && (seenLoading || Date.now() - start > 1500)) return t;
    await sleep(150);
  }
  return tryTab(tabId);
}

async function settle(tabId, before) {
  await sleep(350);
  let t = await tryTab(tabId);
  if (t?.status === 'loading') t = await waitForLoad(tabId, 15_000);
  if (!t) return { tabClosed: true };
  return { url: t.url, title: t.title, navigated: before ? t.url !== before.url : undefined };
}

async function openAgentTab(url) {
  const st = await getState();
  const { tabMode } = await settings();
  if (tabMode === 'window') {
    const win = st.agentWindowId != null ? await chrome.windows.get(st.agentWindowId).catch(() => null) : null;
    if (win) return chrome.tabs.create({ windowId: win.id, url, active: true });
    const w = await chrome.windows.create({ url, focused: false, width: 1280, height: 900 });
    await setState({ agentWindowId: w.id });
    return w.tabs[0];
  }
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (!win) {
    const w = await chrome.windows.create({ url, focused: true });
    return w.tabs[0];
  }
  const tab = await chrome.tabs.create({ windowId: win.id, url, active: true });
  const group = st.agentGroupId != null ? await chrome.tabGroups.get(st.agentGroupId).catch(() => null) : null;
  if (group && group.windowId === win.id) {
    await chrome.tabs.group({ tabIds: tab.id, groupId: group.id });
  } else {
    const groupId = await chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId: win.id } });
    await chrome.tabGroups.update(groupId, { title: 'Agent', color: 'blue' });
    await setState({ agentGroupId: groupId });
  }
  await chrome.windows.update(win.id, { focused: true });
  return tab;
}

function normalizeUrl(url) {
  const u = String(url || '').trim();
  if (!u) throw new Error('"url" fehlt');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^(about|data|blob|mailto|file):/i.test(u)) return u;
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|[a-z0-9-]+(:\d+)?(\/|$))/i.test(u)) return `http://${u}`;
  return `https://${u}`;
}

// --- page helpers ---

async function inPage(tabId, cmd, args = {}) {
  let res;
  try {
    [res] = await chrome.scripting.executeScript({ target: { tabId }, func: pageAgent, args: [cmd, args] });
  } catch (err) {
    if (/error page/i.test(err.message)) throw new Error('Der Tab zeigt eine Fehlerseite (Adresse nicht erreichbar?).');
    if (/Cannot access|must request permission/i.test(err.message)) throw new Error('Auf diese Seite darf die Erweiterung nicht zugreifen.');
    throw err;
  }
  const r = res?.result;
  if (r && r.__error) throw new Error(r.__error);
  return r;
}

async function overlay(tabId, cmd, args = {}) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: agentOverlay, args: [cmd, args] });
  } catch {}
}

const indicate = (tabId, label, extra = {}) => overlay(tabId, 'show', { label, ...extra });

const quote = (s) => `„${String(s ?? '').slice(0, 60)}“`;

async function pointAt(tabId, info, label, click = true) {
  await indicate(tabId, label, { x: info.x, y: info.y, click });
  await sleep(300);
}

async function mouseClick(tabId, x, y, { button = 'left', clickCount = 1 } = {}) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let i = 1; i <= clickCount; i++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i });
  }
}

const KEYS = {
  Enter: [13, 'Enter', '\r'],
  Tab: [9, 'Tab'],
  Escape: [27, 'Escape'],
  Backspace: [8, 'Backspace'],
  Delete: [46, 'Delete'],
  ArrowLeft: [37, 'ArrowLeft'],
  ArrowUp: [38, 'ArrowUp'],
  ArrowRight: [39, 'ArrowRight'],
  ArrowDown: [40, 'ArrowDown'],
  Home: [36, 'Home'],
  End: [35, 'End'],
  PageUp: [33, 'PageUp'],
  PageDown: [34, 'PageDown'],
  Space: [32, 'Space', ' '],
};
for (let i = 1; i <= 12; i++) KEYS[`F${i}`] = [111 + i, `F${i}`];
const KEY_ALIASES = { esc: 'Escape', return: 'Enter', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ' ': 'Space' };
const MOD_BITS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const MAC_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };

function parseKey(combo) {
  const parts = String(combo).split('+');
  let keyName = parts.pop();
  if (keyName === '' && parts.length) keyName = '+';
  let modifiers = 0;
  for (const p of parts) {
    const bit = MOD_BITS[p.trim().toLowerCase()];
    if (!bit) throw new Error(`Unbekannte Modifikatortaste "${p}"`);
    modifiers |= bit;
  }
  keyName = KEY_ALIASES[keyName.toLowerCase()] || keyName;
  const special = KEYS[keyName] || Object.entries(KEYS).find(([k]) => k.toLowerCase() === keyName.toLowerCase())?.[1];
  if (special) {
    const [kc, code, text] = special;
    return { modifiers, key: code === 'Space' ? ' ' : code, code, windowsVirtualKeyCode: kc, text };
  }
  if (keyName.length !== 1) throw new Error(`Unbekannte Taste "${keyName}"`);
  const ch = modifiers & 8 ? keyName.toUpperCase() : keyName;
  const upper = keyName.toUpperCase();
  const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(keyName) ? `Digit${keyName}` : undefined;
  return { modifiers, key: ch, code, windowsVirtualKeyCode: /[A-Z0-9]/.test(upper) ? upper.charCodeAt(0) : undefined, text: ch };
}

async function pressKey(tabId, combo) {
  const k = parseKey(combo);
  const typesText = k.text && !(k.modifiers & (2 | 4 | 1));
  const down = {
    type: typesText ? 'keyDown' : 'rawKeyDown',
    modifiers: k.modifiers,
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.windowsVirtualKeyCode,
  };
  if (typesText) {
    down.text = k.text;
    down.unmodifiedText = k.text;
  }
  if (k.modifiers & 4) {
    const cmd = MAC_COMMANDS[k.key.toLowerCase()];
    if (cmd === 'undo' && k.modifiers & 8) down.commands = ['redo'];
    else if (cmd) down.commands = [cmd];
  }
  await cdp(tabId, 'Input.dispatchKeyEvent', down);
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: k.modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
}

function target(args) {
  return { ref: args.ref, selector: args.selector };
}

async function captureScreenshot(tabId, params) {
  try {
    return await withTimeout(cdp(tabId, 'Page.captureScreenshot', params), 8000, 'timeout');
  } catch {
    await chrome.tabs.update(tabId, { active: true });
    await sleep(300);
    return withTimeout(cdp(tabId, 'Page.captureScreenshot', params), 15_000, 'Screenshot nicht möglich (Fenster minimiert?)');
  }
}

// --- actions ---

const actions = {
  async reload_extension() {
    setTimeout(() => chrome.runtime.reload(), 200);
    return { reloading: true, version: VERSION };
  },

  async list_tabs({ agentOnly = false }) {
    const st = await getState();
    const tabs = await chrome.tabs.query({});
    return tabs.filter((t) => !agentOnly || tabInfo(t, st).agent).map((t) => tabInfo(t, st));
  },

  async navigate({ url, newTab = false, tabId }) {
    url = normalizeUrl(url);
    const st = await getState();
    let tab = newTab ? null : await tryTab(tabId ?? st.currentTabId);
    if (tab) await chrome.tabs.update(tab.id, { url });
    else tab = await openAgentTab(url);
    await setState({ currentTabId: tab.id });
    const t = (await waitForLoad(tab.id)) || tab;
    let host = url;
    try {
      host = new URL(t.url || url).host;
    } catch {}
    await indicate(t.id, `öffnet ${host}`);
    return { tabId: t.id, url: t.url, title: t.title, status: t.status };
  },

  async select_tab({ tabId, active, url }) {
    let tab = null;
    if (tabId != null) tab = await tryTab(tabId);
    else if (active) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    else if (url) {
      const all = await chrome.tabs.query({});
      tab = all.find((t) => t.url === url) || all.find((t) => t.url?.includes(url));
    }
    if (!tab) throw new Error('Tab nicht gefunden');
    await setState({ currentTabId: tab.id });
    return tabInfo(tab, await getState());
  },

  async close_tab({ tabId }) {
    const tab = await resolveTab({ tabId });
    await chrome.tabs.remove(tab.id);
    return { closed: tab.id };
  },

  async history({ direction = 'back', tabId }) {
    const tab = await resolveTab({ tabId });
    if (direction === 'back') await chrome.tabs.goBack(tab.id);
    else if (direction === 'forward') await chrome.tabs.goForward(tab.id);
    else if (direction === 'reload') await chrome.tabs.reload(tab.id);
    else throw new Error('direction muss back, forward oder reload sein');
    const t = await waitForLoad(tab.id);
    return { url: t?.url, title: t?.title };
  },

  async snapshot({ tabId, maxChars = 40_000 }) {
    const tab = await resolveTab({ tabId });
    const text = await inPage(tab.id, 'snapshot', { maxChars });
    return { tabId: tab.id, text };
  },

  async get_text({ tabId, maxChars = 30_000 }) {
    const tab = await resolveTab({ tabId });
    return { tabId: tab.id, ...(await inPage(tab.id, 'text', { maxChars })) };
  },

  async click(args) {
    const tab = await resolveTab(args);
    let x = args.x;
    let y = args.y;
    let info = null;
    if (args.ref || args.selector) {
      info = await inPage(tab.id, 'locate', target(args));
      x = info.x;
      y = info.y;
    } else if (typeof x !== 'number' || typeof y !== 'number') throw new Error('ref, selector oder x/y angeben');
    await pointAt(tab.id, { x, y }, `klickt ${info ? quote(info.name) : 'hier'}`);
    await mouseClick(tab.id, x, y, { button: args.button || 'left', clickCount: args.doubleClick ? 2 : 1 });
    const after = await settle(tab.id, tab);
    return { clicked: info?.label ?? `(${x}, ${y})`, warning: info?.covered ? `Element war verdeckt von ${info.covered}` : undefined, ...after };
  },

  async hover(args) {
    const tab = await resolveTab(args);
    const info = await inPage(tab.id, 'locate', target(args));
    await pointAt(tab.id, info, `zeigt auf ${quote(info.name)}`, false);
    await cdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y });
    await sleep(300);
    return { hovered: info.label };
  },

  async type(args) {
    const tab = await resolveTab(args);
    let label = '(fokussiertes Element)';
    if (args.ref || args.selector) {
      const info = await inPage(tab.id, 'locate', target(args));
      label = info.label;
      await pointAt(tab.id, info, `tippt in ${quote(info.name)}`);
      await mouseClick(tab.id, info.x, info.y);
      await sleep(50);
    }
    const focus = await inPage(tab.id, 'prepareType', { clear: !!args.clear });
    const text = String(args.text ?? '');
    if (!(args.ref || args.selector)) await indicate(tab.id, 'tippt');
    if (text.includes('\n') && focus.kind === 'contenteditable') {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await pressKey(tab.id, 'Shift+Enter');
        if (lines[i]) await cdp(tab.id, 'Input.insertText', { text: lines[i] });
      }
    } else if (text) await cdp(tab.id, 'Input.insertText', { text });
    if (args.submit) await pressKey(tab.id, 'Enter');
    const after = args.submit ? await settle(tab.id, tab) : {};
    const value = await inPage(tab.id, 'focusedValue', {});
    return { typedInto: label, value, ...after };
  },

  async select_option(args) {
    const tab = await resolveTab(args);
    const info = await inPage(tab.id, 'locate', target(args));
    await pointAt(tab.id, info, `wählt ${quote(args.value)}`);
    return inPage(tab.id, 'selectOption', { ...target(args), value: args.value });
  },

  async press_key({ key, tabId, repeat = 1 }) {
    const tab = await resolveTab({ tabId });
    await indicate(tab.id, `drückt ${key}`);
    for (let i = 0; i < Math.min(repeat, 50); i++) await pressKey(tab.id, key);
    return { pressed: key, ...(await settle(tab.id, tab)) };
  },

  async scroll(args) {
    const tab = await resolveTab(args);
    const dir = args.direction || 'down';
    const amount = Number(args.amount) || 600;
    let x, y;
    if (args.ref || args.selector) ({ x, y } = await inPage(tab.id, 'locate', { ...target(args), noScroll: true }));
    else ({ x, y } = await inPage(tab.id, 'viewport', {}));
    await indicate(tab.id, `scrollt ${{ up: 'nach oben', down: 'nach unten', left: 'nach links', right: 'nach rechts' }[dir] || ''}`);
    const deltaX = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
    const deltaY = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
    await cdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
    await sleep(400);
    return inPage(tab.id, 'viewport', {});
  },

  async screenshot(args) {
    const tab = await resolveTab(args);
    const format = args.format === 'png' ? 'png' : 'jpeg';
    const params = { format, ...(format === 'jpeg' ? { quality: args.quality ?? 80 } : {}) };
    if (args.ref || args.selector) {
      const r = await inPage(tab.id, 'rect', target(args));
      params.clip = { ...r, scale: 1 };
      params.captureBeyondViewport = true;
    } else if (args.fullPage) {
      const m = await cdp(tab.id, 'Page.getLayoutMetrics');
      const size = m.cssContentSize || m.contentSize;
      params.clip = { x: 0, y: 0, width: size.width, height: Math.min(size.height, 16_000), scale: 1 };
      params.captureBeyondViewport = true;
    }
    await overlay(tab.id, 'hide');
    let shot;
    try {
      shot = await captureScreenshot(tab.id, params);
    } finally {
      await overlay(tab.id, 'unhide');
    }
    return { tabId: tab.id, url: tab.url, base64: shot.data, mimeType: `image/${format}` };
  },

  async evaluate({ code, tabId }) {
    const tab = await resolveTab({ tabId });
    const run = (expression) =>
      cdp(tab.id, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    const isSyntaxError = (res) => /SyntaxError/.test(res.exceptionDetails?.exception?.description || '');
    let r = await run(String(code));
    if (isSyntaxError(r)) r = await run(`(async () => (\n${code}\n))()`);
    if (isSyntaxError(r)) r = await run(`(async () => {\n${code}\n})()`);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'Fehler beim Ausführen');
    }
    const v = r.result;
    let value = v.value !== undefined ? v.value : v.description ?? v.type;
    const json = JSON.stringify(value);
    if (json && json.length > 50_000) value = json.slice(0, 50_000) + '… (gekürzt)';
    return { type: v.type, value };
  },

  async wait_for({ text, selector, gone = false, timeoutMs = 10_000, tabId }) {
    const tab = await resolveTab({ tabId });
    if (!text && !selector) {
      await sleep(Math.min(timeoutMs, 60_000));
      return { waited: timeoutMs };
    }
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = await inPage(tab.id, 'check', { text, selector }).catch(() => false);
      if (found !== gone) return { ok: true, afterMs: Date.now() - start };
      await sleep(250);
    }
    throw new Error(`Zeitüberschreitung: ${text ? `Text "${text}"` : `Selektor ${selector}`} ${gone ? 'ist noch da' : 'nicht gefunden'}`);
  },

  async upload_file(args) {
    const tab = await resolveTab(args);
    if (!Array.isArray(args.paths) || !args.paths.length) throw new Error('"paths" (Liste absoluter Dateipfade) fehlt');
    const sel = args.ref ? `[data-eb-ref="${args.ref}"]` : args.selector;
    if (!sel) throw new Error('ref oder selector angeben');
    const expression = `(() => {
      const sel = ${JSON.stringify(sel)};
      const find = (root) => {
        const hit = root.querySelector(sel);
        if (hit) return hit;
        for (const n of root.querySelectorAll('*')) {
          if (n.shadowRoot) { const r = find(n.shadowRoot); if (r) return r; }
          if (n.tagName === 'IFRAME') { try { const r = n.contentDocument && find(n.contentDocument); if (r) return r; } catch {} }
        }
        return null;
      };
      return find(document);
    })()`;
    await indicate(tab.id, `lädt ${args.paths.length === 1 ? '1 Datei' : `${args.paths.length} Dateien`} hoch`);
    const r = await cdp(tab.id, 'Runtime.evaluate', { expression });
    if (!r.result?.objectId) throw new Error(`Element ${sel} nicht gefunden`);
    await cdp(tab.id, 'DOM.setFileInputFiles', { files: args.paths, objectId: r.result.objectId });
    return { uploaded: args.paths.length };
  },
};
