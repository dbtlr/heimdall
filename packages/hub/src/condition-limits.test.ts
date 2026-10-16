import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { tempHome } from '@heimdall/service/testing';

import { parseConditionLimits, readConditionLimits } from './condition-limits.ts';
import { configArgs, configFile, invoke } from './testing/cli.ts';
import { migrate, report, storeReport, storeToken } from './testing/hub.ts';
import { testDatabase } from './testing/postgres.ts';

test('update warning ages inherit fields per System and reject invalid limits', () => {
  const limits = parseConditionLimits({
    systems: { 'laptop-1': { updates: { rebootWarningDays: 10 } } },
    updates: { securityWarningDays: 5 },
  });
  expect(limits.updates).toEqual({ rebootWarningDays: 7, securityWarningDays: 5 });
  expect(limits.systems.get('laptop-1')?.updates).toEqual({
    rebootWarningDays: 10,
    securityWarningDays: 5,
  });
  for (const value of [0, -1, Number.POSITIVE_INFINITY, 3651, '3']) {
    expect(() => parseConditionLimits({ updates: { securityWarningDays: value } })).toThrow();
    expect(() =>
      parseConditionLimits({ systems: { 'laptop-1': { updates: { rebootWarningDays: value } } } }),
    ).toThrow();
  }
});

test('hot-process limits inherit individual core and rolling duration settings per System', () => {
  const limits = parseConditionLimits({
    process: { cores: 0.75 },
    systems: { 'laptop-1': { process: { noteMinutes: 20 } } },
  });
  expect(limits.process).toEqual({
    cores: 0.75,
    noteMinutes: 30,
    noteWindowMinutes: 60,
    warningMinutes: 120,
    warningWindowMinutes: 240,
  });
  expect(limits.systems.get('laptop-1')?.process).toEqual({
    ...limits.process,
    noteMinutes: 20,
  });
  expect(parseConditionLimits(undefined).process.cores).toBe(0.5);
  for (const process of [
    { cores: 0 },
    { cores: Number.POSITIVE_INFINITY },
    { noteMinutes: 61 },
    { warningMinutes: 20 },
    { warningWindowMinutes: 30_000 },
    { unknown: 1 },
  ]) {
    expect(() => parseConditionLimits({ process })).toThrow();
  }
  expect(() => parseConditionLimits({ process: { cores: 4 } })).not.toThrow();
});

test('load limits inherit fleet values and validate the complete System override', () => {
  const limits = parseConditionLimits({
    cpu: { percent: 85 },
    systems: { 'laptop-1': { cpu: { noteMinutes: 20 }, memory: { percent: 95 } } },
  });
  expect(limits.cpu).toEqual({
    noteMinutes: 30,
    noteWindowMinutes: 60,
    percent: 85,
    warningMinutes: 120,
    warningWindowMinutes: 240,
  });
  expect(limits.systems.get('laptop-1')?.cpu).toEqual({ ...limits.cpu, noteMinutes: 20 });
  expect(limits.systems.get('laptop-1')?.memory).toEqual({
    percent: 95,
    warningMinutes: 30,
    warningWindowMinutes: 60,
  });
  expect(() => parseConditionLimits({ cpu: { noteMinutes: 61 } })).toThrow();
  expect(() => parseConditionLimits({ memory: { warningWindowMinutes: 30_000 } })).toThrow();
  expect(() =>
    parseConditionLimits({ systems: { 'laptop-1': { cpu: { warningMinutes: 10 } } } }),
  ).toThrow();
});

test.each(['toml', 'json'])(
  'disk limits read the selected %s file and inherit fields per System',
  async (extension) => {
    await using home = await tempHome();
    const named = `settings.${extension}`;
    await writeFile(
      join(home.path, named),
      extension === 'toml'
        ? `
[conditions.disk]
note = 60
warning = 75
[conditions.cpu]
percent = 85
[conditions.memory]
warningMinutes = 20
[conditions.systems.laptop-1.disk]
alert = 95
hysteresis = 3
[conditions.systems.laptop-1.cpu]
noteMinutes = 15
[conditions.systems.laptop-1.memory]
percent = 95
`
        : JSON.stringify({
            conditions: {
              cpu: { percent: 85 },
              disk: { note: 60, warning: 75 },
              memory: { warningMinutes: 20 },
              systems: {
                'laptop-1': {
                  cpu: { noteMinutes: 15 },
                  disk: { alert: 95, hysteresis: 3 },
                  memory: { percent: 95 },
                },
              },
            },
          }),
    );

    const limits = await readConditionLimits({ cwd: home.path, env: {}, named });

    expect(limits.disk).toEqual({ alert: 90, hysteresis: 5, note: 60, warning: 75 });
    expect(limits.systems.get('laptop-1')?.disk).toEqual({
      alert: 95,
      hysteresis: 3,
      note: 60,
      warning: 75,
    });
    expect(limits.systems.has('server-1')).toBe(false);
    expect(limits.systems.get('laptop-1')?.cpu).toEqual({
      noteMinutes: 15,
      noteWindowMinutes: 60,
      percent: 85,
      warningMinutes: 120,
      warningWindowMinutes: 240,
    });
    expect(limits.systems.get('laptop-1')?.memory).toEqual({
      percent: 95,
      warningMinutes: 20,
      warningWindowMinutes: 60,
    });
  },
);

