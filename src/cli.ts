import { call, ensureDaemon } from './client.ts';
import { HOST, PORT, readToken } from './config.ts';

const USAGE = `edge-bridge – drive Edge profiles through the Edge Bridge extension

  edge-bridge status
  edge-bridge <action> ['<json-args>'] [-p <profile>]

Examples:
  edge-bridge list_profiles
  edge-bridge navigate '{"url":"example.com"}' -p work
  edge-bridge snapshot -p work
  edge-bridge click '{"ref":"e12"}' -p work
  edge-bridge screenshot -p work

Actions: list_profiles list_tabs navigate select_tab close_tab history snapshot get_text
          click hover type select_option press_key scroll screenshot evaluate wait_for upload_file
          reload_extension`;

const argv = process.argv.slice(2);
let profile: string | undefined;
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-p' || argv[i] === '--profile') profile = argv[++i];
  else rest.push(argv[i]);
}
const [action, json] = rest;

if (!action || action === '-h' || action === '--help') {
  console.log(USAGE);
  process.exit(action ? 0 : 1);
}

try {
  if (action === 'status') {
    await ensureDaemon();
    const r = await fetch(`http://${HOST}:${PORT}/profiles`, { headers: { Authorization: `Bearer ${readToken()}` } });
    const j = (await r.json()) as { data: unknown[] };
    console.log(JSON.stringify({ daemon: `${HOST}:${PORT}`, profiles: j.data }, null, 2));
  } else {
    const data = (await call(action, json ? JSON.parse(json) : {}, profile)) as Record<string, unknown>;
    if (action === 'snapshot' && typeof data?.text === 'string') console.log(data.text);
    else console.log(JSON.stringify(data, null, 2));
  }
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
