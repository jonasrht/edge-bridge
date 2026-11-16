import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { call } from './client.ts';

const server = new McpServer({ name: 'edge-bridge', version: '0.1.0' });

const profile = z
  .string()
  .optional()
  .describe('Edge profile to act in (name from list_profiles, case-insensitive, partial match ok). Optional when only one profile is connected.');
const tabId = z.number().int().optional().describe('Tab to act on. Defaults to the current tab (last navigated/selected).');
const ref = z.string().optional().describe('Element ref from snapshot, e.g. "e12".');
const selector = z.string().optional().describe('CSS selector, alternative to ref.');

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

function text(v: unknown): Content {
  return { type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) };
}

function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  render: (data: any) => Content[] = (d) => [text(d)],
) {
  server.registerTool(name, { description, inputSchema: { ...shape, profile } }, (async (args: Record<string, unknown>) => {
    const { profile: p, ...rest } = args;
    try {
      return { content: render(await call(name, rest, p as string | undefined)) };
    } catch (err) {
      return { content: [text(err instanceof Error ? err.message : String(err))], isError: true };
    }
  }) as any);
}

tool('list_profiles', 'List Edge profiles that currently have the Edge Bridge extension connected. Call this first when unsure which profile to use.', {});

tool('list_tabs', 'List open tabs of a profile. Tabs the agent opened are marked agent:true.', {
  agentOnly: z.boolean().optional().describe('Only tabs the agent opened.'),
});

tool(
  'navigate',
  'Open a URL. Without a current tab (or with newTab) this opens a new agent tab (by default in the user\'s front window, in a tab group "Agent"; the user can switch to a background window) and leaves the user\'s own tabs untouched. Otherwise the current tab navigates. Waits for load. The user sees an on-page indicator of every action.',
  { url: z.string(), newTab: z.boolean().optional(), tabId },
);

tool(
  'select_tab',
  'Make a tab the current tab. active:true takes the tab the user is looking at right now; url matches an open tab by URL (substring ok).',
  { tabId, active: z.boolean().optional(), url: z.string().optional() },
);

tool('close_tab', 'Close a tab (default: current tab).', { tabId });

tool('history', 'Go back, forward or reload.', { direction: z.enum(['back', 'forward', 'reload']), tabId });

tool(
  'snapshot',
  'Read the page as a compact accessibility-style tree. Interactive elements carry [ref=eN] for click/type/etc. Primary way to read and understand a page; prefer it over screenshots.',
  { tabId, maxChars: z.number().int().optional() },
  (d) => [text(d.text)],
);

tool('get_text', 'Plain visible text of the page (innerText), for reading long content.', {
  tabId,
  maxChars: z.number().int().optional(),
});

tool(
  'click',
  'Click an element (scrolls it into view, real mouse events). Use ref from snapshot, a CSS selector, or x/y viewport coordinates from a screenshot.',
  {
    ref,
    selector,
    x: z.number().optional(),
    y: z.number().optional(),
    button: z.enum(['left', 'right', 'middle']).optional(),
    doubleClick: z.boolean().optional(),
    tabId,
  },
);

tool('hover', 'Move the mouse over an element (opens hover menus, tooltips).', { ref, selector, tabId });

tool(
  'type',
  'Type text like a user. With ref/selector the element is clicked first; without, types into the focused element. Works with inputs, textareas and rich editors (contenteditable).',
  {
    ref,
    selector,
    text: z.string(),
    clear: z.boolean().optional().describe('Replace existing content instead of appending.'),
    submit: z.boolean().optional().describe('Press Enter afterwards.'),
    tabId,
  },
);

tool('select_option', 'Choose an option in a native <select> by value or visible text.', { ref, selector, value: z.string(), tabId });

tool(
  'press_key',
  'Press a key or combo, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Meta+a", "Shift+Tab".',
  { key: z.string(), repeat: z.number().int().optional(), tabId },
);

tool(
  'scroll',
  'Scroll the page, or the scroll container under an element when ref/selector is given.',
  { direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().optional().describe('Pixels, default 600.'), ref, selector, tabId },
);

tool(
  'screenshot',
  'Screenshot of the visible viewport (or full page / one element). Returns the image and its file path. Use when layout or visuals matter, or for cross-origin iframes.',
  {
    fullPage: z.boolean().optional(),
    ref,
    selector,
    format: z.enum(['jpeg', 'png']).optional(),
    quality: z.number().int().min(1).max(100).optional(),
    tabId,
  },
  (d) => {
    const out: Content[] = [text({ path: d.path, url: d.url, tabId: d.tabId, profile: d.profile })];
    try {
      out.unshift({ type: 'image', data: fs.readFileSync(d.path).toString('base64'), mimeType: d.mimeType });
    } catch {}
    return out;
  },
);

tool(
  'evaluate',
  'Run JavaScript in the page (main world, async/await ok, may use return). Returns the JSON-serialisable result.',
  { code: z.string(), tabId },
);

tool(
  'wait_for',
  'Wait until text or a selector appears (or disappears with gone:true). Without text/selector it just waits timeoutMs.',
  { text: z.string().optional(), selector, gone: z.boolean().optional(), timeoutMs: z.number().int().optional(), tabId },
);

tool('upload_file', 'Put local files into a file input (works on hidden inputs too).', {
  ref,
  selector,
  paths: z.array(z.string()).describe('Absolute file paths on this Mac.'),
  tabId,
});

await server.connect(new StdioServerTransport());
