const $ = (id) => document.getElementById(id);
const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String));

document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);

const STATUS_TEXT = {
  connected: (p) => t('statusConnected', p),
  disconnected: () => t('statusDisconnected'),
  disabled: () => t('statusDisabled'),
};

async function render() {
  const { status, profile } = await chrome.storage.session.get(['status', 'profile']);
  $('dot').className = 'dot' + (status === 'connected' ? ' connected' : '');
  $('status').textContent = (STATUS_TEXT[status] || STATUS_TEXT.disconnected)(profile);
}

async function init() {
  const { label, enabled, tabMode } = await chrome.storage.local.get(['label', 'enabled', 'tabMode']);
  $('label').value = label || '';
  $('tabMode').value = tabMode === 'window' ? 'window' : 'group';
  $('enabled').checked = enabled !== false;
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    $('email').textContent = info?.email ? t('emailKnown', info.email) : t('emailUnknown');
  } catch {
    $('email').textContent = '';
  }
  await render();
}

let saveTimer;
$('label').addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ label: $('label').value.trim() }), 400);
});
$('enabled').addEventListener('change', () => chrome.storage.local.set({ enabled: $('enabled').checked }));
$('tabMode').addEventListener('change', () => chrome.storage.local.set({ tabMode: $('tabMode').value }));
$('showWindow').addEventListener('click', async () => {
  const { currentTabId } = await chrome.storage.session.get('currentTabId');
  const tab = currentTabId != null ? await chrome.tabs.get(currentTabId).catch(() => null) : null;
  if (!tab) return ($('status').textContent = t('noAgentTab'));
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
});
chrome.storage.onChanged.addListener((_, area) => area === 'session' && render());

init();
