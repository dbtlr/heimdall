import { describe, expect, test } from 'bun:test';

import type { ConditionLimitSet } from '@heimdall/schema';

import type { Attention } from '../server/attention-types.ts';
import type { ConditionDetail } from '../server/condition-detail-types.ts';
import type { ClearedCondition, LeadEvidence } from '../server/home-types.ts';
import { NeedsAttention } from './needs-attention.tsx';
import { renderRouted } from './render-routed.tsx';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const memory: Attention = {
  checkedAt: NOW,
  conditionId: '11',
  evidence: 'current',
  firstDetected: NOW - 25 * HOUR,
  kind: 'high_memory',
  level: 'warning',
  reason: 'Memory above 90% for 20 of 30 min',
  subject: '',
  system: 'vm-host-1',
  unpaired: false,
};

const down: Attention = {
  checkedAt: NOW,
  checks: [
    { check: 'supervisor', detail: 'inactive (dead)', since: NOW - 4 * MINUTE, state: 'stopped' },
    { check: 'health', detail: 'connection refused', since: NOW - 4 * MINUTE, state: 'unhealthy' },
  ],
  conditionId: '12',
  evidence: 'current',
  firstDetected: NOW - 4 * MINUTE,
  kind: 'service_down',
  level: 'alert',
  reason: 'stopped',
  service: {
    health: 'http://127.0.0.1:8080/health',
    supervisor: 'systemd',
    target: 'caddy.service',
  },
  subject: 'proxy',
  system: 'edge-1',
  unpaired: false,
};

const drift: Attention = {
  checkedAt: NOW,
  conditionId: '13',
  evidence: 'current',
  firstDetected: NOW - HOUR,
  kind: 'drift',
  level: 'warning',
  othersMatching: 0,
  record: 'base',
  sha256: undefined,
  state: 'drifted',
  subject: '/etc/hosts',
  system: 'server-1',
  unpaired: false,
};

const LIMITS: ConditionLimitSet = {
  clock: { alert: 300, hysteresis: 5, note: 30, warning: 120 },
  cpu: {
    noteMinutes: 30,
    noteWindowMinutes: 60,
    percent: 90,
    warningMinutes: 120,
    warningWindowMinutes: 240,
  },
  disk: { alert: 90, hysteresis: 2, note: 70, warning: 80 },
  memory: { percent: 90, warningMinutes: 20, warningWindowMinutes: 30 },
  process: {
    cores: 0.5,
    noteMinutes: 30,
    noteWindowMinutes: 60,
    warningMinutes: 120,
    warningWindowMinutes: 240,
  },
  updates: { rebootWarningDays: 7, securityWarningDays: 7 },
};

// High memory's opened Condition, with a day of readings near its 90% limit.
const memoryDetail = (holders: ConditionDetail['memoryHolders']): ConditionDetail => ({
  attention: memory,
  clearedAt: undefined,
  from: NOW - 24 * HOUR,
  id: '11',
  kind: 'high_memory',
  latestAt: NOW,
  latestReason: memory.kind === 'high_memory' ? memory.reason : '',
  level: 'warning',
  limits: LIMITS,
  memoryHolders: holders,
  packages: undefined,
  platform: 'linux',
  raisedAt: NOW - 25 * HOUR,
  series: {
    kind: 'percent',
    points: [
      { percent: 91, t: NOW - 2 * HOUR },
      { percent: 93, t: NOW - HOUR },
      { percent: 94, t: NOW },
    ],
  },
  subject: '',
  system: 'vm-host-1',
  to: NOW,
  transitions: [],
});

const render = ({
  attention,
  lastCleared,
  lead,
}: {
  attention: Attention[];
  lastCleared?: ClearedCondition;
  lead?: LeadEvidence;
}) =>
  renderRouted(
    <NeedsAttention attention={attention} lastCleared={lastCleared} lead={lead} now={NOW} />,
  );

