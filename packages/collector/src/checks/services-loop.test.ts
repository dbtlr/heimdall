import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';

import type { ServiceRecord } from '@heimdall/schema';

import { openRecords } from '../records.ts';
import type { RecordStore } from '../records.ts';
import type { CommandResult } from '../subprocess.ts';
import { tempStateDir } from '../testing/fixtures.ts';
import { createServiceChecks, startServiceChecks } from './services-loop.ts';

const START = Date.parse('2026-10-10T08:00:00Z');

const WEB: ServiceRecord = { name: 'web', supervisor: 'systemd', unit: 'web.service' };
const DB: ServiceRecord = { name: 'db', supervisor: 'systemd', unit: 'db.service' };

const shown = (active: string): CommandResult => ({
  exitCode: 0,
  kind: 'exited',
  stderr: '',
  stdout: `LoadState=loaded\nActiveState=${active}\nSubState=x\n`,
});

// The Service checks over a Collector's records in a fresh state directory,
// with a fake systemctl that answers per unit from `states` and a clock the
// test sets. `elsewhere` changes the records through a connection of their
// own, as `record` and `forget` do.
const setup = async (
  dir: { path: string },
  { open }: { open?: () => Promise<RecordStore> } = {},
) => {
  const warnings: string[] = [];
  const states = new Map<string, string>();
  let now = START;
  const checks = createServiceChecks({
    findSystemctl: () => Promise.resolve('/usr/bin/systemctl'),
    log: { info: () => 0, warn: (m) => warnings.push(m) },
    now: () => now,
    open: open ?? (() => openRecords({ stateDir: join(dir.path, 'state') })),
    run: (cmd) => {
      const active = states.get(cmd.at(-1) ?? '');
      return Promise.resolve(active === undefined ? shown('inactive') : shown(active));
    },
  });
  const elsewhere = async (change: (store: RecordStore) => void) => {
    const other = await openRecords({ stateDir: join(dir.path, 'state') });
    change(other);
    other.close();
  };
  return {
    advance: (ms: number) => {
      now += ms;
    },
    checks,
    elsewhere,
    now: () => now,
    states,
    warnings,
  };
};

const sent = (service: string, state: string, detail: string, since: number) => ({
  check: 'supervisor',
  detail,
  service,
  since,
  state,
});

test('no services part exists until the first pass has run', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);

  expect(c.checks.latest()).toBeUndefined();
  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual({ services: [] });
});

test('checks the supervisor of every service record, and nothing else', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  c.states.set('web.service', 'active');
  c.states.set('db.service', 'failed');
  await c.elsewhere((store) => {
    store.put('service', WEB);
    store.put('service', DB);
    store.put('application', { name: 'web', version: '1' });
  });

  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual({
    services: [
      sent('db', 'stopped', 'ActiveState=failed', START),
      sent('web', 'up', 'ActiveState=active', START),
    ],
  });
});

test('a check keeps its since time while its state holds, and takes a new one when the state changes', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  c.states.set('web.service', 'failed');
  await c.elsewhere((store) => store.put('service', WEB));
  await c.checks.tick();

  c.advance(60_000);
  c.states.set('web.service', 'inactive');
  await c.checks.tick();
  const stillStopped = c.checks.latest();
  c.advance(60_000);
  c.states.set('web.service', 'active');
  await c.checks.tick();
  c.checks.close();

  expect(stillStopped).toEqual({
    services: [sent('web', 'stopped', 'ActiveState=inactive', START)],
  });
  expect(c.checks.latest()).toEqual({
    services: [sent('web', 'up', 'ActiveState=active', START + 120_000)],
  });
});

test('answers the same object while nothing about the checks changed, so nothing is sent again', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  c.states.set('web.service', 'failed');
  await c.elsewhere((store) => store.put('service', WEB));
  await c.checks.tick();
  const first = c.checks.latest();

  c.advance(60_000);
  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toBe(first);
});

test('a forgotten service leaves the part', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.elsewhere((store) => store.put('service', WEB));
  await c.checks.tick();

  await c.elsewhere((store) => store.forget('service', 'web'));
  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual({ services: [] });
});

test('a service whose supervisor is not checked yet is unchecked', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.elsewhere((store) =>
    store.put('service', { container: 'web', name: 'web', supervisor: 'docker' }),
  );

  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual({
    services: [sent('web', 'unchecked', 'docker is not checked', START)],
  });
});

test('a store that will not open costs the checks, warned about once, and the next tick tries again', async () => {
  await using dir = await tempStateDir();
  let attempts = 0;
  const c = await setup(dir, {
    open: () => {
      attempts += 1;
      return attempts < 3
        ? Promise.reject(new Error('disk I/O error'))
        : openRecords({ stateDir: join(dir.path, 'state') });
    },
  });

  await c.checks.tick();
  await c.checks.tick();
  const failing = c.checks.latest();
  await c.checks.tick();
  c.checks.close();

  expect(failing).toBeUndefined();
  expect(c.warnings).toHaveLength(1);
  expect(c.warnings[0]).toContain('disk I/O error');
  expect(c.checks.latest()).toEqual({ services: [] });
});

test('a service row stored under another name is left out and warned about once', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.elsewhere((store) => store.put('service', WEB));
  const db = new Database(join(dir.path, 'state', 'records.sqlite'));
  db.run('INSERT INTO records (kind, name, body) VALUES (?, ?, ?)', [
    'service',
    'renamed',
    JSON.stringify(DB),
  ]);
  db.close();

  await c.checks.tick();
  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual({
    services: [sent('web', 'stopped', 'ActiveState=inactive', START)],
  });
  expect(c.warnings).toEqual([expect.stringContaining('"renamed"')]);
});

test('started, it checks again each interval until stopped', async () => {
  await using dir = await tempStateDir();
  let ticks = 0;
  const checks = startServiceChecks({
    intervalMs: 10,
    log: { info: () => 0, warn: () => 0 },
    now: () => {
      ticks += 1;
      return START;
    },
    open: () => openRecords({ stateDir: join(dir.path, 'state') }),
  });

  await Bun.sleep(100);
  await checks.stop();
  const count = ticks;
  await Bun.sleep(50);

  expect(count).toBeGreaterThan(1);
  expect(ticks).toBe(count);
  expect(checks.latest()).toEqual({ services: [] });
});
