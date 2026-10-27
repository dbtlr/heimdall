import { beforeAll, expect, test } from 'bun:test';

import type { PendingUpdate, UpdateManager, UpdatesSection } from '@heimdall/schema';

import { readAttention } from '../../dashboard/src/server/attention.ts';
import { readFleetTimeline } from '../../dashboard/src/server/fleet-timeline.ts';
import { parseConditionLimits } from './condition-limits.ts';
import { unpair } from './pairing.ts';
import { NOW, push, report, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';
import { startTestServer } from './testing/postgres.ts';
import { storeToken } from './tokens.ts';
import { evaluateUpdateConditions, judgeUpdateConditions } from './update-conditions.ts';
import type { UpdateConditionFacts } from './update-conditions.ts';

beforeAll(startTestServer, 60_000);
const DAY = 86400000;
const pending: PendingUpdate = {
  available: '1.1',
  installed: '1.0',
  name: 'openssl:amd64',
  security: true,
};
const manager = (at: number, updates = [pending]): UpdateManager => ({
  installation: '/usr/bin/apt',
  manager: 'apt',
  observedAt: at,
  result: { kind: 'available', metadataAt: at, updates },
});
// Hub-confirmed package age and Collector observations, without a database.
const updateFacts = (
  updates: PendingUpdate[] = [pending],
  overrides: Partial<UpdateConditionFacts> = {},
): UpdateConditionFacts => ({
  limits: parseConditionLimits(undefined).updates,
  managers: [{ installation: '/usr/bin/apt', manager: 'apt', observation: manager(NOW, updates) }],
  open: [],
  reboot: undefined,
  subjects: updates.map((update) => ({
    first_seen_at: new Date(NOW),
    installation: '/usr/bin/apt',
    manager: 'apt',
    name: update.name,
    observed_at: new Date(NOW),
    pending_update: update,
    security_since: update.security === true ? new Date(NOW) : null,
    subject: JSON.stringify(['apt', '/usr/bin/apt', update.name]),
  })),
  ...overrides,
});

const judge = (facts = updateFacts(), now = NOW) => judgeUpdateConditions(facts, now);

const send = async (
  h: Hub,
  managers: UpdateManager[],
  reboot: UpdatesSection['reboot'] = {
    kind: 'unavailable',
    observedAt: h.clock.now,
    reason: 'unsupported',
  },
) => {
  expect(
    (
      await push(
        h.hub,
        {
          ...report('laptop-1', [h.clock.now]),
          sentAt: h.clock.now,
          updates: { managers, reboot },
        },
        { token: 'laptop-token' },
      )
    ).status,
  ).toBe(200);
};
const evaluate = async (h: Hub, limits = parseConditionLimits(undefined)) => {
  await evaluateUpdateConditions(h.db.sql, () => h.clock.now, limits);
  return (
    await readAttention(h.db.sql, {
      now: h.clock.now,
      systems: [{ name: 'laptop-1', paired: true }],
    })
  ).filter(({ kind }) => kind === 'pending_update' || kind === 'reboot_required');
};

test('a pending security update ages from Hub confirmation and candidate changes retain one occurrence', async () => {
  await using h = await startHub();
  await send(h, [manager(NOW)]);
  const [note] = await evaluate(h);
  expect(note).toMatchObject({ firstDetected: NOW, kind: 'pending_update', level: 'note' });
  h.clock.now += 3 * DAY + 1;
  await send(h, [manager(h.clock.now, [{ ...pending, available: '1.2' }])]);
  const [warning] = await evaluate(h);
  expect(warning).toMatchObject({ firstDetected: NOW, level: 'warning', subject: note?.subject });
});

test('stale and failed checks preserve a warning, while fresh known non-security evidence can lower it', () => {
  const now = NOW + 4 * DAY;
  const base = updateFacts([{ ...pending, security: false }], {
    open: [
      {
        kind: 'pending_update',
        level: 'warning',
        subject: JSON.stringify(['apt', '/usr/bin/apt']),
      },
    ],
  });
  for (const observation of [
    manager(NOW),
    { ...manager(now), result: { kind: 'available', metadataAt: NOW - 8 * DAY, updates: [] } },
    { ...manager(now), result: { kind: 'unavailable', reason: 'permission denied' } },
    { ...manager(now), result: { kind: 'available', metadataAt: null, updates: [] } },
    undefined,
  ]) {
    const facts = {
      ...base,
      managers: [{ installation: '/usr/bin/apt', manager: 'apt', observation }],
    };
    expect(judge(facts, now).pending.get(JSON.stringify(['apt', '/usr/bin/apt']))?.level).toBe(
      'warning',
    );
  }
  expect(
    judge(
      {
        ...base,
        managers: [
          {
            installation: '/usr/bin/apt',
            manager: 'apt',
            observation: manager(now, [{ ...pending, security: false }]),
          },
        ],
      },
      now,
    ).pending.get(JSON.stringify(['apt', '/usr/bin/apt']))?.level,
  ).toBe('note');
});

test('reboot age survives missing evidence and only a fresh marker absence clears it', async () => {
  await using h = await startHub();
  await send(h, [], { kind: 'available', observedAt: NOW, required: true });
  expect((await evaluate(h))[0]).toMatchObject({ kind: 'reboot_required', level: 'note' });
  h.clock.now += 7 * DAY + 1;
  expect((await evaluate(h))[0]?.level).toBe('warning');
  await send(h, [], { kind: 'unavailable', observedAt: h.clock.now, reason: 'disabled' });
  const longer = parseConditionLimits({ updates: { rebootWarningDays: 30 } });
  expect((await evaluate(h, longer))[0]?.level).toBe('warning');
  h.clock.now += 1;
  await send(h, [], { kind: 'available', observedAt: h.clock.now, required: false });
  expect(await evaluate(h)).toEqual([]);
  h.clock.now += 1;
  await send(h, [], { kind: 'available', observedAt: h.clock.now, required: true });
  expect((await evaluate(h))[0]).toMatchObject({ firstDetected: h.clock.now, level: 'note' });
});

test('only fresh recovery or a complete fresh census proves a pending package is gone', async () => {
  await using h = await startHub();
  await send(h, [manager(NOW)]);
  const [first] = await evaluate(h);
  h.clock.now += 1;
  const unknown = manager(h.clock.now, []);
  if (unknown.result.kind === 'available') {
    unknown.result.metadataAt = null;
  }
  await send(h, [unknown]);
  expect((await evaluate(h))[0]?.firstDetected).toBe(first?.firstDetected);
  h.clock.now += 1;
  await send(h, [
    { ...unknown, installed: { names: [], observedAt: NOW - 2 * DAY }, observedAt: h.clock.now },
  ]);
  expect(await evaluate(h)).toHaveLength(1);
  h.clock.now += 1;
  await send(h, [
    { ...unknown, installed: { names: [], observedAt: h.clock.now }, observedAt: h.clock.now },
  ]);
  expect(await evaluate(h)).toEqual([]);
  h.clock.now += 1;
  await send(h, [manager(h.clock.now)]);
  expect((await evaluate(h))[0]).toMatchObject({ firstDetected: h.clock.now, level: 'note' });
  h.clock.now += 1;
  await send(h, [manager(h.clock.now, [])]);
  expect(await evaluate(h)).toEqual([]);
});

test('cached replay and older success cannot refresh evidence or recover a later pending update', async () => {
  await using h = await startHub();
  const cached = manager(NOW);
  await send(h, [cached]);
  await evaluate(h);
  h.clock.now += 4 * DAY;
  await send(h, [cached]);
  expect((await evaluate(h))[0]).toMatchObject({
    checkedAt: NOW,
    evidence: 'old',
    level: 'warning',
  });
  await send(h, [manager(NOW - 1, [])]);
  expect((await evaluate(h))[0]?.level).toBe('warning');
  await send(h, []);
  expect(await evaluate(h)).toHaveLength(1);
});

test('package identities include the installation and unknown security never inherits another package age', async () => {
  await using h = await startHub();
  await send(h, [
    manager(NOW, [{ ...pending, security: null }]),
    { ...manager(NOW), installation: '/other/apt' },
  ]);
  expect(await evaluate(h)).toHaveLength(2);
  h.clock.now += 4 * DAY;
  const conditions = await evaluate(h);
  expect(
    conditions.map(({ level }) => level).toSorted((a, b) => String(a).localeCompare(String(b))),
  ).toEqual(['note', 'warning']);
  await send(h, [manager(h.clock.now)]);
  expect((await evaluate(h)).find(({ subject }) => subject.includes('/usr/bin/apt'))?.level).toBe(
    'note',
  );
});

test('future evidence is ignored and backlogged security evidence starts aging at Hub confirmation', async () => {
  await using h = await startHub();
  await send(h, [manager(NOW + DAY)]);
  expect(await evaluate(h)).toEqual([]);
  await send(h, [manager(NOW - 10 * DAY)]);
  expect((await evaluate(h))[0]).toMatchObject({ firstDetected: NOW, level: 'note' });
  h.clock.now += 1;
  await send(h, [manager(h.clock.now, [])]);
  expect(await evaluate(h)).toEqual([]);
});

test('security limit overrides apply per System and unpairing clears update Conditions', async () => {
  await using h = await startHub();
  await send(h, [manager(NOW)], { kind: 'available', observedAt: NOW, required: true });
  await evaluate(h);
  h.clock.now += 2 * DAY;
  const limits = parseConditionLimits({
    systems: { 'laptop-1': { updates: { securityWarningDays: 1 } } },
    updates: { securityWarningDays: 10 },
  });
  expect((await evaluate(h, limits)).find(({ kind }) => kind === 'pending_update')?.level).toBe(
    'warning',
  );
  await unpair(h.db.sql, 'laptop-1');
  expect(await evaluate(h)).toEqual([]);
  const timeline = await readFleetTimeline(h.db.sql, { now: h.clock.now });
  expect(
    timeline.entries
      .toSorted((a, b) => a.kind.localeCompare(b.kind))
      .map(({ kind, clearedAt }) => [kind, clearedAt]),
  ).toEqual([
    ['pending_update', h.clock.now],
    ['reboot_required', h.clock.now],
  ]);
});

test('schema-permitted NUL text is normalized without blocking Report delivery or package identity', async () => {
  await using h = await startHub();
  await send(h, [
    {
      ...manager(NOW, [{ ...pending, available: '2\0', name: 'package\0name' }]),
      installation: '/mock\0apt',
    },
  ]);
  const [condition] = await evaluate(h);
  expect(condition?.subject).toBe(JSON.stringify(['apt', '/mock�apt']));
  h.clock.now += 1;
  await send(h, [{ ...manager(h.clock.now, []), installation: '/mock\0apt' }]);
  expect(await evaluate(h)).toEqual([]);
});

test('fresh recoveries received between judgments end both occurrences before a recurrence starts', async () => {
  await using h = await startHub();
  await send(h, [manager(NOW)], { kind: 'available', observedAt: NOW, required: true });
  await evaluate(h);
  h.clock.now += 8 * DAY;
  expect((await evaluate(h)).map(({ level }) => level)).toEqual(['warning', 'warning']);
  const recoveredAt = h.clock.now;
  await send(h, [manager(recoveredAt, [])], {
    kind: 'available',
    observedAt: recoveredAt,
    required: false,
  });
  h.clock.now += 1;
  await send(h, [manager(h.clock.now)], {
    kind: 'available',
    observedAt: h.clock.now,
    required: true,
  });
  expect((await evaluate(h)).map(({ firstDetected, level }) => ({ firstDetected, level }))).toEqual(
    [
      { firstDetected: h.clock.now, level: 'note' },
      { firstDetected: h.clock.now, level: 'note' },
    ],
  );
  const timeline = await readFleetTimeline(h.db.sql, { now: h.clock.now });
  expect(timeline.entries.filter(({ clearedAt }) => clearedAt === recoveredAt)).toHaveLength(2);
});

test('a re-paired System can reconfirm cached positive evidence with a new occurrence and age', async () => {
  await using h = await startHub();
  await send(h, [manager(NOW)], { kind: 'available', observedAt: NOW, required: true });
  await evaluate(h);
  h.clock.now += DAY;
  await unpair(h.db.sql, 'laptop-1');
  expect(await evaluate(h)).toEqual([]);
  await storeToken(h.db.sql, { pairedAt: h.clock.now, system: 'laptop-1', token: 'laptop-token' });
  await send(h, [manager(NOW)], { kind: 'available', observedAt: NOW, required: true });
  expect((await evaluate(h)).map(({ firstDetected, level }) => ({ firstDetected, level }))).toEqual(
    [
      { firstDetected: h.clock.now, level: 'note' },
      { firstDetected: h.clock.now, level: 'note' },
    ],
  );
});

test('fresh fully installed candidate evidence clears an update despite old repository metadata', () => {
  const now = NOW + 4 * DAY;
  const observation = {
    ...manager(now, []),
    installed: {
      names: [pending.name],
      observedAt: now,
      versions: [{ name: pending.name, version: '1.1' }],
    },
    result: { kind: 'available', metadataAt: NOW - 365 * DAY, updates: [] },
  };
  const facts = updateFacts([pending], {
    managers: [{ installation: '/usr/bin/apt', manager: 'apt', observation }],
  });
  expect(judge(facts, now).recoveredSubjects).toEqual([
    JSON.stringify(['apt', '/usr/bin/apt', 'openssl:amd64']),
  ]);
  expect(judge(facts, now).pending.size).toBe(0);
});

test('installed-version proof preserves a warning without fresh matching proof or while a newer update remains pending', () => {
  const now = NOW + 4 * DAY + 1;
  for (const [censusOffset, version, stillPending] of [
    [-2 * DAY, '1.1', false],
    [-1, '1.1', false],
    [0, null, false],
    [0, '1.0', false],
    [DAY, '1.1', false],
    [0, '1.1', true],
  ] satisfies [number, string | null, boolean][]) {
    const facts = updateFacts([pending]);
    facts.subjects = facts.subjects.map((subject) => ({
      ...subject,
      observed_at: new Date(now - 1),
    }));
    facts.managers = [
      {
        installation: '/usr/bin/apt',
        manager: 'apt',
        observation: {
          ...manager(now, []),
          installed: {
            names: [pending.name],
            observedAt: now - 1 + censusOffset,
            versions: version === null ? [] : [{ name: pending.name, version }],
          },
          result: stillPending
            ? { kind: 'available', metadataAt: null, updates: [{ ...pending, available: '1.2' }] }
            : { kind: 'unavailable', reason: 'metadata unavailable' },
        },
      },
    ];
    expect(judge(facts, now).recoveredSubjects).toEqual([]);
    expect(judge(facts, now).pending.get(JSON.stringify(['apt', '/usr/bin/apt']))?.level).toBe(
      'warning',
    );
  }
});

test('fresh fully installed candidate evidence can recover independently of a failed metadata check', () => {
  const now = NOW + 1;
  const facts = updateFacts([pending], {
    managers: [
      {
        installation: '/usr/bin/apt',
        manager: 'apt',
        observation: {
          ...manager(now, []),
          installed: {
            names: [pending.name],
            observedAt: now,
            versions: [{ name: pending.name, version: '1.1' }],
          },
          result: { kind: 'unavailable', reason: 'APT timed out' },
        },
      },
    ],
  });
  expect(judge(facts, now).recoveredSubjects).toEqual([
    JSON.stringify(['apt', '/usr/bin/apt', 'openssl:amd64']),
  ]);
  expect(judge(facts, now).pending.size).toBe(0);
});

test('an unknown candidate version cannot be established as applied by local installed-version evidence', () => {
  const now = NOW + 1;
  const facts = updateFacts([{ ...pending, available: null }], {
    managers: [
      {
        installation: '/usr/bin/apt',
        manager: 'apt',
        observation: {
          ...manager(now, []),
          installed: {
            names: [pending.name],
            observedAt: now,
            versions: [{ name: pending.name, version: '1.1' }],
          },
          result: { kind: 'unavailable', reason: 'APT timed out' },
        },
      },
    ],
  });
  expect(judge(facts, now).recoveredSubjects).toEqual([]);
  expect(judge(facts, now).pending.size).toBe(1);
});

const wget: PendingUpdate = { available: '2.0', installed: '1.0', name: 'wget', security: false };
const curl: PendingUpdate = { available: '8.1', installed: '8.0', name: 'curl', security: null };
const sourceSubject = JSON.stringify(['apt', '/usr/bin/apt']);
type ConditionRow = {
  actions: string[];
  cleared_at: Date | null;
  id: string;
  latest_reason: string;
};
const rows = (h: Hub, where: string): Promise<ConditionRow[]> =>
  h.db.sql.unsafe(
    `SELECT c.id, c.level, c.subject, c.latest_reason, c.cleared_at,
            array(SELECT action FROM condition_transitions WHERE condition = c.id ORDER BY id) AS actions
     FROM conditions c WHERE c.kind = 'pending_update' AND ${where} ORDER BY c.id`,
  );

test('pending updates in one package source share one Condition that counts them', async () => {
  await using h = await startHub();
  await send(h, [manager(NOW, [pending, wget, curl])]);
  const items = await evaluate(h);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ level: 'note', subject: sourceSubject });
  expect(items[0]?.kind === 'pending_update' ? items[0].reason : undefined).toBe(
    '3 APT packages are out of date, 1 of them is a security update.',
  );
  expect(await rows(h, 'true')).toHaveLength(1);
});