test.each([
  { disk: { note: 80 } },
  { disk: { note: 4 } },
  { disk: { hysteresis: 0 } },
  { disk: { alert: 101 } },
  { disk: { warning: '80' } },
  { disk: { unknown: 80 } },
  { systems: { 'bad.name': { disk: { alert: 95 } } } },
  { systems: { 'laptop-1': { disk: { warning: 88 } } } },
  { systems: { 'laptop-1': { service_down: 'note' } } },
  { cpu: { percent: 0 } },
  { memory: { percent: 101 } },
  { cpu: { noteWindowMinutes: 500 } },
  { systems: { 'laptop-1': { memory: { warningWindowMinutes: 10 } } } },
])('invalid limits are refused: %j', (value) => {
  expect(() => parseConditionLimits(value)).toThrow();
});

test('serve refuses invalid inherited System limits before touching its database', async () => {
  await using config = await configFile([
    '[database]',
    'url = "postgres://nobody@127.0.0.1:1/never"',
    '[conditions.systems.laptop-1.disk]',
    'warning = 88',
  ]);

  const result = await invoke(['serve', ...configArgs(config)]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('conditions.systems.laptop-1.disk');
  expect(result.stderr).not.toContain('Could not prepare the database');
});

test('serve refuses invalid load windows before touching its database', async () => {
  await using config = await configFile([
    '[database]',
    'url = "postgres://nobody@127.0.0.1:1/never"',
    '[conditions.systems.laptop-1.cpu]',
    'noteWindowMinutes = 10',
  ]);
  const result = await invoke(['serve', ...configArgs(config)]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('conditions.systems.laptop-1.cpu');
  expect(result.stderr).not.toContain('Could not prepare the database');
});

test('serve judges disk using fleet defaults and partial System overrides from hub.toml', async () => {
  await using db = await testDatabase();
  await migrate(db.sql);
  const now = Date.now();
  for (const system of ['laptop-1', 'server-1']) {
    // oxlint-disable-next-line no-await-in-loop -- seed each System before serving.
    await storeToken(db.sql, { pairedAt: now, system, token: system });
    const body = report(system, [now]);
    body.samples[0]?.disks.splice(0, body.samples[0].disks.length, {
      mount: '/',
      totalBytes: 1000,
      usedBytes: 820,
    });
    // oxlint-disable-next-line no-await-in-loop -- seed each System before serving.
    await storeReport(db.sql, { receivedAt: now, report: body });
  }
  await using config = await configFile([
    'port = 0',
    '[database]',
    `url = "${db.url.href}"`,
    '[conditions.disk]',
    'note = 60',
    'warning = 75',
    '[conditions.systems.laptop-1.disk]',
    'warning = 85',
    'alert = 95',
  ]);

  const result = await invoke(['serve', ...configArgs(config)], {
    whileServing: async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        // oxlint-disable-next-line no-await-in-loop -- wait for the first evaluator pass.
        const rows: { n: number }[] = await db.sql`SELECT count(*)::int AS n FROM conditions`;
        if (rows[0]?.n === 2) {
          return;
        }
        // oxlint-disable-next-line no-await-in-loop -- bounded polling of the public startup behavior.
        await Bun.sleep(10);
      }
      throw new Error('serve did not evaluate both Systems.');
    },
  });

  const conditions: { system: string; level: string }[] =
    await db.sql`SELECT system, level FROM conditions ORDER BY system`;
  expect(conditions).toEqual([
    { level: 'note', system: 'laptop-1' },
    { level: 'warning', system: 'server-1' },
  ]);
  expect(result.stderr).toBe('');
});
