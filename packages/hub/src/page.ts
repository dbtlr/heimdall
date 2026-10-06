import type { VitalsSample } from '@heimdall/schema';

import type { SystemSummary } from './store.ts';

const ESCAPES: Record<string, string> = {
  '"': '&quot;',
  '&': '&amp;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
};

// Text that came from a Collector, safe to place in HTML.
const escape = (text: string) => text.replaceAll(/["&'<>]/gu, (c) => ESCAPES[c] ?? c);

const GIB = 2 ** 30;

const gib = (bytes: number) => (bytes / GIB).toFixed(1);

const usage = ({ totalBytes, usedBytes }: { totalBytes: number; usedBytes: number }) =>
  `${gib(usedBytes)} / ${gib(totalBytes)} GiB`;

// `2026-10-06 12:00:00 UTC`: the same for every reader, whatever their zone.
const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;

const ago = (ms: number) => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${String(minutes)} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)} h ago` : `${String(Math.floor(hours / 24))} d ago`;
};

const duration = (seconds: number) => {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${String(days)}d ${String(hours)}h ${String(minutes)}m`;
};

const vitalsCells = (v: VitalsSample) => [
  `${v.cpu.busyPercent.toFixed(1)}%`,
  usage(v.memory),
  v.disks.map((d) => `${escape(d.mount)} ${usage(d)}`).join('<br>'),
  v.load.map((l) => l.toFixed(2)).join(' '),
  duration(v.uptimeSeconds),
];

const row = (system: SystemSummary, now: number) => {
  const { arch, platform, version } = system.collector;
  const cells = [
    escape(system.name),
    `<time datetime="${new Date(system.lastSeenAt).toISOString()}">${utc(system.lastSeenAt)}</time><br>${ago(now - system.lastSeenAt)}`,
    ...vitalsCells(system.latest),
    escape(`${version} ${platform}/${arch}`),
  ];
  return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
};

const HEADINGS = ['System', 'Last seen', 'CPU', 'Memory', 'Disks', 'Load', 'Uptime', 'Collector'];

// The plain page that lists every System with its last-seen time and newest
// Vitals. M5's dashboard replaces it.
export const renderPage = ({ now, systems }: { now: number; systems: SystemSummary[] }) => {
  const body =
    systems.length === 0
      ? '<p>No System has reported yet.</p>'
      : `<table>
<thead><tr>${HEADINGS.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
<tbody>
${systems.map((s) => row(s, now)).join('\n')}
</tbody>
</table>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Heimdall</title>
<style>
body { font-family: system-ui, sans-serif; margin: 1rem; }
table { border-collapse: collapse; }
th, td { border-bottom: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
</style>
</head>
<body>
<h1>Heimdall</h1>
${body}
</body>
</html>
`;
};