test('one aged security package makes the whole source a warning', () => {
  const now = NOW + 8 * DAY;
  expect(judge(updateFacts([wget, curl]), now).pending.get(sourceSubject)?.level).toBe('note');
  const facts = updateFacts([wget, curl, pending]);
  facts.subjects = facts.subjects.map((subject) =>
    subject.name === pending.name
      ? { ...subject, security_since: new Date(NOW + 4 * DAY) }
      : subject,
  );
  expect(judge(facts, now).pending.get(sourceSubject)?.level).toBe('warning');
});

test('a warning source stays a warning until fresh evidence covers every package', () => {
  const now = NOW + 4 * DAY;
  const facts = updateFacts([{ ...pending, security: false }, curl], {
    open: [{ kind: 'pending_update', level: 'warning', subject: sourceSubject }],
  });
  facts.managers = [
    {
      installation: '/usr/bin/apt',
      manager: 'apt',
      observation: manager(now, [{ ...pending, security: false }, curl]),
    },
  ];
  expect(judge(facts, now).pending.get(sourceSubject)?.level).toBe('warning');
  facts.managers = [
    {
      installation: '/usr/bin/apt',
      manager: 'apt',
      observation: manager(now, [
        { ...pending, security: false },
        { ...curl, security: false },
      ]),
    },
  ];
  expect(judge(facts, now).pending.get(sourceSubject)?.level).toBe('note');
});

