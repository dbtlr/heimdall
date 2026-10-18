import { expect, test } from 'bun:test';

import { processSubject } from '@heimdall/schema';
import type { ConditionLimitSet } from '@heimdall/schema';

import type { Attention } from '../server/attention-types.ts';
import type { ConditionDetail, ConditionSeries } from '../server/condition-detail-types.ts';
import { conditionDetailView, isLone, withGaps } from './condition-detail.ts';
import { phraseText } from './phrase.ts';

const GIB = 1024 ** 3;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

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
  memory: { percent: 90, warningMinutes: 30, warningWindowMinutes: 60 },
  process: {
    cores: 0.5,
    noteMinutes: 30,
    noteWindowMinutes: 60,
    warningMinutes: 120,
    warningWindowMinutes: 240,
  },
  updates: { rebootWarningDays: 7, securityWarningDays: 7 },
};

// A readable sentence for a phrase; the tests care about words, not zones.
const words = (phrase: Parameters<typeof phraseText>[0]) => phraseText(phrase, 'UTC');

// 7 days of readings every 10 minutes ending at NOW: 431 GiB, growing 2.1 GiB
// a day to 393 GiB used (91%).
const diskSeries = (perDay = 2.1, days = 7): ConditionSeries => {
  const count = Math.round(days * 144);
  return {
    kind: 'disk',
    points: Array.from({ length: count + 1 }, (_, index) => ({
      t: NOW - (count - index) * 10 * MINUTE,
      totalBytes: 431 * GIB,
      usedBytes: (393 - perDay * ((count - index) / 144)) * GIB,
    })),
  };
};

const attentionBase = {
  checkedAt: NOW - 2 * MINUTE,
  conditionId: 'c1',
  evidence: 'current',
  firstDetected: NOW - 3 * DAY,
  subject: '',
  system: 'gateway-1',
  unpaired: false,
} as const;

const diskAttention: Attention = {
  ...attentionBase,
  disk: { mount: '/', totalBytes: 431 * GIB, usedBytes: 393 * GIB },
  kind: 'low_disk',
  level: 'warning',
  reason: '91% used',
  subject: '/',
};

const diskDetail = (overrides: Partial<ConditionDetail> = {}): ConditionDetail => ({
  attention: diskAttention,
  clearedAt: undefined,
  from: NOW - 7 * DAY,
  id: 'c1',
  kind: 'low_disk',
  latestAt: NOW - 2 * MINUTE,
  latestReason: '91% used',
  level: 'warning',
  limits: LIMITS,
  packages: undefined,
  platform: 'linux',
  raisedAt: NOW - 3 * DAY,
  series: diskSeries(),
  subject: '/',
  system: 'gateway-1',
  to: NOW,
  transitions: [
    { at: NOW - 3 * DAY, backfilled: true, kind: 'raised', level: 'note', reason: '70% used' },
    {
      at: NOW - 2 * DAY,
      backfilled: false,
      kind: 'level_changed',
      level: 'warning',
      previousLevel: 'note',
      reason: '80% used',
    },
  ],
  ...overrides,
});

test('a low disk leads with the share used and what is free on the mount', () => {
  const view = conditionDetailView(diskDetail(), NOW);
  expect(view.title).toBe('Low disk /');
  expect(view.level).toBe('warning');
  expect(view.cleared).toBe(false);
  expect(view.hero.value).toBe('91');
  expect(view.hero.unit).toBe('%');
  expect(words(view.hero.text)).toBe('used. 38 GiB free of 431 GiB on /.');
});

test('a low disk estimates growth and when it fills, marked as an estimate', () => {
  const view = conditionDetailView(diskDetail(), NOW);
  expect(view.rate).toEqual({
    estimate: true,
    text: '+2.1 GiB a day over the last 7 days. At that rate it is full in about 18 days.',
  });
});

