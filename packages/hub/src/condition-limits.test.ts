import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { tempHome } from '@heimdall/service/testing';

import { parseConditionLimits, readConditionLimits } from './condition-limits.ts';
import { configArgs, configFile, invoke } from './testing/cli.ts';
import { migrate, report, storeReport, storeToken } from './testing/hub.ts';
import { testDatabase } from './testing/postgres.ts';

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
[conditions.systems.laptop-1.disk]
alert = 95
hysteresis = 3
`
        : JSON.stringify({
            conditions: {
              disk: { note: 60, warning: 75 },
              systems: { 'laptop-1': { disk: { alert: 95, hysteresis: 3 } } },
            },
          }),
    );

    const limits = await readConditionLimits({ cwd: home.path, env: {}, named });

    expect(limits.disk).toEqual({ alert: 90, hysteresis: 5, note: 60, warning: 75 });
    expect(limits.systems.get('laptop-1')).toEqual({
      alert: 95,
      hysteresis: 3,
      note: 60,
      warning: 75,
    });
    expect(limits.systems.has('server-1')).toBe(false);
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