test('a package recovering while others remain changes only the Condition reason', () => {
  const facts = updateFacts([wget, curl], {
    open: [{ kind: 'pending_update', level: 'note', subject: sourceSubject }],
  });
  expect(judge(facts).pending.get(sourceSubject)).toEqual({
    level: 'note',
    raise: '2 APT packages are out of date.',
  });
  facts.managers = [
    { installation: '/usr/bin/apt', manager: 'apt', observation: manager(NOW + 1, [curl]) },
  ];
  expect(judge(facts, NOW + 1)).toMatchObject({
    emptySources: [],
    recoveredSubjects: [JSON.stringify(['apt', '/usr/bin/apt', 'wget'])],
  });
  expect(judge(facts, NOW + 1).pending.get(sourceSubject)).toEqual({
    level: 'note',
    raise: '1 APT package is out of date.',
  });
});

test('stale, failed, or metadata-less checks never clear a source that still has packages', () => {
  const now = NOW + 9 * DAY;
  for (const observation of [
    manager(NOW, [wget]),
    { ...manager(now), result: { kind: 'unavailable', reason: 'permission denied' } },
    { ...manager(now), result: { kind: 'available', metadataAt: null, updates: [] } },
  ]) {
    const facts = updateFacts([wget], {
      managers: [{ installation: '/usr/bin/apt', manager: 'apt', observation }],
      open: [{ kind: 'pending_update', level: 'note', subject: sourceSubject }],
    });
    expect(judge(facts, now).emptySources).toEqual([]);
    expect(judge(facts, now).pending.get(sourceSubject)).toEqual({
      level: 'note',
      raise: '1 APT package is out of date.',
    });
  }
});