test('the rate names the span the readings cover, not the window', () => {
  const days = conditionDetailView(diskDetail({ series: diskSeries(2.1, 3) }), NOW).rate;
  expect(days?.text).toStartWith('+2.1 GiB a day over the last 3 days.');
  const hours = conditionDetailView(diskDetail({ series: diskSeries(2.1, 26 / 24) }), NOW).rate;
  expect(hours?.text).toStartWith('+2.1 GiB a day over the last 26 h.');
});

test('a low disk growing under 1 MiB a day shows no rate', () => {
  const crawl = 0.5 / 1024; // GiB a day
  expect(conditionDetailView(diskDetail({ series: diskSeries(crawl) }), NOW).rate).toBeUndefined();
});

test('a low disk that is not growing, or has under a day of readings, shows no rate', () => {
  expect(conditionDetailView(diskDetail({ series: diskSeries(0) }), NOW).rate).toBeUndefined();
  expect(conditionDetailView(diskDetail({ series: diskSeries(-1) }), NOW).rate).toBeUndefined();
  expect(
    conditionDetailView(diskDetail({ series: diskSeries(2.1, 0.5) }), NOW).rate,
  ).toBeUndefined();
});

test('a low disk charts percent used with a dashed line at each of the System limits', () => {
  const { chart } = conditionDetailView(diskDetail(), NOW);
  expect(chart?.lines).toEqual([
    { label: '70%', level: 'note', value: 70 },
    { label: '80%', level: 'warning', value: 80 },
    { label: '90%', level: 'alert', value: 90 },
  ]);
  expect(chart?.window).toEqual({ from: NOW - 7 * DAY, to: NOW });
  expect(chart?.points.at(-1)?.value).toBeCloseTo((393 / 431) * 100, 5);
  expect(chart?.captions.left).toBe('Disk used, last 7 days');
  expect(chart?.captions.right).toBe('65 to 100%, lines at 70, 80, 90');
  // Every line and reading sits inside the plotted range.
  const [low, high] = chart?.domain ?? [0, 0];
  expect(low).toBeLessThanOrEqual(70);
  expect(high).toBeGreaterThanOrEqual(91);
});

test('limits the System overrides move the lines, the caption, and the clearing level', () => {
  const view = conditionDetailView(
    diskDetail({
      limits: { ...LIMITS, disk: { alert: 95, hysteresis: 5, note: 60, warning: 75 } },
    }),
    NOW,
  );
  expect(view.chart?.lines.map((line) => line.value)).toEqual([60, 75, 95]);
  expect(view.chart?.captions.right).toContain('lines at 60, 75, 95');
  expect(view.nextStep?.clears).toBe(
    'The warning eases below 70%, and the Condition clears below 55%.',
  );
});

test("a low disk history shows each level with the Hub's words, never limits that may since have changed", () => {
  const view = conditionDetailView(diskDetail(), NOW);
  expect(view.history.map((row) => [row.label, row.backfilled])).toEqual([
    ['Raised at note', true],
    ['note → warning', false],
  ]);
  expect(view.history.every((row) => row.reason !== undefined)).toBe(true);
  expect(view.history.map((row) => row.at)).toEqual([NOW - 3 * DAY, NOW - 2 * DAY]);
});

test('a low disk names the next step, when it clears, and how fresh the reading is', () => {
  const view = conditionDetailView(diskDetail(), NOW);
  expect(view.nextStep?.steps[0]?.title).toBe('Free space or grow the disk');
  expect(view.nextStep?.clears).toBe(
    'The warning eases below 78%, and the Condition clears below 68%.',
  );
  expect(view.provenance).toContain('Updated 2 min ago.');
  expect(view.provenance).toContain('highest reading in each 5 minutes');
});

test('a low disk falls back to the Vitals on the attention when no readings came back', () => {
  const view = conditionDetailView(diskDetail({ series: undefined }), NOW);
  expect(view.hero.value).toBe('91');
  expect(view.chart).toBeUndefined();
  expect(view.rate).toBeUndefined();
});

