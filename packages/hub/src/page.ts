import type { VitalsSample } from '@heimdall/schema';

import { TIMELINE_CONDITIONS } from './store.ts';
import type { ConditionKind, OpenCondition, SystemSummary, TimelineEntry } from './store.ts';

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
const utc = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/u, ' UTC');

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

const vitalsCells = (v: VitalsSample | undefined) =>
  v === undefined
    ? Array.from({ length: 5 }, () => UNKNOWN)
    : [
        `${v.cpu.busyPercent.toFixed(1)}%`,
        usage(v.memory),
        v.disks.map((d) => `${escape(d.mount)} ${usage(d)}`).join('<br>'),
        v.load.map((l) => l.toFixed(2)).join(' '),
        duration(v.uptimeSeconds),
      ];

// What the page calls each Condition when it is raised and when it is cleared.
const CONDITION_LABELS: Record<ConditionKind, { cleared: string; raised: string }> = {
  drift: { cleared: 'Drift cleared', raised: 'Drift' },
  job_failing: { cleared: 'Job no longer failing', raised: 'Job failing' },
  job_overdue: { cleared: 'Job no longer overdue', raised: 'Job overdue' },
  low_disk: { cleared: 'Low disk cleared', raised: 'Low disk' },
  reports_rejected: { cleared: 'Reports accepted again', raised: 'Reports rejected' },
  system_stale: { cleared: 'System heard from again', raised: 'System stale' },
};

// A label followed by what the Condition is about, such as a job's name.
const about = (label: string, subject: string) =>
  subject === '' ? label : `${label} <code>${escape(subject)}</code>`;

const moment = (ms: number) => `<time datetime="${new Date(ms).toISOString()}">${utc(ms)}</time>`;

// A reason may span several lines, as the schema's error report does.
const reasonText = (reason: string) => `<span class="reason">${escape(reason)}</span>`;

const status = (conditions: OpenCondition[]) =>
  conditions.length === 0
    ? 'No open Conditions'
    : conditions
        .map(
          (c) =>
            `${about(`<strong>${CONDITION_LABELS[c.kind].raised}</strong>`, c.subject)} since ${moment(c.raisedAt)}: ${reasonText(c.reason)}`,
        )
        .join('<br>');

// Shown in place of Vitals for a System with no stored Report yet.
const UNKNOWN = '—';

const row = (system: SystemSummary, now: number) => {
  const reported =
    system.reported === undefined
      ? [...vitalsCells(undefined), UNKNOWN]
      : [
          ...vitalsCells(system.reported.latest),
          escape(
            `${system.reported.collector.version} ${system.reported.collector.platform}/${system.reported.collector.arch}`,
          ),
        ];
  const cells = [
    escape(system.name),
    system.lastSeenAt === undefined
      ? 'Never seen'
      : `${moment(system.lastSeenAt)}<br>${ago(now - system.lastSeenAt)}`,
    status(system.conditions),
    ...reported,
  ];
  return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
};

const timelineLine = (entry: TimelineEntry) => {
  const label = CONDITION_LABELS[entry.condition];
  return entry.kind === 'raised'
    ? `<li>${moment(entry.at)} ${about(label.raised, entry.subject)}: ${reasonText(entry.reason)}</li>`
    : `<li>${moment(entry.at)} ${about(label.cleared, entry.subject)}</li>`;
};

const timeline = (system: SystemSummary) =>
  `<h3>${escape(system.name)}</h3>\n${
    system.timeline.length === 0
      ? '<p>No Conditions yet.</p>'
      : `<ol>\n${system.timeline.map(timelineLine).join('\n')}\n</ol>`
  }`;

const HEADINGS = [
  'System',
  'Last seen',
  'Status',
  'CPU',
  'Memory',
  'Disks',
  'Load',
  'Uptime',
  'Collector',
];

// The plain page that lists every System with its last-seen time, status, and
// newest Vitals, then each System's Timeline. M5's dashboard replaces it.
export const renderPage = ({ now, systems }: { now: number; systems: SystemSummary[] }) => {
  const body =
    systems.length === 0
      ? '<p>No System has reported yet.</p>'
      : `<table>
<thead><tr>${HEADINGS.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
<tbody>
${systems.map((s) => row(s, now)).join('\n')}
</tbody>
</table>
<h2>Timeline</h2>
<p>Each System's latest ${String(TIMELINE_CONDITIONS)} Conditions, newest first.</p>
${systems.map(timeline).join('\n')}`;
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
.reason { white-space: pre-wrap; }
</style>
</head>
<body>
<h1>Heimdall</h1>
${body}
</body>
</html>
`;
};