test('the Condition clears when the last package recovers', async () => {
  await using h = await startHub();
  await send(h, [manager(NOW, [wget, curl])]);
  await evaluate(h);
  h.clock.now += 1;
  await send(h, [manager(h.clock.now, [curl])]);
  h.clock.now += 1;
  await send(h, [manager(h.clock.now, [])]);
  const [source] = await rows(h, 'true');
  expect(source).toMatchObject({ actions: ['raised', 'cleared'] });
  expect(source?.cleared_at).toEqual(new Date(h.clock.now));
  expect(await evaluate(h)).toEqual([]);
});

test('a package joining an open source retains its level and updates the count', () => {
  const facts = updateFacts([wget, curl], {
    open: [{ kind: 'pending_update', level: 'note', subject: sourceSubject }],
  });
  expect(judge(facts).pending).toEqual(
    new Map([[sourceSubject, { level: 'note', raise: '2 APT packages are out of date.' }]]),
  );
});

test('an aged security package keeps the source a warning when a newer one joins', () => {
  const now = NOW + 4 * DAY;
  const facts = updateFacts([pending, { ...pending, name: 'newer' }]);
  facts.subjects = facts.subjects.map((subject) =>
    subject.name === 'newer' ? { ...subject, security_since: new Date(now) } : subject,
  );
  expect(judge(facts, now).pending.get(sourceSubject)).toEqual({
    level: 'warning',
    raise: '2 APT packages are out of date, 2 of them are security updates.',
  });
});