test('a low disk falls back to the Vitals on the attention when its readings came back empty', () => {
  const view = conditionDetailView(diskDetail({ series: { kind: 'disk', points: [] } }), NOW);
  expect(view.hero.value).toBe('91');
  expect(view.hero.unit).toBe('%');
});

test('a low disk whose newest reading has no total falls back to the Vitals, never to load wording', () => {
  const series = diskSeries();
  const points = series.kind === 'disk' ? series.points : [];
  const newest = points.at(-1);
  if (newest !== undefined) {
    points[points.length - 1] = { ...newest, totalBytes: 0 };
  }
  const view = conditionDetailView(diskDetail({ series: { kind: 'disk', points } }), NOW);
  expect(view.hero.value).toBe('91');
  expect(words(view.hero.text)).not.toContain('busy');
});

test('a cleared Condition keeps its last level, adds the clearing row, and has no next step', () => {
  const view = conditionDetailView(
    diskDetail({
      attention: undefined,
      clearedAt: NOW - HOUR,
      to: NOW - HOUR,
      transitions: [
        ...diskDetail().transitions,
        { at: NOW - HOUR, backfilled: false, kind: 'cleared', level: 'warning', reason: 'below' },
      ],
    }),
    NOW,
  );
  expect(view.cleared).toBe(true);
  expect(view.level).toBe('warning');
  expect(view.nextStep).toBeUndefined();
  expect(view.rate).toBeUndefined();
  expect(view.history.at(-1)?.label).toBe('Cleared at warning');
  expect(view.provenance).not.toContain('Updated');
  expect(words(view.hero.text)).toContain('when it cleared');
});

test('unknown limits draw no lines and say so', () => {
  const view = conditionDetailView(diskDetail({ limits: undefined }), NOW);
  expect(view.chart?.lines).toEqual([]);
  expect(view.chart?.captions.right).toBe('80 to 100%; limits unknown');
  expect(view.history.map((row) => row.label)).toEqual(['Raised at note', 'note → warning']);
  expect(view.nextStep?.clears).toBeUndefined();
});

const percentSeries = (percent: number): ConditionSeries => ({
  kind: 'percent',
  points: Array.from({ length: 289 }, (_, index) => ({
    percent: index === 100 ? null : percent - (288 - index) / 100,
    t: NOW - (288 - index) * 5 * MINUTE,
  })),
});

const cpuDetail = (): ConditionDetail => ({
  attention: {
    ...attentionBase,
    kind: 'high_cpu',
    level: 'note',
    reason: 'CPU 93% for 32 of 60 min',
  },
  clearedAt: undefined,
  from: NOW - DAY,
  id: 'c2',
  kind: 'high_cpu',
  latestAt: NOW,
  latestReason: 'CPU 93% for 32 of 60 min',
  level: 'note',
  limits: LIMITS,
  packages: undefined,
  platform: 'linux',
  raisedAt: NOW - 2 * HOUR,
  series: percentSeries(93),
  subject: '',
  system: 'gateway-1',
  to: NOW,
  transitions: [
    {
      at: NOW - 2 * HOUR,
      backfilled: false,
      kind: 'raised',
      level: 'note',
      reason: 'CPU 91% for 31 of 60 min',
    },
  ],
});

test('high CPU leads with the latest busy share, one line at its limit, and the minutes rule', () => {
  const view = conditionDetailView(cpuDetail(), NOW);
  expect(view.title).toBe('High CPU');
  expect(view.hero.value).toBe('93');
  expect(view.hero.unit).toBe('%');
  expect(view.chart?.lines).toEqual([{ label: '90%', level: 'note', value: 90 }]);
  expect(view.chart?.captions.left).toBe('CPU busy, last 24 h');
  expect(view.chart?.captions.right).toBe('85 to 100%, line at 90%');
  expect(view.chart?.captions.rule).toBe(
    'above 90% for 30 of 60 min is a note, 120 of 240 a warning',
  );
  expect(view.rate).toBeUndefined();
  // Not a limit per level: the Hub's own reason says what was crossed.
  expect(view.history[0]?.label).toBe('Raised at note');
  expect(view.history[0]?.reason).toBe('CPU 91% for 31 of 60 min');
});