describe('the attention card', () => {
  test('leads with the worst item, then the newest, linking to it, tinted for its level, with the rest a line each', async () => {
    const html = await render({ attention: [memory, down, drift] });

    expect(html).toContain('data-level="alert"');
    expect(html.indexOf('Service down proxy on edge-1')).toBeLessThan(
      html.indexOf('Drift /etc/hosts on server-1'),
    );
    expect(html.indexOf('Drift /etc/hosts on server-1')).toBeLessThan(
      html.indexOf('High memory on vm-host-1'),
    );
    expect(html).toContain('href="/systems/edge-1/conditions/12"');
    expect(html).toContain('Alert · open 4 min');
    expect(html).toContain('href="/timeline?status=%5B%22open%22%5D"');
  });

  test('a High memory lead shows its chart against the limit, and the processes holding the most memory', async () => {
    const holders = {
      processes: [{ name: 'qemu-system-x86', pid: 812, rssBytes: 21.4 * 1024 ** 3 }],
      t: NOW,
    };
    const html = await render({
      attention: [memory],
      lead: { conditionId: '11', detail: memoryDetail(holders), stops: undefined },
    });

    expect(html).toContain('data-level="warning"');
    expect(html).toContain('Warning · open 1 d 1 h');
    expect(html).toContain('aria-label="Memory used over the last 24 h"');
    expect(html).toContain('data-limit="90"');
    expect(html).toContain('stop-color="var(--status-serious)"');
    expect(html).toContain('Processes holding the most memory');
    expect(html).toContain('qemu-system-x86');
  });

  test('a High memory lead without named processes shows no heading for them', async () => {
    const html = await render({
      attention: [memory],
      lead: { conditionId: '11', detail: memoryDetail(undefined), stops: undefined },
    });

    expect(html).toContain('data-limit="90"');
    expect(html).not.toContain('Processes holding the most memory');
  });

  test('evidence read for another Condition than the lead is not shown under it', async () => {
    const html = await render({
      attention: [memory],
      lead: { conditionId: '99', detail: memoryDetail(undefined), stops: undefined },
    });

    expect(html).toContain('High memory on vm-host-1');
    expect(html).not.toContain('data-limit="90"');
  });

  test("a Service down lead shows its latest checks and the week's stops", async () => {
    const html = await render({
      attention: [down],
      lead: { conditionId: '12', detail: undefined, stops: 4 },
    });

    expect(html).toContain('>Supervisor<');
    expect(html).toContain('>Health<');
    expect(html).toContain('>Stops this week<');
    expect(html).toContain('>4<');
    expect(html).toContain('journalctl -u caddy.service -n 50');
  });

  test('any other lead shows what was observed and its next step', async () => {
    const html = await render({
      attention: [drift],
      lead: { conditionId: '13', detail: undefined, stops: undefined },
    });

    expect(html).toContain('Content differs.');
    expect(html).toContain('<b class="font-semibold">Next step.</b> Re-apply');
  });

  test('with nothing open, says so and names the Condition that cleared last', async () => {
    const html = await render({
      attention: [],
      lastCleared: {
        clearedAt: NOW - 3 * 24 * HOUR,
        id: '9',
        kind: 'drift',
        level: 'warning',
        raisedAt: NOW - 3 * 24 * HOUR - 148 * MINUTE,
        subject: '/etc/hosts',
        system: 'server-1',
      },
    });

    expect(html).not.toContain('data-level=');
    expect(html).toContain('Nothing open');
    expect(html).toContain('The last Condition cleared 3 d ago: ');
    expect(html).toContain('href="/systems/server-1/conditions/9"');
    expect(html).toContain('Drift /etc/hosts on server-1');
    expect(html).toContain(', open 2 h 28 min.');
  });

  test('notes follow the alerts and warnings as the last rows, with the note mark, and tint nothing', async () => {
    const disk: Attention = {
      checkedAt: NOW,
      conditionId: '21',
      disk: undefined,
      evidence: 'current',
      firstDetected: NOW - 2 * HOUR,
      kind: 'low_disk',
      level: 'note',
      reason: '/data is 72% used',
      subject: '/data',
      system: 'server-1',
      unpaired: false,
    };
    const reboot: Attention = {
      ...disk,
      conditionId: '22',
      kind: 'reboot_required',
      reason: 'A reboot is required.',
      subject: '',
    };

    const html = await render({ attention: [disk, memory, reboot, drift] });

    expect(html).toContain('data-level="warning"');
    // Drift, the newer warning, leads; High memory is the other warning's row.
    expect(html.indexOf('High memory on vm-host-1')).toBeGreaterThan(-1);
    expect(html.indexOf('High memory on vm-host-1')).toBeLessThan(
      html.indexOf('Low disk /data on server-1'),
    );
    expect(html).toContain('href="/systems/server-1/conditions/21"');
    expect(html).toContain('fill-status-warning');
    expect(html).not.toContain('Reboot required');

    const notesOnly = await render({ attention: [disk, reboot] });

    expect(notesOnly).not.toContain('data-level=');
    expect(notesOnly).toContain('No alert or warning open');
    expect(notesOnly).toContain('Low disk /data on server-1');
  });

  test('with nothing open and nothing ever cleared, says only that nothing is open', async () => {
    const html = await render({ attention: [] });

    expect(html).toContain('Nothing open');
    expect(html).not.toContain('The last Condition cleared');
  });
});