test('a held warning stays while any package has unknown security, whatever its order', () => {
  const now = NOW + 4 * DAY + 1;
  for (const updates of [
    [
      { ...curl, name: 'a-unknown' },
      { ...pending, security: false },
    ],
    [
      { ...pending, security: false },
      { ...curl, name: 'z-unknown' },
    ],
  ]) {
    const facts = updateFacts(updates, {
      managers: [
        { installation: '/usr/bin/apt', manager: 'apt', observation: manager(now, updates) },
      ],
      open: [{ kind: 'pending_update', level: 'warning', subject: sourceSubject }],
    });
    expect(judge(facts, now).pending.get(sourceSubject)?.level).toBe('warning');
  }
});

test('local proof that the last package is gone ends the Condition in its Report', async () => {
  await using h = await startHub();
  await send(h, [manager(NOW, [wget])]);
  await evaluate(h);
  h.clock.now += 1;
  await send(h, [
    {
      ...manager(h.clock.now, []),
      installed: { names: [], observedAt: h.clock.now },
      result: { kind: 'unavailable', reason: 'APT timed out' },
    },
  ]);
  h.clock.now += 1;
  await send(h, [manager(h.clock.now, [wget])]);
  await evaluate(h);
  expect((await rows(h, 'true')).map(({ actions }) => actions)).toEqual([
    ['raised', 'cleared'],
    ['raised'],
  ]);
});