test('high memory charts used memory against its one warning limit', () => {
  const view = conditionDetailView(
    {
      ...cpuDetail(),
      attention: { ...cpuDetail().attention, kind: 'high_memory' } as Attention,
      kind: 'high_memory',
      level: 'warning',
    },
    NOW,
  );
  expect(view.title).toBe('High memory');
  expect(view.chart?.captions.left).toBe('Memory used, last 24 h');
  expect(view.chart?.captions.rule).toBe('above 90% for 30 of 60 min is a warning');
  expect(view.chart?.lines).toEqual([{ label: '90%', level: 'warning', value: 90 }]);
  expect(view.hero.unit).toBe('%');
});

test('macOS high memory states the pressure rule and draws no usage line', () => {
  const view = conditionDetailView(
    {
      ...cpuDetail(),
      attention: { ...cpuDetail().attention, kind: 'high_memory' } as Attention,
      kind: 'high_memory',
      level: 'warning',
      platform: 'darwin',
    },
    NOW,
  );
  expect(view.chart?.captions.left).toBe('Memory used, last 24 h');
  expect(view.chart?.captions.right).toBe('85 to 100%');
  expect(view.chart?.captions.rule).toBe('memory pressure for 30 of 60 min is a warning');
  expect(view.chart?.lines).toEqual([]);
});

test('a hot process leads with the cores it used and charts them against the cores limit', () => {
  const subject = processSubject({ bootId: 'b', name: 'node', pid: 4242, start: '99' });
  const view = conditionDetailView(
    {
      ...cpuDetail(),
      attention: {
        ...attentionBase,
        kind: 'hot_process',
        level: 'warning',
        reason: 'node used 0.86 cores',
        subject,
      },
      kind: 'hot_process',
      level: 'warning',
      series: {
        kind: 'cores',
        points: [
          { cores: 0.2, t: NOW - HOUR },
          { cores: null, t: NOW - 30 * MINUTE },
          { cores: 0.86, t: NOW },
        ],
      },
      subject,
    },
    NOW,
  );
  expect(view.title).toBe('Hot process node (PID 4242)');
  expect(view.hero.value).toBe('0.86');
  expect(view.hero.unit).toBe('of a core');
  expect(view.chart?.lines).toEqual([{ label: '0.5 core', level: 'warning', value: 0.5 }]);
  expect(view.chart?.captions.left).toBe('node (PID 4242) CPU, last 24 h');
  expect(view.chart?.captions.right).toBe('0 to 1.1 cores, limit 0.5 core');
  expect(view.chart?.domain[0]).toBe(0);
  expect(view.chart?.domain[1]).toBeGreaterThanOrEqual(0.86);
});

test('a latest reading with no value falls back to how long the Condition has been open', () => {
  const view = conditionDetailView(
    { ...cpuDetail(), series: { kind: 'percent', points: [{ percent: null, t: NOW }] } },
    NOW,
  );
  expect(view.chart).toBeUndefined();
  expect(view.hero.value).toBe('2');
  expect(view.hero.unit).toBe('h');
});

const updateDetail = (overrides: Partial<ConditionDetail> = {}): ConditionDetail => ({
  attention: {
    ...attentionBase,
    kind: 'pending_update',
    level: 'note',
    reason: '3 updates',
    subject: '["apt","system"]',
  },
  clearedAt: undefined,
  from: NOW - 7 * DAY,
  id: 'c3',
  kind: 'pending_update',
  latestAt: NOW,
  latestReason: '3 updates',
  level: 'note',
  limits: LIMITS,
  packages: undefined,
  platform: 'linux',
  raisedAt: NOW - 3 * DAY,
  series: undefined,
  subject: '["apt","system"]',
  system: 'gateway-1',
  to: NOW,
  transitions: [
    { at: NOW - 3 * DAY, backfilled: false, kind: 'raised', level: 'note', reason: '3 updates' },
  ],
  ...overrides,
});

