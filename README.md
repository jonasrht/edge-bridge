# Edge Bridge

Lässt lokale Agenten (Claude Code per MCP, Shell per CLI) den echten Edge-Browser steuern –
mit allen Logins und gezielt pro Edge-Profil.

```
Claude Code ──stdio──▶ src/mcp.ts ──HTTP+Token──▶ src/daemon.ts ◀──WebSocket── Erweiterung (pro Profil)
edge-bridge CLI ──────────────────HTTP+Token──▶     127.0.0.1:10087               chrome.debugger + scripting
```

- `extension/` – MV3-Erweiterung, ohne Build-Schritt. Feste ID `kfjjmfgccekckgnegnjdbbloopmjdidk`
  über den `key` im Manifest (privater Schlüssel liegt in `~/.edge-bridge/extension-key.pem`).
- `src/daemon.ts` – Dienst, hält die Verbindungen aller Profile, leitet Befehle weiter.
- `src/mcp.ts` – MCP-Server (stdio), `src/cli.ts` – CLI.

## Einrichtung

1. Dienst: `scripts/dev.rodehorst.edge-bridge.plist` nach `~/Library/LaunchAgents/`,
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.rodehorst.edge-bridge.plist`.
2. Pro Edge-Profil: `edge://extensions` → Entwicklermodus → „Entpackte Erweiterung laden" → `extension/`.
   Im Popup einen Namen vergeben (sonst Edge-Profilname, wenn ein Konto erkannt wird).
3. MCP: `claude mcp add -s user edge-bridge -- node ~/projects/edge-bridge/src/mcp.ts`.
4. CLI: `ln -s ~/projects/edge-bridge/scripts/edge-bridge ~/.local/bin/edge-bridge`.

## Sicherheit

- Dienst nur auf `127.0.0.1`. HTTP braucht das Token aus `~/.edge-bridge/token` (0600); Anfragen mit
  `Origin`-Header oder fremdem `Host` werden abgewiesen (keine Steuerung aus Webseiten, kein DNS-Rebinding).
- WebSocket nimmt nur `chrome-extension://<feste ID>` an.
- Die Erweiterung lässt sich pro Profil im Popup ausschalten.

## Entwickeln

`npm run check` (TypeScript). Nach Änderungen an `extension/` die Erweiterung in jedem Profil neu laden,
nach Änderungen am Dienst `launchctl kickstart -k gui/$(id -u)/dev.rodehorst.edge-bridge`.