test('security and reboot ages warn strictly past their limits', () => {
  expect(judge(updateFacts(), NOW + 3 * DAY).pending.get(sourceSubject)?.level).toBe('note');
  expect(judge(updateFacts(), NOW + 3 * DAY + 1).pending.get(sourceSubject)?.level).toBe('warning');
  const facts = updateFacts([], {
    reboot: {
      first_required_at: new Date(NOW),
      observation: { kind: 'available', observedAt: NOW, required: true },
    },
  });
  expect(judge(facts, NOW + 7 * DAY).reboot).toMatchObject({ level: 'note' });
  expect(judge(facts, NOW + 7 * DAY + 1).reboot).toEqual({
    level: 'warning',
    raise: 'A reboot is required; confirmed by the local reboot-required marker.',
  });
});

test('missing reboot evidence holds, and fresh absence clears only that marker', () => {
  expect(judge(updateFacts([])).reboot).toBe('hold');
  const facts = updateFacts([], {
    reboot: {
      first_required_at: null,
      observation: { kind: 'unavailable', observedAt: NOW, reason: 'unsupported' },
    },
  });
  expect(judge(facts).reboot).toBe('hold');
  facts.reboot = {
    first_required_at: new Date(NOW),
    observation: { kind: 'available', observedAt: NOW, required: false },
  };
  expect(judge(facts).reboot).toBe('clear');
  expect(judge(facts, NOW + 2 * DAY).reboot).toMatchObject({ level: 'note' });
});