test.each([
  ['pending_update', 'Pending update APT (system)'],
  ['reboot_required', 'Reboot required'],
  ['reports_rejected', 'Reports rejected'],
  ['clock_skew', 'Clock skew'],
] as const)('%s has no chart and leads with how long it has been open', (kind, title) => {
  const view = conditionDetailView(
    updateDetail({
      attention: { ...updateDetail().attention, kind } as Attention,
      kind,
      subject: kind === 'pending_update' ? '["apt","system"]' : '',
    }),
    NOW,
  );
  expect(view.title).toBe(title);
  expect(view.chart).toBeUndefined();
  expect(view.rate).toBeUndefined();
  expect(view.hero.value).toBe('3');
  expect(view.hero.unit).toBe('days');
  expect(words(view.hero.text).startsWith('open.')).toBe(true);
  expect(view.history.map((row) => row.label)).toEqual(['Raised at note']);
});

test('a short-lived Condition counts hours and minutes, and a cleared one the time it was open', () => {
  const hours = conditionDetailView(updateDetail({ raisedAt: NOW - 5 * HOUR - 10 * MINUTE }), NOW);
  expect([hours.hero.value, hours.hero.unit]).toEqual(['5', 'h 10 min']);
  const cleared = conditionDetailView(
    updateDetail({
      attention: undefined,
      clearedAt: NOW - DAY,
      raisedAt: NOW - 2 * DAY - 6 * HOUR,
    }),
    NOW,
  );
  expect([cleared.hero.value, cleared.hero.unit]).toEqual(['1', 'day']);
  expect(words(cleared.hero.text)).toContain('open before it cleared');
  expect(cleared.hero.text.length).toBeGreaterThan(0);
  expect(cleared.nextStep).toBeUndefined();
});

test('evidence that is old is said so in the view', () => {
  const view = conditionDetailView(
    updateDetail({ attention: { ...updateDetail().attention, evidence: 'old' } as Attention }),
    NOW,
  );
  expect(view.evidenceNote).toBeDefined();
});

test('a level that eased is labelled like any level change, with the Hub reason', () => {
  const view = conditionDetailView(
    diskDetail({
      transitions: [
        ...diskDetail().transitions,
        {
          at: NOW - DAY,
          backfilled: false,
          kind: 'level_changed',
          level: 'note',
          previousLevel: 'warning',
          reason: '77% used',
        },
      ],
    }),
    NOW,
  );
  expect(view.history.at(-1)?.label).toBe('warning → note');
  expect(view.history.at(-1)?.reason).toBe('77% used');
});

test('a disk at the note level clears below the note limit less the margin', () => {
  const view = conditionDetailView(diskDetail({ level: 'note' }), NOW);
  expect(view.nextStep?.clears).toBe('It clears below 68%.');
});

test('a Condition raised after the read time leads with under a minute open', () => {
  const view = conditionDetailView(updateDetail({ raisedAt: NOW + HOUR + 30 * MINUTE }), NOW);
  expect([view.hero.value, view.hero.unit]).toEqual(['<1', 'min']);
});

test('a gap of more than 15 minutes between readings breaks the line with an empty point', () => {
  const view = conditionDetailView(
    {
      ...cpuDetail(),
      series: {
        kind: 'percent',
        points: [
          { percent: 91, t: NOW - 40 * MINUTE },
          { percent: 92, t: NOW - 35 * MINUTE },
          { percent: 93, t: NOW - 10 * MINUTE },
          { percent: 94, t: NOW - 5 * MINUTE },
        ],
      },
    },
    NOW,
  );
  const points = view.chart?.points ?? [];
  expect(points.map((point) => point.value)).toEqual([91, 92, null, 93, 94]);
  const gap = points[2]?.t ?? 0;
  expect(gap).toBeGreaterThan(NOW - 35 * MINUTE);
  expect(gap).toBeLessThan(NOW - 10 * MINUTE);
});

