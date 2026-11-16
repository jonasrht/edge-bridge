const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  connected: (p) => `Verbunden als „${p}“`,
  disconnected: () => 'Nicht verbunden – läuft der edge-bridge-Dienst auf dem Mac?',
  disabled: () => 'Ausgeschaltet',
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
    $('email').textContent = info?.email
      ? `Angemeldet als ${info.email}. Ohne eigenen Namen nutzt der Agent den Edge-Profilnamen.`
      : 'Kein Konto erkannt. Bitte einen Namen vergeben, damit der Agent das Profil findet.';
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
  if (!tab) return ($('status').textContent = 'Der Agent hat gerade keinen Tab offen.');
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
});
chrome.storage.onChanged.addListener((_, area) => area === 'session' && render());

init();