test('readings 15 minutes apart or closer stay joined', () => {
  const view = conditionDetailView(
    {
      ...cpuDetail(),
      series: {
        kind: 'percent',
        points: [
          { percent: 91, t: NOW - 30 * MINUTE },
          { percent: 92, t: NOW - 15 * MINUTE },
          { percent: 93, t: NOW },
        ],
      },
    },
    NOW,
  );
  expect(view.chart?.points.map((point) => point.value)).toEqual([91, 92, 93]);
});

test('a hot process using a core or more says cores, and under one says of a core', () => {
  const subject = processSubject({ bootId: 'b', name: 'node', pid: 4242, start: '99' });
  const hot = (latest: number) =>
    conditionDetailView(
      {
        ...cpuDetail(),
        kind: 'hot_process',
        level: 'warning',
        series: {
          kind: 'cores',
          points: [
            { cores: 0.2, t: NOW - HOUR },
            { cores: latest, t: NOW },
          ],
        },
        subject,
      },
      NOW,
    ).hero;
  expect(hot(1.5)).toMatchObject({ unit: 'cores', value: '1.50' });
  expect(hot(0.86)).toMatchObject({ unit: 'of a core', value: '0.86' });
});

test('a hot process rule says above its cores limit', () => {
  const subject = processSubject({ bootId: 'b', name: 'node', pid: 4242, start: '99' });
  const view = conditionDetailView(
    {
      ...cpuDetail(),
      kind: 'hot_process',
      series: {
        kind: 'cores',
        points: [
          { cores: 0.2, t: NOW - HOUR },
          { cores: 0.9, t: NOW },
        ],
      },
      subject,
    },
    NOW,
  );
  expect(view.chart?.captions.rule).toBe(
    'above 0.5 core for 30 of 60 min is a note, 120 of 240 a warning',
  );
});

test('a reading with no neighbour on either side is marked lone, so the chart still draws it', () => {
  const points = [
    { t: NOW - 40 * MINUTE, value: 1 },
    { t: NOW - 20 * MINUTE, value: 2 },
    { t: NOW - 15 * MINUTE, value: 3 },
    { t: NOW + MINUTE, value: 4 },
  ];
  const lone = withGaps(points).map((point, index, all) => isLone(all, index));
  expect(lone).toEqual([true, false, false, false, false, true]);
});

test('an open pending_update Condition lists its packages with versions, security, and age', () => {
  const view = conditionDetailView(
    updateDetail({
      packages: [
        {
          available: '3.0',
          installed: '1.0',
          name: 'openssl',
          security: true,
          securitySince: NOW - 2 * DAY - 3 * HOUR,
        },
        { available: null, installed: null, name: 'wget', security: false, securitySince: null },
        { available: '2', installed: '1', name: 'zlib', security: null, securitySince: NOW - HOUR },
        { available: '9', installed: '8', name: 'curl', security: null, securitySince: null },
      ],
      subject: '["apt","system"]',
    }),
    NOW,
  );
  expect(view.title).toBe('Pending update APT (system)');
  expect(view.packages).toEqual([
    { name: 'openssl', pending: '2 d 3 h', security: 'yes', versions: '1.0 → 3.0' },
    { name: 'wget', pending: undefined, security: 'no', versions: 'unknown → unknown' },
    { name: 'zlib', pending: '1 h', security: 'yes', versions: '1 → 2' },
    { name: 'curl', pending: undefined, security: 'unknown', versions: '8 → 9' },
  ]);
});

test('a Condition with no packages to list has no table', () => {
  expect(conditionDetailView(updateDetail({ packages: undefined }), NOW).packages).toBeUndefined();
  expect(conditionDetailView(updateDetail({ packages: [] }), NOW).packages).toEqual([]);
});
